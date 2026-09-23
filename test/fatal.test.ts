import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exitAfterDelay, FATAL_EXIT_DELAY_MS } from '../src/fatal.js';
import { createLogger } from '../src/log.js';

function setup() {
  const lines: string[] = [];
  const exit = vi.fn((_code: number) => {});
  const handlers = new Map<string, () => void>();
  exitAfterDelay(new Error('leader (bot1) failed to log in: An invalid token was provided.'), {
    log: createLogger((line) => lines.push(line)),
    delayMs: FATAL_EXIT_DELAY_MS,
    exit,
    onSignal: (signal, handler) => void handlers.set(signal, handler),
  });
  return { lines, exit, handlers };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('exitAfterDelay', () => {
  it('waits five minutes by default, so restarts cannot exhaust Discord’s daily login limit', () => {
    expect(FATAL_EXIT_DELAY_MS).toBe(5 * 60_000);
  });

  it('logs the error and when it will exit', () => {
    const { lines } = setup();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /error startup_failed error="leader \(bot1\) failed to log in: An invalid token was provided\." exitInSeconds=300$/,
    );
  });

  it('exits with code 1 only after the delay', () => {
    const { exit } = setup();
    vi.advanceTimersByTime(FATAL_EXIT_DELAY_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(['SIGTERM', 'SIGINT'])('exits at once on %s (a redeploy or stop) and not again later', (signal) => {
    const { exit, handlers } = setup();
    handlers.get(signal)?.();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    vi.advanceTimersByTime(FATAL_EXIT_DELAY_MS);
    expect(exit).toHaveBeenCalledOnce();
  });
});
