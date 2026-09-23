# Discord Yo Swarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single Node/TypeScript service that logs in N Discord bots. When a trigger user joins voice, or anyone runs `/yo`, the bots join that voice channel one at a time, 1–2 s apart; each plays a sound clip the moment it connects and then leaves.

**Architecture:** One process, one Docker container, and N `discord.js` clients, where `bots[0]` is the leader that listens for voice joins and `/yo`. The logic lives in small pure modules (`schedule`, `gate`, `shouldTrigger`/`hasHumans`, `config`, and `swarm` with an injected player), all unit-tested without Discord. The Discord-facing code is limited to `player`, `fleet`, `commands`, the leader handlers, and `index`. `player` and the handlers are tested against fakes.

**Tech Stack:** Node ≥ 22.12 (Docker: `node:24-slim`), TypeScript 7.0.2, discord.js 14.27.0, @discordjs/voice 0.19.2 (bundles @snazzah/davey for DAVE), Vitest 5.0.1, tsx 4.23.15.

**Spec:** `docs/superpowers/specs/2026-09-23-discord-yo-swarm-design.md`

**Verification status:** Every file in this plan was built and run in a scratch copy before the plan was written. That run covered the type-check, 94 passing tests, `npm run build`, the startup failure paths (bad config, missing clip, invalid token) and a `docker build` + `docker run`. The code blocks are that exact code.

**Additions beyond the spec's file layout** (all small, and all serving spec requirements):
- `src/errors.ts`: the `toError` helper.
- `src/log.ts`: the §8 log format.
- `src/types.ts`: shared `Bot` and `PlayResult` types.
- `src/invite.ts`: pure invite-link helpers for the script.
- Extra tests: `log`, `player` (with a mocked `@discordjs/voice`), `fleet`, `commands`, `leader-handlers`, `invite`.
- `createSwarm` is generic over the bot type, so its tests need no Discord objects.
- `playOnce` takes optional timeouts, so its tests run fast.

## Global Constraints

- Work on a feature branch (for example `feat/yo-swarm`), never directly on `main`.
- End every commit message with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The commit steps below do this with a second `-m`.
- ESM throughout: `"type": "module"`, with `module`/`moduleResolution` set to `NodeNext`. Relative imports use the `.js` extension (for example `import { toError } from './errors.js'`).
- **Pinned versions** (use `--save-exact`):
  - Dependencies: `discord.js@14.27.0`, `@discordjs/voice@0.19.2`.
  - Dev dependencies: `typescript@7.0.2`, `vitest@5.0.1`, `tsx@4.23.15`, `@types/node@24.13.6`.
- **No other runtime dependencies.** Voice transport encryption uses Node's native AES-256-GCM, and DAVE comes from `@snazzah/davey`, which `@discordjs/voice` pulls in. No sodium, no Opus encoder, and no FFmpeg at runtime: the clip is passed through as `StreamType.OggOpus`.
- Gateway intents: only `Guilds` and `GuildVoiceStates`. No privileged intents.
- `/yo` is registered on the configured guild only. Its description is "Summon the swarm". Every reply is ephemeral (`MessageFlags.Ephemeral`) and uses exactly this copy:
  - Not in voice, or in a stage channel: `Join a voice channel first.`
  - A swarm is running: `Swarm already in flight 🐝`
  - Cooling down: `Swarm is cooling down — try again in ${Math.ceil(remainingMs / 1000)}s.`
  - Launched: `🐝 incoming`
- **Environment variables:**
  - Required: `BOT_TOKENS` (comma-separated; the first is the leader), `GUILD_ID`, `TRIGGER_USER_IDS` (comma-separated).
  - Optional: `STAGGER_MIN_MS` (default 1000), `STAGGER_MAX_MS` (default 2000), `COOLDOWN_MS` (default 30000; `0` disables it).
  - IDs are 17–20 digit snowflakes.
- The stagger applies to **joins**. Each bot starts joining at its `joinDelayMs`, then plays the moment its connection is Ready. The clip itself is never delayed.
- **Timeouts:**
  - Voice connection Ready: 10 000 ms.
  - Playback: 30 000 ms ceiling.
  - Client login-to-ready: 30 000 ms.
  - Shutdown hard exit: 5 000 ms.
- Clip path: `assets/yo.ogg` (Ogg Opus, 48 kHz, stereo).
- Log lines are `<ISO time> <level> <event> key=value …`. Tokens are never logged.
- Invite permissions: `3146752` (View Channel + Connect + Speak). Scopes: `bot applications.commands` for the leader, `bot` for followers.
- Docker base: `node:24-slim` (Debian glibc), never Alpine.

## Review Focus

No spec requirement pins these five, but each is likely to bite in real use. Each has a test in the task that owns the code.

1. **A voice `error` event after the awaited step has finished.** Examples: a UDP hiccup mid-clip, or a late decoder error. Expected: the process must not crash; that bot alone finishes or fails. Pinned in **Task 6** by "does not crash when the connection emits an error mid-clip" and "does not crash when the audio player emits an error after playback ended".
2. **A connection destroyed by someone else mid-clip**, for example by the SIGTERM shutdown or a moderator disconnecting the bot. Expected: `playOnce` resolves `failed` and doesn't throw from a second `destroy()`. Pinned in **Task 6** by "does not throw when the connection was already destroyed elsewhere".
3. **Channel occupants whose member isn't cached, and other people's bots** (such as a music bot) in the channel. Expected: an uncached user counts as human, so the swarm doesn't silently skip the owner. A music bot doesn't count, so it doesn't keep the swarm going after everyone has left. Pinned in **Task 4** by the `hasHumans` tests.
4. **Environment values as Dokploy's UI produces them:** blank optional fields, quoted values, trailing commas, and tokens pasted with a `Bot ` prefix. Expected: defaults or cleaned values, not a startup failure. Pinned in **Task 1** by "treats blank optional numbers as defaults", "parses several trigger user IDs with spaces, quotes and a trailing comma", "accepts a quoted GUILD_ID", and "strips surrounding quotes and a "Bot " prefix".
5. **A leader that logs in but was never invited to the server.** Expected: a fatal startup error with an invite hint, not a process that runs and silently ignores everything. Pinned in **Task 7** by "is fatal when the leader is not in the server".

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `package.json`, `package-lock.json` | Scripts, pinned deps | 1 |
| `tsconfig.json` | Type-check `src`, `scripts` and `test` (no emit) | 1 |
| `tsconfig.build.json` | Compile `src` → `dist` | 1 |
| `vitest.config.ts` | Run only `test/**/*.test.ts` | 1 |
| `.env.example` | Documents every env var | 1 |
| `src/errors.ts` | `toError(unknown): Error` | 1 |
| `src/log.ts` | `Logger`, `createLogger`, `formatLine` | 1 |
| `src/config.ts` | `Config`, `ConfigError`, `loadConfig`, `parseTokens` | 1 |
| `src/schedule.ts` | `buildSchedule`: shuffle plus cumulative join delays | 2 |
| `src/gate.ts` | `SwarmGate`: one swarm at a time, plus cooldown | 3 |
| `src/triggers.ts` | Pure `shouldTrigger`/`hasHumans` (Task 4); leader handlers (Task 8) | 4, 8 |
| `src/types.ts` | `Bot`, `PlayResult` | 5 |
| `src/swarm.ts` | `createSwarm`: gate → schedule → join timers → release | 5 |
| `src/player.ts` | `playOnce`: pre-check → join → play → always leave | 6 |
| `src/fleet.ts` | `selectFleet` (pure), `startFleet` (login all clients) | 7 |
| `src/commands.ts` | `YO_COMMAND`, `registerYoCommand` | 8 |
| `src/index.ts` | Wiring, clip loading, signal handling | 9 |
| `assets/yo.ogg` | Placeholder clip, a 0.6 s 880 Hz tone | 9 |
| `src/invite.ts` | `applicationIdFromToken`, `inviteUrl`, `INVITE_PERMISSIONS` | 10 |
| `scripts/invite-links.ts` | CLI: print invite URLs | 10 |
| `Dockerfile`, `.dockerignore` | Two-stage image | 11 |
| `README.md` | Setup, deploy, smoke test, troubleshooting | 11 |
| `test/*.test.ts` | One test file per module, plus `leader-handlers.test.ts` | each task |

`.gitignore` already exists (`node_modules/`, `dist/`, `.env`), so there's no need to touch it.

---

### Task 1: Project scaffold, config and logger

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.env.example`, `src/errors.ts`, `src/log.ts`, `src/config.ts`
- Generated: `package-lock.json`
- Test: `test/log.test.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `toError(value: unknown): Error`
  - `type Fields = Record<string, string | number | boolean | undefined>`
  - `interface Logger { info(event: string, fields?: Fields): void; warn(...): void; error(...): void }`
  - `createLogger(write?: (line: string) => void, now?: () => Date): Logger`
  - `formatLine(level: string, event: string, fields: Fields, now: Date): string`
  - `interface Config { botTokens: string[]; guildId: string; triggerUserIds: Set<string>; staggerMinMs: number; staggerMaxMs: number; cooldownMs: number }`
  - `class ConfigError extends Error { readonly problems: string[] }`
  - `loadConfig(env: Record<string, string | undefined>): Config` (throws `ConfigError`)
  - `parseTokens(raw: string | undefined): string[]`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "discord-voice-goat",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.12.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/index.js",
    "dev": "tsx --env-file=.env src/index.ts",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run",
    "invite-links": "tsx --env-file=.env scripts/invite-links.ts"
  }
}
```

- [ ] **Step 2: Install the pinned dependencies**

Run:
```bash
npm install --save-exact discord.js@14.27.0 @discordjs/voice@0.19.2
npm install --save-exact -D typescript@7.0.2 vitest@5.0.1 tsx@4.23.15 @types/node@24.13.6
```
Expected: `package.json` gains `dependencies` and `devDependencies` with exact versions, and `package-lock.json` is created. Confirm that the lockfile includes the Linux DAVE binaries the Docker image will need:
```bash
grep -c '"node_modules/@snazzah/davey-linux' package-lock.json
```
Expected: `5` or more.

- [ ] **Step 3: Create `tsconfig.json`, `tsconfig.build.json` and `vitest.config.ts`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "scripts", "test"]
}
```

`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create `.env.example`**

```bash
# Comma-separated bot tokens. The FIRST token is the leader: it watches voice joins and owns /yo.
BOT_TOKENS=
# Your server's ID (Developer Mode on, then right-click the server > Copy Server ID).
GUILD_ID=
# Comma-separated user IDs whose voice join triggers the swarm (right-click yourself > Copy User ID).
TRIGGER_USER_IDS=
# Optional, in milliseconds. Blank means the default shown.
STAGGER_MIN_MS=1000
STAGGER_MAX_MS=2000
COOLDOWN_MS=30000
```

- [ ] **Step 5: Write the failing tests**

`test/log.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createLogger, formatLine } from '../src/log.js';

const NOW = new Date('2026-09-23T12:00:00.000Z');

