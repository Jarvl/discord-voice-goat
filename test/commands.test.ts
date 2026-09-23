import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { registerYoCommand, YO_COMMAND } from '../src/commands.js';

describe('registerYoCommand', () => {
  it('overwrites the guild commands with just /yo', async () => {
    const set = vi.fn(async () => undefined);
    const leader = { guilds: { cache: new Map([['g1', { commands: { set } }]]) } } as unknown as Client<true>;
    await registerYoCommand(leader, 'g1');
    expect(set).toHaveBeenCalledWith([{ name: 'yo', description: 'Summon the swarm' }]);
    expect(YO_COMMAND.name).toBe('yo');
  });

  it('throws when the leader is not in the server', async () => {
    const leader = { guilds: { cache: new Map() } } as unknown as Client<true>;
    await expect(registerYoCommand(leader, 'g1')).rejects.toThrow('leader is not in server g1');
  });
});
