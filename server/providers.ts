import { randomUUID } from 'node:crypto';
import { countryAt, validCoordinates } from '../shared/geo';
import type { SoundCandidate, SoundCategory } from '../shared/types';
import { publicAudioUrl } from './audio-relay';

export interface SoundSearchOptions {
  query: string;
  category: SoundCategory;
  page?: number;
  minDuration?: number;
  maxDuration?: number;
  license?: string;
}
export interface AudioProvider {
  id: SoundCandidate['provider'];
  name: string;
  enabled: boolean;
  searchSounds(options: SoundSearchOptions): Promise<SoundCandidate[]>;
  /**
   * Returns an ephemeral, varied sample when a provider can do so without
   * building a local catalog. Results are used for one match only.
   */
  randomSounds?(count: number, random?: () => number): Promise<SoundCandidate[]>;
  getSound(id: string): Promise<SoundCandidate | null>;
  validateSound(sound: SoundCandidate): Promise<boolean>;
}
export class AudioProviderError extends Error {
  constructor(
    message: string,
    public kind: 'network' | 'rate_limit' | 'authentication' | 'response',
  ) {
    super(message);
  }
}
type Dict = Record<string, unknown>;
const object = (value: unknown): Dict =>
  value && typeof value === 'object' ? (value as Dict) : {};