describe('formatLine', () => {
  it('writes time, level, event, then key=value pairs', () => {
    expect(formatLine('info', 'swarm.launch', { channel: '123', bots: 3 }, NOW)).toBe(
      '2026-09-23T12:00:00.000Z info swarm.launch channel=123 bots=3',
    );
  });

  it('quotes values containing spaces, quotes or equals signs, and empty values', () => {
    expect(formatLine('warn', 'e', { reason: 'channel is full', q: 'a"b', eq: 'a=b', empty: '' }, NOW)).toBe(
      '2026-09-23T12:00:00.000Z warn e reason="channel is full" q="a\\"b" eq="a=b" empty=""',
    );
  });

  it('skips undefined values', () => {
    expect(formatLine('info', 'e', { a: undefined, b: false }, NOW)).toBe('2026-09-23T12:00:00.000Z info e b=false');
  });
});

describe('createLogger', () => {
  it('writes one formatted line per call at the right level', () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line), () => NOW);
    log.info('a');
    log.warn('b', { x: 1 });
    log.error('c');
    expect(lines).toEqual([
      '2026-09-23T12:00:00.000Z info a',
      '2026-09-23T12:00:00.000Z warn b x=1',
      '2026-09-23T12:00:00.000Z error c',
    ]);
  });
});
```

`test/config.test.ts`. The Dokploy-input cases are Review Focus #4.
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseTokens } from '../src/config.js';

const GUILD = '111111111111111111';
const USER = '222222222222222222';
const USER2 = '333333333333333333';
const valid = { BOT_TOKENS: 'tokA,tokB', GUILD_ID: GUILD, TRIGGER_USER_IDS: USER };

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('expected loadConfig to throw ConfigError');
}

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    expect(loadConfig(valid)).toEqual({
      botTokens: ['tokA', 'tokB'],
      guildId: GUILD,
      triggerUserIds: new Set([USER]),
      staggerMinMs: 1000,
      staggerMaxMs: 2000,
      cooldownMs: 30_000,
    });
  });

  it('reads the optional numbers, including a zero cooldown', () => {
    const cfg = loadConfig({ ...valid, STAGGER_MIN_MS: '500', STAGGER_MAX_MS: '750', COOLDOWN_MS: '0' });
    expect([cfg.staggerMinMs, cfg.staggerMaxMs, cfg.cooldownMs]).toEqual([500, 750, 0]);
  });

  it('treats blank optional numbers as defaults (a cleared field in the Dokploy UI)', () => {
    const cfg = loadConfig({ ...valid, STAGGER_MIN_MS: '', STAGGER_MAX_MS: '   ', COOLDOWN_MS: '' });
    expect([cfg.staggerMinMs, cfg.staggerMaxMs, cfg.cooldownMs]).toEqual([1000, 2000, 30_000]);
  });

  it('parses several trigger user IDs with spaces, quotes and a trailing comma', () => {
    const cfg = loadConfig({ ...valid, TRIGGER_USER_IDS: `"${USER}, ${USER2},"` });
    expect(cfg.triggerUserIds).toEqual(new Set([USER, USER2]));
  });

  it('accepts a quoted GUILD_ID', () => {
    expect(loadConfig({ ...valid, GUILD_ID: `"${GUILD}"` }).guildId).toBe(GUILD);
  });

  it('reports every missing required variable at once', () => {
    const problems = problemsOf({});
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/BOT_TOKENS/);
    expect(problems[1]).toMatch(/GUILD_ID/);
    expect(problems[2]).toMatch(/TRIGGER_USER_IDS/);
  });

  it.each([
    ['GUILD_ID', 'abc'],
    ['GUILD_ID', '123'],
    ['TRIGGER_USER_IDS', 'nope'],
  ])('rejects malformed %s=%s', (name, value) => {
    expect(problemsOf({ ...valid, [name]: value })).toEqual([expect.stringContaining(name)]);
  });

  it.each(['-1', '1.5', '1s', '1,000', 'abc'])('rejects STAGGER_MIN_MS=%s', (value) => {
    expect(problemsOf({ ...valid, STAGGER_MIN_MS: value })).toEqual([expect.stringContaining('STAGGER_MIN_MS')]);
  });

  it('rejects a minimum stagger above the maximum', () => {
    expect(problemsOf({ ...valid, STAGGER_MIN_MS: '3000', STAGGER_MAX_MS: '2000' })).toEqual([
      'STAGGER_MIN_MS (3000) must not be greater than STAGGER_MAX_MS (2000)',
    ]);
  });

  it('does not add a min>max problem when a stagger value is malformed', () => {
    expect(problemsOf({ ...valid, STAGGER_MIN_MS: 'abc', STAGGER_MAX_MS: '500' })).toHaveLength(1);
  });

  it('lists each problem in the error message', () => {
    expect(() => loadConfig({ ...valid, GUILD_ID: 'x', COOLDOWN_MS: 'y' })).toThrow(
      /Invalid configuration:\n {2}- GUILD_ID.*\n {2}- COOLDOWN_MS/,
    );
  });
});

describe('parseTokens', () => {
  it('trims, drops empty entries and removes duplicates', () => {
    expect(parseTokens(' a , ,b,a ')).toEqual(['a', 'b']);
  });

  it('returns an empty list for undefined', () => {
    expect(parseTokens(undefined)).toEqual([]);
  });

  it('strips surrounding quotes and a "Bot " prefix', () => {
    expect(parseTokens(`"Bot a, 'b'"`)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. Both files report that they can't resolve `../src/log.js` or `../src/config.js`.

- [ ] **Step 7: Implement `src/errors.ts`, `src/log.ts` and `src/config.ts`**

`src/errors.ts`:
```ts
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
```

`src/log.ts`:
```ts
export type Fields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
}

export function formatLine(level: string, event: string, fields: Fields, now: Date): string {
  const parts = [now.toISOString(), level, event];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = String(value);
    parts.push(`${key}=${text === '' || /[\s"=]/.test(text) ? JSON.stringify(text) : text}`);
  }
  return parts.join(' ');
}

export function createLogger(
  write: (line: string) => void = (line) => console.log(line),
  now: () => Date = () => new Date(),
): Logger {
  const at =
    (level: string) =>
    (event: string, fields: Fields = {}) =>
      write(formatLine(level, event, fields, now()));
  return { info: at('info'), warn: at('warn'), error: at('error') };
}
```

`src/config.ts`:
```ts
export interface Config {
  /** Bot tokens; index 0 is the leader. */
  botTokens: string[];
  guildId: string;
  triggerUserIds: Set<string>;
  staggerMinMs: number;
  staggerMaxMs: number;
  cooldownMs: number;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const SNOWFLAKE = /^\d{17,20}$/;

function stripQuotes(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

function splitList(raw: string | undefined): string[] {
  return stripQuotes((raw ?? '').trim())
    .split(',')
    .map((part) => stripQuotes(part.trim()).trim())
    .filter((part) => part.length > 0);
}

/** Trim, drop empties, strip quotes and a leading "Bot " prefix, and dedupe. */
export function parseTokens(raw: string | undefined): string[] {
  const tokens = splitList(raw)
    .map((token) => token.replace(/^Bot\s+/i, ''))
    .filter((token) => token.length > 0);
  return [...new Set(tokens)];
}

/** Returns NaN (and records a problem) when the value is present but not a whole number. */
function parseMs(env: Record<string, string | undefined>, name: string, fallback: number, problems: string[]): number {
  const raw = stripQuotes(env[name]?.trim() ?? '');
  if (raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    problems.push(`${name} must be a whole number of milliseconds, got "${raw}"`);
    return Number.NaN;
  }
  return Number(raw);
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];

  const botTokens = parseTokens(env.BOT_TOKENS);
  if (botTokens.length === 0) {
    problems.push('BOT_TOKENS is required (comma-separated bot tokens; the first is the leader)');
  }

  const guildId = stripQuotes(env.GUILD_ID?.trim() ?? '');
  if (guildId === '') problems.push('GUILD_ID is required');
  else if (!SNOWFLAKE.test(guildId)) problems.push(`GUILD_ID must be a Discord ID (17-20 digits), got "${guildId}"`);

  const triggerUserIds = splitList(env.TRIGGER_USER_IDS);
  if (triggerUserIds.length === 0) problems.push('TRIGGER_USER_IDS is required (comma-separated Discord user IDs)');
  for (const id of triggerUserIds) {
    if (!SNOWFLAKE.test(id)) problems.push(`TRIGGER_USER_IDS contains "${id}", which is not a Discord ID (17-20 digits)`);
  }

  const staggerMinMs = parseMs(env, 'STAGGER_MIN_MS', 1000, problems);
  const staggerMaxMs = parseMs(env, 'STAGGER_MAX_MS', 2000, problems);
  const cooldownMs = parseMs(env, 'COOLDOWN_MS', 30_000, problems);
  // NaN comparisons are false, so a malformed value never adds this second, confusing problem.
  if (staggerMinMs > staggerMaxMs) {
    problems.push(`STAGGER_MIN_MS (${staggerMinMs}) must not be greater than STAGGER_MAX_MS (${staggerMaxMs})`);
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return { botTokens, guildId, triggerUserIds: new Set(triggerUserIds), staggerMinMs, staggerMaxMs, cooldownMs };
}
```

- [ ] **Step 8: Run the tests and the type-check**

Run: `npm test && npm run typecheck`
Expected: `Test Files 2 passed (2)` and `Tests 24 passed (24)`, then `tsc` exits 0 with no output.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts .env.example src/errors.ts src/log.ts src/config.ts test/log.test.ts test/config.test.ts
git commit -m "feat: scaffold project with config loading and logger" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Join schedule

**Files:**
- Create: `src/schedule.ts`
- Test: `test/schedule.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Slot<T> { item: T; joinDelayMs: number }`
  - `buildSchedule<T>(items: readonly T[], minMs: number, maxMs: number, rng: () => number): Slot<T>[]`

  Every gap, including the first, is a whole number of milliseconds within `[minMs, maxMs]`.

- [ ] **Step 1: Write the failing test**

`test/schedule.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildSchedule } from '../src/schedule.js';

/** Small deterministic PRNG so the tests are repeatable. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ITEMS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

describe('buildSchedule', () => {
  it('includes every item exactly once', () => {
    const slots = buildSchedule(ITEMS, 1000, 2000, mulberry32(1));
    expect(slots.map((s) => s.item).sort()).toEqual(ITEMS);
  });

  it('keeps the first join delay and every gap within [min, max], and never goes backwards', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const slots = buildSchedule(ITEMS, 1000, 2000, mulberry32(seed));
      let previous = 0;
      for (const { joinDelayMs } of slots) {
        const gap = joinDelayMs - previous;
        expect(gap).toBeGreaterThanOrEqual(1000);
        expect(gap).toBeLessThanOrEqual(2000);
        expect(Number.isInteger(joinDelayMs)).toBe(true);
        previous = joinDelayMs;
      }
    }
  });

  it('spaces joins exactly when min equals max', () => {
    const slots = buildSchedule(['a', 'b', 'c', 'd'], 1500, 1500, mulberry32(7));
    expect(slots.map((s) => s.joinDelayMs)).toEqual([1500, 3000, 4500, 6000]);
  });

  it('shuffles the order', () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) {
      orders.add(buildSchedule(ITEMS, 1000, 2000, mulberry32(seed)).map((s) => s.item).join(''));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('handles a single item and an empty list', () => {
    expect(buildSchedule(['solo'], 1000, 2000, () => 0)).toEqual([{ item: 'solo', joinDelayMs: 1000 }]);
    expect(buildSchedule([], 1000, 2000, () => 0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/schedule.test.ts`
Expected: FAIL, because it can't resolve `../src/schedule.js`.

- [ ] **Step 3: Implement `src/schedule.ts`**

```ts
export interface Slot<T> {
  item: T;
  /** Milliseconds after launch at which this item starts joining. */
  joinDelayMs: number;
}

