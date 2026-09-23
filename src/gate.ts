export type Acquire =
  | { ok: true }
  | { ok: false; reason: 'busy' }
  | { ok: false; reason: 'cooldown'; remainingMs: number };

/** Allows one swarm at a time, then enforces a cooldown after each one. */
export class SwarmGate {
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private running = false;
  private cooldownUntil = 0;

  constructor(cooldownMs: number, now: () => number = Date.now) {
    this.cooldownMs = cooldownMs;
    this.now = now;
  }

  tryAcquire(): Acquire {
    if (this.running) return { ok: false, reason: 'busy' };
    const remainingMs = this.cooldownUntil - this.now();
    if (remainingMs > 0) return { ok: false, reason: 'cooldown', remainingMs };
    this.running = true;
    return { ok: true };
  }

  /** Ends the running swarm and starts the cooldown. Does nothing if no swarm is running. */
  release(): void {
    if (!this.running) return;
    this.running = false;
    this.cooldownUntil = this.now() + this.cooldownMs;
  }
}
