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

  it('fails with a readable timeout and leaves when the connection never becomes ready', async () => {
    const result = await playOnce(fakeBot(voiceChannel()), 'c1', CLIP, FAST);
    expect(result).toMatchObject({ status: 'failed', error: { message: 'voice connection not ready within 50ms' } });
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

  it('reports the playback timeout, not an earlier harmless connection error', async () => {
    later(() => conn.setStatus(VoiceConnectionStatus.Ready));
    player.play.mockImplementation(() => {
      player.setStatus(AudioPlayerStatus.Playing);
      later(() => conn.emit('error', new Error('socket hiccup')));
    });
    const result = await playOnce(fakeBot(voiceChannel()), 'c1', CLIP, FAST);
    expect(result).toMatchObject({ status: 'failed', error: { message: 'playback did not finish within 50ms' } });
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