/**
 * Shuffles `items` (Fisher-Yates) and gives each a cumulative join delay:
 * every gap, including the first, is a whole number of ms drawn from [minMs, maxMs].
 */
export function buildSchedule<T>(items: readonly T[], minMs: number, maxMs: number, rng: () => number): Slot<T>[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  let at = 0;
  return shuffled.map((item) => {
    at += Math.round(minMs + rng() * (maxMs - minMs));
    return { item, joinDelayMs: at };
  });
}
```

Round each *gap*, not the running total. Rounding the total can push a gap to `min - 1` or `max + 1`, which breaks the range test.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/schedule.test.ts && npm run typecheck`
Expected: `Tests 5 passed (5)`, and `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/schedule.ts test/schedule.test.ts
git commit -m "feat: add shuffled join schedule with cumulative stagger" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Swarm gate

**Files:**
- Create: `src/gate.ts`
- Test: `test/gate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Acquire = { ok: true } | { ok: false; reason: 'busy' } | { ok: false; reason: 'cooldown'; remainingMs: number }`
  - `class SwarmGate { constructor(cooldownMs: number, now?: () => number); tryAcquire(): Acquire; release(): void }`

- [ ] **Step 1: Write the failing test**

`test/gate.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SwarmGate } from '../src/gate.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('SwarmGate', () => {
  it('allows the first swarm', () => {
    expect(new SwarmGate(30_000, clock().now).tryAcquire()).toEqual({ ok: true });
  });

  it('reports busy while a swarm is running', () => {
    const gate = new SwarmGate(30_000, clock().now);
    gate.tryAcquire();
    expect(gate.tryAcquire()).toEqual({ ok: false, reason: 'busy' });
  });

  it('reports the remaining cooldown after release, then allows again once it has elapsed', () => {
    const c = clock(1_000);
    const gate = new SwarmGate(30_000, c.now);
    gate.tryAcquire();
    gate.release();
    expect(gate.tryAcquire()).toEqual({ ok: false, reason: 'cooldown', remainingMs: 30_000 });
    c.advance(10_000);
    expect(gate.tryAcquire()).toEqual({ ok: false, reason: 'cooldown', remainingMs: 20_000 });
    c.advance(20_000);
    expect(gate.tryAcquire()).toEqual({ ok: true });
  });

  it('allows again immediately when the cooldown is 0', () => {
    const gate = new SwarmGate(0, clock().now);
    gate.tryAcquire();
    gate.release();
    expect(gate.tryAcquire()).toEqual({ ok: true });
  });

  it('ignores release when nothing is running', () => {
    const gate = new SwarmGate(30_000, clock().now);
    gate.release();
    expect(gate.tryAcquire()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/gate.test.ts`
Expected: FAIL, because it can't resolve `../src/gate.js`.

- [ ] **Step 3: Implement `src/gate.ts`**

```ts
export type Acquire =
  | { ok: true }
  | { ok: false; reason: 'busy' }
  | { ok: false; reason: 'cooldown'; remainingMs: number };

/** Allows one swarm at a time, then enforces a cooldown after each one. */
export class SwarmGate {
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private running = false;
  private cooldownUntil = 0;

  constructor(cooldownMs: number, now: () => number = Date.now) {
    this.cooldownMs = cooldownMs;
    this.now = now;
  }

  tryAcquire(): Acquire {
    if (this.running) return { ok: false, reason: 'busy' };
    const remainingMs = this.cooldownUntil - this.now();
    if (remainingMs > 0) return { ok: false, reason: 'cooldown', remainingMs };
    this.running = true;
    return { ok: true };
  }

  /** Ends the running swarm and starts the cooldown. Does nothing if no swarm is running. */
  release(): void {
    if (!this.running) return;
    this.running = false;
    this.cooldownUntil = this.now() + this.cooldownMs;
  }
}
```

Use explicit fields rather than constructor parameter properties, so the file stays compatible with type-stripping runners.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/gate.test.ts && npm run typecheck`
Expected: `Tests 5 passed (5)`, and `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/gate.ts test/gate.test.ts
git commit -m "feat: add swarm gate with busy lock and cooldown" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Voice rules (`shouldTrigger`, `hasHumans`)

**Files:**
- Create: `src/triggers.ts` (pure part only; Task 8 adds the handlers)
- Test: `test/triggers.test.ts`

**Interfaces:**
- Consumes: `Config` (type only) from `src/config.ts`.
- Produces:
  - `interface VoiceTransition { guildId: string; userId: string; isBot: boolean; oldChannelId: string | null; newChannelId: string | null; newChannelIsVoice: boolean; afkChannelId: string | null }`
  - `shouldTrigger(t: VoiceTransition, cfg: Pick<Config, 'guildId' | 'triggerUserIds'>): boolean`
  - `interface Occupant { userId: string; channelId: string | null; isBot: boolean | undefined }`
  - `hasHumans(occupants: Iterable<Occupant>, channelId: string, fleetIds: ReadonlySet<string>): boolean`

- [ ] **Step 1: Write the failing test**

`test/triggers.test.ts`. The `hasHumans` cases are Review Focus #3.
```ts
import { describe, expect, it } from 'vitest';
import { hasHumans, shouldTrigger, type VoiceTransition } from '../src/triggers.js';

const GUILD = '111111111111111111';
const OWNER = '222222222222222222';
const CFG = { guildId: GUILD, triggerUserIds: new Set([OWNER]) };

const join: VoiceTransition = {
  guildId: GUILD,
  userId: OWNER,
  isBot: false,
  oldChannelId: null,
  newChannelId: 'vc1',
  newChannelIsVoice: true,
  afkChannelId: 'afk',
};

describe('shouldTrigger', () => {
  it('triggers when a trigger user joins voice from nowhere', () => {
    expect(shouldTrigger(join, CFG)).toBe(true);
  });

  it.each<[string, Partial<VoiceTransition>]>([
    ['switching channels', { oldChannelId: 'vc0' }],
    ['mute/deafen/stream toggles in the same channel', { oldChannelId: 'vc1' }],
    ['leaving voice', { oldChannelId: 'vc1', newChannelId: null }],
    ['a user who is not a trigger user', { userId: '999999999999999999' }],
    ['a bot', { isBot: true }],
    ['a different server', { guildId: '444444444444444444' }],
    ['joining the AFK channel', { newChannelId: 'afk' }],
    ['joining a stage channel', { newChannelIsVoice: false }],
  ])('does not trigger for %s', (_label, change) => {
    expect(shouldTrigger({ ...join, ...change }, CFG)).toBe(false);
  });
});

describe('hasHumans', () => {
  const FLEET = new Set(['bot1', 'bot2']);

  it('is true when a non-bot user is in the channel', () => {
    expect(hasHumans([{ userId: OWNER, channelId: 'vc1', isBot: false }], 'vc1', FLEET)).toBe(true);
  });

  it('counts a user whose member is not cached as human', () => {
    expect(hasHumans([{ userId: OWNER, channelId: 'vc1', isBot: undefined }], 'vc1', FLEET)).toBe(true);
  });

  it('ignores our own bots even if their member is not cached', () => {
    expect(hasHumans([{ userId: 'bot1', channelId: 'vc1', isBot: undefined }], 'vc1', FLEET)).toBe(false);
  });

  it('ignores other bots such as music bots', () => {
    expect(hasHumans([{ userId: 'music', channelId: 'vc1', isBot: true }], 'vc1', FLEET)).toBe(false);
  });

  it('ignores people in other channels', () => {
    expect(hasHumans([{ userId: OWNER, channelId: 'vc2', isBot: false }], 'vc1', FLEET)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/triggers.test.ts`
Expected: FAIL, because it can't resolve `../src/triggers.js`.

- [ ] **Step 3: Implement `src/triggers.ts`**

```ts
import type { Config } from './config.js';

export interface VoiceTransition {
  guildId: string;
  userId: string;
  isBot: boolean;
  oldChannelId: string | null;
  newChannelId: string | null;
  /** True only for regular voice channels (not stage channels). */
  newChannelIsVoice: boolean;
  afkChannelId: string | null;
}

/** True only when a trigger user moves from no voice channel into a regular, non-AFK voice channel. */
export function shouldTrigger(t: VoiceTransition, cfg: Pick<Config, 'guildId' | 'triggerUserIds'>): boolean {
  return (
    t.guildId === cfg.guildId &&
    cfg.triggerUserIds.has(t.userId) &&
    !t.isBot &&
    t.oldChannelId === null &&
    t.newChannelId !== null &&
    t.newChannelIsVoice &&
    t.newChannelId !== t.afkChannelId
  );
}

export interface Occupant {
  userId: string;
  channelId: string | null;
  /** undefined when the member is not cached; treated as human. */
  isBot: boolean | undefined;
}

/** True if anyone other than our own bots, and other than known bots, is in the channel. */
export function hasHumans(occupants: Iterable<Occupant>, channelId: string, fleetIds: ReadonlySet<string>): boolean {
  for (const o of occupants) {
    if (o.channelId === channelId && !fleetIds.has(o.userId) && o.isBot !== true) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/triggers.test.ts && npm run typecheck`
Expected: `Tests 14 passed (14)`, and `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/triggers.ts test/triggers.test.ts
git commit -m "feat: add join-trigger and humans-present rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Swarm orchestration

**Files:**
- Create: `src/types.ts`, `src/swarm.ts`
- Test: `test/swarm.test.ts`

**Interfaces:**
- Consumes:
  - `SwarmGate`, `Acquire` (Task 3)
  - `buildSchedule` (Task 2)
  - `Logger`, `createLogger` (Task 1)
  - `toError` (Task 1)
- Produces:
  - `interface Bot { name: string; client: Client<true> }` (`src/types.ts`)
  - `type PlayResult = { status: 'played' } | { status: 'skipped'; reason: string } | { status: 'failed'; error: Error }` (`src/types.ts`)
  - `interface SwarmDeps<B extends { name: string }> { bots: readonly B[]; gate: SwarmGate; play: (bot: B, channelId: string) => Promise<PlayResult>; channelHasHumans: (channelId: string) => boolean; rng: () => number; staggerMinMs: number; staggerMaxMs: number; log: Logger }`
  - `interface Swarm { launch(channelId: string): Acquire; cancelAll(): void }`
  - `createSwarm<B extends { name: string }>(deps: SwarmDeps<B>): Swarm`

- [ ] **Step 1: Create `src/types.ts`**

This file is types only, so there's nothing to test.
```ts
import type { Client } from 'discord.js';

export interface Bot {
  name: string;
  client: Client<true>;
}

export type PlayResult =
  | { status: 'played' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: Error };
```

- [ ] **Step 2: Write the failing test**

`test/swarm.test.ts`. This uses Vitest fake timers. `flush()` exists because the `allSettled(...).finally(...)` chain needs a few microtask turns after the last `play` settles.
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwarmGate } from '../src/gate.js';
import { createLogger } from '../src/log.js';
import { createSwarm, type SwarmDeps } from '../src/swarm.js';
import type { PlayResult } from '../src/types.js';

type FakeBot = { name: string };
const BOTS: FakeBot[] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];

/** Let queued promise callbacks run (fake timers do not advance microtasks on their own). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup(overrides: Partial<SwarmDeps<FakeBot>> = {}) {
  const lines: string[] = [];
  const calls: { bot: string; at: number }[] = [];
  const gate = new SwarmGate(30_000);
  const play = vi.fn(async (bot: FakeBot, _channelId: string): Promise<PlayResult> => {
    calls.push({ bot: bot.name, at: Date.now() });
    return { status: 'played' };
  });
  const swarm = createSwarm<FakeBot>({
    bots: BOTS,
    gate,
    play,
    channelHasHumans: () => true,
    rng: () => 0, // every gap is exactly staggerMinMs
    staggerMinMs: 1000,
    staggerMaxMs: 2000,
    log: createLogger((line) => lines.push(line)),
    ...overrides,
  });
  return { swarm, gate, play, calls, lines };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createSwarm', () => {
  it('starts each bot at its scheduled join delay', async () => {
    const { swarm, calls } = setup();
    expect(swarm.launch('vc1')).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.map((c) => c.at)).toEqual([1000, 2000, 3000]);
    expect(calls.map((c) => c.bot).sort()).toEqual(['a', 'b', 'c']);
  });

  it('passes the channel to every play call', async () => {
    const { swarm, play } = setup();
    swarm.launch('vc1');
    await vi.advanceTimersByTimeAsync(3000);
    expect(play.mock.calls.map(([, channelId]) => channelId)).toEqual(['vc1', 'vc1', 'vc1']);
  });

  it('refuses a second launch while one is running', async () => {
    const { swarm, play } = setup();
    swarm.launch('vc1');
    expect(swarm.launch('vc2')).toEqual({ ok: false, reason: 'busy' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(play).toHaveBeenCalledTimes(3);
  });

  it('stays busy until the last bot settles, then starts the cooldown', async () => {
    let finishLast!: () => void;
    const { swarm } = setup({
      play: (bot) =>
        new Promise<PlayResult>((resolve) => {
          if (bot.name === 'a') finishLast = () => resolve({ status: 'played' });
          else resolve({ status: 'played' });
        }),
    });
    swarm.launch('vc1');
    await vi.advanceTimersByTimeAsync(3000);
    expect(swarm.launch('vc1')).toEqual({ ok: false, reason: 'busy' });
    finishLast();
    await flush();
    expect(swarm.launch('vc1')).toEqual({ ok: false, reason: 'cooldown', remainingMs: 30_000 });
  });

  it('releases the gate even when bots fail or throw', async () => {
    let n = 0;
    const { swarm, lines } = setup({
      play: async () => {
        n++;
        if (n === 1) return { status: 'failed', error: new Error('boom') };
        if (n === 2) throw new Error('kaboom');
        return { status: 'played' };
      },
    });
    swarm.launch('vc1');
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(swarm.launch('vc1')).toMatchObject({ ok: false, reason: 'cooldown' });
    expect(lines.filter((l) => l.includes('bot.failed'))).toHaveLength(2);
  });

  it('skips bots whose turn comes after everyone has left the channel', async () => {
    let humans = true;
    const { swarm, play, lines } = setup({ channelHasHumans: () => humans });
    swarm.launch('vc1');
    await vi.advanceTimersByTimeAsync(1000);
    humans = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(play).toHaveBeenCalledTimes(1);
    expect(lines.filter((l) => l.includes('channel has no humans'))).toHaveLength(2);
  });

  it('cancelAll stops pending bots and still releases the gate', async () => {
    const { swarm, play } = setup();
    swarm.launch('vc1');
    await vi.advanceTimersByTimeAsync(1000);
    swarm.cancelAll();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(play).toHaveBeenCalledTimes(1);
    expect(swarm.launch('vc1')).toMatchObject({ ok: false, reason: 'cooldown' });
  });

  it('logs a refusal with the remaining cooldown', async () => {
    const { swarm, lines } = setup();
    swarm.launch('vc1');
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    vi.setSystemTime(5000);
    expect(swarm.launch('vc1')).toEqual({ ok: false, reason: 'cooldown', remainingMs: 28_000 });
    expect(lines.at(-1)).toMatch(/swarm\.refused channel=vc1 reason=cooldown remainingMs=28000$/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/swarm.test.ts`
Expected: FAIL, because it can't resolve `../src/swarm.js`.

- [ ] **Step 4: Implement `src/swarm.ts`**

```ts
import { toError } from './errors.js';
import type { Acquire, SwarmGate } from './gate.js';
import type { Logger } from './log.js';
import { buildSchedule } from './schedule.js';
import type { PlayResult } from './types.js';

export interface SwarmDeps<B extends { name: string }> {
  bots: readonly B[];
  gate: SwarmGate;
  /** Joins the channel, plays the clip, leaves. Expected never to throw, but a throw is contained. */
  play: (bot: B, channelId: string) => Promise<PlayResult>;
  channelHasHumans: (channelId: string) => boolean;
  rng: () => number;
  staggerMinMs: number;
  staggerMaxMs: number;
  log: Logger;
}

export interface Swarm {
  /** Returns immediately; the swarm runs in the background. */
  launch(channelId: string): Acquire;
  /** Clears every pending join timer (used on shutdown). */
  cancelAll(): void;
}

export function createSwarm<B extends { name: string }>(deps: SwarmDeps<B>): Swarm {
  const pending = new Set<() => void>();

  function logResult(bot: B, result: PlayResult): void {
    if (result.status === 'played') deps.log.info('bot.played', { bot: bot.name });
    else if (result.status === 'skipped') deps.log.warn('bot.skipped', { bot: bot.name, reason: result.reason });
    else deps.log.error('bot.failed', { bot: bot.name, error: result.error.message });
  }

  function runBot(bot: B, channelId: string, joinDelayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const cancel = () => {
        clearTimeout(timer);
        pending.delete(cancel);
        resolve();
      };
      const timer = setTimeout(async () => {
        pending.delete(cancel);
        try {
          if (!deps.channelHasHumans(channelId)) {
            deps.log.info('bot.skipped', { bot: bot.name, reason: 'channel has no humans' });
            return;
          }
          logResult(bot, await deps.play(bot, channelId));
        } catch (err) {
          deps.log.error('bot.failed', { bot: bot.name, error: toError(err).message });
        } finally {
          resolve();
        }
      }, joinDelayMs);
      pending.add(cancel);
    });
  }

  return {
    launch(channelId) {
      const acquired = deps.gate.tryAcquire();
      if (!acquired.ok) {
        deps.log.info('swarm.refused', {
          channel: channelId,
          reason: acquired.reason,
          remainingMs: acquired.reason === 'cooldown' ? acquired.remainingMs : undefined,
        });
        return acquired;
      }
      const slots = buildSchedule(deps.bots, deps.staggerMinMs, deps.staggerMaxMs, deps.rng);
      deps.log.info('swarm.launch', { channel: channelId, bots: slots.length });
      void Promise.allSettled(slots.map((slot) => runBot(slot.item, channelId, slot.joinDelayMs))).finally(() => {
        deps.gate.release();
        deps.log.info('swarm.done', { channel: channelId });
      });
      return acquired;
    },
    cancelAll() {
      for (const cancel of [...pending]) cancel();
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/swarm.test.ts && npm run typecheck`
Expected: `Tests 8 passed (8)`, and `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/swarm.ts test/swarm.test.ts
git commit -m "feat: add swarm orchestration with staggered join timers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Player (`playOnce`)

**Files:**
- Create: `src/player.ts`
- Test: `test/player.test.ts`

**Interfaces:**
- Consumes: `Bot`, `PlayResult` (Task 5); `toError` (Task 1).
- Produces:
  - `interface PlayOptions { readyTimeoutMs?: number; playbackTimeoutMs?: number }`
  - `playOnce(bot: Bot, channelId: string, clip: Buffer, opts?: PlayOptions): Promise<PlayResult>`

  `playOnce` never throws. Its defaults are 10 000 ms for Ready and 30 000 ms for playback.

**Why this is tested against fakes:** the fakes reproduce the two real behaviours that cause the worst bugs. First, `VoiceConnection.destroy()` throws if the connection is already destroyed. Second, an `EventEmitter` that emits `error` with no listener throws, which would crash the process. The rest of `@discordjs/voice` is the real library: the tests use the real `entersState` and only mock `joinVoiceChannel`, `createAudioPlayer` and `createAudioResource`.

- [ ] **Step 1: Write the failing test**

`test/player.test.ts`. The two "does not crash" tests are Review Focus #1, and "already destroyed elsewhere" is Review Focus #2.
```ts
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import { playOnce } from '../src/player.js';
import type { Bot } from '../src/types.js';

vi.mock('@discordjs/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@discordjs/voice')>();
  return { ...actual, joinVoiceChannel: vi.fn(), createAudioPlayer: vi.fn(), createAudioResource: vi.fn() };
});

/** Mimics VoiceConnection: emits the new status as an event, and destroy() throws if already destroyed. */
class FakeConnection extends EventEmitter {
  state: { status: VoiceConnectionStatus } = { status: VoiceConnectionStatus.Signalling };
  subscribe = vi.fn();
  destroy = vi.fn(() => {
    if (this.state.status === VoiceConnectionStatus.Destroyed) throw new Error('already destroyed');
    this.setStatus(VoiceConnectionStatus.Destroyed);
  });
  setStatus(status: VoiceConnectionStatus): void {
    const oldState = this.state;
    this.state = { status };
    this.emit('stateChange', oldState, this.state);
    this.emit(status, oldState, this.state);
  }
}

class FakePlayer extends EventEmitter {
  state: { status: AudioPlayerStatus } = { status: AudioPlayerStatus.Idle };
  play = vi.fn(() => this.setStatus(AudioPlayerStatus.Playing));
  stop = vi.fn();
  setStatus(status: AudioPlayerStatus): void {
    const oldState = this.state;
    this.state = { status };
    this.emit(status, oldState, this.state);
  }
}

const later = (fn: () => void) => setTimeout(fn, 1);
const CLIP = Buffer.from('fake-ogg');
const FAST = { readyTimeoutMs: 50, playbackTimeoutMs: 50 };

function voiceChannel(overrides: Record<string, unknown> = {}) {
  return {
    type: ChannelType.GuildVoice,
    joinable: true,
    speakable: true,
    full: false,
    guild: { id: 'g1', voiceAdapterCreator: vi.fn() },
    ...overrides,
  };
}

function fakeBot(channel?: object): Bot {
  const cache = new Map<string, object>(channel ? [['c1', channel]] : []);
  return { name: 'bot1', client: { user: { id: '999' }, channels: { cache } } } as unknown as Bot;
}

let conn: FakeConnection;
let player: FakePlayer;

beforeEach(() => {
  vi.clearAllMocks();
  conn = new FakeConnection();
  player = new FakePlayer();
  vi.mocked(joinVoiceChannel).mockImplementation(() => conn as unknown as VoiceConnection);
  vi.mocked(createAudioPlayer).mockImplementation(() => player as unknown as AudioPlayer);
  vi.mocked(createAudioResource).mockImplementation((() => ({})) as never);
});

describe('playOnce pre-checks', () => {
  it.each<[string, object | undefined, string]>([
    ['the channel is not visible', undefined, 'channel not visible to this bot'],
    ['it is a stage channel', voiceChannel({ type: ChannelType.GuildStageVoice }), 'not a regular voice channel'],
    ['the channel is full', voiceChannel({ joinable: false, full: true }), 'channel is full'],
    ['it lacks Connect', voiceChannel({ joinable: false }), 'missing View Channel or Connect permission'],
    ['it lacks Speak', voiceChannel({ speakable: false }), 'missing Speak permission'],
  ])('skips without joining when %s', async (_label, channel, reason) => {
    expect(await playOnce(fakeBot(channel), 'c1', CLIP, FAST)).toEqual({ status: 'skipped', reason });
    expect(joinVoiceChannel).not.toHaveBeenCalled();
  });
});

describe('playOnce', () => {
  it('joins with its own group, plays the clip as Ogg Opus once ready, then leaves', async () => {
    later(() => conn.setStatus(VoiceConnectionStatus.Ready));
    player.play.mockImplementation(() => {
      player.setStatus(AudioPlayerStatus.Playing);
      later(() => player.setStatus(AudioPlayerStatus.Idle));
    });

    expect(await playOnce(fakeBot(voiceChannel()), 'c1', CLIP, FAST)).toEqual({ status: 'played' });
    expect(joinVoiceChannel).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'c1', guildId: 'g1', group: '999', selfDeaf: true, selfMute: false }),
    );
    expect(createAudioResource).toHaveBeenCalledWith(expect.anything(), { inputType: StreamType.OggOpus });
    expect(conn.subscribe).toHaveBeenCalledWith(player);
    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it('fails and leaves when the connection never becomes ready', async () => {
    const result = await playOnce(fakeBot(voiceChannel()), 'c1', CLIP, FAST);
    expect(result.status).toBe('failed');
    expect(player.play).not.toHaveBeenCalled();
    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it('fails and leaves when playback does not finish in time', async () => {
    later(() => conn.setStatus(VoiceConnectionStatus.Ready));
    const result = await playOnce(fakeBot(voiceChannel()), 'c1', CLIP, FAST);
    expect(result).toMatchObject({ status: 'failed', error: { message: 'playback did not finish within 50ms' } });
    expect(player.stop).toHaveBeenCalledWith(true);
    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it('fails (without crashing) when the audio player emits an error', async () => {
    later(() => conn.setStatus(VoiceConnectionStatus.Ready));
    player.play.mockImplementation(() => {
      player.setStatus(AudioPlayerStatus.Playing);
      later(() => player.emit('error', new Error('bad clip')));
    });
    const result = await playOnce(fakeBot(voiceChannel()), 'c1', CLIP, FAST);
    expect(result).toMatchObject({ status: 'failed', error: { message: 'bad clip' } });
    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it('fails (without crashing) when the connection emits an error while joining', async () => {
    later(() => conn.emit('error', new Error('udp blocked')));
    const result = await playOnce(fakeBot(voiceChannel()), 'c1', CLIP, FAST);
    expect(result).toMatchObject({ status: 'failed', error: { message: 'udp blocked' } });
    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not crash when the connection emits an error mid-clip', async () => {
    later(() => conn.setStatus(VoiceConnectionStatus.Ready));
    player.play.mockImplementation(() => {
      player.setStatus(AudioPlayerStatus.Playing);
      later(() => {
        conn.emit('error', new Error('socket hiccup'));
        later(() => player.setStatus(AudioPlayerStatus.Idle));
      });
    });
    expect(await playOnce(fakeBot(voiceChannel()), 'c1', CLIP, FAST)).toEqual({ status: 'played' });
  });

  it('does not crash when the audio player emits an error after playback ended', async () => {
    later(() => conn.setStatus(VoiceConnectionStatus.Ready));
    player.play.mockImplementation(() => {
      player.setStatus(AudioPlayerStatus.Playing);
      later(() => {
        player.setStatus(AudioPlayerStatus.Idle);
        later(() => player.emit('error', new Error('late error')));
      });
    });
    expect(await playOnce(fakeBot(voiceChannel()), 'c1', CLIP, FAST)).toEqual({ status: 'played' });
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the late error fire
  });

  it('fails when the bot is disconnected mid-clip', async () => {
    later(() => conn.setStatus(VoiceConnectionStatus.Ready));
    player.play.mockImplementation(() => {
      player.setStatus(AudioPlayerStatus.Playing);
      later(() => conn.setStatus(VoiceConnectionStatus.Disconnected));
    });
    const result = await playOnce(fakeBot(voiceChannel()), 'c1', CLIP, FAST);
    expect(result).toMatchObject({ status: 'failed', error: { message: 'voice connection lost during playback' } });
    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the connection was already destroyed elsewhere (e.g. by shutdown)', async () => {
    later(() => conn.setStatus(VoiceConnectionStatus.Ready));
    player.play.mockImplementation(() => {
      player.setStatus(AudioPlayerStatus.Playing);
      later(() => conn.destroy());
    });
    const result = await playOnce(fakeBot(voiceChannel()), 'c1', CLIP, FAST);
    expect(result).toMatchObject({ status: 'failed', error: { message: 'voice connection lost during playback' } });
    expect(conn.destroy).toHaveBeenCalledTimes(1); // only the external call; playOnce did not destroy twice
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/player.test.ts`
Expected: FAIL, because it can't resolve `../src/player.js`.

- [ ] **Step 3: Implement `src/player.ts`**

```ts
import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import { ChannelType } from 'discord.js';
import { toError } from './errors.js';
import type { Bot, PlayResult } from './types.js';

export interface PlayOptions {
  readyTimeoutMs?: number;
  playbackTimeoutMs?: number;
}

function skipped(reason: string): PlayResult {
  return { status: 'skipped', reason };
}

/** Resolves when the player goes idle; rejects on player error, lost connection, or timeout. */
function waitForPlaybackEnd(player: AudioPlayer, connection: VoiceConnection, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onIdle = () => done();
    const onPlayerError = (err: Error) => done(err);
    const onConnectionLost = () => done(new Error('voice connection lost during playback'));
    const timer = setTimeout(() => done(new Error(`playback did not finish within ${timeoutMs}ms`)), timeoutMs);
    function done(err?: Error): void {
      clearTimeout(timer);
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onPlayerError);
      connection.off(VoiceConnectionStatus.Disconnected, onConnectionLost);
      connection.off(VoiceConnectionStatus.Destroyed, onConnectionLost);
      if (err) reject(err);
      else resolve();
    }
    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', onPlayerError);
    connection.on(VoiceConnectionStatus.Disconnected, onConnectionLost);
    connection.on(VoiceConnectionStatus.Destroyed, onConnectionLost);
  });
}

/** Joins the channel, plays the clip the moment the connection is ready, and always leaves. Never throws. */
export async function playOnce(bot: Bot, channelId: string, clip: Buffer, opts: PlayOptions = {}): Promise<PlayResult> {
  const { readyTimeoutMs = 10_000, playbackTimeoutMs = 30_000 } = opts;

  const channel = bot.client.channels.cache.get(channelId);
  if (!channel) return skipped('channel not visible to this bot');
  if (channel.type !== ChannelType.GuildVoice) return skipped('not a regular voice channel');
  if (!channel.joinable) return skipped(channel.full ? 'channel is full' : 'missing View Channel or Connect permission');
  if (!channel.speakable) return skipped('missing Speak permission');

  let connection: VoiceConnection | undefined;
  let player: AudioPlayer | undefined;
  let connectionError: Error | undefined;
  try {
    connection = joinVoiceChannel({
      channelId,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      group: bot.client.user.id, // one connection per bot, so bots in the same guild don't collide
      selfDeaf: true,
      selfMute: false,
    });
    // Without an 'error' listener, an emitted error would crash the whole process.
    connection.on('error', (err) => {
      connectionError = err;
    });
    await entersState(connection, VoiceConnectionStatus.Ready, readyTimeoutMs);

    player = createAudioPlayer();
    player.on('error', () => {}); // surfaced by waitForPlaybackEnd; this keeps a late error from crashing
    connection.subscribe(player);
    player.play(createAudioResource(Readable.from(clip), { inputType: StreamType.OggOpus }));
    await waitForPlaybackEnd(player, connection, playbackTimeoutMs);
    return { status: 'played' };
  } catch (err) {
    return { status: 'failed', error: connectionError ?? toError(err) };
  } finally {
    player?.stop(true);
    // destroy() throws if the connection was already destroyed (e.g. by shutdown), so check first.
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/player.test.ts && npm run typecheck`
Expected: `Tests 14 passed (14)`, with no "Unhandled Errors" section, and `tsc` exits 0.

- [ ] **Step 5: Check that the safety tests really bite**

These tests were checked against deliberately broken versions of the file while this plan was prepared, and this step re-confirms it.
1. Temporarily change the `finally` block's last line to `if (connection) connection.destroy();`.
2. Run `npx vitest run test/player.test.ts`. Expected: exactly 1 failure, "does not throw when the connection was already destroyed elsewhere".
3. Restore the line.
4. Temporarily delete both permanent `error` listeners: the `connection.on('error', …)` block and the `player.on('error', () => {})` line.
5. Run the same command. Expected: a failure plus an "Unhandled Errors" section.
6. Restore both, then run `npx vitest run test/player.test.ts`. Expected: 14 passed.

- [ ] **Step 6: Commit**

```bash
git add src/player.ts test/player.test.ts
git commit -m "feat: add playOnce voice player with pre-checks and guaranteed cleanup" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Fleet (log in all bots)

**Files:**
- Create: `src/fleet.ts`
- Test: `test/fleet.test.ts`

**Interfaces:**
- Consumes: `Bot` (Task 5); `Logger`, `toError` (Task 1).
- Produces:
  - `interface LoginAttempt { label: string; client?: Client<true>; error?: Error }`
  - `type FleetSelection = { fatal: string } | { bots: Bot[]; dropped: { label: string; reason: string }[] }`
  - `selectFleet(attempts: readonly LoginAttempt[], guildId: string): FleetSelection` (pure; `attempts[0]` is the leader)
  - `startFleet(tokens: readonly string[], guildId: string, log: Logger, readyTimeoutMs?: number): Promise<Bot[]>`

  `startFleet` throws `Error(fatal)` when the leader is unusable. It destroys every client it doesn't keep.

- [ ] **Step 1: Write the failing test**

`test/fleet.test.ts`. "is fatal when the leader is not in the server" is Review Focus #5.
```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/fleet.test.ts`
Expected: FAIL, because it can't resolve `../src/fleet.js`.

- [ ] **Step 3: Implement `src/fleet.ts`**

```ts
import { once } from 'node:events';
import { Client, Events, GatewayIntentBits, Options } from 'discord.js';
import { toError } from './errors.js';
import type { Logger } from './log.js';
import type { Bot } from './types.js';

export interface LoginAttempt {
  label: string;
  client?: Client<true>;
  error?: Error;
}

export type FleetSelection = { fatal: string } | { bots: Bot[]; dropped: { label: string; reason: string }[] };

const INVITE_HINT = 'run `npm run invite-links` and add it to the server';

/** Decides which logged-in clients make up the fleet. attempts[0] is the leader. */
export function selectFleet(attempts: readonly LoginAttempt[], guildId: string): FleetSelection {
  const [leader, ...followers] = attempts;
  if (!leader) return { fatal: 'no bot tokens were provided' };
  if (!leader.client) return { fatal: `leader (${leader.label}) failed to log in: ${leader.error?.message ?? 'unknown error'}` };
  if (!leader.client.guilds.cache.has(guildId)) {
    return { fatal: `leader (${leader.client.user.username}) is not in server ${guildId}; ${INVITE_HINT}` };
  }

  const bots: Bot[] = [{ name: leader.client.user.username, client: leader.client }];
  const dropped: { label: string; reason: string }[] = [];
  for (const attempt of followers) {
    if (!attempt.client) dropped.push({ label: attempt.label, reason: `failed to log in: ${attempt.error?.message ?? 'unknown error'}` });
    else if (!attempt.client.guilds.cache.has(guildId)) dropped.push({ label: attempt.client.user.username, reason: `not in server ${guildId}; ${INVITE_HINT}` });
    else bots.push({ name: attempt.client.user.username, client: attempt.client });
  }
  return { bots, dropped };
}

function createBotClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      PresenceManager: 0,
      ReactionManager: 0,
    }),
  });
}

async function loginOne(token: string, readyTimeoutMs: number): Promise<Client<true>> {
  const client = createBotClient();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`not ready within ${readyTimeoutMs}ms`)), readyTimeoutMs);
  const ready = once(client, Events.ClientReady, { signal: abort.signal });
  ready.catch(() => {}); // awaited below; this stops an early login failure leaving an unhandled rejection
  try {
    await client.login(token);
    await ready;
    if (!client.isReady()) throw new Error('client not ready after ClientReady');
    return client;
  } catch (err) {
    await client.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** Logs in every token concurrently. Throws if the leader cannot be used; drops unusable followers. */
export async function startFleet(tokens: readonly string[], guildId: string, log: Logger, readyTimeoutMs = 30_000): Promise<Bot[]> {
  const settled = await Promise.allSettled(tokens.map((token) => loginOne(token, readyTimeoutMs)));
  const attempts: LoginAttempt[] = settled.map((result, i) =>
    result.status === 'fulfilled'
      ? { label: `bot${i + 1}`, client: result.value }
      : { label: `bot${i + 1}`, error: toError(result.reason) },
  );

  const selection = selectFleet(attempts, guildId);
  const kept = new Set('fatal' in selection ? [] : selection.bots.map((bot) => bot.client));
  await Promise.allSettled(attempts.flatMap((a) => (a.client && !kept.has(a.client) ? [a.client.destroy()] : [])));

  if ('fatal' in selection) throw new Error(selection.fatal);
  for (const { label, reason } of selection.dropped) log.warn('fleet.bot_dropped', { bot: label, reason });
  log.info('fleet.ready', { bots: selection.bots.length, leader: selection.bots[0]?.name });
  return selection.bots;
}
```

`startFleet` and `loginOne` need a real Discord login, so they aren't unit-tested. Task 9 exercises the invalid-token path end to end, and Task 12 exercises a real login.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/fleet.test.ts && npm run typecheck`
Expected: `Tests 6 passed (6)`, and `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/fleet.ts test/fleet.test.ts
git commit -m "feat: add fleet login with leader-fatal and follower-drop rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `/yo` registration and leader handlers

**Files:**
- Create: `src/commands.ts`
- Modify: `src/triggers.ts`. Replace the whole file; the pure section from Task 4 is unchanged, and new imports and handlers are added around it.
- Test: `test/commands.test.ts`, `test/leader-handlers.test.ts`

**Interfaces:**
- Consumes:
  - `Config` (Task 1)
  - `Swarm` (Task 5)
  - `Logger`, `toError` (Task 1)
  - `shouldTrigger` (Task 4)
- Produces:
  - `YO_COMMAND = { name: 'yo', description: 'Summon the swarm' }`
  - `registerYoCommand(leader: Client<true>, guildId: string): Promise<void>`
  - `toTransition(oldState: VoiceState, newState: VoiceState): VoiceTransition`
  - `YO_REPLIES`
  - `handleYo(interaction: ChatInputCommandInteraction, swarm: Pick<Swarm, 'launch'>, log: Logger): Promise<void>`
  - `attachLeaderHandlers(leader: Client<true>, cfg: Pick<Config, 'guildId' | 'triggerUserIds'>, swarm: Pick<Swarm, 'launch'>, log: Logger): () => void` (returns a detach function)

- [ ] **Step 1: Write the failing tests**

`test/commands.test.ts`:
```ts
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
```

`test/leader-handlers.test.ts`:
```ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ChannelType, Events, MessageFlags, type ChatInputCommandInteraction, type Client, type VoiceState } from 'discord.js';
import type { Acquire } from '../src/gate.js';
import { createLogger } from '../src/log.js';
import { attachLeaderHandlers, handleYo, toTransition } from '../src/triggers.js';

const GUILD = '111111111111111111';
const OWNER = '222222222222222222';
const CFG = { guildId: GUILD, triggerUserIds: new Set([OWNER]) };
const log = createLogger(() => {});

function voiceState(channelId: string | null, opts: { type?: ChannelType; bot?: boolean; userId?: string } = {}): VoiceState {
  return {
    id: opts.userId ?? OWNER,
    guild: { id: GUILD, afkChannelId: 'afk' },
    member: { user: { bot: opts.bot ?? false } },
    channelId,
    channel: channelId === null ? null : { id: channelId, type: opts.type ?? ChannelType.GuildVoice },
  } as unknown as VoiceState;
}

function yoInteraction(channel: { id: string; type: ChannelType } | null, guildId = GUILD) {
  const reply = vi.fn(async () => undefined);
  const voiceStates = new Map(channel ? [[OWNER, { channel }]] : []);
  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'yo',
    guildId,
    user: { id: OWNER },
    guild: { voiceStates: { cache: voiceStates } },
    reply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply };
}

