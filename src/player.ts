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
