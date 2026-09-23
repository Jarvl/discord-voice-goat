export interface Slot<T> {
  item: T;
  /** Milliseconds after launch at which this item starts joining. */
  joinDelayMs: number;
}

/**
 * Shuffles `items` (Fisher-Yates) and gives each a cumulative join delay:
 * every gap, including the first, is a whole number of ms drawn from [minMs, maxMs].
 */
export function buildSchedule<T>(items: readonly T[], minMs: number, maxMs: number, rng: () => number): Slot<T>[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  let at = 0;
  return shuffled.map((item) => {
    at += Math.round(minMs + rng() * (maxMs - minMs));
    return { item, joinDelayMs: at };
  });
}
