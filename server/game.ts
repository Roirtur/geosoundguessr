import { randomBytes, randomUUID } from 'node:crypto';
import { countryAt, haversineKm, scoreForDistance, validCoordinates } from '../shared/geo';
import type {
  ActionResult,
  Coordinates,
  GuessView,
  JoinResult,
  Phase,
  PlayerView,
  RevealView,
  RoomView,
  SoundEntry,
} from '../shared/types';

interface Player {
  id: string;
  token: string;
  socketId: string | null;
  name: string;
  color: string;
  totalScore: number;
  confirmed: boolean;
  joinedAt: number;
}
interface Room {
  code: string;
  phase: Phase;
  hostId: string;
  players: Map<string, Player>;
  rounds: number;
  roundIndex: number;
  sounds: SoundEntry[];
  sound?: SoundEntry;
  audioToken?: string;
  usedSounds: Set<string>;
  mode: 'casual' | 'curated';
  ready: Set<string>;
  guesses: Map<string, GuessView>;
  deadline?: number;
  preparationDeadline?: number;
  reveal?: RevealView;
  timer?: ReturnType<typeof setTimeout>;
  preparationAttempts: number;
  error?: string;
}
export interface GameSoundSource {
  pick(count: number, mode: 'casual' | 'curated'): Promise<SoundEntry[]>;
  replacement(excluded: Set<string>, mode: 'casual' | 'curated'): SoundEntry | undefined;
}
const COLORS = [
  '#45d9ef',
  '#ffba69',
  '#bb98ff',
  '#92ed9b',
  '#ff7fa2',
  '#ffe084',
  '#6fa8ff',
  '#fbf6e7',
];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ok = <T>(data?: T): ActionResult<T> => ({ ok: true, data });
const fail = <T = never>(error: string): ActionResult<T> => ({ ok: false, error });

export class GameEngine {
  readonly rooms = new Map<string, Room>();
  constructor(
    private source: GameSoundSource,
    private publish: (code: string, view: RoomView) => void,
    private now = () => Date.now(),
  ) {}

