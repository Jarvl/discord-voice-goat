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

export type FleetSelection = { fatal: string } | { bots: Bot[]; dropped: { label: string; reason: string }[] };

const INVITE_HINT = 'run `npm run invite-links` and add it to the server';

/** Decides which logged-in clients make up the fleet. attempts[0] is the leader. */
export function selectFleet(attempts: readonly LoginAttempt[], guildId: string): FleetSelection {
  const [leader, ...followers] = attempts;
  if (!leader) return { fatal: 'no bot tokens were provided' };
  if (!leader.client) return { fatal: `leader (${leader.label}) failed to log in: ${leader.error?.message ?? 'unknown error'}` };
  if (!leader.client.guilds.cache.has(guildId)) {
    return { fatal: `leader (${leader.client.user.username}) is not in server ${guildId}; ${INVITE_HINT}` };
  }

  const bots: Bot[] = [{ name: leader.client.user.username, client: leader.client }];
  const dropped: { label: string; reason: string }[] = [];
  for (const attempt of followers) {
    if (!attempt.client) dropped.push({ label: attempt.label, reason: `failed to log in: ${attempt.error?.message ?? 'unknown error'}` });
    else if (!attempt.client.guilds.cache.has(guildId)) dropped.push({ label: attempt.client.user.username, reason: `not in server ${guildId}; ${INVITE_HINT}` });
    else bots.push({ name: attempt.client.user.username, client: attempt.client });
  }
  return { bots, dropped };
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

async function loginOne(token: string, readyTimeoutMs: number): Promise<Client<true>> {
  const client = createBotClient();
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
    throw err;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** Logs in every token concurrently. Throws if the leader cannot be used; drops unusable followers. */
export async function startFleet(tokens: readonly string[], guildId: string, log: Logger, readyTimeoutMs = 30_000): Promise<Bot[]> {
  const settled = await Promise.allSettled(tokens.map((token) => loginOne(token, readyTimeoutMs)));
  const attempts: LoginAttempt[] = settled.map((result, i) =>
    result.status === 'fulfilled'
      ? { label: `bot${i + 1}`, client: result.value }
      : { label: `bot${i + 1}`, error: toError(result.reason) },
  );

  const selection = selectFleet(attempts, guildId);
  const kept = new Set('fatal' in selection ? [] : selection.bots.map((bot) => bot.client));
  await Promise.allSettled(attempts.flatMap((a) => (a.client && !kept.has(a.client) ? [a.client.destroy()] : [])));

  if ('fatal' in selection) throw new Error(selection.fatal);
  for (const { label, reason } of selection.dropped) log.warn('fleet.bot_dropped', { bot: label, reason });
  log.info('fleet.ready', { bots: selection.bots.length, leader: selection.bots[0]?.name });
  return selection.bots;
}
