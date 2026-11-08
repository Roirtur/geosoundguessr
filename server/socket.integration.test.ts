import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { EVENTS } from '../shared/events';
import type { ActionResult, JoinResult, RoomView, SoundEntry } from '../shared/types';
import { countryAt } from '../shared/geo';

const places = [
  { latitude: 48.8566, longitude: 2.3522 },
  { latitude: 35.6762, longitude: 139.6503 },
  { latitude: 41.8781, longitude: -87.6298 },
  { latitude: -33.8688, longitude: 151.2093 },
  { latitude: -23.5505, longitude: -46.6333 },
  { latitude: 28.6139, longitude: 77.209 },
  { latitude: 30.0444, longitude: 31.2357 },
  { latitude: 52.52, longitude: 13.405 },
  { latitude: 19.4326, longitude: -99.1332 },
  { latitude: -1.2921, longitude: 36.8219 },
];
function fixture(id: number): SoundEntry {
  const location = places[id - 1];
  const country = countryAt(location)!;
  return {
    id: `fixture-${id}`,
    provider: 'wikimedia',
    providerId: String(id),
    audioUrl: `https://upload.wikimedia.org/wikipedia/commons/fixture-${id}.ogg`,
    sourceUrl: `https://commons.wikimedia.org/wiki/File:fixture-${id}.ogg`,
    title: `Mock fixture ${id}`,
    description: 'Mocked transport test only',
    creator: 'fixture',
    tags: [],
    category: id % 2 ? 'nature' : 'city',
    duration: 30,
    ...location,
    countryCode: country.id,
    countryName: country.properties.name,
    originType: 'recording_location',
    license: 'Attribution',
    approvalStatus: 'provisional',
    locationEvidence: 'Mock Commons coordinates for a transport fixture.',
    playable: true,
    attribution: 'Mock fixture',
    lastCheckedAt: '2026-01-01',
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

describe('real Socket.IO transport with mocked metadata', () => {
  let child: ChildProcess;
  let directory: string;
  let port: number;
  const clients: Socket[] = [];
  beforeAll(async () => {
    port = await freePort();
    directory = await mkdtemp(join(tmpdir(), 'echo-atlas-test-'));
    const file = join(directory, 'sounds.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(places.map((_, i) => fixture(i + 1))));
    child = spawn(
      process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), resolve('server/index.ts')],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          SOUND_METADATA_FILE: file,
        },
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`);
        if (response.ok) return;
      } catch {
        /* waiting for server */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Fixture game server did not start.');
  }, 15000);
  afterAll(async () => {
    for (const client of clients) client.disconnect();
    child?.kill();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('plays five synchronized rounds, accumulates scores and starts another match', async () => {
    const connect = async () => {
      const socket = io(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        reconnection: false,
      });
      clients.push(socket);
      await new Promise<void>((resolveConnect, reject) => {
        socket.once('connect', resolveConnect);
        socket.once('connect_error', reject);
      });
      return socket;
    };
    const aliceSocket = await connect();
    const bobSocket = await connect();
    const latest = new Map<Socket, RoomView>();
    aliceSocket.on(EVENTS.roomState, (room: RoomView) => latest.set(aliceSocket, room));
    bobSocket.on(EVENTS.roomState, (room: RoomView) => latest.set(bobSocket, room));
    const waitFor = async (
      socket: Socket,
      predicate: (room: RoomView) => boolean,
    ): Promise<RoomView> => {
      const current = latest.get(socket);
      if (current && predicate(current)) return current;
      return new Promise((resolveRoom, reject) => {
        const timer = setTimeout(() => {
          socket.off(EVENTS.roomState, handler);
          reject(new Error('Timed out waiting for room state.'));
        }, 3000);
        const handler = (room: RoomView) => {
          if (predicate(room)) {
            clearTimeout(timer);
            socket.off(EVENTS.roomState, handler);
            resolveRoom(room);
          }
        };
        socket.on(EVENTS.roomState, handler);
      });
    };
    const create = (await aliceSocket.emitWithAck(EVENTS.create, {
      name: 'Alice',
    })) as ActionResult<JoinResult>;
    expect(create.ok).toBe(true);
    const code = create.data!.room.code;
    const join = (await bobSocket.emitWithAck(EVENTS.join, {
      code,
      name: 'Bob',
    })) as ActionResult<JoinResult>;
    expect(join.ok).toBe(true);
    const alice = create.data!.playerId,
      bob = join.data!.playerId;
    expect(
      (
        await aliceSocket.emitWithAck(EVENTS.configure, {
          code,
          playerId: alice,
          rounds: 5,
          mode: 'casual',
        })
      ).ok,
    ).toBe(true);
    expect((await aliceSocket.emitWithAck(EVENTS.start, { code, playerId: alice })).ok).toBe(true);
    let aliceTotal = 0,
      bobTotal = 0;
    for (let round = 1; round <= 5; round++) {
      const preparedA = await waitFor(
        aliceSocket,
        (room) => room.phase === 'preparing' && room.currentRound === round && !!room.playbackUrl,
      );
      const preparedB = await waitFor(
        bobSocket,
        (room) => room.phase === 'preparing' && room.currentRound === round && !!room.playbackUrl,
      );
      expect(preparedA.playbackUrl).toBe(preparedB.playbackUrl);
      expect(preparedA.playbackUrl).toMatch(/^\/api\/audio\//);
      expect(JSON.stringify(preparedA)).not.toContain('fixture-');
      expect(preparedA.reveal).toBeUndefined();
      await aliceSocket.emitWithAck(EVENTS.ready, { code, playerId: alice });
      await bobSocket.emitWithAck(EVENTS.ready, { code, playerId: bob });
      const guessing = await waitFor(
        aliceSocket,
        (room) => room.phase === 'guessing' && room.currentRound === round,
      );
      expect(guessing.deadline).toBeGreaterThan(guessing.serverNow);
      if (round === 1) {
        expect((await aliceSocket.emitWithAck(EVENTS.hint, { code, playerId: alice })).ok).toBe(
          true,
        );
        const pendingHint = await waitFor(
          bobSocket,
          (room) => room.phase === 'guessing' && room.hintVotes.includes(alice),
        );
        expect(pendingHint.hint).toBeUndefined();
        expect((await bobSocket.emitWithAck(EVENTS.hint, { code, playerId: bob })).ok).toBe(true);
        const [hintA, hintB] = await Promise.all([
          waitFor(aliceSocket, (room) => !!room.hint),
          waitFor(bobSocket, (room) => !!room.hint),
        ]);
        expect(hintA.hint).toEqual(hintB.hint);
      }
      expect(
        (
          await aliceSocket.emitWithAck(EVENTS.confirm, {
            code,
            playerId: alice,
            location: places[0],
          })
        ).ok,
      ).toBe(true);
      expect(
        (await bobSocket.emitWithAck(EVENTS.confirm, { code, playerId: bob, location: places[1] }))
          .ok,
      ).toBe(true);
      const resultA = await waitFor(
        aliceSocket,
        (room) => room.phase === 'results' && room.currentRound === round,
      );
      const resultB = await waitFor(
        bobSocket,
        (room) => room.phase === 'results' && room.currentRound === round,
      );
      expect(resultA.reveal).toEqual(resultB.reveal);
      expect(resultA.reveal?.guesses).toHaveLength(2);
      aliceTotal += resultA.reveal!.guesses.find((guess) => guess.playerId === alice)!.score;
      bobTotal += resultA.reveal!.guesses.find((guess) => guess.playerId === bob)!.score;
      expect(resultA.players.find((p) => p.id === alice)?.totalScore).toBe(aliceTotal);
      expect(resultA.players.find((p) => p.id === bob)?.totalScore).toBe(bobTotal);
      expect((await aliceSocket.emitWithAck(EVENTS.advance, { code, playerId: alice })).ok).toBe(
        true,
      );
    }
    const finalA = await waitFor(aliceSocket, (room) => room.phase === 'finished');
    const finalB = await waitFor(bobSocket, (room) => room.phase === 'finished');
    expect(finalA.players).toEqual(finalB.players);
    expect((await aliceSocket.emitWithAck(EVENTS.playAgain, { code, playerId: alice })).ok).toBe(
      true,
    );
    expect((await aliceSocket.emitWithAck(EVENTS.start, { code, playerId: alice })).ok).toBe(true);
    const second = await waitFor(
      bobSocket,
      (room) => room.phase === 'preparing' && room.currentRound === 1,
    );
    expect(second.players.every((p) => p.totalScore === 0)).toBe(true);
  }, 30000);
});
