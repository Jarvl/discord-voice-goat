import type { Client } from 'discord.js';
import { toError } from './errors.js';
import type { Logger } from './log.js';

export const YO_COMMAND = { name: 'yo', description: 'Summon the swarm' } as const;

/**
 * Registers /yo on one server only (instant, unlike global commands). Overwrites, so it is safe on every start.
 * A failure is logged, not thrown: the voice-join trigger keeps working without /yo.
 */
export async function registerYoCommand(leader: Client<true>, guildId: string, log: Logger): Promise<boolean> {
  try {
    const guild = leader.guilds.cache.get(guildId);
    if (!guild) throw new Error(`leader is not in server ${guildId}`);
    await guild.commands.set([YO_COMMAND]);
    return true;
  } catch (err) {
    log.error('commands.register_failed', {
      error: toError(err).message,
      hint: 're-invite the leader with the first link from npm run invite-links (it adds the slash-command scope), then restart',
    });
    return false;
  }
}
