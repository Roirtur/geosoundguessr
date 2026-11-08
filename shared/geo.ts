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

export function scoreForDistance(distanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return 0;
  return Math.round(100 * Math.max(0, 1 - distanceKm / 3185.5));
}
