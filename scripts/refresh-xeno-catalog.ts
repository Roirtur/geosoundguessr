import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isGameSound, recordingKey, soundKey } from '../server/pool';
import { XenoCantoProvider } from '../server/providers';
import type { SoundCandidate, SoundEntry } from '../shared/types';

const OUTPUT =
  process.env.SOUND_CATALOG_FILE || join(process.cwd(), 'server/data/seed-sounds.json');
const MAX_RECORDINGS = Math.max(1, Number(process.env.XENO_CATALOG_MAX || 5000));
const MAX_PER_COUNTRY = Math.max(1, Number(process.env.XENO_CATALOG_MAX_PER_COUNTRY || 150));
const PAGES = Math.max(1, Number(process.env.XENO_CATALOG_PAGES || 350));
const REQUEST_DELAY_MS = Math.max(500, Number(process.env.XENO_CATALOG_DELAY_MS || 1000));

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function readCatalog(): Promise<SoundCandidate[]> {
  try {
    const body = JSON.parse(await readFile(OUTPUT, 'utf8')) as unknown;
    return Array.isArray(body) ? body.filter((item): item is SoundCandidate => !!item) : [];
  } catch {
    return [];
  }
}

function stableEntry(sound: SoundEntry, existing: Map<string, SoundCandidate>): SoundEntry {
  const previous = existing.get(soundKey(sound));
  return {
    ...sound,
    id: previous?.id || `xeno-canto:${sound.providerId}`,
    lastCheckedAt: previous?.lastCheckedAt || new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  if (!process.env.XENO_CANTO_API_KEY)
    throw new Error('XENO_CANTO_API_KEY is required to build the Xeno-canto catalog.');
  const existingCatalog = await readCatalog();
  const existing = new Map(existingCatalog.map((sound) => [soundKey(sound), sound]));
  const provider = new XenoCantoProvider(process.env.XENO_CANTO_API_KEY);
  const discovered: SoundEntry[] = existingCatalog.filter(isGameSound) as SoundEntry[];

  for (let page = 1; page <= PAGES; page++) {
    const pageResults = await provider.searchSounds({
      query: 'q:>C',
      category: 'nature',
      page,
      minDuration: 12,
      maxDuration: 90,
    });
    if (!pageResults.length) break;
    discovered.push(
      ...pageResults.filter(isGameSound).map((sound) => stableEntry(sound, existing)),
    );
    console.log(`Collected Xeno-canto page ${page}/${PAGES} (${pageResults.length} candidates).`);
    if (page < PAGES) await pause(REQUEST_DELAY_MS);
  }

  const seenRecordings = new Set<string>();
  const countryCounts = new Map<string, number>();
  const catalog = discovered
    .sort(
      (a, b) =>
        a.countryName.localeCompare(b.countryName) ||
        a.provider.localeCompare(b.provider) ||
        a.title.localeCompare(b.title),
    )
    .filter((sound) => {
      const key = recordingKey(sound);
      if (seenRecordings.has(key)) return false;
      if ((countryCounts.get(sound.countryCode) || 0) >= MAX_PER_COUNTRY) return false;
      seenRecordings.add(key);
      countryCounts.set(sound.countryCode, (countryCounts.get(sound.countryCode) || 0) + 1);
      return true;
    })
    .slice(0, MAX_RECORDINGS);
  if (!catalog.some((sound) => sound.provider === 'xeno-canto'))
    throw new Error('Xeno-canto returned no geographically documented recordings.');
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote ${catalog.length} documented recordings across ${countryCounts.size} countries to ${OUTPUT}.`,
  );
}

await main();
