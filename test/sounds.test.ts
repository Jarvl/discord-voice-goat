import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSound, JOIN_SOUND, loadClips, SOUNDS } from '../src/sounds.js';

describe('SOUNDS', () => {
  it('has /yoo and /briish', () => {
    expect(SOUNDS.map((s) => s.name)).toEqual(['yoo', 'briish']);
  });

  it('plays yoo when a trigger user joins voice', () => {
    expect(JOIN_SOUND).toBe('yoo');
  });
});

describe('findSound', () => {
  it('finds a sound by its command name', () => {
    expect(findSound('briish')).toBe('briish');
  });

  it('returns undefined for anything else', () => {
    expect(findSound('yo')).toBeUndefined();
  });
});

describe('loadClips', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clips-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads <name>.ogg for every sound', async () => {
    await writeFile(join(dir, 'yoo.ogg'), 'Y');
    await writeFile(join(dir, 'briish.ogg'), 'B');
    const clips = await loadClips(dir);
    expect(clips.yoo.toString()).toBe('Y');
    expect(clips.briish.toString()).toBe('B');
  });

  it('names the missing file when a clip cannot be read', async () => {
    await writeFile(join(dir, 'yoo.ogg'), 'Y');
    await expect(loadClips(dir)).rejects.toThrow(`Cannot read the sound clip at ${join(dir, 'briish.ogg')}`);
  });
});
