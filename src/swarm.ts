import { toError } from './errors.js';
import type { Acquire, SwarmGate } from './gate.js';
import type { Logger } from './log.js';
import { buildSchedule } from './schedule.js';
import type { PlayResult } from './types.js';

export interface SwarmDeps<B extends { name: string }> {
  bots: readonly B[];
  gate: SwarmGate;
  /** Joins the channel, plays the clip, leaves. Expected never to throw, but a throw is contained. */
  play: (bot: B, channelId: string) => Promise<PlayResult>;
  channelHasHumans: (channelId: string) => boolean;
  rng: () => number;
  staggerMinMs: number;
  staggerMaxMs: number;
  log: Logger;
}

export interface Swarm {
  /** Returns immediately; the swarm runs in the background. */
  launch(channelId: string): Acquire;
  /** Clears every pending join timer (used on shutdown). */
  cancelAll(): void;
}

export function createSwarm<B extends { name: string }>(deps: SwarmDeps<B>): Swarm {
  const pending = new Set<() => void>();

  function logResult(bot: B, result: PlayResult): void {
    if (result.status === 'played') deps.log.info('bot.played', { bot: bot.name });
    else if (result.status === 'skipped') deps.log.warn('bot.skipped', { bot: bot.name, reason: result.reason });
    else deps.log.error('bot.failed', { bot: bot.name, error: result.error.message });
  }

  function runBot(bot: B, channelId: string, joinDelayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const cancel = () => {
        clearTimeout(timer);
        pending.delete(cancel);
        resolve();
      };
      const timer = setTimeout(async () => {
        pending.delete(cancel);
        try {
          if (!deps.channelHasHumans(channelId)) {
            deps.log.info('bot.skipped', { bot: bot.name, reason: 'channel has no humans' });
            return;
          }
          logResult(bot, await deps.play(bot, channelId));
        } catch (err) {
          deps.log.error('bot.failed', { bot: bot.name, error: toError(err).message });
        } finally {
          resolve();
        }
      }, joinDelayMs);
      pending.add(cancel);
    });
  }

  return {
    launch(channelId) {
      const acquired = deps.gate.tryAcquire();
      if (!acquired.ok) {
        deps.log.info('swarm.refused', {
          channel: channelId,
          reason: acquired.reason,
          remainingMs: acquired.reason === 'cooldown' ? acquired.remainingMs : undefined,
        });
        return acquired;
      }
      const slots = buildSchedule(deps.bots, deps.staggerMinMs, deps.staggerMaxMs, deps.rng);
      deps.log.info('swarm.launch', { channel: channelId, bots: slots.length });
      void Promise.allSettled(slots.map((slot) => runBot(slot.item, channelId, slot.joinDelayMs))).finally(() => {
        deps.gate.release();
        deps.log.info('swarm.done', { channel: channelId });
      });
      return acquired;
    },
    cancelAll() {
      for (const cancel of [...pending]) cancel();
    },
  };
}