const swarmReturning = (result: Acquire) => ({ launch: vi.fn((_channelId: string) => result) });

describe('toTransition', () => {
  it('maps discord.js voice states to a plain transition', () => {
    expect(toTransition(voiceState(null), voiceState('vc1'))).toEqual({
      guildId: GUILD,
      userId: OWNER,
      isBot: false,
      oldChannelId: null,
      newChannelId: 'vc1',
      newChannelIsVoice: true,
      afkChannelId: 'afk',
    });
  });

  it('marks stage channels as not voice', () => {
    expect(toTransition(voiceState(null), voiceState('stage', { type: ChannelType.GuildStageVoice })).newChannelIsVoice).toBe(false);
  });
});

describe('handleYo', () => {
  it.each<[string, { id: string; type: ChannelType } | null]>([
    ['the caller is not in voice', null],
    ['the caller is in a stage channel', { id: 'stage', type: ChannelType.GuildStageVoice }],
  ])('asks the caller to join voice when %s', async (_label, channel) => {
    const swarm = swarmReturning({ ok: true });
    const { interaction, reply } = yoInteraction(channel);
    await handleYo(interaction, swarm, log);
    expect(swarm.launch).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
  });

  it.each<[string, Acquire, string]>([
    ['launched', { ok: true }, '🐝 incoming'],
    ['busy', { ok: false, reason: 'busy' }, 'Swarm already in flight 🐝'],
    ['cooling down', { ok: false, reason: 'cooldown', remainingMs: 12_001 }, 'Swarm is cooling down — try again in 13s.'],
  ])('replies privately when the swarm is %s', async (_label, result, content) => {
    const swarm = swarmReturning(result);
    const { interaction, reply } = yoInteraction({ id: 'vc1', type: ChannelType.GuildVoice });
    await handleYo(interaction, swarm, log);
    expect(swarm.launch).toHaveBeenCalledWith('vc1');
    expect(reply).toHaveBeenCalledWith({ content, flags: MessageFlags.Ephemeral });
  });
});