const string = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const noHtml = (value: unknown): string =>
  string(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
const https = (value: unknown): string => {
  try {
    const raw = string(value);
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
};
const isFreesound = (value: unknown): boolean =>
  /(^|\.)freesound\.org$/i.test(
    (() => {
      try {
        return new URL(string(value)).hostname;
      } catch {
        return '';
      }
    })(),
  );
const eligibleLicense = (license: string): boolean =>
  /^(CC0|CC BY(?:-NC)?(?:-SA)?(?: |$)|Public domain|PDM)/i.test(license);
const base = (
  provider: SoundCandidate['provider'],
  providerId: string,
  title: string,
  audioUrl: string,
  sourceUrl: string,
  creator: string,
  license: string,
  category: SoundCategory,
  description = '',
): SoundCandidate => ({
  id: randomUUID(),
  provider,
  providerId,
  title,
  audioUrl,
  sourceUrl,
  creator,
  license,
  category,
  description,
  tags: [],
  originType: 'recording_location',
  approvalStatus: 'provisional',
  attribution: `“${title}” by ${creator || 'unknown creator'} (${license}) — ${sourceUrl}`,
  lastCheckedAt: new Date().toISOString(),
  playable: false,
});
function withCoordinates(
  sound: SoundCandidate,
  location: unknown,
  evidence: string,
): SoundCandidate {
  if (!validCoordinates(location)) return sound;
  const country = countryAt(location);
  if (!country) return sound;
  return {
    ...sound,
    ...location,
    countryCode: country.id,
    countryName: country.properties.name,
    locationEvidence: evidence,
    playable: true,
  };
}
async function json(url: URL, requester: typeof fetch): Promise<Dict> {
  let response: Response;
  try {
    response = await requester(url, {
      headers: {
        'User-Agent':
          'EchoAtlas/1.0 (https://github.com/Roirtur/geosoundguessr; contact via GitHub issues)',
      },
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new AudioProviderError(`Could not reach ${url.hostname}.`, 'network');
  }
  if (response.status === 429)
    throw new AudioProviderError(
      `${url.hostname} rate limit reached. Try again later.`,
      'rate_limit',
    );
  if (response.status === 401 || response.status === 403)
    throw new AudioProviderError(`${url.hostname} rejected the request.`, 'authentication');
  if (!response.ok)
    throw new AudioProviderError(`${url.hostname} returned HTTP ${response.status}.`, 'network');
  try {
    return object(await response.json());
  } catch {
    throw new AudioProviderError(`${url.hostname} returned invalid JSON.`, 'response');
  }
}
async function head(sound: SoundCandidate, requester: typeof fetch): Promise<boolean> {
  const audio = https(sound.audioUrl);
  if (!audio || isFreesound(audio)) return false;
  const probe = async (method: 'HEAD' | 'GET'): Promise<boolean> => {
    let target = audio;
    try {
      for (let redirect = 0; redirect <= 3; redirect++) {
        const url = await publicAudioUrl(target);
        if (!url) return false;
        const response = await requester(url, {
          method,
          headers: method === 'GET' ? { Range: 'bytes=0-0' } : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(8000),
        });
        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
          await response.body?.cancel();
          target = new URL(response.headers.get('location')!, url).href;
          continue;
        }
        const valid =
          response.ok && /audio|ogg|octet-stream/i.test(response.headers.get('content-type') || '');
        await response.body?.cancel();
        return valid;
      }
    } catch {
      return false;
    }
    return false;
  };
  return (await probe('HEAD')) || (await probe('GET'));
}

// These file titles were checked against Commons coordinates and licensing. Metadata and
// playback URLs are fetched live; no recording bytes are bundled or cached on disk.
export const COMMONS_STARTERS = [
  'File:Thunder Claps.ogg',
  'File:Steam Whistle at Georgia Tech.ogg',
  'File:Bugu.ogg',
  'File:台北捷運廣播-月台間隙提示.ogg',
  "File:Arrivée et départ d'une rame MF 01.ogg",
  'File:2011-06-05 19-32 Berlin TXL Airplane Flyover plus Wingtip Vortex.ogg',
  'File:Northern California Folk Music - Mazurka.oga',
] as const;

export class WikimediaProvider implements AudioProvider {
  readonly id = 'wikimedia';
  readonly name = 'Wikimedia Commons';
  readonly enabled = true;
  constructor(private requester: typeof fetch = fetch) {}
  private url(): URL {
    const url = new URL('https://commons.wikimedia.org/w/api.php');
    url.searchParams.set('action', 'query');
    url.searchParams.set('format', 'json');
    url.searchParams.set('prop', 'imageinfo|coordinates|videoinfo');
    url.searchParams.set('coprop', 'type');
    url.searchParams.set('iiprop', 'url|mime|extmetadata|metadata');
    url.searchParams.set('viprop', 'derivatives');
    return url;
  }
  private normalize(pageValue: unknown, category: SoundCategory): SoundCandidate | null {
    const page = object(pageValue),
      title = string(page.title);
    const info = object(Array.isArray(page.imageinfo) ? page.imageinfo[0] : null);
    const videoInfo = object(Array.isArray(page.videoinfo) ? page.videoinfo[0] : null);
    const derivative = Array.isArray(videoInfo.derivatives)
      ? videoInfo.derivatives.find((item) => object(item).type === 'audio/mpeg')
      : null;
    const audioUrl = https(object(derivative).src) || https(info.url),
      mime = string(info.mime);
    const meta = object(info.extmetadata);
    const field = (key: string) => noHtml(object(meta[key]).value);
    const license = field('LicenseShortName') || field('License');
    if (
      !title.startsWith('File:') ||
      !audioUrl ||
      !/audio|application\/ogg/i.test(mime) ||
      !eligibleLicense(license)
    )
      return null;
    if (new URL(audioUrl).hostname !== 'upload.wikimedia.org') return null;
    const creator = field('Artist') || 'Wikimedia Commons contributor';
    const sourceUrl =
      https(info.descriptionurl) ||
      `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    const description = field('ImageDescription');
    const sound = base(
      this.id,
      title,
      title.slice(5).replace(/\.[^.]+$/, ''),
      audioUrl,
      sourceUrl,
      creator,
      license,
      category,
      description,
    );
    const metadata = Array.isArray(info.metadata) ? info.metadata : [];
    const length = Number(object(metadata.find((entry) => object(entry).name === 'length')).value);
    if (Number.isFinite(length) && length > 0) sound.duration = length;
    const coordinate = object(
      Array.isArray(page.coordinates)
        ? page.coordinates.find((entry) => object(entry).type === 'camera')
        : null,
    );
    const located = withCoordinates(
      sound,
      { latitude: Number(coordinate.lat), longitude: Number(coordinate.lon) },
      `Wikimedia Commons file coordinates (${string(coordinate.type) || 'page'}); verify that they describe the recording location.`,
    );
    // File coordinates are uploader supplied. They remain provisional until reviewed.
    return located;
  }
  async getSounds(
    ids: readonly string[],
    categories: Record<string, SoundCategory> = {},
  ): Promise<SoundCandidate[]> {
    if (!ids.length) return [];
    const url = this.url();
    url.searchParams.set('titles', ids.join('|'));
    const pages = object(object(await json(url, this.requester)).query).pages;
    const sounds = Object.values(object(pages))
      .map((page) => this.normalize(page, categories[string(object(page).title)] || 'other'))
      .filter((item): item is SoundCandidate => !!item);
    return sounds;
  }
  async getSound(id: string): Promise<SoundCandidate | null> {
    return (await this.getSounds([id]))[0] || null;
  }
  async searchSounds(options: SoundSearchOptions): Promise<SoundCandidate[]> {
    const url = this.url();
    url.searchParams.set('generator', 'search');
    url.searchParams.set('gsrsearch', `${options.query} filetype:audio`);
    url.searchParams.set('gsrnamespace', '6');
    url.searchParams.set('gsrlimit', '50');
    url.searchParams.set('gsroffset', String(((options.page || 1) - 1) * 50));
    const pages = object(object(await json(url, this.requester)).query).pages;
    const sounds = Object.values(object(pages))
      .map((page) => this.normalize(page, options.category))
      .filter((item): item is SoundCandidate => !!item)
      .filter(
        (item) =>
          !item.duration ||
          (item.duration >= (options.minDuration || 1) &&
            item.duration <= (options.maxDuration || 300)),
      )
      .filter(
        (item) =>
          !options.license || item.license.toLowerCase().includes(options.license.toLowerCase()),
      );
    return sounds;
  }
  validateSound(sound: SoundCandidate): Promise<boolean> {
    return head(sound, this.requester);
  }
}

export class OpenverseProvider implements AudioProvider {
  readonly id = 'openverse';
  readonly name = 'Openverse';
  readonly enabled = true;
  constructor(private requester: typeof fetch = fetch) {}
  private normalize(value: unknown, category: SoundCategory): SoundCandidate | null {
    const raw = object(value),
      providerId = string(raw.id),
      title = string(raw.title);
    const audioUrl = https(raw.url),
      sourceUrl = https(raw.foreign_landing_url);
    const code = string(raw.license).toUpperCase();
    const license =
      code === 'CC0' ? 'CC0' : code === 'PDM' ? 'Public domain' : `CC ${code.replaceAll('_', '-')}`;
    if (
      !providerId ||
      !title ||
      !audioUrl ||
      !sourceUrl ||
      !eligibleLicense(license) ||
      string(raw.source).toLowerCase().includes('freesound') ||
      string(raw.provider).toLowerCase().includes('freesound') ||
      isFreesound(audioUrl) ||
      isFreesound(sourceUrl)
    )
      return null;
    const creator = string(raw.creator) || 'unknown creator';
    const sound = base(
      this.id,
      providerId,
      title,
      audioUrl,
      sourceUrl,
      creator,
      license + (raw.license_version ? ` ${raw.license_version}` : ''),
      category,
    );
    const duration = Number(raw.duration);
    if (Number.isFinite(duration) && duration > 0) sound.duration = duration / 1000;
    sound.tags = Array.isArray(raw.tags)
      ? raw.tags.map((tag) => string(object(tag).name)).filter(Boolean)
      : [];
    // Openverse does not provide verified recording coordinates. Admins may review
    // the source and add evidence separately; discovery never invents a location.
    return sound;
  }
  async searchSounds(options: SoundSearchOptions): Promise<SoundCandidate[]> {
    const url = new URL('https://api.openverse.org/v1/audio/');
    url.searchParams.set('q', options.query);
    url.searchParams.set('excluded_source', 'freesound');
    url.searchParams.set('page', String(options.page || 1));
    url.searchParams.set('page_size', '20');
    const results = (await json(url, this.requester)).results;
    if (!Array.isArray(results))
      throw new AudioProviderError('Openverse response has no results.', 'response');
    return results
      .map((item) => this.normalize(item, options.category))
      .filter((item): item is SoundCandidate => !!item)
      .filter(
        (item) =>
          !item.duration ||
          (item.duration >= (options.minDuration || 1) &&
            item.duration <= (options.maxDuration || 300)),
      )
      .filter(
        (item) =>
          !options.license || item.license.toLowerCase().includes(options.license.toLowerCase()),
      );
  }
  async getSound(id: string): Promise<SoundCandidate | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const url = new URL(`https://api.openverse.org/v1/audio/${id}/`);
    return this.normalize(await json(url, this.requester), 'other');
  }
  validateSound(sound: SoundCandidate): Promise<boolean> {
    return head(sound, this.requester);
  }
}

export class XenoCantoProvider implements AudioProvider {
  readonly id = 'xeno-canto';
  readonly name = 'Xeno-canto';
  constructor(
    private key = process.env.XENO_CANTO_API_KEY,
    private requester: typeof fetch = fetch,
  ) {}
  get enabled(): boolean {
    return !!this.key;
  }
  private async query(options: SoundSearchOptions): Promise<Dict> {
    const url = new URL('https://xeno-canto.org/api/3/recordings');
    url.searchParams.set('query', options.query || 'q:A');
    url.searchParams.set('key', this.key!);
    url.searchParams.set('page', String(options.page || 1));
    return json(url, this.requester);
  }
  private normalize(value: unknown): SoundCandidate | null {
    const raw = object(value),
      providerId = string(raw.id),
      audioUrl = https(raw.file);
    const sourceUrl = https(raw.url) || `https://xeno-canto.org/${providerId}`;
    const title =
      [string(raw.en) || string(raw.gen), string(raw.sp)].filter(Boolean).join(' — ') ||
      `Bird recording ${providerId}`;
    const licenseUrl = string(raw.lic);
    const licenseMatch = licenseUrl.match(/\/licenses\/(by(?:-nc)?(?:-sa)?)\/(\d+(?:\.\d+)?)\//i);
    const license = licenseMatch ? `CC ${licenseMatch[1].toUpperCase()} ${licenseMatch[2]}` : '';
    if (!providerId || !audioUrl || !eligibleLicense(license)) return null;
    const sound = base(
      this.id,
      providerId,
      title,
      audioUrl,
      sourceUrl,
      string(raw.rec),
      license,
      'nature',
      `${string(raw.loc)}, ${string(raw.cnt)}`,
    );
    const [minutes, seconds] = string(raw.length).split(':').map(Number);
    if (Number.isFinite(minutes) && Number.isFinite(seconds))
      sound.duration = minutes * 60 + seconds;
    return withCoordinates(
      sound,
      { latitude: Number(raw.lat), longitude: Number(raw.lon ?? raw.lng) },
      `Xeno-canto recording ${providerId}: uploader coordinates; locality ${string(raw.loc)}, ${string(raw.cnt)}.`,
    );
  }
  async searchSounds(options: SoundSearchOptions): Promise<SoundCandidate[]> {
    if (!this.enabled) return [];
    const recordings = (await this.query(options)).recordings;
    if (!Array.isArray(recordings))
      throw new AudioProviderError('Xeno-canto response has no recordings.', 'response');
    return recordings
      .map((item) => this.normalize(item))
      .filter((item): item is SoundCandidate => !!item)
      .filter(
        (item) =>
          !item.duration ||
          (item.duration >= (options.minDuration || 1) &&
            item.duration <= (options.maxDuration || 300)),
      );
  }
  /**
   * The web site's /explore/random page is an HTML UI, not a stable data API.
   * Randomizing a documented API query and result page gives the game fresh,
   * coordinate-bearing recordings without retaining a Xeno-canto catalog.
   */
  async randomSounds(count: number, random: () => number = Math.random): Promise<SoundCandidate[]> {
    if (!this.enabled || count < 1) return [];
    const queries = [
      'area:africa q:>C',
      'area:america q:>C',
      'area:asia q:>C',
      'area:australia q:>C',
      'area:europe q:>C',
      'q:>C',
    ];
    const selected: SoundCandidate[] = [];
    const seen = new Set<string>();
    // A result page normally supplies many candidates. Keep the request count
    // modest so a match does not wait behind a long chain of external calls.
    const attempts = Math.max(3, Math.min(8, Math.ceil(count / 4) + 2));
    for (let attempt = 0; attempt < attempts && selected.length < count; attempt++) {
      const query = queries[Math.floor(random() * queries.length)];
      const firstPage = await this.query({ query, category: 'nature', page: 1 });
      const pageCount = Math.max(1, Number(firstPage.numPages) || 1);
      const page = 1 + Math.floor(random() * pageCount);
      const body = page === 1 ? firstPage : await this.query({ query, category: 'nature', page });
      const recordings = body.recordings;
      if (!Array.isArray(recordings)) continue;
      const candidates = recordings
        .map((item) => this.normalize(item))
        .filter((item): item is SoundCandidate => !!item)
        .filter((item) => !!item.duration && item.duration >= 12 && item.duration <= 90)
        .sort(() => random() - 0.5);
      for (const candidate of candidates) {
        if (seen.has(candidate.providerId)) continue;
        seen.add(candidate.providerId);
        selected.push(candidate);
        if (selected.length >= count) break;
      }
    }
    return selected;
  }
  async getSound(id: string): Promise<SoundCandidate | null> {
    if (!this.enabled || !/^\d+$/.test(id)) return null;
    return (
      (await this.searchSounds({ query: `nr:${id}`, category: 'nature' })).find(
        (item) => item.providerId === id,
      ) || null
    );
  }
  validateSound(sound: SoundCandidate): Promise<boolean> {
    return head(sound, this.requester);
  }
}
