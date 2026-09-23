import { PermissionFlagsBits } from 'discord.js';

/** View Channel + Connect + Speak = 3146752. */
export const INVITE_PERMISSIONS = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak;

/** A bot token's first segment is the base64-encoded bot user ID, which equals the application ID. */
export function applicationIdFromToken(token: string): string {
  const id = Buffer.from(token.split('.')[0] ?? '', 'base64').toString('utf8');
  if (!/^\d{17,20}$/.test(id)) throw new Error('this does not look like a Discord bot token');
  return id;
}

export function inviteUrl(applicationId: string, isLeader: boolean): string {
  const scope = isLeader ? 'bot applications.commands' : 'bot';
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=${encodeURIComponent(scope)}&permissions=${INVITE_PERMISSIONS}`;
}
