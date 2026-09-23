# Discord Yo Swarm — Design

- **Date:** 2026-09-23
- **Status:** Draft for review
- **Repo:** https://github.com/Jarvl/discord-voice-goat

## 1. Intent

**Requested**

- When the owner joins a voice channel on their Discord server, a swarm of ~10 bots joins that channel soon after, and each plays the same sound bite, staggered 1–2 s apart.
- A `/yo` slash command that plays the sound bite.

**Agreed during brainstorming**

- `/yo` summons the *whole swarm* into the invoker's current voice channel (same behaviour as the join trigger, on demand).
- The join trigger fires only for a configured set of user IDs (initially just the owner), not for anyone.
- Each bot leaves immediately after its own clip finishes.
- The owner supplies the clip, a few seconds long.
- Runs on the owner's always-on home machine, deployed with Dokploy.
- Written in TypeScript on Node.

**Success looks like**

- Fires every time the owner joins a voice channel.
- Looks and sounds like a chaotic swarm: bots visibly pop in one by one, each lighting up as it speaks, and roll back out.
- Runs unattended as a single container; a redeploy leaves no bots stranded in a channel.
- Bot count is configurable (start with 2–3 while testing, scale to ~10).

**Non-goals**

- Multiple servers.
- Multiple, random, or per-user clips.
- A web UI or dashboard.
- Persisting state across restarts (the cooldown resets on restart; acceptable).
- Sharding.

## 2. Platform constraints

- **One voice connection per bot per guild.** A Discord bot user can be in only one voice channel per guild, so N bots in one channel requires N Discord applications, each with its own token and each invited to the server.
- **Long-running process.** Voice needs a persistent gateway connection plus UDP audio, which rules out serverless platforms.
- **DAVE end-to-end encryption.** Discord requires DAVE on voice connections. The `@discordjs/voice` release used must support it; exact versions are verified and pinned in the implementation plan.
- **Guild-scoped commands.** Guild slash commands update instantly; global ones can take up to an hour. `/yo` is registered for the configured guild only.

## 3. Architecture

One Node process in one Docker container runs N `discord.js` clients, one per bot token. `bots[0]` is the **leader**: it watches voice state changes and owns `/yo`. All bots (leader included) take part in the swarm.

### Modules

| Module | Responsibility | Depends on |
|---|---|---|
| `config.ts` | Parse and validate environment variables into a typed `Config`; report every problem at once. | — |
| `fleet.ts` | Log in all clients with minimal intents and small caches; drop followers that fail; expose `bots[]`. | config, discord.js |
| `player.ts` | `playOnce(bot, channelId, clip)`: pre-check → join → play → wait → always disconnect. | @discordjs/voice |
| `schedule.ts` | Pure: shuffle bots and assign cumulative random start delays. | — |
| `gate.ts` | Allow one swarm at a time; enforce cooldown. Clock injected. | — |
| `swarm.ts` | `launch(channelId)`: acquire gate → build schedule → run players on their timers → release gate when all settle. | schedule, gate, player (injected) |
| `triggers.ts` | Pure `shouldTrigger(transition, config)` plus thin leader handlers for `voiceStateUpdate` and `/yo`. | swarm |
| `commands.ts` | Leader registers `/yo` on the guild at startup (idempotent overwrite). | discord.js |
| `index.ts` | Load the clip into memory, wiring, logging, signal handling. | all |
| `scripts/invite-links.ts` | Print one OAuth invite URL per bot token. Reads only `BOT_TOKENS`. | config (`parseTokens`) |

The Discord-facing code is confined to `fleet`, `player`, `commands`, and the thin handlers in `triggers`. `schedule`, `gate`, `shouldTrigger`, `config`, and `swarm` (with an injected player) contain the logic and are testable without Discord.

### Key interfaces

