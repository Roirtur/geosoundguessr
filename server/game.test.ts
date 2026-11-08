import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countryAt } from '../shared/geo';
import type { RoomView, SoundEntry } from '../shared/types';
import { GameEngine, type GameSoundSource } from './game';

const paris = { latitude: 48.8566, longitude: 2.3522 };
const tokyo = { latitude: 35.6762, longitude: 139.6503 };
function sound(id: number, location = paris): SoundEntry {
  const country = countryAt(location)!;
  return {
    id: `sound-${id}`,
    provider: 'wikimedia',
    providerId: String(id),
    audioUrl: `https://upload.wikimedia.org/${id}.ogg`,
    sourceUrl: `https://commons.wikimedia.org/wiki/File:${id}.ogg`,
    title: `Real sound ${id}`,
    description: '',
    creator: 'recorder',
    tags: [],
    category: 'nature',
    duration: 30,
    ...location,
    countryCode: country.id,
    countryName: country.properties.name,
    originType: 'recording_location',
    license: 'Attribution',
    approvalStatus: 'provisional',
    locationEvidence: 'Mock Commons coordinates for a test fixture.',
    playable: true,
    attribution: 'Test recording',
    lastCheckedAt: '2026-01-01',
  };
}
function setup(sounds = [sound(1), sound(2, tokyo)]) {
  const updates: RoomView[] = [];
  const source: GameSoundSource = {
    pick: vi.fn(async (count) => sounds.slice(0, count)),
    replacement: vi.fn((excluded) =>
      sounds.find((item) => !excluded.has(`${item.provider}:${item.providerId}`)),
    ),
  };
  const game = new GameEngine(source, (_code, view) => updates.push(view));
  const alice = game.create('Alice', 'socket-a').data!;
  const bob = game.join(alice.room.code, 'Bob', 'socket-b').data!;
  const code = alice.room.code;
  const view = () => game.getView(code)!;
  const start = async (rounds = 1) => {
    game.configure(code, alice.playerId, 'socket-a', rounds, 'casual');
    expect((await game.start(code, alice.playerId, 'socket-a')).ok).toBe(true);
    expect(view().phase).toBe('preparing');
    game.ready(code, alice.playerId, 'socket-a');
    game.ready(code, bob.playerId, 'socket-b');
    expect(view().phase).toBe('guessing');
  };
  return { game, source, updates, alice, bob, code, view, start };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('multiplayer room state', () => {
  it('creates, joins and restricts host controls', async () => {
    const { game, alice, bob, code, view } = setup();
    expect(view().players).toHaveLength(2);
    expect(game.join(code, 'Bob', 'socket-c').ok).toBe(false);
    expect(game.configure(code, bob.playerId, 'socket-b', 10, 'casual').ok).toBe(false);
    expect((await game.start(code, bob.playerId, 'socket-b')).ok).toBe(false);
    expect(game.configure(code, alice.playerId, 'socket-a', 2, 'casual').ok).toBe(true);
  });
  it('locks guesses, ends early and reveals the same result to all', async () => {
    const { game, alice, bob, code, view, start } = setup();
    await start();
    expect(view().reveal).toBeUndefined();
    const token = view().playbackUrl!.split('/').at(-1)!;
    expect(game.audioFor(code, token)?.title).toBe('Real sound 1');
    expect(game.audioFor(code, 'wrong-token')).toBeUndefined();
    expect(game.confirm(code, alice.playerId, 'socket-a', paris).ok).toBe(true);
    expect(game.confirm(code, alice.playerId, 'socket-a', tokyo).ok).toBe(false);
    expect(view().phase).toBe('guessing');
    expect(game.confirm(code, bob.playerId, 'socket-b', tokyo).ok).toBe(true);
    expect(view().phase).toBe('results');
    expect(game.audioFor(code, token)).toBeUndefined();
    expect(view().reveal?.answer.countryName).toBe('France');
    expect(view().reveal?.guesses).toHaveLength(2);
    expect(view().players.find((p) => p.id === alice.playerId)?.totalScore).toBe(100);
    expect(view().players.find((p) => p.id === bob.playerId)?.totalScore).toBe(0);
    vi.advanceTimersByTime(8000);
    expect(view().phase).toBe('finished');
  });
  it('uses a server deadline and awards zero to an unanswered player', async () => {
    const { game, alice, code, view, start } = setup();
    await start();
    game.confirm(code, alice.playerId, 'socket-a', paris);
    vi.advanceTimersByTime(30000);
    expect(view().phase).toBe('results');
    expect(view().reveal?.guesses).toHaveLength(1);
    expect(view().players[1].totalScore).toBe(0);
  });
  it('accumulates across rounds, produces a deterministic leaderboard and resets replay', async () => {
    const { game, alice, bob, code, view, start } = setup();
    await start(2);
    game.confirm(code, alice.playerId, 'socket-a', paris);
    game.confirm(code, bob.playerId, 'socket-b', tokyo);
    vi.advanceTimersByTime(8000);
    expect(view().currentRound).toBe(2);
    game.ready(code, alice.playerId, 'socket-a');
    game.ready(code, bob.playerId, 'socket-b');
    game.confirm(code, alice.playerId, 'socket-a', tokyo);
    game.confirm(code, bob.playerId, 'socket-b', paris);
    vi.advanceTimersByTime(8000);
    expect(view().phase).toBe('finished');
    expect(view().players.find((p) => p.id === alice.playerId)?.totalScore).toBe(200);
    const ranking = [...view().players].sort(
      (a, b) => b.totalScore - a.totalScore || a.name.localeCompare(b.name),
    );
    expect(ranking[0].name).toBe('Alice');
    expect(game.playAgain(code, alice.playerId, 'socket-a').ok).toBe(true);
    expect(view().phase).toBe('lobby');
    expect(view().players.every((p) => p.totalScore === 0)).toBe(true);
  });
  it('resumes identities and migrates host after disconnection', () => {
    const { game, alice, bob, code, view } = setup();
    game.disconnect('socket-a');
    expect(view().hostId).toBe(bob.playerId);
    expect(game.resume(code, bob.sessionToken, 'socket-b2').data?.playerId).toBe(bob.playerId);
    expect(game.resume(code, alice.sessionToken, 'socket-a2').data?.playerId).toBe(alice.playerId);
    expect(view().players.find((p) => p.id === alice.playerId)?.connected).toBe(true);
  });
  it('replaces failed audio for everyone and ignores stale failures', async () => {
    const { game, alice, code, view, start } = setup([sound(1), sound(2)]);
    await start();
    const old = view().playbackUrl!;
    expect(old).toMatch(/^\/api\/audio\//);
    expect(old).not.toContain('wikimedia');
    expect(game.audioFailed(code, alice.playerId, 'socket-a', old).ok).toBe(true);
    expect(view().phase).toBe('preparing');
    expect(view().playbackUrl).not.toBe(old);
    expect(game.audioFailed(code, alice.playerId, 'socket-a', old).ok).toBe(false);
  });
  it('does not start a deadline for audio that never becomes ready', async () => {
    const { game, alice, code, view } = setup([sound(1), sound(2)]);
    game.configure(code, alice.playerId, 'socket-a', 1, 'casual');
    expect((await game.start(code, alice.playerId, 'socket-a')).ok).toBe(true);
    vi.advanceTimersByTime(15000);
    expect(view().phase).toBe('preparing');
    expect(view().playbackUrl).toMatch(/^\/api\/audio\//);
    vi.advanceTimersByTime(15000);
    expect(view().phase).toBe('lobby');
    expect(view().error).toMatch(/Audio playback failed/);
  });
});
