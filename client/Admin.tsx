import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Search, ShieldCheck, X, RotateCcw } from 'lucide-react';
import type { ApprovalStatus, SoundCategory, SoundEntry } from '../shared/types';
import { serverBase } from './config';

interface AdminProps {
  onBack: () => void;
}
type Stats = {
  total: number;
  byCategory: Record<string, number>;
  byCountry: Record<string, number>;
  byStatus: Record<string, number>;
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
  const [minDuration, setMinDuration] = useState(12);
  const [maxDuration, setMaxDuration] = useState(75);
  const [sounds, setSounds] = useState<SoundEntry[]>([]);
  const [pool, setPool] = useState<SoundEntry[]>([]);
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
      const data = await request('search', { query, category, license, minDuration, maxDuration });
      setSounds(data.sounds);
      if (!data.sounds.length)
        setNotice('No eligible geotagged sounds matched. Try another search.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const review = async (sound: SoundEntry, status: ApprovalStatus, existing: boolean) => {
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
              Find real geotagged recordings, listen remotely, and review their metadata. No audio
              files are saved.
            </p>
          </div>
          <button className="button secondary" onClick={discover} disabled={busy}>
            <RotateCcw size={16} /> Discover automatically
          </button>
        </div>
        <div className="admin-stats">
          <div>
            <strong>{stats?.total ?? '—'}</strong>
            <span>in pool</span>
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
            <strong>{Object.keys(stats?.byCountry ?? {}).length}</strong>
            <span>countries</span>
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
              License
              <select value={license} onChange={(event) => setLicense(event.target.value)}>
                <option value="any">Any supported</option>
                <option>Attribution</option>
                <option>Creative Commons 0</option>
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
              <Search size={17} /> Search Freesound
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
              <div className="sound-card-body">
                <div className="sound-card-top">
                  <span className="pill">{sound.category}</span>
                  <span className="muted">
                    {Math.round(sound.duration)}s · {sound.approvalStatus}
                  </span>
                </div>
                <h3>{sound.title}</h3>
                <p>
                  {sound.countryName} · {sound.latitude.toFixed(2)}, {sound.longitude.toFixed(2)}
                </p>
                <p className="muted">
                  by {sound.username} · {sound.license}
                </p>
                <p className="sound-description">
                  {sound.description.replace(/<[^>]*>/g, '').slice(0, 180)}
                </p>
                <audio controls preload="none" src={sound.previewUrl} />
                <div className="sound-actions">
                  <a href={sound.sourceUrl} target="_blank" rel="noreferrer">
                    Freesound source ↗
                  </a>
                  <button
                    className="mini-button approve"
                    disabled={busy}
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
            The metadata pool is empty. Configure Freesound and run discovery.
          </p>
        )}
      </main>
    </div>
  );
}
