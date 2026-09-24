import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwarmGate } from '../src/gate.js';
import { createLogger } from '../src/log.js';
import { createSwarm, type SwarmDeps } from '../src/swarm.js';
import type { PlayResult } from '../src/types.js';

type FakeBot = { name: string };
const BOTS: FakeBot[] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];

/** Let queued promise callbacks run (fake timers do not advance microtasks on their own). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup(overrides: Partial<SwarmDeps<FakeBot>> = {}) {
  const lines: string[] = [];
  const calls: { bot: string; at: number }[] = [];
  const play = vi.fn(async (bot: FakeBot, _channelId: string, _sound: string): Promise<PlayResult> => {
    calls.push({ bot: bot.name, at: Date.now() });
    return { status: 'played' };
  });
  const swarm = createSwarm<FakeBot>({
    botsIn: () => BOTS,
    createGate: () => new SwarmGate(30_000),
    play,
    channelHasHumans: () => true,
    rng: () => 0, // every gap is exactly staggerMinMs
    staggerMinMs: 1000,
    staggerMaxMs: 2000,
    log: createLogger((line) => lines.push(line)),
    ...overrides,
  });
  return { swarm, play, calls, lines };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createSwarm', () => {
  it('starts each bot at its scheduled join delay', async () => {
    const { swarm, calls } = setup();
    expect(swarm.launch('g1', 'vc1', 'yoo')).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.map((c) => c.at)).toEqual([1000, 2000, 3000]);
    expect(calls.map((c) => c.bot).sort()).toEqual(['a', 'b', 'c']);
  });

  it('passes the channel and the sound to every play call', async () => {
    const { swarm, play } = setup();
    swarm.launch('g1', 'vc1', 'briish');
    await vi.advanceTimersByTimeAsync(3000);
    expect(play.mock.calls.map(([, channelId, sound]) => [channelId, sound])).toEqual([
      ['vc1', 'briish'],
      ['vc1', 'briish'],
      ['vc1', 'briish'],
    ]);
  });

  it('refuses a second launch while one is running', async () => {
    const { swarm, play } = setup();
    swarm.launch('g1', 'vc1', 'yoo');
    expect(swarm.launch('g1', 'vc2', 'yoo')).toEqual({ ok: false, reason: 'busy' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(play).toHaveBeenCalledTimes(3);
  });

  it('stays busy until the last bot settles, then starts the cooldown', async () => {
    let finishLast!: () => void;
    const { swarm } = setup({
      play: (bot) =>
        new Promise<PlayResult>((resolve) => {
          if (bot.name === 'a') finishLast = () => resolve({ status: 'played' });
          else resolve({ status: 'played' });
        }),
    });
    swarm.launch('g1', 'vc1', 'yoo');
    await vi.advanceTimersByTimeAsync(3000);
    expect(swarm.launch('g1', 'vc1', 'yoo')).toEqual({ ok: false, reason: 'busy' });
    finishLast();
    await flush();
    expect(swarm.launch('g1', 'vc1', 'yoo')).toEqual({ ok: false, reason: 'cooldown', remainingMs: 30_000 });
  });

  it('releases the gate even when bots fail or throw', async () => {
    let n = 0;
    const { swarm, lines } = setup({
      play: async () => {
        n++;
        if (n === 1) return { status: 'failed', error: new Error('boom') };
        if (n === 2) throw new Error('kaboom');
        return { status: 'played' };
      },
    });
    swarm.launch('g1', 'vc1', 'yoo');
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(swarm.launch('g1', 'vc1', 'yoo')).toMatchObject({ ok: false, reason: 'cooldown' });
    expect(lines.filter((l) => l.includes('bot.failed'))).toHaveLength(2);
  });

  it('skips bots whose turn comes after everyone has left the channel', async () => {
    let humans = true;
    const { swarm, play, lines } = setup({ channelHasHumans: () => humans });
    swarm.launch('g1', 'vc1', 'yoo');
    await vi.advanceTimersByTimeAsync(1000);
    humans = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(play).toHaveBeenCalledTimes(1);
    expect(lines.filter((l) => l.includes('channel has no humans'))).toHaveLength(2);
  });

  it('cancelAll stops pending bots and still releases the gate', async () => {
    const { swarm, play } = setup();
    swarm.launch('g1', 'vc1', 'yoo');
    await vi.advanceTimersByTimeAsync(1000);
    swarm.cancelAll();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(play).toHaveBeenCalledTimes(1);
    expect(swarm.launch('g1', 'vc1', 'yoo')).toMatchObject({ ok: false, reason: 'cooldown' });
  });

  it('keeps a separate busy flag and cooldown for each server', async () => {
    const { swarm, play } = setup();
    swarm.launch('g1', 'vc1', 'yoo');
    expect(swarm.launch('g2', 'vc9', 'yoo')).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(play).toHaveBeenCalledTimes(6);
    expect(swarm.launch('g1', 'vc1', 'yoo')).toMatchObject({ ok: false, reason: 'cooldown' });
    expect(swarm.launch('g3', 'vc5', 'yoo')).toEqual({ ok: true });
  });

  it('sends only the bots that are in the server, and checks that server for humans', async () => {
    const channelHasHumans = vi.fn((_guildId: string, _channelId: string) => true);
    const { swarm, calls } = setup({
      botsIn: (guildId) => (guildId === 'g2' ? [BOTS[0]!] : BOTS),
      channelHasHumans,
    });
    swarm.launch('g2', 'vc9', 'yoo');
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.map((c) => c.bot)).toEqual(['a']);
    expect(channelHasHumans).toHaveBeenCalledWith('g2', 'vc9');
  });

  it('logs a refusal with the remaining cooldown', async () => {
    const { swarm, lines } = setup();
    swarm.launch('g1', 'vc1', 'yoo');
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    vi.setSystemTime(5000);
    expect(swarm.launch('g1', 'vc1', 'yoo')).toEqual({ ok: false, reason: 'cooldown', remainingMs: 28_000 });
    expect(lines.at(-1)).toMatch(/swarm\.refused server=g1 channel=vc1 sound=yoo reason=cooldown remainingMs=28000$/);
  });
});
