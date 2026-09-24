import { once } from 'node:events';
import { Client, Events, GatewayIntentBits, Options } from 'discord.js';
import { toError } from './errors.js';
import type { Logger } from './log.js';
import type { Bot } from './types.js';

export interface LoginAttempt {
  label: string;
  client?: Client<true>;
  error?: Error;
}

export interface FleetGap {
  label: string;
  guildId: string;
}

export type FleetSelection =
  | { fatal: string }
  | {
      bots: Bot[];
      /** Configured servers the leader is in; only these are served. */
      guildIds: string[];
      /** Configured servers the leader is not in. */
      skippedGuildIds: string[];
      dropped: { label: string; reason: string }[];
      /** Kept followers that are missing from some served servers; they sit out swarms there. */
      gaps: FleetGap[];
    };

const INVITE_HINT = 'run `npm run invite-links` and add it to the server';

/**
 * Decides which logged-in clients make up the fleet. attempts[0] is the leader. Only servers the leader is
 * in are served; a follower is kept if it is in at least one of them.
 */
export function selectFleet(attempts: readonly LoginAttempt[], guildIds: Iterable<string>): FleetSelection {
  const [leader, ...followers] = attempts;
  if (!leader) return { fatal: 'no bot tokens were provided' };
  if (!leader.client) return { fatal: `leader (${leader.label}) failed to log in: ${leader.error?.message ?? 'unknown error'}` };
  const leaderClient = leader.client;
  const configured = [...guildIds];
  const served = configured.filter((id) => leaderClient.guilds.cache.has(id));
  const skippedGuildIds = configured.filter((id) => !leaderClient.guilds.cache.has(id));
  if (served.length === 0) {
    return { fatal: `leader (${leaderClient.user.username}) is not in any configured server (${configured.join(', ')}); ${INVITE_HINT}` };
  }

  const bots: Bot[] = [{ name: leaderClient.user.username, client: leaderClient }];
  const dropped: { label: string; reason: string }[] = [];
  const gaps: FleetGap[] = [];
  for (const attempt of followers) {
    if (!attempt.client) {
      dropped.push({ label: attempt.label, reason: `failed to log in: ${attempt.error?.message ?? 'unknown error'}` });
      continue;
    }
    const { client } = attempt;
    const missing = served.filter((id) => !client.guilds.cache.has(id));
    if (missing.length === served.length) {
      const where = served.length === 1 ? `server ${served[0]}` : `any served server (${served.join(', ')})`;
      dropped.push({ label: client.user.username, reason: `not in ${where}; ${INVITE_HINT}` });
      continue;
    }
    bots.push({ name: client.user.username, client });
    for (const guildId of missing) gaps.push({ label: client.user.username, guildId });
  }
  return { bots, guildIds: served, skippedGuildIds, dropped, gaps };
}

function createBotClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      PresenceManager: 0,
      ReactionManager: 0,
    }),
  });
}

export async function loginOne(
  token: string,
  readyTimeoutMs: number,
  createClient: () => Client = createBotClient,
): Promise<Client<true>> {
  const client = createClient();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`not ready within ${readyTimeoutMs}ms`)), readyTimeoutMs);
  const ready = once(client, Events.ClientReady, { signal: abort.signal });
  ready.catch(() => {}); // awaited below; this stops an early login failure leaving an unhandled rejection
  try {
    await client.login(token);
    await ready;
    if (!client.isReady()) throw new Error('client not ready after ClientReady');
    return client;
  } catch (err) {
    await client.destroy();
    // once() reports our timeout as a bare "The operation was aborted"; throw the reason we gave instead.
    throw abort.signal.aborted ? (abort.signal.reason as Error) : err;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

export interface Fleet {
  /** Leader first. */
  bots: Bot[];
  /** Configured servers the leader is in. */
  guildIds: string[];
}

/** Logs in every token concurrently. Throws if the leader cannot be used; drops unusable followers. */
export async function startFleet(
  tokens: readonly string[],
  guildIds: Iterable<string>,
  log: Logger,
  readyTimeoutMs = 30_000,
): Promise<Fleet> {
  const settled = await Promise.allSettled(tokens.map((token) => loginOne(token, readyTimeoutMs)));
  const attempts: LoginAttempt[] = settled.map((result, i) =>
    result.status === 'fulfilled'
      ? { label: `bot${i + 1}`, client: result.value }
      : { label: `bot${i + 1}`, error: toError(result.reason) },
  );

  const selection = selectFleet(attempts, guildIds);
  const kept = new Set('fatal' in selection ? [] : selection.bots.map((bot) => bot.client));
  await Promise.allSettled(attempts.flatMap((a) => (a.client && !kept.has(a.client) ? [a.client.destroy()] : [])));

  if ('fatal' in selection) throw new Error(selection.fatal);
  for (const guildId of selection.skippedGuildIds) {
    log.warn('fleet.server_skipped', { server: guildId, reason: `leader is not in this server; ${INVITE_HINT}` });
  }
  for (const { label, reason } of selection.dropped) log.warn('fleet.bot_dropped', { bot: label, reason });
  for (const { label, guildId } of selection.gaps) {
    log.warn('fleet.bot_missing_server', { bot: label, server: guildId, hint: INVITE_HINT });
  }
  log.info('fleet.ready', { bots: selection.bots.length, leader: selection.bots[0]?.name, servers: selection.guildIds.length });
  return { bots: selection.bots, guildIds: selection.guildIds };
}
