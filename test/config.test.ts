import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseTokens } from '../src/config.js';

const GUILD = '111111111111111111';
const USER = '222222222222222222';
const USER2 = '333333333333333333';
const GUILD2 = '444444444444444444';
const valid = { BOT_TOKENS: 'tokA,tokB', GUILD_IDS: GUILD, TRIGGER_USER_IDS: USER };

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('expected loadConfig to throw ConfigError');
}

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    expect(loadConfig(valid)).toEqual({
      botTokens: ['tokA', 'tokB'],
      guildIds: new Set([GUILD]),
      triggerUserIds: new Set([USER]),
      staggerMinMs: 1000,
      staggerMaxMs: 2000,
      cooldownMs: 30_000,
    });
  });

  it('reads the optional numbers, including a zero cooldown', () => {
    const cfg = loadConfig({ ...valid, STAGGER_MIN_MS: '500', STAGGER_MAX_MS: '750', COOLDOWN_MS: '0' });
    expect([cfg.staggerMinMs, cfg.staggerMaxMs, cfg.cooldownMs]).toEqual([500, 750, 0]);
  });

  it('treats blank optional numbers as defaults (a cleared field in the Dokploy UI)', () => {
    const cfg = loadConfig({ ...valid, STAGGER_MIN_MS: '', STAGGER_MAX_MS: '   ', COOLDOWN_MS: '' });
    expect([cfg.staggerMinMs, cfg.staggerMaxMs, cfg.cooldownMs]).toEqual([1000, 2000, 30_000]);
  });

  it('parses several trigger user IDs with spaces, quotes and a trailing comma', () => {
    const cfg = loadConfig({ ...valid, TRIGGER_USER_IDS: `"${USER}, ${USER2},"` });
    expect(cfg.triggerUserIds).toEqual(new Set([USER, USER2]));
  });

  it('parses several server IDs with spaces, quotes and a trailing comma', () => {
    expect(loadConfig({ ...valid, GUILD_IDS: `"${GUILD}, ${GUILD2},"` }).guildIds).toEqual(new Set([GUILD, GUILD2]));
  });

  it('still accepts the older GUILD_ID, alone or alongside GUILD_IDS', () => {
    expect(loadConfig({ ...valid, GUILD_IDS: undefined, GUILD_ID: `"${GUILD}"` }).guildIds).toEqual(new Set([GUILD]));
    expect(loadConfig({ ...valid, GUILD_ID: `${GUILD2},${GUILD}` }).guildIds).toEqual(new Set([GUILD, GUILD2]));
  });

  it('reports every missing required variable at once', () => {
    const problems = problemsOf({});
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/BOT_TOKENS/);
    expect(problems[1]).toMatch(/GUILD_IDS/);
  });

  it.each([undefined, '', '  '])('treats TRIGGER_USER_IDS=%j as no join trigger', (value) => {
    expect(loadConfig({ ...valid, TRIGGER_USER_IDS: value }).triggerUserIds).toEqual(new Set());
  });

  it.each([
    ['GUILD_IDS', 'abc', 'GUILD_IDS'],
    ['GUILD_IDS', `${GUILD},123`, 'GUILD_IDS'],
    ['GUILD_ID', '123', 'GUILD_IDS'],
    ['TRIGGER_USER_IDS', 'nope', 'TRIGGER_USER_IDS'],
  ])('rejects malformed %s=%s', (name, value, reported) => {
    expect(problemsOf({ ...valid, [name]: value })).toEqual([expect.stringContaining(reported)]);
  });

  it.each(['-1', '1.5', '1s', '1,000', 'abc'])('rejects STAGGER_MIN_MS=%s', (value) => {
    expect(problemsOf({ ...valid, STAGGER_MIN_MS: value })).toEqual([expect.stringContaining('STAGGER_MIN_MS')]);
  });

  it('rejects a minimum stagger above the maximum', () => {
    expect(problemsOf({ ...valid, STAGGER_MIN_MS: '3000', STAGGER_MAX_MS: '2000' })).toEqual([
      'STAGGER_MIN_MS (3000) must not be greater than STAGGER_MAX_MS (2000)',
    ]);
  });

  it('does not add a min>max problem when a stagger value is malformed', () => {
    expect(problemsOf({ ...valid, STAGGER_MIN_MS: 'abc', STAGGER_MAX_MS: '500' })).toHaveLength(1);
  });

  it('lists each problem in the error message', () => {
    expect(() => loadConfig({ ...valid, GUILD_IDS: 'x', COOLDOWN_MS: 'y' })).toThrow(
      /Invalid configuration:\n {2}- GUILD_IDS.*\n {2}- COOLDOWN_MS/,
    );
  });
});

describe('parseTokens', () => {
  it('trims, drops empty entries and removes duplicates', () => {
    expect(parseTokens(' a , ,b,a ')).toEqual(['a', 'b']);
  });

  it('returns an empty list for undefined', () => {
    expect(parseTokens(undefined)).toEqual([]);
  });

  it('strips surrounding quotes and a "Bot " prefix', () => {
    expect(parseTokens(`"Bot a, 'b'"`)).toEqual(['a', 'b']);
  });
});
