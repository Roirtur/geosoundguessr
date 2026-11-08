import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Search, ShieldCheck, X, RotateCcw } from 'lucide-react';
import type { ApprovalStatus, OriginType, SoundCategory, SoundCandidate } from '../shared/types';
import { serverBase } from './config';

interface AdminProps {
  onBack: () => void;
}
type Stats = {
  total: number;
  byCategory: Record<string, number>;
  byCountry: Record<string, number>;
  byStatus: Record<string, number>;
  byProvider: Record<string, number>;
  playable: number;
};
const categories: SoundCategory[] = [
  'nature',
  'city',
  'culture',
  'dialogue',
  'music',
  'radio',
  'other',
];

export default function Admin({ onBack }: AdminProps) {
  const [token, setToken] = useState(sessionStorage.getItem('adminToken') || '');
  const [query, setQuery] = useState('forest ambience');
  const [category, setCategory] = useState<SoundCategory>('nature');
  const [license, setLicense] = useState('any');
  const [provider, setProvider] = useState('all');
  const [minDuration, setMinDuration] = useState(12);
  const [maxDuration, setMaxDuration] = useState(75);
  const [sounds, setSounds] = useState<SoundCandidate[]>([]);
  const [pool, setPool] = useState<SoundCandidate[]>([]);
  const [locations, setLocations] = useState<
    Record<string, { latitude: string; longitude: string; evidence: string }>
  >({});
  const [originTypes, setOriginTypes] = useState<Record<string, OriginType>>({});
  const [stats, setStats] = useState<Stats>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'search' | 'pool'>('search');

  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${serverBase}/api/admin/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Admin request failed.');
    return data;
  };
  const load = async () => {
    try {
      const data = await request('pool');
      setPool(data.sounds);
      setStats(data.stats);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [token]);
  const search = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await request('search', {
        query,
        category,
        license,
        provider,
        minDuration,
        maxDuration,
      });
      setSounds(data.sounds);
      if (!data.sounds.length) setNotice('No audio matched. Try another search.');
      else if (data.errors?.length) setNotice(data.errors.join(' '));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const review = async (sound: SoundCandidate, status: ApprovalStatus, existing: boolean) => {
    setBusy(true);
    setError('');
    try {
      await request(existing ? 'review' : 'add', { id: sound.id, status });
      setNotice(`${sound.title} marked ${status}.`);
      if (!existing) setSounds((list) => list.filter((entry) => entry.id !== sound.id));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const locate = async (sound: SoundCandidate) => {
    const location = locations[sound.id];
    if (!location) return;
    setBusy(true);
    setError('');
    try {
      await request('locate', {
        id: sound.id,
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        evidence: location.evidence,
        originType: originTypes[sound.id] || 'recording_location',
      });
      setNotice('Location evidence saved. Review the source before approval.');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const discover = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request('discover', {});
      await load();
      setNotice('Discovery completed. Pool metadata updated.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-page">
      <header className="admin-header">
        <button className="text-button" onClick={onBack}>
          <ArrowLeft size={17} /> Back to game
        </button>
        <div className="brand compact">
          <span className="brand-mark">◎</span> ECHO<span>ATLAS</span>
        </div>
        <span className="admin-badge">
          <ShieldCheck size={14} /> Local administration
        </span>
      </header>
      <main className="admin-content">
        <div className="admin-intro">
          <div>
            <span className="eyebrow">SOUND OPERATIONS</span>
            <h1>Discovery studio</h1>
            <p>
              Search real recordings across Wikimedia Commons, Openverse, and optional Xeno-canto.
              Only sounds with documented coordinates can enter a game. No audio files are saved.
            </p>
          </div>
          <button className="button secondary" onClick={discover} disabled={busy}>
            <RotateCcw size={16} /> Discover automatically
          </button>
        </div>
        <div className="admin-stats">
          <div>
            <strong>{stats?.total ?? '—'}</strong>
            <span>in catalog</span>
          </div>
          <div>
            <strong>{stats?.byStatus.approved ?? 0}</strong>
            <span>approved</span>
          </div>
          <div>
            <strong>{stats?.byStatus.provisional ?? 0}</strong>
            <span>provisional</span>
          </div>
          <div>
            <strong>{stats?.playable ?? 0}</strong>
            <span>game ready</span>
          </div>
        </div>
        <div className="admin-toolbar">
          <div className="segmented">
            <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>
              Search candidates
            </button>
            <button className={tab === 'pool' ? 'active' : ''} onClick={() => setTab('pool')}>
              Metadata pool
            </button>
          </div>
          <label>
            Admin token{' '}
            <input
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                sessionStorage.setItem('adminToken', event.target.value);
              }}
              placeholder="Local access needs none"
            />
          </label>
        </div>
        {tab === 'search' && (
          <form
            className="admin-search glass"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <label>
              Search phrase
              <input value={query} onChange={(event) => setQuery(event.target.value)} required />
            </label>
            <label>
              Category
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value as SoundCategory)}
              >
                {categories.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              Provider
              <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                <option value="all">All available</option>
                <option value="wikimedia">Wikimedia Commons</option>
                <option value="openverse">Openverse</option>
                <option value="xeno-canto">Xeno-canto</option>
              </select>
            </label>
            <label>
              License
              <select value={license} onChange={(event) => setLicense(event.target.value)}>
                <option value="any">Any supported</option>
                <option value="CC BY">CC BY</option>
                <option value="CC0">CC0</option>
              </select>
            </label>
            <label>
              Min seconds
              <input
                type="number"
                min="1"
                max="300"
                value={minDuration}
                onChange={(event) => setMinDuration(Number(event.target.value))}
              />
            </label>
            <label>
              Max seconds
              <input
                type="number"
                min="1"
                max="300"
                value={maxDuration}
                onChange={(event) => setMaxDuration(Number(event.target.value))}
              />
            </label>
            <button className="button primary" disabled={busy}>
              <Search size={17} /> Search audio
            </button>
          </form>
        )}
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="message success">{notice}</p>}
        <div className="sound-grid">
          {(tab === 'search' ? sounds : pool).map((sound) => (
            <article key={sound.id} className="sound-card glass">
              {typeof sound.latitude === 'number' && typeof sound.longitude === 'number' && (
                <div className="sound-map">
                  <div className="map-grid" />
                  <span
                    className="map-dot"
                    style={{
                      left: `${((sound.longitude + 180) / 360) * 100}%`,
                      top: `${((90 - sound.latitude) / 180) * 100}%`,
                    }}
                  />
                </div>
              )}
              <div className="sound-card-body">
                <div className="sound-card-top">
                  <span className="pill">{sound.category}</span>
                  <span className="muted">
                    {sound.provider} · {sound.duration ? `${Math.round(sound.duration)}s · ` : ''}
                    {sound.approvalStatus}
                  </span>
                </div>
                <h3>{sound.title}</h3>
                <p>
                  {sound.countryName &&
                  typeof sound.latitude === 'number' &&
                  typeof sound.longitude === 'number'
                    ? `${sound.countryName} · ${sound.latitude.toFixed(2)}, ${sound.longitude.toFixed(2)}`
                    : 'Recording location not documented'}
                </p>
                <p className="muted">
                  by {sound.creator} · {sound.license}
                </p>
                <p className="sound-description">
                  {sound.description.replace(/<[^>]*>/g, '').slice(0, 180)}
                </p>
                {sound.locationEvidence && (
                  <p className="muted">Location evidence: {sound.locationEvidence}</p>
                )}
                {sound.provider !== 'legacy-freesound' && (
                  <audio controls preload="none" src={sound.audioUrl} />
                )}
                {tab === 'pool' && sound.provider !== 'legacy-freesound' && !sound.playable && (
                  <div className="location-review">
                    <input
                      aria-label="Latitude"
                      type="number"
                      step="any"
                      placeholder="Latitude"
                      value={locations[sound.id]?.latitude ?? ''}
                      onChange={(event) =>
                        setLocations((current) => ({
                          ...current,
                          [sound.id]: {
                            latitude: event.target.value,
                            longitude: current[sound.id]?.longitude ?? '',
                            evidence: current[sound.id]?.evidence ?? '',
                          },
                        }))
                      }
                    />
                    <input
                      aria-label="Longitude"
                      type="number"
                      step="any"
                      placeholder="Longitude"
                      value={locations[sound.id]?.longitude ?? ''}
                      onChange={(event) =>
                        setLocations((current) => ({
                          ...current,
                          [sound.id]: {
                            latitude: current[sound.id]?.latitude ?? '',
                            longitude: event.target.value,
                            evidence: current[sound.id]?.evidence ?? '',
                          },
                        }))
                      }
                    />
                    <input
                      aria-label="Location evidence"
                      placeholder="Source documenting recording location"
                      value={locations[sound.id]?.evidence ?? ''}
                      onChange={(event) =>
                        setLocations((current) => ({
                          ...current,
                          [sound.id]: {
                            latitude: current[sound.id]?.latitude ?? '',
                            longitude: current[sound.id]?.longitude ?? '',
                            evidence: event.target.value,
                          },
                        }))
                      }
                    />
                    <select
                      aria-label="Geographic origin type"
                      value={originTypes[sound.id] || 'recording_location'}
                      onChange={(event) =>
                        setOriginTypes((current) => ({
                          ...current,
                          [sound.id]: event.target.value as OriginType,
                        }))
                      }
                    >
                      <option value="recording_location">Recording location</option>
                      <option value="cultural_origin">Cultural origin</option>
                      <option value="broadcast_origin">Broadcast origin</option>
                    </select>
                    <button
                      className="mini-button"
                      disabled={busy || !locations[sound.id]?.evidence}
                      onClick={() => locate(sound)}
                    >
                      Save location
                    </button>
                  </div>
                )}
                <div className="sound-actions">
                  <a href={sound.sourceUrl} target="_blank" rel="noreferrer">
                    {sound.provider} source ↗
                  </a>
                  <button
                    className="mini-button approve"
                    disabled={busy || !sound.playable}
                    onClick={() => review(sound, 'approved', tab === 'pool')}
                  >
                    <Check size={15} /> Approve
                  </button>
                  <button
                    className="mini-button"
                    disabled={busy}
                    onClick={() => review(sound, 'provisional', tab === 'pool')}
                  >
                    Review
                  </button>
                  <button
                    className="mini-button reject"
                    disabled={busy}
                    onClick={() => review(sound, 'rejected', tab === 'pool')}
                  >
                    <X size={15} /> Reject
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
        {tab === 'pool' && pool.length === 0 && (
          <p className="empty">
            The metadata catalog is empty. Run discovery to find real remote recordings.
          </p>
        )}
      </main>
    </div>
  );
}
