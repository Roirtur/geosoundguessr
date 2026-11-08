import { describe, expect, it, vi } from 'vitest';
import { FreesoundClient, FreesoundError, normalizeSound } from './freesound';
import { selectSoundSequence } from './pool';
import type { SoundEntry } from '../shared/types';

const raw = {
  id: 123,
  url: 'https://freesound.org/people/fieldrec/sounds/123/',
  name: 'Forest morning in France',
  description: 'Field recording near Paris',
  tags: ['forest', 'field-recording'],
  username: 'fieldrec',
  duration: 31,
  geotag: '48.8566 2.3522',
  license: 'Attribution',
  is_geotagged: true,
  previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/123/123_hq.mp3' },
};

describe('Freesound metadata', () => {
  it('accepts eligible country geotags as provisional metadata', () => {
    const sound = normalizeSound(raw, 'nature');
    expect(sound).toMatchObject({
      freesoundId: 123,
      countryName: 'France',
      approvalStatus: 'provisional',
      originType: 'recording_location',
    });
    expect(sound?.previewUrl).toBe(raw.previews['preview-hq-mp3']);
  });
  it('filters invalid metadata, ambiguous places and preview hosts', () => {
    expect(normalizeSound({ ...raw, geotag: '0 -140' }, 'nature')).toBeNull();
    expect(normalizeSound({ ...raw, license: 'Attribution NonCommercial' }, 'nature')).toBeNull();
    expect(
      normalizeSound({ ...raw, name: 'Paris street', geotag: '35.6762 139.6503' }, 'city'),
    ).toBeNull();
    expect(
      normalizeSound(
        { ...raw, previews: { 'preview-hq-mp3': 'https://evil.example/stream' } },
        'nature',
      ),
    ).toBeNull();
  });
  it('uses the current search endpoint, fields and private token header', async () => {
    const requester = vi.fn(
      async () => new Response(JSON.stringify({ results: [raw] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new FreesoundClient('secret-key', requester);
    const found = await client.search('forest ambience', 'nature');
    expect(found).toHaveLength(1);
    const [url, options] = vi.mocked(requester).mock.calls[0];
    expect(String(url)).toContain('/apiv2/search/?');
    expect(String(url)).toContain('fields=');
    expect((options?.headers as Record<string, string>).Authorization).toBe('Token secret-key');
    expect(String(url)).not.toContain('secret-key');
  });
  it('distinguishes missing credentials and rate limits', async () => {
    await expect(new FreesoundClient(undefined).search('birds', 'nature')).rejects.toMatchObject({
      kind: 'configuration',
    });
    const client = new FreesoundClient('key', async () => new Response('', { status: 429 }));
    await expect(client.search('birds', 'nature')).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(FreesoundError).toBeDefined();
  });
  it('discovers across themes with explicit geotag, duration and license filters', async () => {
    const urls: string[] = [];
    const requester = vi.fn(async (url: URL | RequestInfo) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ results: [{ ...raw, id: urls.length }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const found = await new FreesoundClient('key', requester).discover();
    expect(found.length).toBeGreaterThan(1);
    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls) {
      const filter = new URL(url).searchParams.get('filter') || '';
      expect(filter).toContain('is_geotagged:1');
      expect(filter).toContain('duration:[12 TO 75]');
      expect(filter).toContain('license:');
    }
  });
  it('never repeats a sound and prefers country diversity', () => {
    const base = normalizeSound(raw, 'nature')!;
    const candidates: SoundEntry[] = [
      base,
      { ...base, id: 'duplicate', freesoundId: 123 },
      {
        ...base,
        id: 'japan',
        freesoundId: 124,
        countryCode: '392',
        countryName: 'Japan',
        category: 'city',
      },
      { ...base, id: 'france2', freesoundId: 125 },
    ];
    const picked = selectSoundSequence(candidates, 2, [], () => 0.5);
    expect(new Set(picked.map((sound) => sound.freesoundId)).size).toBe(2);
    expect(new Set(picked.map((sound) => sound.countryCode)).size).toBe(2);
  });
});
