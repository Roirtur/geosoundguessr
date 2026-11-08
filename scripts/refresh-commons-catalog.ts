import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isGameSound, recordingKey, soundKey } from '../server/pool';
import { COMMONS_STARTERS, WikimediaProvider } from '../server/providers';
import type { SoundCandidate, SoundEntry } from '../shared/types';

const OUTPUT =
  process.env.SOUND_CATALOG_FILE || join(process.cwd(), 'server/data/seed-sounds.json');
const PAGES_PER_QUERY = Math.max(1, Number(process.env.COMMONS_CATALOG_PAGES || 3));
const MAX_RECORDINGS = Math.max(1, Number(process.env.COMMONS_CATALOG_MAX || 2000));
const MAX_PER_COUNTRY = Math.max(1, Number(process.env.COMMONS_CATALOG_MAX_PER_COUNTRY || 40));
const REQUEST_DELAY_MS = Math.max(1000, Number(process.env.COMMONS_CATALOG_DELAY_MS || 3000));
const QUERY_GROUPS = [
  [
    'field recording',
    'soundscape',
    'street ambience',
    'urban ambience',
    'metro sound',
    'railway sound',
    'airport sound',
    'market ambience',
    'bird song',
    'dawn chorus',
    'rain sound',
    'thunder sound',
    'ocean waves',
    'waterfall sound',
    'forest sound',
    'insect sound',
    'church bells',
    'festival sound',
    'folk music field recording',
    'public announcement sound',
    'traffic sound',
    'harbour sound',
    'wind sound',
  ],
  [
    'London sound',
    'Paris sound',
    'Berlin sound',
    'Rome sound',
    'Madrid sound',
    'Prague sound',
    'Stockholm sound',
    'Helsinki sound',
    'Warsaw sound',
    'Istanbul sound',
    'Cairo sound',
    'Nairobi sound',
    'Cape Town sound',
    'Lagos sound',
    'Delhi sound',
    'Mumbai sound',
    'Bangkok sound',
    'Tokyo sound',
    'Seoul sound',
    'Taipei sound',
    'Singapore sound',
    'Sydney sound',
    'Melbourne sound',
  ],
  [
    'Mexico sound',
    'Brazil sound',
    'Argentina sound',
    'Chile sound',
    'Peru sound',
    'Colombia sound',
    'Canada sound',
    'New York sound',
    'Chicago sound',
    'San Francisco sound',
    'New Orleans sound',
    'Caribbean sound',
    'Amazon rainforest sound',
    'Andes sound',
    'desert sound',
    'volcano sound',
    'glacier sound',
    'river sound',
    'water soundscape',
    'coastal sound',
    'ship horn sound',
    'road traffic sound',
    'train station sound',
  ],
  [
    'India field recording',
    'China field recording',
    'Japan field recording',
    'Indonesia field recording',
    'Philippines field recording',
    'Vietnam sound',
    'Thailand sound',
    'Australia field recording',
    'New Zealand sound',
    'South Africa sound',
    'Kenya sound',
    'Tanzania sound',
    'Uganda sound',
    'Morocco sound',
    'Ghana sound',
    'bird sound recording',
    'frog sound recording',
    'whale sound recording',
    'cricket sound recording',
    'monkey sound recording',
    'traditional music recording',
    'market sound recording',
    'religious bells sound',
  ],
] as const;
const requestedGroup = Number(process.env.COMMONS_CATALOG_GROUP);
const currentWeek = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
const QUERY_GROUP_INDEX = Number.isInteger(requestedGroup)
  ? Math.abs(requestedGroup) % QUERY_GROUPS.length
  : currentWeek % QUERY_GROUPS.length;
const QUERIES = QUERY_GROUPS[QUERY_GROUP_INDEX];

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function categoryFor(query: string): SoundEntry['category'] {
  if (query.includes('music')) return 'music';
  if (query.includes('festival') || query.includes('church')) return 'culture';
  if (/street|urban|metro|railway|airport|market|announcement|traffic|harbour/.test(query))
    return 'city';
  return 'nature';
}

async function existingSounds(): Promise<Map<string, SoundCandidate>> {
  try {
    const body = JSON.parse(await readFile(OUTPUT, 'utf8')) as unknown;
    if (!Array.isArray(body)) return new Map();
    return new Map(
      body
        .filter((item): item is SoundCandidate => !!item && typeof item === 'object')
        .map((item) => [soundKey(item), item]),
    );
  } catch {
    return new Map();
  }
}

function stableEntry(sound: SoundEntry, existing: Map<string, SoundCandidate>): SoundEntry {
  const previous = existing.get(soundKey(sound));
  return {
    ...sound,
    id: previous?.id || `wikimedia:${sound.providerId}`,
    lastCheckedAt: previous?.lastCheckedAt || new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const provider = new WikimediaProvider();
  const existing = await existingSounds();
  const discovered: SoundEntry[] = [];
  const capture = (items: SoundCandidate[]) => {
    discovered.push(...items.filter(isGameSound).map((item) => stableEntry(item, existing)));
  };

  capture([...existing.values()]);

  capture(
    await provider.getSounds(COMMONS_STARTERS, {
      'File:Thunder Claps.ogg': 'nature',
      'File:Steam Whistle at Georgia Tech.ogg': 'city',
      'File:Bugu.ogg': 'nature',
      'File:台北捷運廣播-月台間隙提示.ogg': 'city',
      "File:Arrivée et départ d'une rame MF 01.ogg": 'city',
      'File:2011-06-05 19-32 Berlin TXL Airplane Flyover plus Wingtip Vortex.ogg': 'city',
      'File:Northern California Folk Music - Mazurka.oga': 'music',
    }),
  );

  console.log(
    `Searching Commons catalog query group ${QUERY_GROUP_INDEX + 1}/${QUERY_GROUPS.length} (${QUERIES.length} terms).`,
  );
  let completed = 0;
  for (const query of QUERIES) {
    for (let page = 1; page <= PAGES_PER_QUERY; page++) {
      try {
        capture(
          await provider.searchSounds({
            query,
            category: categoryFor(query),
            page,
            minDuration: 8,
            maxDuration: 120,
          }),
        );
      } catch (error) {
        console.warn(
          `Skipping Commons search “${query}” page ${page}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
      completed++;
      if (completed < QUERIES.length * PAGES_PER_QUERY) await pause(REQUEST_DELAY_MS);
    }
  }

  const seenRecordings = new Set<string>();
  const countryCounts = new Map<string, number>();
  const catalog = discovered
    .sort(
      (a, b) =>
        a.countryName.localeCompare(b.countryName) ||
        a.category.localeCompare(b.category) ||
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
  if (!catalog.length)
    throw new Error('Commons catalog refresh returned no geographically documented audio.');
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote ${catalog.length} geographically documented Commons recordings across ${countryCounts.size} countries to ${OUTPUT}.`,
  );
}

await main();
