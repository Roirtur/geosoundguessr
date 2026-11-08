import countries from './data/countries-50m.json';
import { feature } from 'topojson-client';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { Coordinates } from './types';

export type Country = Feature<Polygon | MultiPolygon, { name: string }> & { id: string };
const collection = feature(
  countries as never,
  countries.objects.countries as never,
) as unknown as FeatureCollection<Polygon | MultiPolygon, { name: string }>;
export const countryFeatures: Country[] = collection.features.map((country) => ({
  ...country,
  id: String(country.id),
})) as Country[];

export function validCoordinates(location: unknown): location is Coordinates {
  if (!location || typeof location !== 'object') return false;
  const { latitude, longitude } = location as Partial<Coordinates>;
  return (
    typeof latitude === 'number' &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    typeof longitude === 'number' &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function countryAt(location: Coordinates): Country | undefined {
  if (!validCoordinates(location)) return undefined;
  const p = point([location.longitude, location.latitude]);
  return countryFeatures.find((country) => booleanPointInPolygon(p, country));
}

export function parseCoordinateString(raw: unknown): Coordinates | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split(/[\s,]+/);
  if (parts.length !== 2 || parts.some((part) => part === '')) return null;
  const location = { latitude: Number(parts[0]), longitude: Number(parts[1]) };
  return validCoordinates(location) ? location : null;
}

export function haversineKm(a: Coordinates, b: Coordinates): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

interface CountryDistance {
  distanceKm: number;
  closest: Coordinates;
}

const EARTH_RADIUS_KM = 6371;
const radians = (degrees: number) => (degrees * Math.PI) / 180;
const degrees = (angle: number) => (angle * 180) / Math.PI;

function angularDistance(a: Coordinates, b: Coordinates): number {
  return haversineKm(a, b) / EARTH_RADIUS_KM;
}

function bearing(a: Coordinates, b: Coordinates): number {
  const fromLat = radians(a.latitude);
  const toLat = radians(b.latitude);
  const deltaLongitude = radians(b.longitude - a.longitude);
  return Math.atan2(
    Math.sin(deltaLongitude) * Math.cos(toLat),
    Math.cos(fromLat) * Math.sin(toLat) -
      Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLongitude),
  );
}

function destination(
  start: Coordinates,
  bearingRadians: number,
  distanceRadians: number,
): Coordinates {
  const latitude = radians(start.latitude);
  const longitude = radians(start.longitude);
  const targetLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(distanceRadians) +
      Math.cos(latitude) * Math.sin(distanceRadians) * Math.cos(bearingRadians),
  );
  const targetLongitude =
    longitude +
    Math.atan2(
      Math.sin(bearingRadians) * Math.sin(distanceRadians) * Math.cos(latitude),
      Math.cos(distanceRadians) - Math.sin(latitude) * Math.sin(targetLatitude),
    );
  return {
    latitude: degrees(targetLatitude),
    longitude: ((degrees(targetLongitude) + 540) % 360) - 180,
  };
}

function closestPointOnSegment(
  location: Coordinates,
  start: Coordinates,
  end: Coordinates,
): CountryDistance {
  const segmentLength = angularDistance(start, end);
  if (segmentLength < 1e-12) return { distanceKm: haversineKm(location, start), closest: start };
  const fromStart = angularDistance(start, location);
  const segmentBearing = bearing(start, end);
  const locationBearing = bearing(start, location);
  const alongTrack = Math.atan2(
    Math.sin(fromStart) * Math.cos(locationBearing - segmentBearing),
    Math.cos(fromStart),
  );
  if (alongTrack <= 0) return { distanceKm: haversineKm(location, start), closest: start };
  if (alongTrack >= segmentLength) return { distanceKm: haversineKm(location, end), closest: end };
  const closest = destination(start, segmentBearing, alongTrack);
  return { distanceKm: haversineKm(location, closest), closest };
}

function countryRings(country: Country): number[][][] {
  return country.geometry.type === 'Polygon'
    ? country.geometry.coordinates
    : country.geometry.coordinates.flat();
}

export function closestPointOnCountry(location: Coordinates, country: Country): CountryDistance {
  if (!validCoordinates(location)) return { distanceKm: Infinity, closest: location };
  if (booleanPointInPolygon(point([location.longitude, location.latitude]), country))
    return { distanceKm: 0, closest: location };
  let best: CountryDistance = { distanceKm: Infinity, closest: location };
  for (const ring of countryRings(country)) {
    for (let index = 1; index < ring.length; index++) {
      const start = { longitude: ring[index - 1][0], latitude: ring[index - 1][1] };
      const end = { longitude: ring[index][0], latitude: ring[index][1] };
      const candidate = closestPointOnSegment(location, start, end);
      if (candidate.distanceKm < best.distanceKm) best = candidate;
    }
  }
  return best;
}

export function distanceToCountryKm(location: Coordinates, country: Country): number {
  return closestPointOnCountry(location, country).distanceKm;
}

export function scoreForDistance(distanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return 0;
  return Math.round(100 * Math.max(0, 1 - distanceKm / 3185.5));
}
