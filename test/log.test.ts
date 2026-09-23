import { describe, expect, it } from 'vitest';
import { createLogger, formatLine } from '../src/log.js';

const NOW = new Date('2026-09-23T12:00:00.000Z');

describe('formatLine', () => {
  it('writes time, level, event, then key=value pairs', () => {
    expect(formatLine('info', 'swarm.launch', { channel: '123', bots: 3 }, NOW)).toBe(
      '2026-09-23T12:00:00.000Z info swarm.launch channel=123 bots=3',
    );
  });

  it('quotes values containing spaces, quotes or equals signs, and empty values', () => {
    expect(formatLine('warn', 'e', { reason: 'channel is full', q: 'a"b', eq: 'a=b', empty: '' }, NOW)).toBe(
      '2026-09-23T12:00:00.000Z warn e reason="channel is full" q="a\\"b" eq="a=b" empty=""',
    );
  });

  it('skips undefined values', () => {
    expect(formatLine('info', 'e', { a: undefined, b: false }, NOW)).toBe('2026-09-23T12:00:00.000Z info e b=false');
  });
});

describe('createLogger', () => {
  it('writes one formatted line per call at the right level', () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line), () => NOW);
    log.info('a');
    log.warn('b', { x: 1 });
    log.error('c');
    expect(lines).toEqual([
      '2026-09-23T12:00:00.000Z info a',
      '2026-09-23T12:00:00.000Z warn b x=1',
      '2026-09-23T12:00:00.000Z error c',
    ]);
  });
});
