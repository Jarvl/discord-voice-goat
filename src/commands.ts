import type { Client } from 'discord.js';

export const YO_COMMAND = { name: 'yo', description: 'Summon the swarm' } as const;

/** Registers /yo on one server only (instant, unlike global commands). Overwrites, so it is safe on every start. */
export async function registerYoCommand(leader: Client<true>, guildId: string): Promise<void> {
  const guild = leader.guilds.cache.get(guildId);
  if (!guild) throw new Error(`leader is not in server ${guildId}`);
  await guild.commands.set([YO_COMMAND]);
}
