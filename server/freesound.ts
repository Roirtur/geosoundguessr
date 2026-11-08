import { randomUUID } from 'node:crypto';
import { countryAt, parseGeotag } from '../shared/geo';
import type { SoundCategory, SoundEntry } from '../shared/types';

export class FreesoundError extends Error {
  constructor(
    message: string,
    public kind: 'configuration' | 'network' | 'rate_limit' | 'authentication' | 'empty',
  ) {
    super(message);
  }
}

type RawSound = Record<string, unknown>;
const FIELDS =
  'id,url,name,description,tags,username,duration,geotag,license,previews,is_geotagged';
const THEMES: { query: string; category: SoundCategory }[] = [
  { query: 'forest ambience', category: 'nature' },
  { query: 'birds field recording', category: 'nature' },
  { query: 'rainforest wildlife', category: 'nature' },
  { query: 'market ambience', category: 'city' },
  { query: 'street ambience', category: 'city' },
  { query: 'train station ambience', category: 'city' },
  { query: 'festival field recording', category: 'culture' },
  { query: 'rural ambience', category: 'nature' },
];
const PREVIEW_HOSTS = new Set(['cdn.freesound.org', 'freesound.org', 'www.freesound.org']);
const AMBIGUOUS = /\b(studio|sample pack|synthesiz|generated|sound effect|sfx|loop|stock audio)\b/i;
const CITY_HINTS: Record<string, string> = {
  paris: 'France',
  london: 'United Kingdom',
  tokyo: 'Japan',
  berlin: 'Germany',
  madrid: 'Spain',
  rome: 'Italy',
  'new york': 'United States of America',
};

export function normalizeSound(raw: RawSound, category: SoundCategory): SoundEntry | null {
  const location = parseGeotag(raw.geotag);
  if (!location || raw.is_geotagged === false) return null;
  const country = countryAt(location);
  if (!country) return null;
  const duration = Number(raw.duration);
  const id = Number(raw.id);
  if (
    !Number.isInteger(id) ||
    id <= 0 ||
    !Number.isFinite(duration) ||
    duration < 12 ||
    duration > 75
  )
    return null;
  const title = typeof raw.name === 'string' ? raw.name.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const username = typeof raw.username === 'string' ? raw.username.trim() : '';
  const license = typeof raw.license === 'string' ? raw.license : '';
  if (
    !title ||
    !username ||
    !['Attribution', 'Creative Commons 0'].includes(license) ||
    AMBIGUOUS.test(`${title} ${description}`)
  )
    return null;
  const previewObject =
    raw.previews && typeof raw.previews === 'object'
      ? (raw.previews as Record<string, unknown>)
      : {};
  const preview = ['preview-hq-mp3', 'preview-lq-mp3', 'preview-hq-ogg', 'preview-lq-ogg']
    .map((key) => previewObject[key])
    .find((value) => typeof value === 'string');
  if (typeof preview !== 'string') return null;
  try {
    const url = new URL(preview);
    if (url.protocol !== 'https:' || !PREVIEW_HOSTS.has(url.hostname)) return null;
  } catch {
    return null;
  }
  const sourceUrl =
    typeof raw.url === 'string' && /^https:\/\/freesound\.org\/people\//.test(raw.url)
      ? raw.url
      : `https://freesound.org/s/${id}/`;
  const placeText = `${title} ${description.slice(0, 250)}`.toLowerCase();
  for (const [city, countryName] of Object.entries(CITY_HINTS)) {
    if (new RegExp(`\\b${city}\\b`).test(placeText) && countryName !== country.properties.name)
      return null;
  }
  return {
    id: randomUUID(),
    freesoundId: id,
    previewUrl: preview,
    sourceUrl,
    title,
    description,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    username,
    category,
    duration,
    ...location,
    countryCode: country.id,
    countryName: country.properties.name,
    originType: 'recording_location',
    license,
    approvalStatus: 'provisional',
    attribution: `“${title}” by ${username} on Freesound (${license})`,
    lastCheckedAt: new Date().toISOString(),
  };
}

export class FreesoundClient {
  constructor(
    private key: string | undefined,
    private requester: typeof fetch = fetch,
  ) {}
  get configured(): boolean {
    return !!this.key && this.key !== 'your_api_key_here';
  }

  async search(
    query: string,
    category: SoundCategory,
    page = 1,
    filter = 'is_geotagged:1 duration:[12 TO 75]',
  ): Promise<SoundEntry[]> {
    if (!this.configured)
      throw new FreesoundError(
        'Freesound API not configured. Add FREESOUND_API_KEY to .env.',
        'configuration',
      );
    const url = new URL('https://freesound.org/apiv2/search/');
    url.searchParams.set('query', query);
    url.searchParams.set('filter', filter);
    url.searchParams.set('fields', FIELDS);
    url.searchParams.set('page_size', '50');
    url.searchParams.set('page', String(page));
    let response: Response;
    try {
      response = await this.requester(url, {
        headers: { Authorization: `Token ${this.key}` },
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new FreesoundError(
        'Could not reach Freesound. Check the network connection.',
        'network',
      );
    }
    if (response.status === 429)
      throw new FreesoundError('Freesound rate limit reached. Try again later.', 'rate_limit');
    if (response.status === 401 || response.status === 403)
      throw new FreesoundError('Freesound API key was rejected.', 'authentication');
    if (!response.ok)
      throw new FreesoundError(`Freesound returned HTTP ${response.status}.`, 'network');
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new FreesoundError('Freesound returned invalid JSON.', 'network');
    }
    const results = (body as { results?: unknown })?.results;
    if (!Array.isArray(results))
      throw new FreesoundError('Freesound response has no sound results.', 'network');
    return results
      .map((item) =>
        item && typeof item === 'object' ? normalizeSound(item as RawSound, category) : null,
      )
      .filter((item): item is SoundEntry => !!item);
  }

  async discover(): Promise<SoundEntry[]> {
    const themes = [...THEMES].sort(() => Math.random() - 0.5);
    const collected: SoundEntry[] = [];
    let lastError: Error | undefined;
    for (const [index, theme] of themes.entries()) {
      try {
        const license = index % 2 ? 'Creative Commons 0' : 'Attribution';
        const filter = `is_geotagged:1 duration:[12 TO 75] license:"${license}"`;
        const page = 1 + Math.floor(Math.random() * 3);
        let found = await this.search(theme.query, theme.category, page, filter);
        if (found.length === 0 && page !== 1)
          found = await this.search(theme.query, theme.category, 1, filter);
        collected.push(...found);
      } catch (error) {
        lastError = error as Error;
        if (
          error instanceof FreesoundError &&
          ['configuration', 'authentication', 'rate_limit'].includes(error.kind)
        )
          throw error;
      }
      if (collected.length >= 80) break;
    }
    if (collected.length === 0 && lastError) throw lastError;
    return [...new Map(collected.map((sound) => [sound.freesoundId, sound])).values()];
  }
}
