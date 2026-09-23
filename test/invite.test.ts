import { describe, expect, it } from 'vitest';
import { applicationIdFromToken, INVITE_PERMISSIONS, inviteUrl } from '../src/invite.js';

const APP_ID = '123456789012345678';
const token = (id: string) => `${Buffer.from(id).toString('base64').replace(/=+$/, '')}.GhIjKl.fake-signature`;

describe('applicationIdFromToken', () => {
  it('decodes the application ID from the first token segment', () => {
    expect(applicationIdFromToken(token(APP_ID))).toBe(APP_ID);
  });

  it('rejects something that is not a bot token', () => {
    expect(() => applicationIdFromToken('not-a-token')).toThrow('this does not look like a Discord bot token');
  });
});

describe('inviteUrl', () => {
  it('uses View Channel + Connect + Speak', () => {
    expect(INVITE_PERMISSIONS).toBe(3146752n);
  });

  it('gives the leader the applications.commands scope', () => {
    expect(inviteUrl(APP_ID, true)).toBe(
      `https://discord.com/oauth2/authorize?client_id=${APP_ID}&scope=bot%20applications.commands&permissions=3146752`,
    );
  });

  it('gives followers only the bot scope', () => {
    expect(inviteUrl(APP_ID, false)).toBe(`https://discord.com/oauth2/authorize?client_id=${APP_ID}&scope=bot&permissions=3146752`);
  });
});
