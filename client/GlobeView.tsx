import { memo, useEffect, useMemo, useRef, useState } from 'react';
import Globe, { type GlobeMethods } from 'react-globe.gl';
import { countryAt, type Country } from '../shared/geo';
import displayMap from './countries-display.json';
import type { Coordinates, PlayerView, RevealView } from '../shared/types';

export interface Selection extends Coordinates {
  countryName: string;
  countryCode: string;
}
interface GlobeProps {
  phase: 'menu' | 'lobby' | 'preparing' | 'guessing' | 'results' | 'finished';
  selected?: Selection;
  reveal?: RevealView;
  players?: PlayerView[];
  disabled?: boolean;
  onSelect?: (selection: Selection) => void;
}
interface Marker extends Coordinates {
  label: string;
  color: string;
  radius: number;
}
interface Arc {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  color: string;
}
const displayCountries = displayMap.features as unknown as Country[];

function GlobeView({ phase, selected, reveal, players = [], disabled, onSelect }: GlobeProps) {
  const host = useRef<HTMLDivElement>(null);
  const globe = useRef<GlobeMethods | undefined>(undefined);
  const [size, setSize] = useState({ width: 1000, height: 800 });
  const [hoveredCountry, setHoveredCountry] = useState<string>();

  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const controls = globe.current?.controls();
    if (controls) {
      controls.autoRotate = phase === 'menu';
      controls.autoRotateSpeed = 0.45;
      controls.enableDamping = true;
    }
  }, [phase]);
  useEffect(() => {
    if (reveal && phase === 'results')
      globe.current?.pointOfView(
        { lat: reveal.answer.latitude, lng: reveal.answer.longitude, altitude: 2.1 },
        1800,
      );
  }, [reveal, phase]);

  const markers = useMemo<Marker[]>(() => {
    if (reveal && ['results', 'finished'].includes(phase)) {
      return [
        {
          latitude: reveal.answer.latitude,
          longitude: reveal.answer.longitude,
          label: `Answer · ${reveal.answer.countryName}`,
          color: '#f9cc74',
          radius: 0.85,
        },
        ...reveal.guesses.map((guess) => {
          const player = players.find((p) => p.id === guess.playerId);
          return {
            latitude: guess.latitude,
            longitude: guess.longitude,
            label: `${player?.name || 'Player'} · ${guess.distanceKm.toFixed(0)} km`,
            color: player?.color || '#ffffff',
            radius: 0.62,
          };
        }),
      ];
    }
    return selected ? [{ ...selected, label: 'Your guess', color: '#49e4ec', radius: 0.72 }] : [];
  }, [selected, reveal, players, phase]);
  const arcs = useMemo<Arc[]>(
    () =>
      reveal && ['results', 'finished'].includes(phase)
        ? reveal.guesses.map((guess) => ({
            startLat: guess.latitude,
            startLng: guess.longitude,
            endLat: reveal.answer.latitude,
            endLng: reveal.answer.longitude,
            color: players.find((p) => p.id === guess.playerId)?.color || '#ffffff',
          }))
        : [],
    [reveal, players, phase],
  );

  const select = (_polygon: object, _event: MouseEvent, coords: { lat: number; lng: number }) => {
    if (phase !== 'guessing' || disabled || !onSelect) return;
    const actual = countryAt({ latitude: coords.lat, longitude: coords.lng });
    if (!actual) return;
    onSelect({
      latitude: coords.lat,
      longitude: coords.lng,
      countryName: actual.properties.name,
      countryCode: actual.id,
    });
  };

  return (
    <div className="globe-host" ref={host} aria-label="Interactive globe">
      <Globe
        ref={globe}
        width={size.width}
        height={size.height}
        globeImageUrl="/earth.jpg"
        backgroundImageUrl="/space.png"
        showAtmosphere
        atmosphereColor="#5ea8d9"
        atmosphereAltitude={0.16}
        polygonsData={displayCountries}
        polygonGeoJsonGeometry="geometry"
        polygonCapColor={(raw) => {
          const country = raw as Country;
          if (phase === 'results' && reveal?.answer.countryName === country.properties.name)
            return 'rgba(255,198,92,0.36)';
          if (selected?.countryName === country.properties.name && phase === 'guessing')
            return 'rgba(56,232,233,0.38)';
          return hoveredCountry === country.properties.name
            ? 'rgba(88,193,237,0.3)'
            : 'rgba(44,125,174,0.055)';
        }}
        polygonSideColor={() => 'rgba(41,134,195,0.08)'}
        polygonStrokeColor={() => 'rgba(116,195,226,0.5)'}
        polygonAltitude={0.004}
        polygonCapCurvatureResolution={10}
        polygonsTransitionDuration={0}
        polygonLabel={(raw) => (raw as Country).properties.name}
        onPolygonHover={(raw) => {
          const next = raw ? (raw as Country).properties.name : undefined;
          setHoveredCountry((current) => (current === next ? current : next));
        }}
        onPolygonClick={select}
        onGlobeClick={(coords, event) => select({}, event, coords)}
        pointsData={markers}
        pointLat="latitude"
        pointLng="longitude"
        pointColor="color"
        pointRadius="radius"
        pointAltitude={0.012}
        pointLabel="label"
        pointResolution={6}
        pointsTransitionDuration={700}
        arcsData={arcs}
        arcStartLat="startLat"
        arcStartLng="startLng"
        arcEndLat="endLat"
        arcEndLng="endLng"
        arcColor="color"
        arcAltitudeAutoScale={0.35}
        arcStroke={0.45}
        arcCurveResolution={32}
        arcCircularResolution={4}
        arcDashLength={0.45}
        arcDashGap={0.08}
        arcDashAnimateTime={2200}
      />
      <div className="globe-vignette" aria-hidden="true" />
    </div>
  );
}

export default memo(GlobeView);
