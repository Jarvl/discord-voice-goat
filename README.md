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