  private code(): string {
    let code = '';
    do {
      code = Array.from(randomBytes(5), (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
    } while (this.rooms.has(code));
    return code;
  }
  private cleanName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const name = value.trim().replace(/\s+/g, ' ');
    return name.length >= 2 && name.length <= 20 ? name : null;
  }
  private addPlayer(room: Room, name: string, socketId: string): Player {
    const player: Player = {
      id: randomUUID(),
      token: randomUUID(),
      socketId,
      name,
      color: COLORS[room.players.size % COLORS.length],
      totalScore: 0,
      confirmed: false,
      joinedAt: this.now(),
    };
    room.players.set(player.id, player);
    return player;
  }
  private view(room: Room): RoomView {
    const players: PlayerView[] = [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      connected: !!p.socketId,
      isHost: p.id === room.hostId,
      confirmed: p.confirmed,
      totalScore: p.totalScore,
    }));
    return {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      players,
      roundCount: room.rounds,
      currentRound: Math.min(room.roundIndex + 1, room.rounds),
      serverNow: this.now(),
      deadline: room.deadline,
      preparationDeadline: room.preparationDeadline,
      playbackUrl:
        room.sound && room.audioToken && ['preparing', 'guessing'].includes(room.phase)
          ? `/api/audio/${room.code}/${room.audioToken}`
          : undefined,
      reveal: room.reveal,
      mode: room.mode,
      error: room.error,
    };
  }
  getView(code: string): RoomView | undefined {
    const room = this.rooms.get(code);
    return room ? this.view(room) : undefined;
  }
  audioFor(code: string, token: string): SoundEntry | undefined {
    const room = this.rooms.get(code);
    return room && ['preparing', 'guessing'].includes(room.phase) && room.audioToken === token
      ? room.sound
      : undefined;
  }
  private emit(room: Room): void {
    this.publish(room.code, this.view(room));
  }
  private result(room: Room, player: Player): JoinResult {
    return { playerId: player.id, sessionToken: player.token, room: this.view(room) };
  }
  private actor(
    code: string,
    playerId: string,
    socketId?: string,
  ): { room: Room; player: Player } | undefined {
    const room = this.rooms.get(code),
      player = room?.players.get(playerId);
    return room && player && (!socketId || player.socketId === socketId)
      ? { room, player }
      : undefined;
  }

  create(nameInput: unknown, socketId: string): ActionResult<JoinResult> {
    const name = this.cleanName(nameInput);
    if (!name) return fail('Enter a nickname with 2–20 characters.');
    const room: Room = {
      code: this.code(),
      phase: 'lobby',
      hostId: '',
      players: new Map(),
      rounds: 5,
      roundIndex: 0,
      sounds: [],
      usedSounds: new Set(),
      mode: 'casual',
      ready: new Set(),
      guesses: new Map(),
      preparationAttempts: 0,
    };
    const player = this.addPlayer(room, name, socketId);
    room.hostId = player.id;
    this.rooms.set(room.code, room);
    this.emit(room);
    return ok(this.result(room, player));
  }

  join(codeInput: unknown, nameInput: unknown, socketId: string): ActionResult<JoinResult> {
    const code = typeof codeInput === 'string' ? codeInput.toUpperCase().trim() : '';
    const room = this.rooms.get(code),
      name = this.cleanName(nameInput);
    if (!room) return fail('Room not found. Check the code.');
    if (room.phase !== 'lobby') return fail('This game is already in progress.');
    if (!name) return fail('Enter a nickname with 2–20 characters.');
    if (room.players.size >= 8) return fail('This room is full.');
    if (
      [...room.players.values()].some((player) => player.name.toLowerCase() === name.toLowerCase())
    )
      return fail('That nickname is already in use.');
    const player = this.addPlayer(room, name, socketId);
    this.emit(room);
    return ok(this.result(room, player));
  }

  resume(codeInput: unknown, tokenInput: unknown, socketId: string): ActionResult<JoinResult> {
    const room = this.rooms.get(String(codeInput).toUpperCase());
    const player = [...(room?.players.values() ?? [])].find((p) => p.token === tokenInput);
    if (!room || !player) return fail('Saved room session is no longer available.');
    player.socketId = socketId;
    this.migrateHost(room);
    this.emit(room);
    return ok(this.result(room, player));
  }

  disconnect(socketId: string): void {
    for (const room of this.rooms.values()) {
      const player = [...room.players.values()].find((p) => p.socketId === socketId);
      if (!player) continue;
      player.socketId = null;
      this.migrateHost(room);
      if (room.phase === 'guessing' && this.allConfirmed(room)) this.finishRound(room);
      this.emit(room);
    }
  }
  leave(code: string, playerId: string, socketId: string): ActionResult {
    const actor = this.actor(code, playerId, socketId);
    if (!actor) return fail('Player session not found.');
    const { room } = actor;
    room.players.delete(playerId);
    room.ready.delete(playerId);
    room.guesses.delete(playerId);
    if (room.players.size === 0) {
      this.clearTimer(room);
      this.rooms.delete(room.code);
      return ok();
    }
    this.migrateHost(room);
    if (room.phase === 'preparing' && this.allReady(room)) this.startCountdown(room);
    if (room.phase === 'guessing' && this.allConfirmed(room)) this.finishRound(room);
    this.emit(room);
    return ok();
  }
  private migrateHost(room: Room): void {
    const host = room.players.get(room.hostId);
    if (host?.socketId) return;
    room.hostId =
      [...room.players.values()].sort(
        (a, b) => Number(!!b.socketId) - Number(!!a.socketId) || a.joinedAt - b.joinedAt,
      )[0]?.id || '';
  }
  configure(
    code: string,
    playerId: string,
    socketId: string,
    count: unknown,
    mode: unknown,
  ): ActionResult {
    const actor = this.actor(code, playerId, socketId);
    if (!actor) return fail('Player session not found.');
    const { room } = actor;
    if (room.hostId !== playerId) return fail('Only the host can configure the room.');
    if (room.phase !== 'lobby') return fail('Configuration is locked during a game.');
    if (
      !Number.isInteger(count) ||
      Number(count) < 1 ||
      Number(count) > 10 ||
      !['casual', 'curated'].includes(String(mode))
    )
      return fail('Choose 1–10 rounds and a valid mode.');
    room.rounds = Number(count);
    room.mode = mode as 'casual' | 'curated';
    this.emit(room);
    return ok();
  }
  async start(code: string, playerId: string, socketId: string): Promise<ActionResult> {
    const actor = this.actor(code, playerId, socketId);
    if (!actor) return fail('Player session not found.');
    const { room } = actor;
    if (room.hostId !== playerId) return fail('Only the host can start the game.');
    if (room.phase !== 'lobby') return fail('The game has already started.');
    room.error = undefined;
    room.phase = 'preparing';
    this.emit(room);
    try {
      const sounds = await this.source.pick(room.rounds, room.mode);
      if (room.phase !== 'preparing') return fail('Game start was cancelled.');
      room.sounds = sounds;
      room.usedSounds = new Set(sounds.map((s) => `${s.provider}:${s.providerId}`));
      room.roundIndex = 0;
      room.players.forEach((player) => {
        player.totalScore = 0;
        player.confirmed = false;
      });
      this.prepareRound(room);
      return ok();
    } catch (error) {
      room.phase = 'lobby';
      room.error = error instanceof Error ? error.message : 'Could not prepare recordings.';
      this.emit(room);
      return fail(room.error);
    }
  }
  private clearTimer(room: Room): void {
    if (room.timer) clearTimeout(room.timer);
    room.timer = undefined;
  }
  private prepareRound(room: Room): void {
    this.clearTimer(room);
    room.phase = 'preparing';
    room.sound = room.sounds[room.roundIndex];
    room.audioToken = randomUUID();
    room.ready.clear();
    room.guesses.clear();
    room.reveal = undefined;
    room.deadline = undefined;
    room.preparationDeadline = this.now() + 15000;
    room.players.forEach((player) => {
      player.confirmed = false;
    });
    this.emit(room);
    room.timer = setTimeout(() => {
      if (room.phase !== 'preparing') return;
      if (this.allReady(room)) this.startCountdown(room);
      else this.replaceAudio(room);
    }, 15000);
  }
  ready(code: string, playerId: string, socketId: string): ActionResult {
    const actor = this.actor(code, playerId, socketId);
    if (!actor) return fail('Player session not found.');
    const { room } = actor;
    if (room.phase !== 'preparing') return fail('The round is not preparing.');
    room.ready.add(playerId);
    if (this.allReady(room)) this.startCountdown(room);
    return ok();
  }
  private allReady(room: Room): boolean {
    return [...room.players.values()].filter((p) => p.socketId).every((p) => room.ready.has(p.id));
  }
  private startCountdown(room: Room): void {
    if (room.phase !== 'preparing') return;
    this.clearTimer(room);
    room.phase = 'guessing';
    room.preparationDeadline = undefined;
    room.deadline = this.now() + 30000;
    this.emit(room);
    room.timer = setTimeout(() => this.finishRound(room), 30000);
  }
  confirm(code: string, playerId: string, socketId: string, location: unknown): ActionResult {
    const actor = this.actor(code, playerId, socketId);
    if (!actor) return fail('Player session not found.');
    const { room, player } = actor;
    if (room.phase !== 'guessing' || !room.deadline || this.now() >= room.deadline)
      return fail('The guessing period has ended.');
    if (player.confirmed) return fail('Your guess is already locked.');
    if (!validCoordinates(location)) return fail('Choose a valid location on land.');
    const country = countryAt(location);
    if (!country) return fail('Choose a location inside a country.');
    const distanceKm = haversineKm(location, room.sound!);
    room.guesses.set(playerId, {
      playerId,
      ...location,
      countryName: country.properties.name,
      distanceKm,
      score: scoreForDistance(distanceKm),
    });
    player.confirmed = true;
    this.emit(room);
    if (this.allConfirmed(room)) this.finishRound(room);
    return ok();
  }
  private allConfirmed(room: Room): boolean {
    return [...room.players.values()].filter((p) => p.socketId).every((p) => p.confirmed);
  }
  private finishRound(room: Room): void {
    if (room.phase !== 'guessing' || !room.sound) return;
    this.clearTimer(room);
    const sound = room.sound;
    for (const guess of room.guesses.values())
      room.players.get(guess.playerId)!.totalScore += guess.score;
    room.reveal = {
      answer: {
        latitude: sound.latitude,
        longitude: sound.longitude,
        countryName: sound.countryName,
        countryCode: sound.countryCode,
      },
      sound: {
        title: sound.title,
        category: sound.category,
        creator: sound.creator,
        provider: sound.provider,
        sourceUrl: sound.sourceUrl,
        license: sound.license,
        attribution: sound.attribution,
        approvalStatus: sound.approvalStatus,
        originType: sound.originType,
        locationEvidence: sound.locationEvidence,
      },
      guesses: [...room.guesses.values()],
    };
    room.phase = 'results';
    room.deadline = undefined;
    this.emit(room);
    room.timer = setTimeout(() => this.nextRound(room), 8000);
  }
  audioFailed(code: string, playerId: string, socketId: string, src?: string): ActionResult {
    const actor = this.actor(code, playerId, socketId);
    if (!actor) return fail('Player session not found.');
    const { room } = actor;
    if (!['preparing', 'guessing'].includes(room.phase)) return fail('No active audio to replace.');
    if (src && src !== `/api/audio/${room.code}/${room.audioToken}`)
      return fail('That audio is no longer active.');
    return this.replaceAudio(room);
  }
  private replaceAudio(room: Room): ActionResult {
    this.clearTimer(room);
    room.preparationAttempts++;
    const replacement =
      room.preparationAttempts <= 3
        ? this.source.replacement(room.usedSounds, room.mode)
        : undefined;
    if (!replacement) {
      room.phase = 'lobby';
      room.error =
        'Audio playback failed and no replacement recording is available. Discover more sounds in Admin.';
      this.emit(room);
      return fail(room.error);
    }
    room.usedSounds.add(`${replacement.provider}:${replacement.providerId}`);
    room.sounds[room.roundIndex] = replacement;
    this.prepareRound(room);
    return ok();
  }
  private nextRound(room: Room): void {
    if (room.phase !== 'results') return;
    this.clearTimer(room);
    if (room.roundIndex + 1 >= room.rounds) {
      room.phase = 'finished';
      this.emit(room);
      return;
    }
    room.roundIndex++;
    room.preparationAttempts = 0;
    this.prepareRound(room);
  }
  advance(code: string, playerId: string, socketId: string): ActionResult {
    const actor = this.actor(code, playerId, socketId);
    if (!actor) return fail('Player session not found.');
    if (actor.room.hostId !== playerId) return fail('Only the host can advance the round.');
    if (actor.room.phase !== 'results') return fail('No result to advance.');
    this.nextRound(actor.room);
    return ok();
  }
  playAgain(code: string, playerId: string, socketId: string): ActionResult {
    const actor = this.actor(code, playerId, socketId);
    if (!actor) return fail('Player session not found.');
    const { room } = actor;
    if (room.hostId !== playerId) return fail('Only the host can reset the game.');
    if (room.phase !== 'finished') return fail('Finish the current match first.');
    this.clearTimer(room);
    room.phase = 'lobby';
    room.roundIndex = 0;
    room.sounds = [];
    room.sound = undefined;
    room.reveal = undefined;
    room.error = undefined;
    room.players.forEach((player) => {
      player.totalScore = 0;
      player.confirmed = false;
    });
    this.emit(room);
    return ok();
  }
}
