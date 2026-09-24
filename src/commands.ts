import type { Client } from 'discord.js';
import { toError } from './errors.js';
import type { Logger } from './log.js';
import { SOUNDS } from './sounds.js';

/** One slash command per sound. */
export const COMMANDS = SOUNDS.map(({ name, description }) => ({ name, description }));

/**
 * Registers the sound commands on one server (instant, unlike global commands); call it once per server. Overwrites, so it is
 * safe on every start and removes commands that no longer exist. A failure is logged, not thrown: the
 * voice-join trigger keeps working without the commands.
 */
export async function registerCommands(leader: Client<true>, guildId: string, log: Logger): Promise<boolean> {
  try {
    const guild = leader.guilds.cache.get(guildId);
    if (!guild) throw new Error(`leader is not in server ${guildId}`);
    await guild.commands.set(COMMANDS);
    return true;
  } catch (err) {
    log.error('commands.register_failed', {
      server: guildId,
      error: toError(err).message,
      hint: 're-invite the leader with the first link from npm run invite-links (it adds the slash-command scope), then restart',
    });
    return false;
  }
}
