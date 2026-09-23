import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseTokens } from '../src/config.js';

const GUILD = '111111111111111111';
const USER = '222222222222222222';
const USER2 = '333333333333333333';
const valid = { BOT_TOKENS: 'tokA,tokB', GUILD_ID: GUILD, TRIGGER_USER_IDS: USER };

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
      guildId: GUILD,
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

  it('accepts a quoted GUILD_ID', () => {
    expect(loadConfig({ ...valid, GUILD_ID: `"${GUILD}"` }).guildId).toBe(GUILD);
  });

  it('reports every missing required variable at once', () => {
    const problems = problemsOf({});
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/BOT_TOKENS/);
    expect(problems[1]).toMatch(/GUILD_ID/);
    expect(problems[2]).toMatch(/TRIGGER_USER_IDS/);
  });

  it.each([
    ['GUILD_ID', 'abc'],
    ['GUILD_ID', '123'],
    ['TRIGGER_USER_IDS', 'nope'],
  ])('rejects malformed %s=%s', (name, value) => {
    expect(problemsOf({ ...valid, [name]: value })).toEqual([expect.stringContaining(name)]);
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
    expect(() => loadConfig({ ...valid, GUILD_ID: 'x', COOLDOWN_MS: 'y' })).toThrow(
      /Invalid configuration:\n {2}- GUILD_ID.*\n {2}- COOLDOWN_MS/,
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
