import { describe, expect, it } from 'vitest';
import { SwarmGate } from '../src/gate.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('SwarmGate', () => {
  it('allows the first swarm', () => {
    expect(new SwarmGate(30_000, clock().now).tryAcquire()).toEqual({ ok: true });
  });

  it('reports busy while a swarm is running', () => {
    const gate = new SwarmGate(30_000, clock().now);
    gate.tryAcquire();
    expect(gate.tryAcquire()).toEqual({ ok: false, reason: 'busy' });
  });

  it('reports the remaining cooldown after release, then allows again once it has elapsed', () => {
    const c = clock(1_000);
    const gate = new SwarmGate(30_000, c.now);
    gate.tryAcquire();
    gate.release();
    expect(gate.tryAcquire()).toEqual({ ok: false, reason: 'cooldown', remainingMs: 30_000 });
    c.advance(10_000);
    expect(gate.tryAcquire()).toEqual({ ok: false, reason: 'cooldown', remainingMs: 20_000 });
    c.advance(20_000);
    expect(gate.tryAcquire()).toEqual({ ok: true });
  });

  it('allows again immediately when the cooldown is 0', () => {
    const gate = new SwarmGate(0, clock().now);
    gate.tryAcquire();
    gate.release();
    expect(gate.tryAcquire()).toEqual({ ok: true });
  });

  it('ignores release when nothing is running', () => {
    const gate = new SwarmGate(30_000, clock().now);
    gate.release();
    expect(gate.tryAcquire()).toEqual({ ok: true });
  });
});
