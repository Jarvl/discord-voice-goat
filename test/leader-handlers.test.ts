import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ChannelType, Events, MessageFlags, type ChatInputCommandInteraction, type Client, type VoiceState } from 'discord.js';
import type { Acquire } from '../src/gate.js';
import { createLogger } from '../src/log.js';
import { attachLeaderHandlers, handleSoundCommand, toTransition } from '../src/triggers.js';

const GUILD = '111111111111111111';
const OWNER = '222222222222222222';
const GUILD2 = '555555555555555555';
const CFG = { guildIds: new Set([GUILD, GUILD2]), triggerUserIds: new Set([OWNER]) };
const log = createLogger(() => {});

function voiceState(
  channelId: string | null,
  opts: { type?: ChannelType; bot?: boolean; userId?: string; guildId?: string } = {},
): VoiceState {
  return {
    id: opts.userId ?? OWNER,
    guild: { id: opts.guildId ?? GUILD, afkChannelId: 'afk' },
    member: { user: { bot: opts.bot ?? false } },
    channelId,
    channel: channelId === null ? null : { id: channelId, type: opts.type ?? ChannelType.GuildVoice },
  } as unknown as VoiceState;
}

function commandInteraction(
  channel: { id: string; type: ChannelType } | null,
  opts: { commandName?: string; guildId?: string } = {},
) {
  const reply = vi.fn(async () => undefined);
  const voiceStates = new Map(channel ? [[OWNER, { channel: { guildId: opts.guildId ?? GUILD, ...channel } }]] : []);
  const interaction = {
    isChatInputCommand: () => true,
    commandName: opts.commandName ?? 'yoo',
    guildId: opts.guildId ?? GUILD,
    user: { id: OWNER },
    guild: { voiceStates: { cache: voiceStates } },
    reply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply };
}

const swarmReturning = (result: Acquire) => ({ launch: vi.fn((_guildId: string, _channelId: string, _sound: string) => result) });
const VOICE = { id: 'vc1', type: ChannelType.GuildVoice };

describe('toTransition', () => {
  it('maps discord.js voice states to a plain transition', () => {
    expect(toTransition(voiceState(null), voiceState('vc1'))).toEqual({
      guildId: GUILD,
      userId: OWNER,
      isBot: false,
      oldChannelId: null,
      newChannelId: 'vc1',
      newChannelIsVoice: true,
      afkChannelId: 'afk',
    });
  });

  it('marks stage channels as not voice', () => {
    expect(toTransition(voiceState(null), voiceState('stage', { type: ChannelType.GuildStageVoice })).newChannelIsVoice).toBe(false);
  });
});

describe('handleSoundCommand', () => {
  it.each<[string, { id: string; type: ChannelType } | null]>([
    ['the caller is not in voice', null],
    ['the caller is in a stage channel', { id: 'stage', type: ChannelType.GuildStageVoice }],
  ])('asks the caller to join voice when %s', async (_label, channel) => {
    const swarm = swarmReturning({ ok: true });
    const { interaction, reply } = commandInteraction(channel);
    await handleSoundCommand(interaction, 'yoo', swarm, log);
    expect(swarm.launch).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
  });

  it.each<[string, Acquire, string]>([
    ['launched', { ok: true }, '🐝 incoming'],
    ['busy', { ok: false, reason: 'busy' }, 'Swarm already in flight 🐝'],
    ['cooling down', { ok: false, reason: 'cooldown', remainingMs: 12_001 }, 'Swarm is cooling down — try again in 13s.'],
  ])('replies privately when the swarm is %s', async (_label, result, content) => {
    const swarm = swarmReturning(result);
    const { interaction, reply } = commandInteraction(VOICE);
    await handleSoundCommand(interaction, 'briish', swarm, log);
    expect(swarm.launch).toHaveBeenCalledWith(GUILD, 'vc1', 'briish');
    expect(reply).toHaveBeenCalledWith({ content, flags: MessageFlags.Ephemeral });
  });
});

describe('attachLeaderHandlers', () => {
  function setup(cfg = CFG) {
    const leader = new EventEmitter();
    const swarm = swarmReturning({ ok: true });
    const detach = attachLeaderHandlers(leader as unknown as Client<true>, cfg, swarm, log);
    return { leader, swarm, detach };
  }

  it('launches a yoo swarm when the owner joins voice', () => {
    const { leader, swarm } = setup();
    leader.emit(Events.VoiceStateUpdate, voiceState(null), voiceState('vc1'));
    expect(swarm.launch).toHaveBeenCalledWith(GUILD, 'vc1', 'yoo');
  });

  it('launches in whichever configured server the owner joins', () => {
    const { leader, swarm } = setup();
    leader.emit(Events.VoiceStateUpdate, voiceState(null, { guildId: GUILD2 }), voiceState('vc9', { guildId: GUILD2 }));
    expect(swarm.launch).toHaveBeenCalledWith(GUILD2, 'vc9', 'yoo');
  });

  it('ignores a join by someone else', () => {
    const { leader, swarm } = setup();
    leader.emit(Events.VoiceStateUpdate, voiceState(null, { userId: '999999999999999999' }), voiceState('vc1', { userId: '999999999999999999' }));
    expect(swarm.launch).not.toHaveBeenCalled();
  });

  it('ignores every join when no trigger users are configured', () => {
    const { leader, swarm } = setup({ guildIds: new Set([GUILD]), triggerUserIds: new Set() });
    leader.emit(Events.VoiceStateUpdate, voiceState(null), voiceState('vc1'));
    expect(swarm.launch).not.toHaveBeenCalled();
  });

  it.each(['yoo', 'briish'])('routes /%s to its own sound', async (commandName) => {
    const { leader, swarm } = setup();
    const { interaction, reply } = commandInteraction(VOICE, { commandName });
    leader.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(swarm.launch).toHaveBeenCalledWith(GUILD, 'vc1', commandName);
  });

  it('handles commands from every configured server', async () => {
    const { leader, swarm } = setup();
    const { interaction, reply } = commandInteraction(VOICE, { guildId: GUILD2 });
    leader.emit(Events.InteractionCreate, interaction);
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(swarm.launch).toHaveBeenCalledWith(GUILD2, 'vc1', 'yoo');
  });

  it('ignores commands that are not sounds, and commands from other servers', async () => {
    const { leader, swarm } = setup();
    const unknown = commandInteraction(VOICE, { commandName: 'yo' });
    const elsewhere = commandInteraction(VOICE, { guildId: '444444444444444444' });
    leader.emit(Events.InteractionCreate, unknown.interaction);
    leader.emit(Events.InteractionCreate, elsewhere.interaction);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(swarm.launch).not.toHaveBeenCalled();
    expect(unknown.reply).not.toHaveBeenCalled();
    expect(elsewhere.reply).not.toHaveBeenCalled();
  });

  it('stops reacting after detach', () => {
    const { leader, swarm, detach } = setup();
    detach();
    leader.emit(Events.VoiceStateUpdate, voiceState(null), voiceState('vc1'));
    expect(swarm.launch).not.toHaveBeenCalled();
    expect(leader.listenerCount(Events.InteractionCreate)).toBe(0);
  });
});
