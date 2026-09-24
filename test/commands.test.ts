import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { COMMANDS, registerCommands } from '../src/commands.js';
import { createLogger } from '../src/log.js';

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger((line) => lines.push(line)) };
}

function leaderWith(set: () => Promise<unknown>): Client<true> {
  return { guilds: { cache: new Map([['g1', { commands: { set } }]]) } } as unknown as Client<true>;
}

describe('registerCommands', () => {
  it('overwrites the guild commands with one command per sound and returns true', async () => {
    const set = vi.fn(async () => undefined);
    const { log } = capture();
    await expect(registerCommands(leaderWith(set), 'g1', log)).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith([
      { name: 'yoo', description: 'Summon the yoo swarm' },
      { name: 'briish', description: 'Summon the briish swarm' },
      { name: 'hewoo-pwincess', description: 'Summon the hewoo-pwincess swarm' },
      { name: 'geeeey', description: 'Summon the geeeey swarm' },
      { name: 'lisan-al-gaib', description: 'Summon the lisan-al-gaib swarm' },
      { name: 'loser', description: 'Summon the loser swarm' },
    ]);
    expect(COMMANDS.map((c) => c.name)).toEqual(['yoo', 'briish', 'hewoo-pwincess', 'geeeey', 'lisan-al-gaib', 'loser']);
  });

  it('returns false and logs an invite hint when Discord refuses the registration', async () => {
    const { lines, log } = capture();
    const leader = leaderWith(async () => {
      throw new Error('Missing Access');
    });
    await expect(registerCommands(leader, 'g1', log)).resolves.toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/error commands\.register_failed error="Missing Access" hint=".*npm run invite-links.*"/);
  });

  it('returns false and logs when the leader is not in the server', async () => {
    const { lines, log } = capture();
    const leader = { guilds: { cache: new Map() } } as unknown as Client<true>;
    await expect(registerCommands(leader, 'g1', log)).resolves.toBe(false);
    expect(lines[0]).toMatch(/commands\.register_failed error="leader is not in server g1"/);
  });
});
