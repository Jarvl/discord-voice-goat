import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getVoiceConnections, VoiceConnectionStatus } from '@discordjs/voice';
import { registerYoCommand } from './commands.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { toError } from './errors.js';
import { startFleet } from './fleet.js';
import { SwarmGate } from './gate.js';
import { createLogger } from './log.js';
import { playOnce } from './player.js';
import { createSwarm } from './swarm.js';
import { attachLeaderHandlers, hasHumans } from './triggers.js';

const CLIP_PATH = fileURLToPath(new URL('../assets/yo.ogg', import.meta.url));
const SHUTDOWN_TIMEOUT_MS = 5_000;

const log = createLogger();

process.on('unhandledRejection', (reason) => log.error('unhandled_rejection', { error: toError(reason).message }));
process.on('uncaughtException', (err) => {
  log.error('uncaught_exception', { error: err.message });
  process.exit(1);
});

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  let clip: Buffer;
  try {
    clip = await readFile(CLIP_PATH);
  } catch (err) {
    console.error(`Cannot read the sound clip at ${CLIP_PATH}: ${toError(err).message}`);
    process.exit(1);
  }

  const bots = await startFleet(config.botTokens, config.guildId, log);
  const leader = bots[0]!; // startFleet throws unless the leader is usable
  const fleetIds = new Set(bots.map((bot) => bot.client.user.id));

  const swarm = createSwarm({
    bots,
    gate: new SwarmGate(config.cooldownMs),
    play: (bot, channelId) => playOnce(bot, channelId, clip),
    channelHasHumans: (channelId) => {
      const guild = leader.client.guilds.cache.get(config.guildId);
      if (!guild) return false;
      const occupants = [...guild.voiceStates.cache.values()].map((state) => ({
        userId: state.id,
        channelId: state.channelId,
        isBot: state.member?.user.bot,
      }));
      return hasHumans(occupants, channelId, fleetIds);
    },
    rng: Math.random,
    staggerMinMs: config.staggerMinMs,
    staggerMaxMs: config.staggerMaxMs,
    log,
  });

  await registerYoCommand(leader.client, config.guildId);
  const detach = attachLeaderHandlers(leader.client, config, swarm, log);
  log.info('ready', { bots: bots.length, leader: leader.name });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown', { signal });
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
    detach();
    swarm.cancelAll();
    for (const bot of bots) {
      for (const connection of getVoiceConnections(bot.client.user.id)?.values() ?? []) {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      }
    }
    await Promise.allSettled(bots.map((bot) => bot.client.destroy()));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('startup_failed', { error: toError(err).message });
  process.exit(1);
});
