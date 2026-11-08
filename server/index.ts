import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { EVENTS } from '../shared/events';
import type { ApprovalStatus, SoundCategory } from '../shared/types';
import { FreesoundClient } from './freesound';
import { SoundPool } from './pool';
import { GameEngine } from './game';

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
const client = new FreesoundClient(process.env.FREESOUND_API_KEY);
const pool = new SoundPool(client);
await pool.load();
const game = new GameEngine(pool, (code, view) => io.to(code).emit(EVENTS.roomState, view));
const port = Number(process.env.PORT || 3001);

app.get('/api/status', (_req, res) =>
  res.json({
    configured: client.configured,
    pool: pool.stats(),
    adminEnabled: process.env.NODE_ENV !== 'production',
  }),
);

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
    req.body?.license === 'Attribution' || req.body?.license === 'Creative Commons 0'
      ? ` license:"${req.body.license}"`
      : '';
  if (!query || min > max) {
    res.status(400).json({ error: 'Enter a search query and valid duration range.' });
    return;
  }
  try {
    const sounds = await pool.search(
      query,
      category,
      page,
      `is_geotagged:1 duration:[${min} TO ${max}]${license}`,
    );
    for (const sound of sounds) pending.set(sound.id, { sound, expires: Date.now() + 30 * 60_000 });
    for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
    res.json({ sounds });
  } catch (error) {
    res
      .status(502)
      .json({ error: error instanceof Error ? error.message : 'Freesound search failed.' });
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
    const added = await pool.add([{ ...item.sound, approvalStatus: status }]);
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
    const found = await pool.review(req.body.id, req.body.status);
    res.status(found ? 200 : 404).json(found ? { ok: true } : { error: 'Sound not found.' });
  } catch {
    res.status(500).json({ error: 'Could not save review.' });
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
    `Echo Atlas server listening on port ${port}; Freesound ${client.configured ? 'configured' : 'not configured'}.`,
  ),
);