describe('attachLeaderHandlers', () => {
  function setup() {
    const leader = new EventEmitter();
    const swarm = swarmReturning({ ok: true });
    const detach = attachLeaderHandlers(leader as unknown as Client<true>, CFG, swarm, log);
    return { leader, swarm, detach };
  }

  it('launches the swarm when the owner joins voice', () => {
    const { leader, swarm } = setup();
    leader.emit(Events.VoiceStateUpdate, voiceState(null), voiceState('vc1'));
    expect(swarm.launch).toHaveBeenCalledWith('vc1');
  });

  it('ignores a join by someone else', () => {
    const { leader, swarm } = setup();
    leader.emit(Events.VoiceStateUpdate, voiceState(null, { userId: '999999999999999999' }), voiceState('vc1', { userId: '999999999999999999' }));
    expect(swarm.launch).not.toHaveBeenCalled();
  });

  it('handles /yo from the configured server and ignores other servers', async () => {
    const { leader, swarm } = setup();
    const here = yoInteraction({ id: 'vc1', type: ChannelType.GuildVoice });
    const elsewhere = yoInteraction({ id: 'vc9', type: ChannelType.GuildVoice }, '444444444444444444');
    leader.emit(Events.InteractionCreate, here.interaction);
    leader.emit(Events.InteractionCreate, elsewhere.interaction);
    await vi.waitFor(() => expect(here.reply).toHaveBeenCalled());
    expect(swarm.launch).toHaveBeenCalledTimes(1);
    expect(elsewhere.reply).not.toHaveBeenCalled();
  });

  it('stops reacting after detach', () => {
    const { leader, swarm, detach } = setup();
    detach();
    leader.emit(Events.VoiceStateUpdate, voiceState(null), voiceState('vc1'));
    expect(swarm.launch).not.toHaveBeenCalled();
    expect(leader.listenerCount(Events.InteractionCreate)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/commands.test.ts test/leader-handlers.test.ts`
Expected: FAIL. `commands.test.ts` can't resolve `../src/commands.js`. `leader-handlers.test.ts` fails because `attachLeaderHandlers`, `handleYo` and `toTransition` aren't exported.

- [ ] **Step 3: Implement `src/commands.ts`**

```ts
import type { Client } from 'discord.js';

export const YO_COMMAND = { name: 'yo', description: 'Summon the swarm' } as const;

/** Registers /yo on one server only (instant, unlike global commands). Overwrites, so it is safe on every start. */
export async function registerYoCommand(leader: Client<true>, guildId: string): Promise<void> {
  const guild = leader.guilds.cache.get(guildId);
  if (!guild) throw new Error(`leader is not in server ${guildId}`);
  await guild.commands.set([YO_COMMAND]);
}
```

- [ ] **Step 4: Replace `src/triggers.ts` with the full version**

```ts
import {
  ChannelType,
  Events,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type VoiceState,
} from 'discord.js';
import { YO_COMMAND } from './commands.js';
import type { Config } from './config.js';
import { toError } from './errors.js';
import type { Logger } from './log.js';
import type { Swarm } from './swarm.js';

export interface VoiceTransition {
  guildId: string;
  userId: string;
  isBot: boolean;
  oldChannelId: string | null;
  newChannelId: string | null;
  /** True only for regular voice channels (not stage channels). */
  newChannelIsVoice: boolean;
  afkChannelId: string | null;
}

/** True only when a trigger user moves from no voice channel into a regular, non-AFK voice channel. */
export function shouldTrigger(t: VoiceTransition, cfg: Pick<Config, 'guildId' | 'triggerUserIds'>): boolean {
  return (
    t.guildId === cfg.guildId &&
    cfg.triggerUserIds.has(t.userId) &&
    !t.isBot &&
    t.oldChannelId === null &&
    t.newChannelId !== null &&
    t.newChannelIsVoice &&
    t.newChannelId !== t.afkChannelId
  );
}

export interface Occupant {
  userId: string;
  channelId: string | null;
  /** undefined when the member is not cached; treated as human. */
  isBot: boolean | undefined;
}

/** True if anyone other than our own bots, and other than known bots, is in the channel. */
export function hasHumans(occupants: Iterable<Occupant>, channelId: string, fleetIds: ReadonlySet<string>): boolean {
  for (const o of occupants) {
    if (o.channelId === channelId && !fleetIds.has(o.userId) && o.isBot !== true) return true;
  }
  return false;
}

export function toTransition(oldState: VoiceState, newState: VoiceState): VoiceTransition {
  return {
    guildId: newState.guild.id,
    userId: newState.id,
    isBot: newState.member?.user.bot ?? false,
    oldChannelId: oldState.channelId,
    newChannelId: newState.channelId,
    newChannelIsVoice: newState.channel?.type === ChannelType.GuildVoice,
    afkChannelId: newState.guild.afkChannelId,
  };
}

export const YO_REPLIES = {
  notInVoice: 'Join a voice channel first.',
  busy: 'Swarm already in flight 🐝',
  cooldown: (remainingMs: number) => `Swarm is cooling down — try again in ${Math.ceil(remainingMs / 1000)}s.`,
  launched: '🐝 incoming',
} as const;

/** Handles /yo: launches the swarm into the caller's voice channel and replies privately. */
export async function handleYo(interaction: ChatInputCommandInteraction, swarm: Pick<Swarm, 'launch'>, log: Logger): Promise<void> {
  const channel = interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channel;
  let content: string;
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    content = YO_REPLIES.notInVoice;
  } else {
    const result = swarm.launch(channel.id);
    if (result.ok) content = YO_REPLIES.launched;
    else if (result.reason === 'busy') content = YO_REPLIES.busy;
    else content = YO_REPLIES.cooldown(result.remainingMs);
  }
  log.info('trigger.yo', { user: interaction.user.id, channel: channel?.id, reply: content });
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Wires the leader's voice and /yo handlers. Returns a function that removes them. */
export function attachLeaderHandlers(
  leader: Client<true>,
  cfg: Pick<Config, 'guildId' | 'triggerUserIds'>,
  swarm: Pick<Swarm, 'launch'>,
  log: Logger,
): () => void {
  const onVoiceStateUpdate = (oldState: VoiceState, newState: VoiceState) => {
    const t = toTransition(oldState, newState);
    if (!shouldTrigger(t, cfg) || t.newChannelId === null) return;
    log.info('trigger.join', { user: t.userId, channel: t.newChannelId });
    swarm.launch(t.newChannelId);
  };
  const onInteractionCreate = (interaction: Interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== YO_COMMAND.name) return;
    if (interaction.guildId !== cfg.guildId) return;
    handleYo(interaction, swarm, log).catch((err) => log.error('trigger.yo_reply_failed', { error: toError(err).message }));
  };
  leader.on(Events.VoiceStateUpdate, onVoiceStateUpdate);
  leader.on(Events.InteractionCreate, onInteractionCreate);
  return () => {
    leader.off(Events.VoiceStateUpdate, onVoiceStateUpdate);
    leader.off(Events.InteractionCreate, onInteractionCreate);
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: `Test Files 10 passed (10)` and `Tests 89 passed (89)`: the 76 from Tasks 1–7, plus `commands` 2 and `leader-handlers` 11. Then `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/commands.ts src/triggers.ts test/commands.test.ts test/leader-handlers.test.ts
git commit -m "feat: add /yo command and leader voice/interaction handlers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Entry point and placeholder clip

**Files:**
- Create: `src/index.ts`, `assets/yo.ogg`

**Interfaces:**
- Consumes everything above:
  - `loadConfig`, `ConfigError`, `Config`
  - `startFleet`
  - `SwarmGate`
  - `createSwarm`
  - `playOnce`
  - `registerYoCommand`
  - `attachLeaderHandlers`, `hasHumans`
  - `createLogger`, `toError`
- Produces: the runnable app (`npm run build && npm start`, or `npm run dev`).

`index.ts` is wiring and process handling, so it's verified by running it, not by unit tests.

- [ ] **Step 1: Implement `src/index.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getVoiceConnections, VoiceConnectionStatus } from '@discordjs/voice';
import { registerYoCommand } from './commands.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { toError } from './errors.js';
import { startFleet } from './fleet.js';
import { SwarmGate } from './gate.js';
import { createLogger } from './log.js';
import { playOnce } from './player.js';
import { createSwarm } from './swarm.js';
import { attachLeaderHandlers, hasHumans } from './triggers.js';

const CLIP_PATH = fileURLToPath(new URL('../assets/yo.ogg', import.meta.url));
const SHUTDOWN_TIMEOUT_MS = 5_000;

const log = createLogger();

process.on('unhandledRejection', (reason) => log.error('unhandled_rejection', { error: toError(reason).message }));
process.on('uncaughtException', (err) => {
  log.error('uncaught_exception', { error: err.message });
  process.exit(1);
});

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  let clip: Buffer;
  try {
    clip = await readFile(CLIP_PATH);
  } catch (err) {
    console.error(`Cannot read the sound clip at ${CLIP_PATH}: ${toError(err).message}`);
    process.exit(1);
  }

  const bots = await startFleet(config.botTokens, config.guildId, log);
  const leader = bots[0]!; // startFleet throws unless the leader is usable
  const fleetIds = new Set(bots.map((bot) => bot.client.user.id));

  const swarm = createSwarm({
    bots,
    gate: new SwarmGate(config.cooldownMs),
    play: (bot, channelId) => playOnce(bot, channelId, clip),
    channelHasHumans: (channelId) => {
      const guild = leader.client.guilds.cache.get(config.guildId);
      if (!guild) return false;
      const occupants = [...guild.voiceStates.cache.values()].map((state) => ({
        userId: state.id,
        channelId: state.channelId,
        isBot: state.member?.user.bot,
      }));
      return hasHumans(occupants, channelId, fleetIds);
    },
    rng: Math.random,
    staggerMinMs: config.staggerMinMs,
    staggerMaxMs: config.staggerMaxMs,
    log,
  });

  await registerYoCommand(leader.client, config.guildId);
  const detach = attachLeaderHandlers(leader.client, config, swarm, log);
  log.info('ready', { bots: bots.length, leader: leader.name });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown', { signal });
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
    detach();
    swarm.cancelAll();
    for (const bot of bots) {
      for (const connection of getVoiceConnections(bot.client.user.id)?.values() ?? []) {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      }
    }
    await Promise.allSettled(bots.map((bot) => bot.client.destroy()));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('startup_failed', { error: toError(err).message });
  process.exit(1);
});
```

- [ ] **Step 2: Build it and check the bad-config path**

Run:
```bash
npm run build && env -i PATH="$PATH" node dist/index.js; echo "exit=$?"
```
Expected:
```
Invalid configuration:
  - BOT_TOKENS is required (comma-separated bot tokens; the first is the leader)
  - GUILD_ID is required
  - TRIGGER_USER_IDS is required (comma-separated Discord user IDs)
exit=1
```

- [ ] **Step 3: Check the missing-clip path (before the clip exists)**

Run:
```bash
env -i PATH="$PATH" BOT_TOKENS=x GUILD_ID=111111111111111111 TRIGGER_USER_IDS=222222222222222222 node dist/index.js; echo "exit=$?"
```
Expected: `Cannot read the sound clip at …/assets/yo.ogg: ENOENT: …` followed by `exit=1`.

- [ ] **Step 4: Generate the placeholder clip**

Run:
```bash
mkdir -p assets && ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=880:duration=0.6" -af "volume=0.5" -c:a libopus -b:a 96k -ar 48000 -ac 2 assets/yo.ogg && ls -l assets/yo.ogg
```
Expected: a file of roughly 9–10 KB. FFmpeg is only needed here, on the developer machine, never at runtime.

- [ ] **Step 5: Check the invalid-token path (this contacts Discord's API with a fake token, which is harmless)**

Run:
```bash
FAKE="$(printf 123456789012345678 | base64).GhIjKl.fakefakefakefakefakefakefakefakefake"
env -i PATH="$PATH" BOT_TOKENS="$FAKE,$FAKE-2" GUILD_ID=111111111111111111 TRIGGER_USER_IDS=222222222222222222 node dist/index.js; echo "exit=$?"
```
Expected: one line ending `error startup_failed error="leader (bot1) failed to log in: An invalid token was provided."`, then `exit=1`. The token itself must not appear anywhere in the output.

- [ ] **Step 6: Check the dev runner**

Run:
```bash
printf 'GUILD_ID=abc\n' > .env && npm run dev --silent; echo "exit=$?"; rm .env
```
Expected: `Invalid configuration:` listing the `BOT_TOKENS` problem, `GUILD_ID must be a Discord ID (17-20 digits), got "abc"`, and the `TRIGGER_USER_IDS` problem, then `exit=1`.

- [ ] **Step 7: Run the full suite and the type-check**

Run: `npm test && npm run typecheck`
Expected: every test passes, and `tsc` exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts assets/yo.ogg
git commit -m "feat: add entry point with clip loading and graceful shutdown" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Invite links

**Files:**
- Create: `src/invite.ts`, `scripts/invite-links.ts`
- Test: `test/invite.test.ts`

**Interfaces:**
- Consumes: `parseTokens` (Task 1); `toError` (Task 1).
- Produces:
  - `INVITE_PERMISSIONS: bigint` (equals `3146752n`)
  - `applicationIdFromToken(token: string): string` (throws on non-tokens)
  - `inviteUrl(applicationId: string, isLeader: boolean): string`
  - `npm run invite-links`

- [ ] **Step 1: Write the failing test**

`test/invite.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/invite.test.ts`
Expected: FAIL, because it can't resolve `../src/invite.js`.

- [ ] **Step 3: Implement `src/invite.ts` and `scripts/invite-links.ts`**

`src/invite.ts`:
```ts
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
```

`scripts/invite-links.ts`:
```ts
import { parseTokens } from '../src/config.js';
import { toError } from '../src/errors.js';
import { applicationIdFromToken, inviteUrl } from '../src/invite.js';

const tokens = parseTokens(process.env.BOT_TOKENS);
if (tokens.length === 0) {
  console.error('BOT_TOKENS is empty. Put your bot tokens in .env first (see .env.example).');
  process.exit(1);
}

console.log('Open each link and add the bot to your server:\n');
tokens.forEach((token, i) => {
  const label = i === 0 ? `bot${i + 1} (leader)` : `bot${i + 1}`;
  try {
    console.log(`${label}: ${inviteUrl(applicationIdFromToken(token), i === 0)}`);
  } catch (err) {
    console.log(`${label}: could not read an application ID from this token (${toError(err).message})`);
    process.exitCode = 1;
  }
});
```

- [ ] **Step 4: Run the test, then the script**

Run: `npx vitest run test/invite.test.ts && npm run typecheck`
Expected: `Tests 5 passed (5)`, and `tsc` exits 0.

Run (no `.env` needed; the variable is passed inline):
```bash
FAKE="$(printf 123456789012345678 | base64).GhIjKl.fake"
BOT_TOKENS="Bot $FAKE, garbage" npx tsx scripts/invite-links.ts; echo "exit=$?"
```
Expected:
```
Open each link and add the bot to your server:

bot1 (leader): https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot%20applications.commands&permissions=3146752
bot2: could not read an application ID from this token (this does not look like a Discord bot token)
exit=1
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `Test Files 11 passed (11)` and `Tests 94 passed (94)`.

- [ ] **Step 6: Commit**

```bash
git add src/invite.ts scripts/invite-links.ts test/invite.test.ts
git commit -m "feat: add invite-links script" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docker image and README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `README.md`

**Interfaces:**
- Consumes: `npm run build` output (`dist/`), `assets/yo.ogg`, `package-lock.json`.
- Produces: an image that runs `node dist/index.js` as the `node` user; the setup and deploy docs.

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Fail the build here if the native DAVE (voice encryption) binary is missing for this platform.
RUN npm ci --omit=dev && npm cache clean --force && node -e "require('@snazzah/davey')"
COPY --from=build /app/dist ./dist
COPY assets ./assets
USER node
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create `.dockerignore`**

```
node_modules
dist
.env
.git
docs
test
scripts
```

- [ ] **Step 3: Build and run the image**

Run:
```bash
docker build -t discord-voice-goat:dev . && docker run --rm discord-voice-goat:dev; echo "exit=$?"
```
Expected: the build succeeds, including the `require('@snazzah/davey')` check in the runtime stage. The run prints the three `Invalid configuration` lines from Task 9 Step 2, then `exit=1`.

Run:
```bash
docker run --rm --entrypoint node discord-voice-goat:dev -e "import('@discordjs/voice').then(v=>console.log(v.generateDependencyReport()))"
```
Expected: the output includes `native crypto support for aes-256-gcm: yes` and `@snazzah/davey: 0.1.12`. The Opus libraries and FFmpeg show as not found, which is fine because none are needed.

Then clean up: `docker rmi discord-voice-goat:dev`.

- [ ] **Step 4: Create `README.md`**

````markdown
# discord-voice-goat

When you join a voice channel, a swarm of bots piles in one by one. Each bot joins 1–2 seconds after the one before it, plays the same sound bite as soon as it connects, and leaves. `/yo` summons the swarm to whatever voice channel you're in.

One Node process runs every bot. The first token is the **leader**: it watches for your voice join and owns `/yo`. Every bot, the leader included, joins the swarm. The full design is in [`docs/superpowers/specs/2026-09-23-discord-yo-swarm-design.md`](docs/superpowers/specs/2026-09-23-discord-yo-swarm-design.md).

## 1. Create the bots (one-time)

A Discord bot can only be in one voice channel per server, so every bot in the swarm needs its own application.

1. Go to <https://discord.com/developers/applications>. For each bot, click **New Application**.
2. On the app's **Bot** page, click **Reset Token** and copy the token. Giving each bot its own name and avatar makes the swarm funnier.
3. Leave **Presence Intent**, **Server Members Intent** and **Message Content Intent** off. The bots don't need them.
4. In Discord, turn on **User Settings → Advanced → Developer Mode**. Then right-click your server and choose **Copy Server ID**, and right-click yourself and choose **Copy User ID**.

## 2. Configure

```bash
cp .env.example .env
```

Fill in `.env`. Never commit it; it's git-ignored.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `BOT_TOKENS` | yes | — | Comma-separated bot tokens. The first is the leader. |
| `GUILD_ID` | yes | — | Your server's ID. |
| `TRIGGER_USER_IDS` | yes | — | Comma-separated user IDs whose voice join triggers the swarm. |
| `STAGGER_MIN_MS` | no | `1000` | Minimum gap between one bot joining and the next. |
| `STAGGER_MAX_MS` | no | `2000` | Maximum gap between one bot joining and the next. |
| `COOLDOWN_MS` | no | `30000` | Wait after a swarm before another can start. `0` turns it off. |

## 3. Invite the bots

```bash
npm install
npm run invite-links
```

This prints one invite link per bot. Open each link and add that bot to your server. The leader's link also grants slash commands.

## 4. The sound clip

The clip lives at `assets/yo.ogg`. The repo ships with a short placeholder beep. To use your own sound, convert it with FFmpeg (the `loudnorm` filter evens out the volume, which matters when 10 copies overlap):

```bash
ffmpeg -i input.mp3 -af loudnorm -c:a libopus -b:a 96k -ar 48000 -ac 2 assets/yo.ogg
```

Keep clips under 30 seconds, because each bot stops playing and leaves after 30 seconds.

## 5. Run locally

```bash
npm run dev
```

When it's working, the log shows `fleet.ready` and then `ready`.

## 6. Deploy on Dokploy

1. In Dokploy, create a project, then **Create Service → Application**.
2. Under **Provider**, choose **GitHub**, then pick `Jarvl/discord-voice-goat` and the `main` branch.
3. Set **Build Type** to **Dockerfile**.
4. In the **Environment** tab, paste the contents of your `.env`.
5. Don't add a domain or any ports; the bots only make outgoing connections.
6. Click **Deploy**. The Logs tab should show `fleet.ready` and `ready`.

The host must allow **outgoing UDP**, because Discord voice uses it. Most home routers allow this by default.

## Development

```bash
npm test           # unit tests (no Discord needed)
npm run typecheck  # type-check src, scripts and tests
npm run build      # compile to dist/
npm start          # run the compiled app
```

## Smoke-test checklist

Run through this with 2–3 bots on a test server after any change to the voice code:

1. Join a voice channel. The bots should join one at a time, 1–2 seconds apart. Each plays the clip as soon as it connects, then leaves.
2. Switch channels, then mute and unmute. Neither should trigger a swarm.
3. Run `/yo` while in a voice channel. The swarm should come to that channel.
4. Run `/yo` while not in voice. You should see "Join a voice channel first."
5. Run `/yo` during a swarm and again during the cooldown. You should see "Swarm already in flight 🐝" and then "Swarm is cooling down — try again in *N*s."
6. Set a user limit on a channel. The extra bots should be skipped cleanly; the logs show `bot.skipped reason="channel is full"`.
7. Leave the channel mid-swarm. The remaining bots shouldn't join; the logs show `reason="channel has no humans"`.
8. Redeploy in Dokploy mid-swarm. No bots should be left stuck in the channel.

## Troubleshooting

| Log line or symptom | Fix |
|---|---|
| `fleet.bot_dropped … not in server` | That bot was never invited. Run `npm run invite-links` and open its link. |
| `startup_failed … leader … failed to log in` | The first token in `BOT_TOKENS` is wrong. Reset it on the bot's Developer Portal page. |
| `bot.skipped reason="channel is full"` | Raise the channel's user limit, or give the bots the Move Members permission. |
| `bot.failed … within 10000ms` for every bot | Voice can't connect. Check that the host allows outgoing UDP. |
| Joining voice does nothing | Check that `TRIGGER_USER_IDS` contains your user ID. Only joining from *no* channel triggers it; switching channels doesn't. |
| `/yo` doesn't appear | Re-invite the leader (the first link from `npm run invite-links`) so it has the slash-command scope, then restart the app. |
````

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore README.md
git commit -m "feat: add Docker image and setup/deploy README" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Live smoke test with the owner (manual)

Only the owner can do this task: it needs real bot applications, the owner's server, and their Dokploy instance. **An agent executing the plan stops here and hands off**, giving the owner these steps and waiting for their results.

**Files:**
- Modify: `README.md`, only if a step turns out to differ from what it documents.

- [ ] **Step 1: The owner creates 3 bot applications and fills in `.env`**

Follow README sections 1 and 2. Start with 3 bots; you can scale to ~10 once this passes.

- [ ] **Step 2: The owner invites the bots**

Run: `npm run invite-links`, then open each link.
Expected: all 3 bots appear in the server's member list, offline.

- [ ] **Step 3: The owner runs the app locally**

Run: `npm run dev`
Expected: `fleet.ready bots=3 leader=<name>`, then `ready bots=3 …`, and no `fleet.bot_dropped` lines.

- [ ] **Step 4: The owner works through the README smoke-test checklist, items 1–7**

For each item, note pass or fail. On any failure, copy the relevant log lines.

- [ ] **Step 5: The owner deploys on Dokploy and checks item 8**

Follow README section 6. Then start a swarm and click **Redeploy** while it's running.
Expected: the log shows `shutdown signal=SIGTERM`, and no bots are left in the channel once the new container reports `ready`.

- [ ] **Step 6: Fix any README steps that turned out to be wrong, then commit**

```bash
git add README.md
git commit -m "docs: correct setup steps after live smoke test" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Skip this step if nothing changed.
