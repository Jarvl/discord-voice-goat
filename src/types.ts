import type { Client } from 'discord.js';

export interface Bot {
  name: string;
  client: Client<true>;
}

export type PlayResult =
  | { status: 'played' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: Error };
