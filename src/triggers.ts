import {
  ChannelType,
  Events,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type VoiceState,
} from 'discord.js';
import type { Config } from './config.js';
import { toError } from './errors.js';
import type { Logger } from './log.js';
import { findSound, JOIN_SOUND, type SoundName } from './sounds.js';
import type { Swarm } from './swarm.js';

export interface VoiceTransition {
  guildId: string;
  userId: string;
  isBot: boolean;
  oldChannelId: string | null;
  newChannelId: string | null;
  /** True only for regular voice channels (not stage channels). */
  newChannelIsVoice: boolean;
  afkChannelId: string | null;
}

/** True only when a trigger user moves from no voice channel into a regular, non-AFK voice channel. */
export function shouldTrigger(t: VoiceTransition, cfg: Pick<Config, 'guildId' | 'triggerUserIds'>): boolean {
  return (
    t.guildId === cfg.guildId &&
    cfg.triggerUserIds.has(t.userId) &&
    !t.isBot &&
    t.oldChannelId === null &&
    t.newChannelId !== null &&
    t.newChannelIsVoice &&
    t.newChannelId !== t.afkChannelId
  );
}

export interface Occupant {
  userId: string;
  channelId: string | null;
  /** undefined when the member is not cached; treated as human. */
  isBot: boolean | undefined;
}

/** True if anyone other than our own bots, and other than known bots, is in the channel. */
export function hasHumans(occupants: Iterable<Occupant>, channelId: string, fleetIds: ReadonlySet<string>): boolean {
  for (const o of occupants) {
    if (o.channelId === channelId && !fleetIds.has(o.userId) && o.isBot !== true) return true;
  }
  return false;
}

export function toTransition(oldState: VoiceState, newState: VoiceState): VoiceTransition {
  return {
    guildId: newState.guild.id,
    userId: newState.id,
    isBot: newState.member?.user.bot ?? false,
    oldChannelId: oldState.channelId,
    newChannelId: newState.channelId,
    newChannelIsVoice: newState.channel?.type === ChannelType.GuildVoice,
    afkChannelId: newState.guild.afkChannelId,
  };
}

export const REPLIES = {
  notInVoice: 'Join a voice channel first.',
  busy: 'Swarm already in flight 🐝',
  cooldown: (remainingMs: number) => `Swarm is cooling down — try again in ${Math.ceil(remainingMs / 1000)}s.`,
  launched: '🐝 incoming',
} as const;

/** Handles a sound command: launches the swarm into the caller's voice channel and replies privately. */
export async function handleSoundCommand(
  interaction: ChatInputCommandInteraction,
  sound: SoundName,
  swarm: Pick<Swarm, 'launch'>,
  log: Logger,
): Promise<void> {
  const channel = interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channel;
  let content: string;
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    content = REPLIES.notInVoice;
  } else {
    const result = swarm.launch(channel.id, sound);
    if (result.ok) content = REPLIES.launched;
    else if (result.reason === 'busy') content = REPLIES.busy;
    else content = REPLIES.cooldown(result.remainingMs);
  }
  log.info('trigger.command', { command: sound, user: interaction.user.id, channel: channel?.id, reply: content });
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Wires the leader's voice-join and sound-command handlers. Returns a function that removes them. */
export function attachLeaderHandlers(
  leader: Client<true>,
  cfg: Pick<Config, 'guildId' | 'triggerUserIds'>,
  swarm: Pick<Swarm, 'launch'>,
  log: Logger,
): () => void {
  const onVoiceStateUpdate = (oldState: VoiceState, newState: VoiceState) => {
    const t = toTransition(oldState, newState);
    if (!shouldTrigger(t, cfg) || t.newChannelId === null) return;
    log.info('trigger.join', { user: t.userId, channel: t.newChannelId, sound: JOIN_SOUND });
    swarm.launch(t.newChannelId, JOIN_SOUND);
  };
  const onInteractionCreate = (interaction: Interaction) => {
    if (!interaction.isChatInputCommand() || interaction.guildId !== cfg.guildId) return;
    const sound = findSound(interaction.commandName);
    if (!sound) return;
    handleSoundCommand(interaction, sound, swarm, log).catch((err) =>
      log.error('trigger.command_reply_failed', { command: sound, error: toError(err).message }),
    );
  };
  leader.on(Events.VoiceStateUpdate, onVoiceStateUpdate);
  leader.on(Events.InteractionCreate, onInteractionCreate);
  return () => {
    leader.off(Events.VoiceStateUpdate, onVoiceStateUpdate);
    leader.off(Events.InteractionCreate, onInteractionCreate);
  };
}
