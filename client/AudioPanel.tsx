import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, Volume2, VolumeX, Waves } from 'lucide-react';

interface Props {
  src?: string;
  phase: string;
  onReady: () => void;
  onFailure: (src: string) => void;
}

export default function AudioPanel({ src, phase, onReady, onFailure }: Props) {
  const ref = useRef<HTMLAudioElement>(null);
  const reported = useRef<string | undefined>(undefined);
  const failed = useRef<string | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    audio.pause();
    setPlaying(false);
    setLoading(true);
    setBlocked(false);
    setError('');
    reported.current = undefined;
    failed.current = undefined;
    if (src) {
      audio.load();
      if (audio.readyState >= 3 && phase === 'preparing') {
        reported.current = src;
        onReady();
        setLoading(false);
      }
    }
  }, [src]);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    if (phase === 'guessing' && src) {
      audio.currentTime = 0;
      audio
        .play()
        .then(() => {
          setPlaying(true);
          setBlocked(false);
        })
        .catch(() => {
          setBlocked(true);
          setPlaying(false);
        });
    } else if (phase !== 'preparing') {
      audio.pause();
      setPlaying(false);
    }
  }, [phase, src]);
  useEffect(() => {
    if (ref.current) {
      ref.current.volume = volume;
      ref.current.muted = muted;
    }
  }, [volume, muted]);

  const ready = () => {
    setLoading(false);
    if (phase === 'preparing' && src && reported.current !== src) {
      reported.current = src;
      onReady();
    }
  };
  const failure = () => {
    setLoading(false);
    setError('This recording could not be played. Replacing it for everyone…');
    if (src && failed.current !== src) {
      failed.current = src;
      onFailure(src);
    }
  };
  const toggle = async () => {
    const audio = ref.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
        setPlaying(true);
        setBlocked(false);
      } catch {
        setBlocked(true);
        setError('Playback is blocked. Tap Play again.');
      }
    } else {
      audio.pause();
      setPlaying(false);
    }
  };
  const replay = async () => {
    if (ref.current) {
      ref.current.currentTime = 0;
      try {
        await ref.current.play();
        setPlaying(true);
        setBlocked(false);
      } catch {
        setBlocked(true);
      }
    }
  };

  return (
    <section className="audio-panel glass" aria-label="Mystery audio player">
      <audio
        ref={ref}
        src={src}
        preload="auto"
        onCanPlay={ready}
        onError={failure}
        onEnded={() => setPlaying(false)}
      />
      <div className="audio-heading">
        <span className="audio-icon">
          <Waves size={20} />
        </span>
        <div>
          <strong>Mystery Sound</strong>
          <small>
            {loading
              ? 'Loading remote recording…'
              : phase === 'preparing'
                ? 'Ready for the round'
                : blocked
                  ? 'Tap Play to start audio'
                  : 'Listen closely. Guess the place.'}
          </small>
        </div>
      </div>
      <div className="audio-controls">
        <button
          className="icon-button primary-icon"
          onClick={toggle}
          disabled={!src || phase !== 'guessing'}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <Pause size={18} fill="currentColor" />
          ) : (
            <Play size={18} fill="currentColor" />
          )}
        </button>
        <button
          className="icon-button"
          onClick={replay}
          disabled={!src || phase !== 'guessing'}
          aria-label="Replay"
        >
          <RotateCcw size={18} />
        </button>
        <button
          className="icon-button"
          onClick={() => setMuted(!muted)}
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(event) => setVolume(Number(event.target.value))}
          aria-label="Volume"
        />
      </div>
      {error && (
        <p className="audio-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
