import { describe, expect, it } from 'vitest';
import type { Client } from 'discord.js';
import { selectFleet, type LoginAttempt } from '../src/fleet.js';

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
