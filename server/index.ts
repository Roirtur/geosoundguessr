import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { EVENTS } from '../shared/events';
import type { ApprovalStatus, SoundCategory } from '../shared/types';
import { SoundPool, isGameSound } from './pool';
import { GameEngine } from './game';
import { relayAudio } from './audio-relay';

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const origin = process.env.CLIENT_ORIGIN;
  if (origin && req.header('origin') === origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Token');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: '24kb' }));
const server = createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ['GET', 'POST'] } });
const pool = new SoundPool();
await pool.load();
const game = new GameEngine(pool, (code, view) => io.to(code).emit(EVENTS.roomState, view));
const port = Number(process.env.PORT || 3001);

app.get('/api/status', (_req, res) =>
  res.json({
    providers: pool.providerStatus(),
    pool: pool.stats(),
    adminEnabled: process.env.NODE_ENV !== 'production',
  }),
);
app.get('/api/audio/:code/:token', async (req, res) => {
  const sound = game.audioFor(req.params.code, req.params.token);
  if (!sound) {
    res.sendStatus(404);
    return;
  }
  await relayAudio(req, res, sound);
});

function adminAllowed(req: express.Request): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  const peer = req.socket.remoteAddress || '';
  const viaLocalProxy = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const ip =
    viaLocalProxy && req.header('x-forwarded-for')
      ? req.header('x-forwarded-for')!.split(',').at(-1)!.trim()
      : peer;
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  return (
    local || (!!process.env.ADMIN_TOKEN && req.header('x-admin-token') === process.env.ADMIN_TOKEN)
  );
}
const admin: express.RequestHandler = (req, res, next) => {
  if (!adminAllowed(req)) {
    res.status(403).json({ error: 'Admin is local only. Set ADMIN_TOKEN for LAN administration.' });
    return;
  }
  next();
};
const pending = new Map<
  string,
  { sound: ReturnType<SoundPool['list']>[number]; expires: number }
>();
const categories: SoundCategory[] = [
  'nature',
  'city',
  'music',
  'radio',
  'dialogue',
  'culture',
  'other',
];

