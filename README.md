# discord-voice-goat

Run `/yoo` or `/briish` and a swarm of bots piles into your voice channel one by one. Each bot joins 1–2 seconds after the one before it, plays that command's sound bite as soon as it connects, and leaves. Optionally, joining a voice channel can start a `yoo` swarm too (see `TRIGGER_USER_IDS`).

One Node process runs every bot. The first token is the **leader**: it owns the slash commands and watches for voice joins. Every bot, the leader included, joins the swarm. The full design is in [`docs/superpowers/specs/2026-09-23-discord-yo-swarm-design.md`](docs/superpowers/specs/2026-09-23-discord-yo-swarm-design.md).

## 1. Create the bots (one-time)

A Discord bot can only be in one voice channel per server, so every bot in the swarm needs its own application. The same bots can serve several servers at once.

1. Go to <https://discord.com/developers/applications>. For each bot, click **New Application**.
2. On the app's **Bot** page, click **Reset Token** and copy the token. Giving each bot its own name and avatar makes the swarm funnier.
3. Leave **Presence Intent**, **Server Members Intent** and **Message Content Intent** off. The bots don't need them.
4. In Discord, turn on **User Settings → Advanced → Developer Mode**. Then right-click each server you want the swarm in and choose **Copy Server ID**, and right-click yourself and choose **Copy User ID**.

## 2. Configure

```bash
cp .env.example .env
```

Fill in `.env`. Never commit it; it's git-ignored.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `BOT_TOKENS` | yes | — | Comma-separated bot tokens. The first is the leader. |
| `GUILD_IDS` | yes | — | Comma-separated server IDs. Each server has its own swarm and cooldown, so swarms in different servers can run at once. The older `GUILD_ID` still works. |
| `TRIGGER_USER_IDS` | no | blank | Comma-separated user IDs whose voice join starts a `yoo` swarm. Leave it blank to use only the slash commands. |
| `STAGGER_MIN_MS` | no | `1000` | Minimum gap between one bot joining and the next. |
| `STAGGER_MAX_MS` | no | `2000` | Maximum gap between one bot joining and the next. |
| `COOLDOWN_MS` | no | `30000` | Wait after a swarm before another can start. `0` turns it off. |

## 3. Invite the bots

```bash
npm install
npm run invite-links
```

This prints one invite link per bot. Open each link and add that bot to every server in `GUILD_IDS`. The leader's link also grants slash commands.

The leader must be in a server for it to be served; a server the leader is missing from is skipped with a `fleet.server_skipped` warning. A follower missing from a server just sits out swarms there (`fleet.bot_missing_server`), and joins them once you invite it, without a restart.

## 4. Sounds

Each slash command plays its own clip from `assets/`:

| Command | Clip |
|---|---|
| `/yoo` | `assets/yoo.ogg` |
| `/briish` | `assets/briish.ogg` |
| `/hewoo-pwincess` | `assets/hewoo-pwincess.ogg` |
| `/geeeey` | `assets/geeeey.ogg` |
| `/lisan-al-gaib` | `assets/lisan-al-gaib.ogg` |
| `/loser` | `assets/loser.ogg` |

Clips must be **Ogg Opus at 48 kHz**; the bots send them to Discord without re-encoding. An `.ogg` file from the internet is often Ogg *Vorbis*, which won't play. Convert any file with FFmpeg:

```bash
ffmpeg -i input.ogg -c:a libopus -b:a 96k -ar 48000 -ac 2 assets/yoo.ogg
```

For clips longer than about 3 seconds, you can add `-af loudnorm` to even out the volume, which matters when 10 copies overlap. Keep clips under 30 seconds, because each bot stops playing and leaves after 30 seconds.

To add a sound, add a line to `SOUNDS` in `src/sounds.ts` (the command name and its description), then add `assets/<name>.ogg`. Commit and push the clip, because Dokploy builds from the GitHub repo.

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

1. *(Only if `TRIGGER_USER_IDS` is set.)* Join a voice channel. The bots should join one at a time, 1–2 seconds apart. Each plays the yoo clip as soon as it connects, then leaves.
2. *(Only if `TRIGGER_USER_IDS` is set.)* Switch channels, then mute and unmute. Neither should trigger a swarm.
3. Run `/yoo`, then `/briish`, while in a voice channel. The swarm should come to that channel, playing the matching clip.
4. Run `/yoo` while not in voice. You should see "Join a voice channel first."
5. Run `/briish` during a swarm and again during the cooldown. You should see "Swarm already in flight 🐝" and then "Swarm is cooling down — try again in *N*s."
6. Set a user limit on a channel. The extra bots should be skipped cleanly; the logs show `bot.skipped reason="channel is full"`.
7. Leave the channel mid-swarm. The remaining bots shouldn't join; the logs show `reason="channel has no humans"`.
8. Redeploy in Dokploy mid-swarm. No bots should be left stuck in the channel.
9. Listen to the start of each bot's clip. It should play from the very beginning. If the first fraction of a second is cut off, note it: that points to the bots starting audio before Discord's voice encryption has finished setting up.

## Troubleshooting

| Log line or symptom | Fix |
|---|---|
| `fleet.bot_dropped … not in server` | That bot was never invited. Run `npm run invite-links` and open its link. |
| `startup_failed … leader … failed to log in` | The first token in `BOT_TOKENS` is wrong. Reset it on the bot's Developer Portal page. |
| `startup_failed … exitInSeconds=300` | After any startup failure, the app waits 5 minutes before exiting, so Dokploy's automatic restarts can't use up Discord's daily login limit (1,000 per bot). Fix the cause named in the log, then redeploy; a redeploy stops the waiting app straight away. |
| `bot.skipped reason="channel is full"` | Raise the channel's user limit, or give the bots the Move Members permission. |
| `bot.failed … voice connection not ready within 10000ms` for every bot | Voice can't connect. Check that the host allows outgoing UDP. |
| Joining voice does nothing | That's expected if `TRIGGER_USER_IDS` is blank. Otherwise, check that it contains your user ID. Only joining from *no* channel triggers it; switching channels doesn't. |
| `/yoo` and `/briish` don't appear, and the log shows `commands.register_failed` | Re-invite the leader (the first link from `npm run invite-links`) so it has the slash-command scope, then restart the app. Joining voice still triggers the swarm in the meantime. |
