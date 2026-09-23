import type { Logger } from './log.js';

/** Caps restarts at 288 a day, well under Discord's 1000 logins per bot per day. */
export const FATAL_EXIT_DELAY_MS = 5 * 60_000;

export interface FatalExitDeps {
  log: Logger;
  delayMs: number;
  exit: (code: number) => void;
  onSignal: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void;
}

/**
 * Logs a fatal startup error and exits only after a delay. Dokploy restarts the container on exit, and every
 * restart logs each bot in again, so exiting at once would use up Discord's daily login limit within hours
 * and keep the bots offline for up to a day. A stop or redeploy (SIGTERM/SIGINT) still exits immediately.
 */
export function exitAfterDelay(error: Error, deps: FatalExitDeps): void {
  deps.log.error('startup_failed', { error: error.message, exitInSeconds: Math.round(deps.delayMs / 1000) });
  const timer = setTimeout(() => deps.exit(1), deps.delayMs);
  const exitNow = () => {
    clearTimeout(timer);
    deps.exit(1);
  };
  deps.onSignal('SIGTERM', exitNow);
  deps.onSignal('SIGINT', exitNow);
}