```ts
// config.ts
interface Config {
  botTokens: string[];          // [0] is the leader
  guildId: string;
  triggerUserIds: Set<string>;
  staggerMinMs: number;
  staggerMaxMs: number;
  cooldownMs: number;
}
function loadConfig(env: Record<string, string | undefined>): Config; // throws ConfigError listing all problems
function parseTokens(raw: string | undefined): string[];              // trim, drop empties, dedupe (shared with invite-links)

// schedule.ts
function buildSchedule<T>(
  items: T[], minMs: number, maxMs: number, rng: () => number,
): { item: T; delayMs: number }[];

// gate.ts
type Acquire =
  | { ok: true }
  | { ok: false; reason: 'busy' }
  | { ok: false; reason: 'cooldown'; remainingMs: number };
class SwarmGate {
  constructor(cooldownMs: number, now: () => number);
  tryAcquire(): Acquire;
  release(): void;              // starts the cooldown
}

// triggers.ts
interface VoiceTransition {
  guildId: string;
  userId: string;
  isBot: boolean;
  oldChannelId: string | null;
  newChannelId: string | null;
  newChannelIsVoice: boolean;   // true only for regular voice channels (not stage)
  afkChannelId: string | null;
}
function shouldTrigger(t: VoiceTransition, cfg: Pick<Config, 'guildId' | 'triggerUserIds'>): boolean;

// player.ts
type PlayResult =
  | { status: 'played' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: Error };
function playOnce(bot: Bot, channelId: string, clip: Buffer): Promise<PlayResult>;

// swarm.ts
function createSwarm(deps: {
  bots: Bot[];
  gate: SwarmGate;
  play: (bot: Bot, channelId: string) => Promise<PlayResult>;
  channelHasHumans: (channelId: string) => boolean;
  rng: () => number;
  staggerMinMs: number;
  staggerMaxMs: number;
  log: Logger;
}): {
  launch(channelId: string): Acquire;   // returns immediately; swarm runs in the background
  cancelAll(): void;                    // clears pending timers (used on shutdown)
};
```

`Bot` is `{ name: string; client: Client }`.

### Repository layout

```
src/
  index.ts  config.ts  fleet.ts  player.ts  schedule.ts
  gate.ts   swarm.ts   triggers.ts  commands.ts
scripts/
  invite-links.ts
test/
  config.test.ts  schedule.test.ts  gate.test.ts
  triggers.test.ts  swarm.test.ts
assets/
  yo.ogg
Dockerfile  .dockerignore  .env.example  README.md
package.json  tsconfig.json  vitest.config.ts
```

## 4. Data flow

1. The owner moves from no voice channel into voice channel C, or someone runs `/yo` while in C.
2. The leader receives `voiceStateUpdate` (maps it to a `VoiceTransition` and checks `shouldTrigger`) or `interactionCreate` (resolves the invoker's channel).
3. `swarm.launch(C)` calls `gate.tryAcquire()`. If refused, it returns the refusal right away (`/yo` reports it; the join trigger just logs it).
4. If acquired: `buildSchedule(bots, min, max, rng)` produces a shuffled list of `{bot, delayMs}`, and a timer is set for each.
5. When a bot's timer fires, it runs `channelHasHumans(C)` (leader's cache). If no humans remain, the bot is skipped. Otherwise `playOnce(bot, C, clip)` runs.
6. When every bot has settled (played, skipped, or failed), the gate is released and the cooldown starts.

## 5. Behaviour rules

### 5.1 Join trigger (`shouldTrigger`)

Returns `true` only when **all** of these hold:

- `guildId` equals the configured guild.
- `userId` is in `triggerUserIds`, and `isBot` is false.
- `oldChannelId` is `null` and `newChannelId` is not `null`. Channel switches, mute/deafen toggles, and stream/video changes (same channel before and after) do not trigger.
- `newChannelIsVoice` is true (stage channels are excluded, because bots join those as audience and cannot speak).
- `newChannelId` is not the guild's AFK channel.

### 5.2 Swarm playback

- **Schedule.** Bots are shuffled (Fisher–Yates using the injected `rng`). Bot *k*'s delay is the sum of *k + 1* independent draws from `U[staggerMinMs, staggerMaxMs]`, so the first bot starts 1–2 s after the trigger and each later one 1–2 s after the previous. With 10 bots and defaults, the last bot starts roughly 10–20 s after the trigger.
- **Stagger applies to the start of joining.** Each bot plays the moment its voice connection is ready (typically ~0.5–1 s). That latency is similar for every bot, so the audio spacing tracks the schedule with some natural jitter.
- **Leave immediately.** Each bot disconnects as soon as its own clip finishes. Early bots leave while later ones are still arriving (a rolling wave).
- **Humans check.** Immediately before each bot's turn, if the channel has no non-bot members, that bot is skipped.
- **Voice options.** Bots join self-deafened (they never receive audio), not self-muted.

### 5.3 Gate

- Only one swarm runs at a time. `tryAcquire()` returns `busy` while a swarm is in progress.
- After `release()`, `tryAcquire()` returns `cooldown` with `remainingMs` until `cooldownMs` has elapsed.
- `cooldownMs = 0` disables the cooldown (the busy rule still applies).
- The join trigger and `/yo` share the same gate.

### 5.4 `/yo`

- Registered as a guild command on the configured guild, with no options. Description: "Summon the swarm".
- Available to everyone by default. Server admins can restrict it with Discord's built-in command permissions (Server Settings → Integrations); no code is needed.
- All replies are ephemeral (visible only to the invoker):

