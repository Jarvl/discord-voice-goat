import { describe, expect, it } from 'vitest';
import { hasHumans, shouldTrigger, type VoiceTransition } from '../src/triggers.js';

const GUILD = '111111111111111111';
const OWNER = '222222222222222222';
const CFG = { guildId: GUILD, triggerUserIds: new Set([OWNER]) };

const join: VoiceTransition = {
  guildId: GUILD,
  userId: OWNER,
  isBot: false,
  oldChannelId: null,
  newChannelId: 'vc1',
  newChannelIsVoice: true,
  afkChannelId: 'afk',
};

describe('shouldTrigger', () => {
  it('triggers when a trigger user joins voice from nowhere', () => {
    expect(shouldTrigger(join, CFG)).toBe(true);
  });

  it.each<[string, Partial<VoiceTransition>]>([
    ['switching channels', { oldChannelId: 'vc0' }],
    ['mute/deafen/stream toggles in the same channel', { oldChannelId: 'vc1' }],
    ['leaving voice', { oldChannelId: 'vc1', newChannelId: null }],
    ['a user who is not a trigger user', { userId: '999999999999999999' }],
    ['a bot', { isBot: true }],
    ['a different server', { guildId: '444444444444444444' }],
    ['joining the AFK channel', { newChannelId: 'afk' }],
    ['joining a stage channel', { newChannelIsVoice: false }],
  ])('does not trigger for %s', (_label, change) => {
    expect(shouldTrigger({ ...join, ...change }, CFG)).toBe(false);
  });
});

describe('hasHumans', () => {
  const FLEET = new Set(['bot1', 'bot2']);

  it('is true when a non-bot user is in the channel', () => {
    expect(hasHumans([{ userId: OWNER, channelId: 'vc1', isBot: false }], 'vc1', FLEET)).toBe(true);
  });

  it('counts a user whose member is not cached as human', () => {
    expect(hasHumans([{ userId: OWNER, channelId: 'vc1', isBot: undefined }], 'vc1', FLEET)).toBe(true);
  });

  it('ignores our own bots even if their member is not cached', () => {
    expect(hasHumans([{ userId: 'bot1', channelId: 'vc1', isBot: undefined }], 'vc1', FLEET)).toBe(false);
  });

  it('ignores other bots such as music bots', () => {
    expect(hasHumans([{ userId: 'music', channelId: 'vc1', isBot: true }], 'vc1', FLEET)).toBe(false);
  });

  it('ignores people in other channels', () => {
    expect(hasHumans([{ userId: OWNER, channelId: 'vc2', isBot: false }], 'vc1', FLEET)).toBe(false);
  });
});
