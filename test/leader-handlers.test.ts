import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ChannelType, Events, MessageFlags, type ChatInputCommandInteraction, type Client, type VoiceState } from 'discord.js';
import type { Acquire } from '../src/gate.js';
import { createLogger } from '../src/log.js';
import { attachLeaderHandlers, handleYo, toTransition } from '../src/triggers.js';

const GUILD = '111111111111111111';
const OWNER = '222222222222222222';
const CFG = { guildId: GUILD, triggerUserIds: new Set([OWNER]) };
const log = createLogger(() => {});

function voiceState(channelId: string | null, opts: { type?: ChannelType; bot?: boolean; userId?: string } = {}): VoiceState {
  return {
    id: opts.userId ?? OWNER,
    guild: { id: GUILD, afkChannelId: 'afk' },
    member: { user: { bot: opts.bot ?? false } },
    channelId,
    channel: channelId === null ? null : { id: channelId, type: opts.type ?? ChannelType.GuildVoice },
  } as unknown as VoiceState;
}

function yoInteraction(channel: { id: string; type: ChannelType } | null, guildId = GUILD) {
  const reply = vi.fn(async () => undefined);
  const voiceStates = new Map(channel ? [[OWNER, { channel }]] : []);
  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'yo',
    guildId,
    user: { id: OWNER },
    guild: { voiceStates: { cache: voiceStates } },
    reply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply };
}

const swarmReturning = (result: Acquire) => ({ launch: vi.fn((_channelId: string) => result) });

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

describe('handleYo', () => {
  it.each<[string, { id: string; type: ChannelType } | null]>([
    ['the caller is not in voice', null],
    ['the caller is in a stage channel', { id: 'stage', type: ChannelType.GuildStageVoice }],
  ])('asks the caller to join voice when %s', async (_label, channel) => {
    const swarm = swarmReturning({ ok: true });
    const { interaction, reply } = yoInteraction(channel);
    await handleYo(interaction, swarm, log);
    expect(swarm.launch).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
  });

  it.each<[string, Acquire, string]>([
    ['launched', { ok: true }, '🐝 incoming'],
    ['busy', { ok: false, reason: 'busy' }, 'Swarm already in flight 🐝'],
    ['cooling down', { ok: false, reason: 'cooldown', remainingMs: 12_001 }, 'Swarm is cooling down — try again in 13s.'],
  ])('replies privately when the swarm is %s', async (_label, result, content) => {
    const swarm = swarmReturning(result);
    const { interaction, reply } = yoInteraction({ id: 'vc1', type: ChannelType.GuildVoice });
    await handleYo(interaction, swarm, log);
    expect(swarm.launch).toHaveBeenCalledWith('vc1');
    expect(reply).toHaveBeenCalledWith({ content, flags: MessageFlags.Ephemeral });
  });
});

describe('attachLeaderHandlers', () => {
  function setup() {
    const leader = new EventEmitter();
    const swarm = swarmReturning({ ok: true });
    const detach = attachLeaderHandlers(leader as unknown as Client<true>, CFG, swarm, log);
    return { leader, swarm, detach };
  }

  it('launches the swarm when the owner joins voice', () => {
    const { leader, swarm } = setup();
    leader.emit(Events.VoiceStateUpdate, voiceState(null), voiceState('vc1'));
    expect(swarm.launch).toHaveBeenCalledWith('vc1');
  });

  it('ignores a join by someone else', () => {
    const { leader, swarm } = setup();
    leader.emit(Events.VoiceStateUpdate, voiceState(null, { userId: '999999999999999999' }), voiceState('vc1', { userId: '999999999999999999' }));
    expect(swarm.launch).not.toHaveBeenCalled();
  });

  it('handles /yo from the configured server and ignores other servers', async () => {
    const { leader, swarm } = setup();
    const here = yoInteraction({ id: 'vc1', type: ChannelType.GuildVoice });
    const elsewhere = yoInteraction({ id: 'vc9', type: ChannelType.GuildVoice }, '444444444444444444');
    leader.emit(Events.InteractionCreate, here.interaction);
    leader.emit(Events.InteractionCreate, elsewhere.interaction);
    await vi.waitFor(() => expect(here.reply).toHaveBeenCalled());
    expect(swarm.launch).toHaveBeenCalledTimes(1);
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
