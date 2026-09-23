import { describe, expect, it } from 'vitest';
import { buildSchedule } from '../src/schedule.js';

/** Small deterministic PRNG so the tests are repeatable. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ITEMS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

describe('buildSchedule', () => {
  it('includes every item exactly once', () => {
    const slots = buildSchedule(ITEMS, 1000, 2000, mulberry32(1));
    expect(slots.map((s) => s.item).sort()).toEqual(ITEMS);
  });

  it('keeps the first join delay and every gap within [min, max], and never goes backwards', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const slots = buildSchedule(ITEMS, 1000, 2000, mulberry32(seed));
      let previous = 0;
      for (const { joinDelayMs } of slots) {
        const gap = joinDelayMs - previous;
        expect(gap).toBeGreaterThanOrEqual(1000);
        expect(gap).toBeLessThanOrEqual(2000);
        expect(Number.isInteger(joinDelayMs)).toBe(true);
        previous = joinDelayMs;
      }
    }
  });

  it('spaces joins exactly when min equals max', () => {
    const slots = buildSchedule(['a', 'b', 'c', 'd'], 1500, 1500, mulberry32(7));
    expect(slots.map((s) => s.joinDelayMs)).toEqual([1500, 3000, 4500, 6000]);
  });

  it('shuffles the order', () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) {
      orders.add(buildSchedule(ITEMS, 1000, 2000, mulberry32(seed)).map((s) => s.item).join(''));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('handles a single item and an empty list', () => {
    expect(buildSchedule(['solo'], 1000, 2000, () => 0)).toEqual([{ item: 'solo', joinDelayMs: 1000 }]);
    expect(buildSchedule([], 1000, 2000, () => 0)).toEqual([]);
  });
});
