import type { Config } from './config.js';

export interface VoiceTransition {
  guildId: string;
  userId: string;
  isBot: boolean;
  oldChannelId: string | null;
  newChannelId: string | null;
  /** True only for regular voice channels (not stage channels). */
  newChannelIsVoice: boolean;
  afkChannelId: string | null;
}

/** True only when a trigger user moves from no voice channel into a regular, non-AFK voice channel. */
export function shouldTrigger(t: VoiceTransition, cfg: Pick<Config, 'guildId' | 'triggerUserIds'>): boolean {
  return (
    t.guildId === cfg.guildId &&
    cfg.triggerUserIds.has(t.userId) &&
    !t.isBot &&
    t.oldChannelId === null &&
    t.newChannelId !== null &&
    t.newChannelIsVoice &&
    t.newChannelId !== t.afkChannelId
  );
}

export interface Occupant {
  userId: string;
  channelId: string | null;
  /** undefined when the member is not cached; treated as human. */
  isBot: boolean | undefined;
}

/** True if anyone other than our own bots, and other than known bots, is in the channel. */
export function hasHumans(occupants: Iterable<Occupant>, channelId: string, fleetIds: ReadonlySet<string>): boolean {
  for (const o of occupants) {
    if (o.channelId === channelId && !fleetIds.has(o.userId) && o.isBot !== true) return true;
  }
  return false;
}
