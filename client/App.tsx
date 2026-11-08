import { useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import {
  ArrowRight,
  AudioLines,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Compass,
  Copy,
  Crown,
  ExternalLink,
  Headphones,
  LoaderCircle,
  MapPin,
  Radio,
  Settings2,
  Trophy,
  Users,
  Volume2,
} from 'lucide-react';
import { EVENTS } from '../shared/events';
import type { ActionResult, JoinResult, RoomView } from '../shared/types';
import GlobeView, { type Selection } from './GlobeView';
import AudioPanel from './AudioPanel';
import Admin from './Admin';
import { serverBase } from './config';

const socket = io(serverBase || undefined, {
  autoConnect: false,
  transports: ['websocket', 'polling'],
});
const SESSION_KEY = 'echo-atlas-session';
type Session = { code: string; playerId: string; token: string };
type Status = { configured: boolean; pool: { total: number }; adminEnabled: boolean };

export default function App() {
  const [view, setView] = useState<'game' | 'admin'>('game');
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<Status>();
  const [room, setRoom] = useState<RoomView>();
  const [session, setSession] = useState<Session>();
  const [nickname, setNickname] = useState(localStorage.getItem('echo-atlas-name') || '');
  const [joinCode, setJoinCode] = useState('');
  const [joinOpen, setJoinOpen] = useState(false);
  const [selected, setSelected] = useState<Selection>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(Date.now());

  const accept = useCallback((result: ActionResult<JoinResult>) => {
    if (!result.ok || !result.data) {
      setError(result.error || 'Could not join room.');
      return;
    }
    const next = {
      code: result.data.room.code,
      playerId: result.data.playerId,
      token: result.data.sessionToken,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    setSession(next);
    setRoom(result.data.room);
    setClockOffset(Date.now() - result.data.room.serverNow);
    setError('');
  }, []);
  useEffect(() => {
    const onState = (next: RoomView) => {
      setRoom(next);
      setClockOffset(Date.now() - next.serverNow);
    };
    const onConnect = () => {
      setConnected(true);
      const saved = localStorage.getItem(SESSION_KEY);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as Session;
          socket
            .timeout(5000)
            .emit(
              EVENTS.resume,
              { code: parsed.code, token: parsed.token },
              (err: Error | null, result: ActionResult<JoinResult>) => {
                if (!err && result?.ok) accept(result);
                else {
                  localStorage.removeItem(SESSION_KEY);
                  setSession(undefined);
                  setRoom(undefined);
                }
              },
            );
        } catch {
          localStorage.removeItem(SESSION_KEY);
        }
      }
    };
    const onDisconnect = () => setConnected(false);
    socket.on(EVENTS.roomState, onState);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.connect();
    fetch(`${serverBase}/api/status`)
      .then((response) => response.json())
      .then(setStatus)
      .catch(() => setError('The game server is unavailable.'));
    return () => {
      socket.off(EVENTS.roomState, onState);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.disconnect();
    };
  }, [accept]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    setSelected(undefined);
  }, [room?.currentRound, room?.playbackUrl]);

  const call = useCallback(
    async <T,>(event: string, payload: object, timeout = 10000): Promise<ActionResult<T>> => {
      try {
        return (await socket.timeout(timeout).emitWithAck(event, payload)) as ActionResult<T>;
      } catch {
        return { ok: false, error: 'The server did not respond. Try again.' };
      }
    },
    [],
  );
  const action = useCallback(
    async (event: string, extra: object = {}, timeout?: number) => {
      if (!session) return;
      setBusy(true);
      setError('');
      const result = await call(
        event,
        { code: session.code, playerId: session.playerId, ...extra },
        timeout,
      );
      if (!result.ok) setError(result.error || 'Action failed.');
      setBusy(false);
      return result;
    },
    [call, session],
  );
  const enter = async (kind: 'create' | 'join') => {
    setError('');
    setBusy(true);
    const name = nickname.trim();
    if (name.length < 2 || name.length > 20) {
      setError('Enter a nickname with 2–20 characters.');
      setBusy(false);
      return;
    }
    localStorage.setItem('echo-atlas-name', name);
    const result = await call<JoinResult>(
      kind === 'create' ? EVENTS.create : EVENTS.join,
      kind === 'create' ? { name } : { name, code: joinCode.toUpperCase().trim() },
    );
    accept(result);
    setBusy(false);
  };
  const leave = async () => {
    if (session) await call(EVENTS.leave, { code: session.code, playerId: session.playerId });
    localStorage.removeItem(SESSION_KEY);
    setSession(undefined);
    setRoom(undefined);
    setSelected(undefined);
    setError('');
  };
  const timeLeft = room?.deadline
    ? Math.max(0, Math.ceil((room.deadline - (now - clockOffset)) / 1000))
    : 30;
  const player = room?.players.find((item) => item.id === session?.playerId);
  const isHost = !!player?.isHost;
  const leaderboard = useMemo(
    () =>
      [...(room?.players ?? [])].sort(
        (a, b) =>
          b.totalScore - a.totalScore || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
    [room?.players],
  );
  const resultRows = useMemo(
    () =>
      room?.reveal?.guesses.map((guess) => ({
        ...guess,
        player: room.players.find((p) => p.id === guess.playerId),
      })) ?? [],
    [room],
  );
  const globePhase = room?.phase || 'menu';
  const select = useCallback((location: Selection) => setSelected(location), []);
  const sendReady = useCallback(() => {
    if (session) void call(EVENTS.ready, { code: session.code, playerId: session.playerId });
  }, [session, call]);
  const sendFailed = useCallback(
    (src: string) => {
      if (session)
        void call(EVENTS.audioFailed, { code: session.code, playerId: session.playerId, src });
    },
    [session, call],
  );

  if (view === 'admin')
    return (
      <Admin
        onBack={() => {
          setView('game');
          fetch(`${serverBase}/api/status`)
            .then((r) => r.json())
            .then(setStatus)
            .catch(() => {});
        }}
      />
    );
  return (
    <div className={`app app-${globePhase}`}>
      <GlobeView
        phase={globePhase}
        selected={selected}
        reveal={room?.reveal}
        players={room?.players}
        disabled={player?.confirmed}
        onSelect={select}
      />
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◎</span> ECHO<span>ATLAS</span>
        </div>
        <div className="topbar-right">
          <span className={`connection ${connected ? 'online' : ''}`}>
            <i /> {connected ? 'LIVE CONNECTION' : 'RECONNECTING'}
          </span>
          {room && (
            <button className="top-link" onClick={leave}>
              Leave room <ArrowRight size={14} />
            </button>
          )}
        </div>
      </header>

      {!room && (
        <main className="menu-layer">
          <div className="menu-content">
            <div className="eyebrow">
              <span className="line" /> THE WORLD IS LISTENING
            </div>
            <h1>
              Where in the world
              <br />
              <em>did you hear that?</em>
            </h1>
            <p className="menu-lead">
              A sound. A globe. Thirty seconds. Follow your ears to the place it all began.
            </p>
            <div className="menu-form glass">
              <label htmlFor="nickname">YOUR CALLSIGN</label>
              <input
                id="nickname"
                autoComplete="nickname"
                maxLength={20}
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder="Enter your nickname"
              />
              <div className="menu-actions">
                <button
                  className="button primary"
                  onClick={() => enter('create')}
                  disabled={busy || !connected}
                >
                  <Compass size={18} /> Create a game <ArrowRight size={17} />
                </button>
                <button className="button secondary" onClick={() => setJoinOpen(!joinOpen)}>
                  <Users size={18} /> Join a room
                </button>
              </div>
              {joinOpen && (
                <div className="join-row">
                  <input
                    aria-label="Room code"
                    maxLength={5}
                    value={joinCode}
                    onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                    placeholder="ROOM CODE"
                  />
                  <button
                    className="button primary"
                    onClick={() => enter('join')}
                    disabled={busy || !connected}
                  >
                    Join <ChevronRight size={17} />
                  </button>
                </div>
              )}
            </div>
            {error && (
              <p className="message error" role="alert">
                {error}
              </p>
            )}
            {status && !status.configured && (
              <p className="setup-notice">
                <Radio size={17} /> Freesound API not configured. Add your key to <code>.env</code>{' '}
                to play real recordings.
              </p>
            )}
            <div className="menu-steps">
              <span>
                <Headphones size={19} /> Listen
              </span>
              <i />
              <span>
                <MapPin size={19} /> Pin a place
              </span>
              <i />
              <span>
                <Trophy size={19} /> Win the round
              </span>
            </div>
          </div>
          <div className="menu-side-note">
            <span className="orbit-dot" /> EXPLORE BY EAR
            <br />
            <strong>Every place has a story.</strong>
          </div>
        </main>
      )}

      {room?.phase === 'lobby' && (
        <main className="lobby-layer">
          <div className="lobby-heading">
            <span className="eyebrow">YOUR EXPEDITION BEGINS HERE</span>
            <h1>Gather your crew.</h1>
            <p>Share the code. Choose your route. The same sound plays for everyone.</p>
          </div>
          <div className="lobby-card glass">
            <div className="room-code-row">
              <div>
                <span className="label">ROOM CODE</span>
                <strong>{room.code}</strong>
              </div>
              <button
                className="button secondary"
                onClick={() => navigator.clipboard.writeText(room.code)}
              >
                <Copy size={16} /> Copy code
              </button>
            </div>
            <div className="section-heading">
              <span>
                PLAYERS <b>{room.players.length}/8</b>
              </span>
              <span className="muted">Waiting together</span>
            </div>
            <div className="player-list">
              {room.players.map((p) => (
                <div key={p.id} className="player-row">
                  <span className="avatar" style={{ color: p.color, borderColor: p.color }}>
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                  <strong>{p.name}</strong>
                  {p.isHost && (
                    <span className="host-pill">
                      <Crown size={13} /> HOST
                    </span>
                  )}
                  {!p.connected && <span className="muted">offline</span>}
                </div>
              ))}
            </div>
            <div className="lobby-settings">
              <div className="section-heading">
                <span>
                  <Settings2 size={16} /> MATCH SETTINGS
                </span>
              </div>
              <label>
                Rounds{' '}
                <select
                  value={room.roundCount}
                  disabled={!isHost || busy}
                  onChange={(event) =>
                    action(EVENTS.configure, {
                      rounds: Number(event.target.value),
                      mode: room.mode,
                    })
                  }
                >
                  {[1, 3, 5, 7, 10].map((count) => (
                    <option key={count} value={count}>
                      {count} rounds
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Sound mode{' '}
                <select
                  value={room.mode}
                  disabled={!isHost || busy}
                  onChange={(event) =>
                    action(EVENTS.configure, { rounds: room.roundCount, mode: event.target.value })
                  }
                >
                  <option value="casual">Casual · provisional geotags</option>
                  <option value="curated">Curated · approved only</option>
                </select>
              </label>
            </div>
            {room.error && (
              <p className="message error" role="alert">
                {room.error}
              </p>
            )}
            {!status?.configured && (
              <p className="message warning">
                Freesound API not configured. Add <code>FREESOUND_API_KEY</code> to .env, then
                restart the server.
              </p>
            )}
            <button
              className="button primary start-button"
              disabled={!isHost || busy || !status?.configured}
              onClick={() => action(EVENTS.start, {}, 120000)}
            >
              {busy ? <LoaderCircle className="spin" size={18} /> : <AudioLines size={18} />}{' '}
              {busy ? 'Finding sounds…' : isHost ? 'Start listening' : 'Waiting for host'}{' '}
              <ArrowRight size={17} />
            </button>
            <p className="microcopy">
              Real Freesound previews · 30 seconds per round · exact distance scoring
            </p>
          </div>
          {error && (
            <p className="message error lobby-error" role="alert">
              {error}
            </p>
          )}
        </main>
      )}

      {room && ['preparing', 'guessing'].includes(room.phase) && (
        <main className="game-layer">
          <div className="game-top">
            <div className="round-chip glass">
              <span>ROUND</span>
              <strong>
                {room.currentRound}
                <small> / {room.roundCount}</small>
              </strong>
            </div>
            <div
              className={`timer glass ${timeLeft <= 5 && room.phase === 'guessing' ? 'urgent' : ''}`}
            >
              <Clock3 size={22} />
              <strong>
                {room.phase === 'preparing' ? 'READY' : `00:${String(timeLeft).padStart(2, '0')}`}
              </strong>
            </div>
            <div className="score-chip glass">
              <span>YOUR SCORE</span>
              <strong>
                {player?.totalScore ?? 0}
                <small> PTS</small>
              </strong>
            </div>
          </div>
          <div className="game-left">
            <div className="phase-label">
              <span className="pulse-dot" />{' '}
              {room.phase === 'preparing' ? 'TUNING THE FREQUENCY' : 'LISTEN & LOCATE'}
            </div>
            <h2>{room.phase === 'preparing' ? 'Sound incoming.' : 'Trust your ears.'}</h2>
            <p>
              {room.phase === 'preparing'
                ? 'The round begins when everyone’s audio is ready.'
                : 'Rotate Earth, find the country, and click your exact guess.'}
            </p>
            <AudioPanel
              src={room.playbackUrl}
              phase={room.phase}
              onReady={sendReady}
              onFailure={sendFailed}
            />
            <div className="guess-panel glass">
              <div className="guess-label">
                <MapPin size={18} /> YOUR LOCATION
              </div>
              <strong>{selected?.countryName || 'Choose a place on the globe'}</strong>
              {selected && (
                <small>
                  {selected.latitude.toFixed(3)}°, {selected.longitude.toFixed(3)}°
                </small>
              )}
              <button
                className="button primary confirm-button"
                disabled={!selected || room.phase !== 'guessing' || !!player?.confirmed || busy}
                onClick={() =>
                  selected &&
                  action(EVENTS.confirm, {
                    location: { latitude: selected.latitude, longitude: selected.longitude },
                  })
                }
              >
                {player?.confirmed ? (
                  <>
                    <CheckCircle2 size={18} /> Guess locked
                  </>
                ) : (
                  <>
                    <Check size={18} /> Confirm guess <ArrowRight size={16} />
                  </>
                )}
              </button>
            </div>
            {error && (
              <p className="message error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="game-right glass">
            <span className="label">IN THE ROOM</span>
            {room.players.map((p) => (
              <div key={p.id} className="mini-player">
                <i style={{ background: p.color }} />
                <span>{p.name}</span>
                {p.confirmed ? (
                  <CheckCircle2 size={16} className="confirmed" />
                ) : (
                  <span className="muted">listening</span>
                )}
              </div>
            ))}
          </div>
          <div className="globe-hint">
            DRAG TO ROTATE <span>·</span> SCROLL TO ZOOM <span>·</span> CLICK LAND TO GUESS
          </div>
        </main>
      )}

      {room?.phase === 'results' && room.reveal && (
        <main className="results-layer">
          <div className="results-header">
            <span className="eyebrow">ROUND {room.currentRound} REVEALED</span>
            <h1>
              It was <em>{room.reveal.answer.countryName}.</em>
            </h1>
            <p>The globe shows every guess and its distance from the recording.</p>
          </div>
          <div className="results-card glass">
            <div className="result-sound">
              <span className="label">
                <Volume2 size={16} /> THE RECORDING
              </span>
              <h3>{room.reveal.sound.title}</h3>
              <p>
                by {room.reveal.sound.username} · {room.reveal.sound.category} ·{' '}
                {room.reveal.sound.license}
              </p>
              <p className="confidence">
                {room.reveal.sound.approvalStatus === 'approved'
                  ? 'Reviewed location'
                  : 'Uploader geotag · provisional location'}
              </p>
              <a href={room.reveal.sound.sourceUrl} target="_blank" rel="noreferrer">
                View on Freesound <ExternalLink size={14} />
              </a>
            </div>
            <div className="result-table">
              <div className="table-title">
                <span>ROUND RESULTS</span>
                <span>POINTS</span>
              </div>
              {room.players.map((p) => {
                const guess = resultRows.find((r) => r.playerId === p.id);
                return (
                  <div className="result-row" key={p.id}>
                    <i style={{ background: p.color }} />
                    <strong>{p.name}</strong>
                    <span>
                      {guess
                        ? `${Math.round(guess.distanceKm).toLocaleString()} km away`
                        : 'No guess'}
                    </span>
                    <b>+{guess?.score ?? 0}</b>
                  </div>
                );
              })}
            </div>
            {isHost && (
              <button
                className="button secondary next-button"
                onClick={() => action(EVENTS.advance)}
                disabled={busy}
              >
                {room.currentRound === room.roundCount ? 'View final leaderboard' : 'Next round'}{' '}
                <ChevronRight size={16} />
              </button>
            )}
            <p className="microcopy">Advancing automatically in a few seconds</p>
          </div>
        </main>
      )}

      {room?.phase === 'finished' && (
        <main className="final-layer">
          <div className="final-card glass">
            <div className="winner-icon">
              <Trophy size={38} />
            </div>
            <span className="eyebrow">EXPEDITION COMPLETE</span>
            <h1>{leaderboard[0]?.name} wins!</h1>
            <p>
              {room.roundCount} sound{room.roundCount === 1 ? '' : 's'}. One world. Here's how
              everyone did.
            </p>
            <div className="final-list">
              {leaderboard.map((p, index) => (
                <div className={`final-row rank-${index + 1}`} key={p.id}>
                  <span className="rank">{String(index + 1).padStart(2, '0')}</span>
                  <i style={{ background: p.color }} />
                  <strong>{p.name}</strong>
                  {index === 0 && <Crown size={17} className="gold" />}
                  <b>
                    {p.totalScore} <small>PTS</small>
                  </b>
                </div>
              ))}
            </div>
            {isHost ? (
              <div className="final-actions">
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={async () => {
                    const result = await action(EVENTS.playAgain);
                    if (result?.ok) await action(EVENTS.start, {}, 120000);
                  }}
                >
                  Play again <ArrowRight size={17} />
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => action(EVENTS.playAgain)}
                >
                  Return to lobby
                </button>
              </div>
            ) : (
              <p className="muted">The host can start another match.</p>
            )}
            <button className="text-button final-menu" onClick={leave}>
              Return to main menu
            </button>
          </div>
        </main>
      )}

      {!room && status?.adminEnabled && (
        <button className="admin-link" onClick={() => setView('admin')}>
          <Settings2 size={15} /> Sound administration
        </button>
      )}
      <footer className="footer">
        <span>HEAR THE WORLD DIFFERENTLY</span>
        <span>
          FREESOUND REMOTE PREVIEWS <i>·</i> LOCAL MULTIPLAYER
        </span>
      </footer>
    </div>
  );
}
