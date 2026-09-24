import { toError } from './errors.js';
import type { Acquire, SwarmGate } from './gate.js';
import type { Logger } from './log.js';
import { buildSchedule } from './schedule.js';
import type { SoundName } from './sounds.js';
import type { PlayResult } from './types.js';

export interface SwarmDeps<B extends { name: string }> {
  /** The bots that are in the server right now. */
  botsIn: (guildId: string) => readonly B[];
  /** Called once per server; each server has its own busy flag and cooldown. */
  createGate: () => SwarmGate;
  /** Joins the channel, plays the clip, leaves. Expected never to throw, but a throw is contained. */
  play: (bot: B, channelId: string, sound: SoundName) => Promise<PlayResult>;
  channelHasHumans: (guildId: string, channelId: string) => boolean;
  rng: () => number;
  staggerMinMs: number;
  staggerMaxMs: number;
  log: Logger;
}

export interface Swarm {
  /** Returns immediately; the swarm runs in the background. */
  launch(guildId: string, channelId: string, sound: SoundName): Acquire;
  /** Clears every pending join timer (used on shutdown). */
  cancelAll(): void;
}

export function createSwarm<B extends { name: string }>(deps: SwarmDeps<B>): Swarm {
  const pending = new Set<() => void>();
  const gates = new Map<string, SwarmGate>();

  function gateFor(guildId: string): SwarmGate {
    let gate = gates.get(guildId);
    if (!gate) {
      gate = deps.createGate();
      gates.set(guildId, gate);
    }
    return gate;
  }

  function logResult(bot: B, result: PlayResult): void {
    if (result.status === 'played') deps.log.info('bot.played', { bot: bot.name });
    else if (result.status === 'skipped') deps.log.warn('bot.skipped', { bot: bot.name, reason: result.reason });
    else deps.log.error('bot.failed', { bot: bot.name, error: result.error.message });
  }

  function runBot(bot: B, guildId: string, channelId: string, sound: SoundName, joinDelayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const cancel = () => {
        clearTimeout(timer);
        pending.delete(cancel);
        resolve();
      };
      const timer = setTimeout(async () => {
        pending.delete(cancel);
        try {
          if (!deps.channelHasHumans(guildId, channelId)) {
            deps.log.info('bot.skipped', { bot: bot.name, reason: 'channel has no humans' });
            return;
          }
          logResult(bot, await deps.play(bot, channelId, sound));
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
    launch(guildId, channelId, sound) {
      const gate = gateFor(guildId);
      const acquired = gate.tryAcquire();
      if (!acquired.ok) {
        deps.log.info('swarm.refused', {
          server: guildId,
          channel: channelId,
          sound,
          reason: acquired.reason,
          remainingMs: acquired.reason === 'cooldown' ? acquired.remainingMs : undefined,
        });
        return acquired;
      }
      const slots = buildSchedule(deps.botsIn(guildId), deps.staggerMinMs, deps.staggerMaxMs, deps.rng);
      deps.log.info('swarm.launch', { server: guildId, channel: channelId, sound, bots: slots.length });
      void Promise.allSettled(slots.map((slot) => runBot(slot.item, guildId, channelId, sound, slot.joinDelayMs))).finally(() => {
        gate.release();
        deps.log.info('swarm.done', { server: guildId, channel: channelId, sound });
      });
      return acquired;
    },
    cancelAll() {
      for (const cancel of [...pending]) cancel();
    },
  };
}
