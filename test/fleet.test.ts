import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Events, type Client } from 'discord.js';
import { loginOne, selectFleet, type LoginAttempt } from '../src/fleet.js';

const GUILD = '111111111111111111';

function client(username: string, guildIds: string[] = [GUILD]): Client<true> {
  return { user: { username }, guilds: { cache: new Map(guildIds.map((id) => [id, {}])) } } as unknown as Client<true>;
}

const ok = (label: string, username: string, guildIds?: string[]): LoginAttempt => ({ label, client: client(username, guildIds) });
const failed = (label: string, message: string): LoginAttempt => ({ label, error: new Error(message) });

describe('selectFleet', () => {
  it('keeps every bot that logged in and is in the server, leader first', () => {
    const result = selectFleet([ok('bot1', 'Leader'), ok('bot2', 'Two'), ok('bot3', 'Three')], GUILD);
    expect(result).toMatchObject({ bots: [{ name: 'Leader' }, { name: 'Two' }, { name: 'Three' }], dropped: [] });
  });

  it('is fatal when the leader fails to log in', () => {
    expect(selectFleet([failed('bot1', 'An invalid token was provided.'), ok('bot2', 'Two')], GUILD)).toEqual({
      fatal: 'leader (bot1) failed to log in: An invalid token was provided.',
    });
  });

  it('is fatal when the leader is not in the server', () => {
    expect(selectFleet([ok('bot1', 'Leader', []), ok('bot2', 'Two')], GUILD)).toEqual({
      fatal: `leader (Leader) is not in server ${GUILD}; run \`npm run invite-links\` and add it to the server`,
    });
  });

  it('drops followers that failed to log in or are not in the server, and keeps the rest', () => {
    const result = selectFleet(
      [ok('bot1', 'Leader'), failed('bot2', 'An invalid token was provided.'), ok('bot3', 'Three', []), ok('bot4', 'Four')],
      GUILD,
    );
    expect(result).toMatchObject({
      bots: [{ name: 'Leader' }, { name: 'Four' }],
      dropped: [
        { label: 'bot2', reason: 'failed to log in: An invalid token was provided.' },
        { label: 'Three', reason: `not in server ${GUILD}; run \`npm run invite-links\` and add it to the server` },
      ],
    });
  });

  it('runs as a swarm of one when only the leader is usable', () => {
    expect(selectFleet([ok('bot1', 'Leader'), failed('bot2', 'x')], GUILD)).toMatchObject({ bots: [{ name: 'Leader' }] });
  });

  it('is fatal with no tokens', () => {
    expect(selectFleet([], GUILD)).toEqual({ fatal: 'no bot tokens were provided' });
  });
});

/** Stands in for a discord.js Client: login() resolves, and ClientReady fires only when the test says so. */
class FakeClient extends EventEmitter {
  login = vi.fn(async (_token: string) => 'token');
  destroy = vi.fn(async () => {});
  isReady(): boolean {
    return true;
  }
}

describe('loginOne', () => {
  it('reports a readable timeout and destroys the client when it never becomes ready', async () => {
    const fake = new FakeClient();
    await expect(loginOne('t', 20, () => fake as unknown as Client)).rejects.toThrow('not ready within 20ms');
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it('passes a login failure through unchanged and destroys the client', async () => {
    const fake = new FakeClient();
    fake.login.mockRejectedValueOnce(new Error('An invalid token was provided.'));
    await expect(loginOne('t', 1000, () => fake as unknown as Client)).rejects.toThrow('An invalid token was provided.');
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it('resolves with the client once it is ready', async () => {
    const fake = new FakeClient();
    fake.login.mockImplementationOnce(async () => {
      setTimeout(() => fake.emit(Events.ClientReady, fake), 1);
      return 'token';
    });
    await expect(loginOne('t', 1000, () => fake as unknown as Client)).resolves.toBe(fake);
    expect(fake.destroy).not.toHaveBeenCalled();
  });
});