| Situation | Reply |
|---|---|
| Invoker not in a voice channel, or in a stage channel | "Join a voice channel first." |
| Gate `busy` | "Swarm already in flight 🐝" |
| Gate `cooldown` | "Swarm is cooling down — try again in *N*s." (*N* rounded up) |
| Launched | "🐝 incoming" |

- `launch()` returns synchronously and the swarm runs in the background, so the reply is always sent well within Discord's 3-second window.

## 6. Configuration

All configuration comes from environment variables. In production they are set in Dokploy's Environment tab; locally they come from `.env` (loaded with Node's built-in `--env-file`, so no dotenv dependency is needed). `.env` is git-ignored; `.env.example` lists every variable.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `BOT_TOKENS` | yes | — | Comma-separated bot tokens. The first is the leader. Whitespace is trimmed; empty entries and duplicates are dropped. |
| `GUILD_ID` | yes | — | The server's ID. |
| `TRIGGER_USER_IDS` | yes | — | Comma-separated user IDs whose join triggers the swarm. |
| `STAGGER_MIN_MS` | no | `1000` | Minimum gap between bot starts. |
| `STAGGER_MAX_MS` | no | `2000` | Maximum gap between bot starts. |
| `COOLDOWN_MS` | no | `30000` | Cooldown after a swarm finishes. `0` disables it. |

Validation rules:

- At least one token.
- IDs are 17–20 digit snowflakes.
- Numbers are non-negative integers, and `STAGGER_MIN_MS ≤ STAGGER_MAX_MS`.

Every violation is reported in one error message before the process exits with code 1. Tokens are never logged.

`loadConfig` is pure (no file access). `index.ts` separately reads `assets/yo.ogg` at startup and exits 1 with a clear message if the file is missing or unreadable.

## 7. Audio

- The clip is committed at `assets/yo.ogg` as Ogg Opus (48 kHz, stereo).
- `@discordjs/voice` passes Ogg Opus through without transcoding (`StreamType.OggOpus`), so the runtime image needs no FFmpeg and playback costs almost no CPU.
- The file is read into memory once at startup. Each play creates a fresh readable stream from that buffer.
- The README documents conversion from any input format, with loudness normalisation (important when 10 copies overlap):

  ```
  ffmpeg -i input.mp3 -af loudnorm -c:a libopus -b:a 96k -ar 48000 -ac 2 assets/yo.ogg
  ```

## 8. Deployment (Dokploy)

- **Dockerfile.** Multi-stage:
  1. Build stage (`node:24-slim`): `npm ci`, then compile TypeScript.
  2. Runtime stage (`node:24-slim`): `npm ci --omit=dev`, copy `dist/` and `assets/`, run as the non-root `node` user, `CMD ["node", "dist/index.js"]`.
  - Use Debian slim rather than Alpine so that prebuilt native modules (such as the DAVE library) work.
- **Dokploy setup.** An **Application** with the GitHub provider pointing at `Jarvl/discord-voice-goat` and the Dockerfile build type. **No domain, no exposed ports.** Environment variables are set in the Environment tab. Dokploy's restart policy restarts the container on crash.
- **Network.** The app only makes outbound connections: HTTPS/WSS to the gateway and REST API, and UDP to Discord voice servers. It needs no inbound access. The host must allow outbound UDP.
- **Graceful shutdown.** On `SIGTERM` or `SIGINT` the app:
  1. Stops accepting triggers and calls `swarm.cancelAll()`.
  2. Destroys every voice connection.
  3. Destroys every client and exits 0.

  A hard exit after 5 s guarantees the process stops within Docker's default stop grace period.
- **Logging.** One line per event on stdout, in the form `<ISO time> <level> <event> key=value …`. Events cover startup, fleet size, triggers, gate refusals, each bot's result, and shutdown. Logs are visible in Dokploy's log viewer.

## 9. One-time Discord setup (manual; the README walks through it)

1. Create N applications in the Discord Developer Portal. For each one, on the Bot page, reset and copy the token. Distinct names and avatars are encouraged.
2. Leave all privileged gateway intents (Presence, Server Members, Message Content) **off**. The app uses only `Guilds` and `GuildVoiceStates`, which are not privileged.
3. Enable Developer Mode in Discord, then copy the server ID and your own user ID.
4. Put the tokens and IDs in `.env`, then run `npm run invite-links`. For each token, the script:
   - Derives the application ID from the token's first segment (base64 of the bot user ID, which equals the application ID). Tokens are never printed.
   - Prints `https://discord.com/oauth2/authorize?client_id=<id>&scope=<scopes>&permissions=3146752`, where `3146752` = View Channel + Connect + Speak.
   - Uses `bot applications.commands` as the scopes for the leader and `bot` for followers.
