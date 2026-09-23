import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toError } from './errors.js';

/**
 * Every sound the swarm can play. Each one is a slash command of the same name, and its clip is
 * assets/<name>.ogg (Ogg Opus, 48 kHz). To add a sound, add a line here and drop in the file.
 */
export const SOUNDS = [
  { name: 'yoo', description: 'Summon the yoo swarm' },
  { name: 'briish', description: 'Summon the briish swarm' },
] as const;

export type SoundName = (typeof SOUNDS)[number]['name'];

/** Played when a trigger user joins voice (only when TRIGGER_USER_IDS is set). */
export const JOIN_SOUND: SoundName = 'yoo';

export function findSound(name: string): SoundName | undefined {
  return SOUNDS.find((sound) => sound.name === name)?.name;
}

/** Reads every sound's clip into memory. Rejects, naming the file, if any clip is missing or unreadable. */
export async function loadClips(dir: string): Promise<Record<SoundName, Buffer>> {
  const entries = await Promise.all(
    SOUNDS.map(async ({ name }) => {
      const path = join(dir, `${name}.ogg`);
      try {
        return [name, await readFile(path)] as const;
      } catch (err) {
        throw new Error(`Cannot read the sound clip at ${path}: ${toError(err).message}`);
      }
    }),
  );
  return Object.fromEntries(entries) as Record<SoundName, Buffer>;
}
