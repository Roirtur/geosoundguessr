import { describe, expect, it } from 'vitest';
import { countryAt, haversineKm, parseGeotag, scoreForDistance, validCoordinates } from './geo';

describe('geography and scoring', () => {
  it('validates coordinates and Freesound latitude longitude strings', () => {
    expect(parseGeotag('48.8566 2.3522')).toEqual({ latitude: 48.8566, longitude: 2.3522 });
    expect(parseGeotag('48.8566, 2.3522')).toEqual({ latitude: 48.8566, longitude: 2.3522 });
    expect(parseGeotag('91 2')).toBeNull();
    expect(parseGeotag('hello world')).toBeNull();
    expect(validCoordinates({ latitude: 90, longitude: -180 })).toBe(true);
    expect(validCoordinates({ latitude: Infinity, longitude: 0 })).toBe(false);
  });
  it('finds real country polygons and excludes ocean', () => {
    expect(countryAt({ latitude: 48.8566, longitude: 2.3522 })?.properties.name).toBe('France');
    expect(countryAt({ latitude: 35.6762, longitude: 139.6503 })?.properties.name).toBe('Japan');
    expect(countryAt({ latitude: 0, longitude: -140 })).toBeUndefined();
  });
  it('uses Haversine kilometres and exact score boundaries', () => {
    const paris = { latitude: 48.8566, longitude: 2.3522 };
    expect(haversineKm(paris, paris)).toBe(0);
    expect(haversineKm(paris, { latitude: 51.5072, longitude: -0.1276 })).toBeCloseTo(343.5, 0);
    expect(haversineKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 })).toBeCloseTo(
      Math.PI * 6371,
      5,
    );
    expect(scoreForDistance(0)).toBe(100);
    expect(scoreForDistance(3185.5 * 0.25)).toBe(75);
    expect(scoreForDistance(3185.5 * 0.5)).toBe(50);
    expect(scoreForDistance(3185.5 * 0.75)).toBe(25);
    expect(scoreForDistance(3185.5)).toBe(0);
    expect(scoreForDistance(6000)).toBe(0);
  });
});