app.get('/api/admin/pool', admin, (_req, res) =>
  res.json({ sounds: pool.list(), stats: pool.stats() }),
);
app.post('/api/admin/search', admin, async (req, res) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim().slice(0, 80) : '';
  const category = categories.includes(req.body?.category)
    ? (req.body.category as SoundCategory)
    : 'other';
  const page =
    Number.isInteger(req.body?.page) && req.body.page >= 1 && req.body.page <= 10
      ? req.body.page
      : 1;
  const min = Number.isFinite(Number(req.body?.minDuration))
    ? Math.max(1, Number(req.body.minDuration))
    : 12;
  const max = Number.isFinite(Number(req.body?.maxDuration))
    ? Math.min(300, Number(req.body.maxDuration))
    : 75;
  const license =
    typeof req.body?.license === 'string' && req.body.license !== 'any'
      ? req.body.license.slice(0, 30)
      : undefined;
  const provider =
    typeof req.body?.provider === 'string' && req.body.provider !== 'all'
      ? req.body.provider
      : undefined;
  if (!query || min > max) {
    res.status(400).json({ error: 'Enter a search query and valid duration range.' });
    return;
  }
  try {
    const { sounds, errors } = await pool.search(
      { query, category, page, minDuration: min, maxDuration: max, license },
      provider,
    );
    for (const sound of sounds) pending.set(sound.id, { sound, expires: Date.now() + 30 * 60_000 });
    for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
    res.json({ sounds, errors });
  } catch (error) {
    res
      .status(502)
      .json({ error: error instanceof Error ? error.message : 'Audio search failed.' });
  }
});
app.post('/api/admin/add', admin, async (req, res) => {
  const item = pending.get(req.body?.id);
  const status = req.body?.status as ApprovalStatus;
  if (
    !item ||
    item.expires < Date.now() ||
    !['approved', 'provisional', 'rejected'].includes(status)
  ) {
    res.status(400).json({ error: 'Search candidate expired or status invalid.' });
    return;
  }
  try {
    if (status === 'approved' && !isGameSound(item.sound)) {
      res
        .status(400)
        .json({ error: 'This recording needs verified location evidence before approval.' });
      return;
    }
    if (status !== 'rejected') {
      const provider = pool.providers.find((entry) => entry.id === item.sound.provider);
      if (!provider || !(await provider.validateSound(item.sound))) {
        res.status(400).json({ error: 'Remote audio is currently unavailable or unsupported.' });
        return;
      }
    }
    const added = await pool.add([{ ...item.sound, approvalStatus: status }], true);
    pending.delete(req.body.id);
    res.json({ added });
  } catch {
    res.status(500).json({ error: 'Could not save sound metadata.' });
  }
});
app.post('/api/admin/review', admin, async (req, res) => {
  if (
    !['approved', 'provisional', 'rejected'].includes(req.body?.status) ||
    typeof req.body?.id !== 'string'
  ) {
    res.status(400).json({ error: 'Invalid review.' });
    return;
  }
  try {
    const sound = pool.list().find((entry) => entry.id === req.body.id);
    if (!sound) {
      res.status(404).json({ error: 'Sound not found.' });
      return;
    }
    if (req.body.status !== 'rejected') {
      const provider = pool.providers.find((entry) => entry.id === sound.provider);
      if (!provider || !(await provider.validateSound(sound))) {
        res.status(400).json({ error: 'Remote audio is currently unavailable or unsupported.' });
        return;
      }
    }
    const found = await pool.review(req.body.id, req.body.status);
    res.status(found ? 200 : 404).json(found ? { ok: true } : { error: 'Sound not found.' });
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : 'Could not save review.' });
  }
});
app.post('/api/admin/locate', admin, async (req, res) => {
  if (
    typeof req.body?.id !== 'string' ||
    typeof req.body?.evidence !== 'string' ||
    !Number.isFinite(req.body?.latitude) ||
    !Number.isFinite(req.body?.longitude)
  ) {
    res.status(400).json({ error: 'Provide the sound, coordinates and location evidence.' });
    return;
  }
  try {
    const found = await pool.locate(
      req.body.id,
      req.body.latitude,
      req.body.longitude,
      req.body.evidence,
      req.body.originType || 'recording_location',
    );
    res.status(found ? 200 : 404).json(found ? { ok: true } : { error: 'Sound not found.' });
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : 'Location could not be saved.' });
  }
});
app.post('/api/admin/discover', admin, async (_req, res) => {
  try {
    await pool.refresh(true);
    res.json({ stats: pool.stats() });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Discovery failed.' });
  }
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(join(process.cwd(), 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(join(process.cwd(), 'dist', 'index.html')));
}

io.on('connection', (socket) => {
  const enter = (result: ReturnType<GameEngine['create']>) => {
    if (result.ok && result.data) socket.join(result.data.room.code);
    return result;
  };
  socket.on(EVENTS.create, (payload, ack) => ack?.(enter(game.create(payload?.name, socket.id))));
  socket.on(EVENTS.join, (payload, ack) =>
    ack?.(enter(game.join(payload?.code, payload?.name, socket.id))),
  );
  socket.on(EVENTS.resume, (payload, ack) =>
    ack?.(enter(game.resume(payload?.code, payload?.token, socket.id))),
  );
  socket.on(EVENTS.leave, (payload, ack) => {
    const result = game.leave(payload?.code, payload?.playerId, socket.id);
    if (result.ok) socket.leave(payload.code);
    ack?.(result);
  });
  socket.on(EVENTS.configure, (payload, ack) =>
    ack?.(
      game.configure(payload?.code, payload?.playerId, socket.id, payload?.rounds, payload?.mode),
    ),
  );
  socket.on(EVENTS.start, async (payload, ack) =>
    ack?.(await game.start(payload?.code, payload?.playerId, socket.id)),
  );
  socket.on(EVENTS.ready, (payload, ack) =>
    ack?.(game.ready(payload?.code, payload?.playerId, socket.id)),
  );
  socket.on(EVENTS.audioFailed, (payload, ack) =>
    ack?.(game.audioFailed(payload?.code, payload?.playerId, socket.id, payload?.src)),
  );
  socket.on(EVENTS.hint, (payload, ack) =>
    ack?.(game.hint(payload?.code, payload?.playerId, socket.id)),
  );
  socket.on(EVENTS.confirm, (payload, ack) =>
    ack?.(game.confirm(payload?.code, payload?.playerId, socket.id, payload?.location)),
  );
  socket.on(EVENTS.advance, (payload, ack) =>
    ack?.(game.advance(payload?.code, payload?.playerId, socket.id)),
  );
  socket.on(EVENTS.playAgain, (payload, ack) =>
    ack?.(game.playAgain(payload?.code, payload?.playerId, socket.id)),
  );
  socket.on('disconnect', () => game.disconnect(socket.id));
});

server.listen(port, '0.0.0.0', () =>
  console.log(
    `Echo Atlas server listening on port ${port}; providers: ${pool
      .providerStatus()
      .filter((p) => p.enabled)
      .map((p) => p.name)
      .join(', ')}.`,
  ),
);
