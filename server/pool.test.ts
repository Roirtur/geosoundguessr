import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGameSound } from './pool';
import type { SoundCandidate } from '../shared/types';

afterEach(() => {
  delete process.env.SOUND_METADATA_FILE;
});

describe('metadata migration', () => {
  it('ships a substantial metadata-only catalog of playable documented recordings', async () => {
    const catalog = JSON.parse(
      await readFile(join(process.cwd(), 'server/data/seed-sounds.json'), 'utf8'),
    ) as SoundCandidate[];
    expect(catalog.length).toBeGreaterThanOrEqual(50);
    expect(catalog.every(isGameSound)).toBe(true);
    expect(catalog.every((sound) => sound.audioUrl.startsWith('https://'))).toBe(true);
    expect(catalog.every((sound) => sound.audioUrl.length < 2000)).toBe(true);
  });

  it('preserves reviewed legacy metadata without making its old audio playable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'echo-atlas-migration-'));
    const file = join(directory, 'sounds.json');
    try {
      await writeFile(
        file,
        JSON.stringify([
          {
            id: 'old-recording',
            freesoundId: 123,
            previewUrl: 'https://cdn.freesound.org/old.mp3',
            sourceUrl: 'https://freesound.org/s/123/',
            username: 'recorder',
            title: 'Reviewed recording',
            countryName: 'France',
            countryCode: '250',
            latitude: 48.8566,
            longitude: 2.3522,
            approvalStatus: 'approved',
            category: 'city',
            license: 'Attribution',
          },
          { id: 'custom-note', note: 'User-created metadata in an older format' },
        ]),
      );
      process.env.SOUND_METADATA_FILE = file;
      vi.resetModules();
      const { SoundPool } = await import('./pool');
      const pool = new SoundPool([]);
      await pool.load();
      expect(pool.list()[0]).toMatchObject({
        provider: 'legacy-freesound',
        providerId: '123',
        approvalStatus: 'approved',
        countryName: 'France',
        playable: false,
      });
      expect(pool.stats().playable).toBe(0);
      await expect(pool.pick(1, 'casual')).rejects.toThrow();
      await pool.review('old-recording', 'rejected');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      expect(saved[0].freesoundId).toBe(123);
      expect(saved[1]).toEqual({
        id: 'custom-note',
        note: 'User-created metadata in an older format',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