5. Open each URL and add the bot to the server.

## 10. Error handling

**Startup**

- An invalid config, or a missing clip file, makes the process exit 1 with every problem listed (§6).
- Clients log in concurrently. If the **leader** fails to log in, the process exits 1 and Dokploy restarts it. If a **follower** fails, the app logs a warning and continues without that bot.
- Once all clients are ready, any **follower** that is not a member of `GUILD_ID` is logged with a hint to run `npm run invite-links`, and is dropped. If the **leader** is not a member, the process exits 1 with the same hint, because it cannot watch voice or register `/yo`.
- The app logs the final fleet size. If only the leader remains, it still runs (as a swarm of one).

**Per bot, inside `playOnce`**

- **Pre-check** (using the bot's own view of the channel), before joining:
  - The channel exists and is a regular voice channel.
  - The bot can view the channel and connect to it. A full user limit counts as unjoinable unless the bot has Move Members.
  - The bot can speak in the channel.

  Any failure returns `skipped` with a reason and does not wait on a timeout.
- **Join** with the bot's own connection group (the bot's user ID) so connections do not collide. Wait up to **10 s** for the Ready state, otherwise return `failed`.
- **Playback timeout.** Wait for the player to go idle, up to a fixed **30 s** ceiling (clips are expected to be a few seconds), otherwise return `failed`.
- **Disconnect during playback.** If the connection moves to Disconnected (the bot was kicked, moved, or lost its connection), return `failed`.
- **Always clean up.** A `finally` block stops the player and destroys the connection whatever the outcome.

**Swarm**

- `playOnce` never throws. Results are logged per bot, and one bot's failure never affects the others.
- The swarm awaits every scheduled bot with `allSettled` semantics, and releases the gate in a `finally` block, so the gate can never be left stuck on `busy`.

**Process**

- `discord.js` handles gateway reconnects on its own.
- `unhandledRejection` is logged. `uncaughtException` is logged, then the process exits 1 so Dokploy restarts it.

## 11. Testing

**Automated (Vitest, no Discord)**

- `triggers.test.ts`: a table-driven `shouldTrigger` suite.
  - Joining from no channel triggers.
  - None of these trigger: a channel switch, a mute/deafen toggle in the same channel, leaving, a non-trigger user, a bot, a different guild, the AFK channel, a stage channel.
- `schedule.test.ts`, with a seeded RNG:
  - Output length equals the input length, and every item appears exactly once.
  - The first delay and every successive gap fall within `[min, max]`.
  - Delays are non-decreasing.
  - `min === max` yields exact spacing.
- `gate.test.ts`, with a fake clock:
  - The first acquire succeeds, and a second while running returns `busy`.
  - After release, acquiring returns `cooldown` with the correct `remainingMs`, and succeeds once the cooldown has elapsed.
  - `cooldownMs = 0` allows acquiring immediately after release.
- `config.test.ts`:
  - A valid environment parses, and defaults apply.
  - Tokens are trimmed and deduplicated.
  - Each invalid case (missing required variables, malformed snowflakes, negative numbers, min > max) is reported, and multiple problems are reported together.
- `swarm.test.ts`, with a fake player and Vitest fake timers:
  - Each bot is played at its scheduled delay.
  - The gate stays busy until every bot settles, then releases, even when some players return `failed`.
  - Bots scheduled after the channel empties are skipped.
  - `cancelAll()` prevents pending bots from playing.
  - `launch()` returns the gate refusal when busy.

**Manual smoke test (README checklist, 2–3 bots on a test server)**

1. Joining a voice channel starts a staggered swarm, and each bot leaves after its clip.
2. Switching channels, and muting/unmuting, do not trigger.
3. `/yo` while in voice summons the swarm to that channel.
4. `/yo` while not in voice shows "Join a voice channel first."
5. `/yo` during a swarm and during the cooldown shows the correct messages.
6. A channel with a user limit skips the extra bots cleanly (check the logs).
7. Leaving the channel mid-swarm stops the remaining bots from joining.
8. Redeploying in Dokploy mid-swarm leaves no bots stranded in the channel.

## 12. Open items for the implementation plan

- Check current releases, then pin the versions of `discord.js`, `@discordjs/voice`, and its DAVE and transport-encryption dependencies. Confirm that Ogg Opus passthrough needs no Opus encoder or FFmpeg at runtime.
- Commit a short placeholder `assets/yo.ogg` (for example, a generated tone) so the app runs end to end before the owner supplies the real clip.
- Choose the local dev runner for TypeScript: either `tsx` or Node's built-in type stripping, used with `--env-file`.
