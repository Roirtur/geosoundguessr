import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { countryAt, validCoordinates } from '../shared/geo';
import type {
  ApprovalStatus,
  OriginType,
  SoundCandidate,
  SoundCategory,
  SoundEntry,
} from '../shared/types';
import {
  COMMONS_STARTERS,
  OpenverseProvider,
  WikimediaProvider,
  XenoCantoProvider,
  type AudioProvider,
  type SoundSearchOptions,
} from './providers';

const FILE =
  process.env.SOUND_METADATA_FILE || join(process.cwd(), 'server', 'data', 'sounds.json');
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
export const soundKey = (sound: SoundCandidate) => `${sound.provider}:${sound.providerId}`;
export function recordingKey(sound: SoundCandidate): string {
  try {
    const url = new URL(sound.audioUrl);
    let path = decodeURIComponent(url.pathname);
    if (url.hostname === 'upload.wikimedia.org') {
      path = path.replace('/commons/transcoded/', '/commons/');
      path = path.replace(/(\.(?:ogg|oga|wav|flac|webm|mp3))\/[^/]+\.mp3$/i, '$1');
    }
    return `${url.hostname.toLowerCase()}${path}`;
  } catch {
    return soundKey(sound);
  }
}
export function isGameSound(sound: SoundCandidate): sound is SoundEntry {
  let trustedUrls = false;
  try {
    const audio = new URL(sound.audioUrl),
      source = new URL(sound.sourceUrl);
    trustedUrls =
      audio.protocol === 'https:' &&
      source.protocol === 'https:' &&
      !/(^|\.)freesound\.org$/i.test(audio.hostname) &&
      !/(^|\.)freesound\.org$/i.test(source.hostname) &&
      (sound.provider !== 'wikimedia' ||
        (audio.hostname === 'upload.wikimedia.org' &&
          source.hostname === 'commons.wikimedia.org')) &&
      (sound.provider !== 'xeno-canto' || /(^|\.)xeno-canto\.org$/i.test(audio.hostname));
  } catch {
    return false;
  }
  return (
    sound.playable === true &&
    sound.provider !== 'legacy-freesound' &&
    trustedUrls &&
    !!sound.audioUrl &&
    !!sound.sourceUrl &&
    !!sound.license &&
    !!sound.locationEvidence &&
    !!sound.countryCode &&
    !!sound.countryName &&
    validCoordinates(sound) &&
    countryAt(sound)?.id === sound.countryCode
  );
}
export function selectSoundSequence(
  available: SoundEntry[],
  count: number,
  recentIds: string[] = [],
  random = Math.random,
): SoundEntry[] {
  const selected: SoundEntry[] = [];
  const countryCounts = new Map<string, number>();
  const providerCounts = new Map<string, number>();
  const byRecording = new Map<string, SoundEntry>();
  for (const sound of available) {
    const key = recordingKey(sound),
      previous = byRecording.get(key);
    if (
      !previous ||
      (sound.approvalStatus === 'approved' && previous.approvalStatus !== 'approved') ||
      (sound.approvalStatus === previous.approvalStatus &&
        sound.provider === 'wikimedia' &&
        previous.provider !== 'wikimedia')
    )
      byRecording.set(key, sound);
  }
  const candidates = [...byRecording.values()];
  if (candidates.length < count) throw new Error('Not enough unique recordings.');
  while (selected.length < count) {
    const previous = selected.at(-1);
    const ranked = candidates
      .map((sound) => ({
        sound,
        weight:
          random() * 3 +
          (recentIds.includes(recordingKey(sound)) ? -4 : 0) +
          (countryCounts.get(sound.countryCode) ?? 0) * -5 +
          (providerCounts.get(sound.provider) ?? 0) * -0.5 +
          (sound.audioUrl.toLowerCase().endsWith('.mp3') ? 0.5 : 0) +
          (previous?.category === sound.category ? -2 : 0),
      }))
      .sort((a, b) => b.weight - a.weight);
    const chosen = ranked[0].sound;
    selected.push(chosen);
    countryCounts.set(chosen.countryCode, (countryCounts.get(chosen.countryCode) ?? 0) + 1);
    providerCounts.set(chosen.provider, (providerCounts.get(chosen.provider) ?? 0) + 1);
    candidates.splice(
      candidates.findIndex((entry) => soundKey(entry) === soundKey(chosen)),
      1,
    );
  }
  return selected;
}

export class SoundPool {
  private sounds: SoundCandidate[] = [];
  private unrecognized: unknown[] = [];
  private lastRefresh = 0;
  private refreshTask?: Promise<void>;
  private recentIds: string[] = [];
  readonly providers: AudioProvider[];
  constructor(
    providers: AudioProvider[] = [
      new WikimediaProvider(),
      new OpenverseProvider(),
      new XenoCantoProvider(),
    ],
  ) {
    this.providers = providers;
  }
  providerStatus() {
    return this.providers.map(({ id, name, enabled }) => ({ id, name, enabled }));
  }
  async load(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(FILE, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.sounds = [];
        this.unrecognized = [];
        return;
      }
      throw error;
    }
    const body = JSON.parse(contents) as unknown;
    if (!Array.isArray(body))
      throw new Error('Sound metadata file must contain an array. It was not modified.');
    this.sounds = [];
    this.unrecognized = [];
    for (const item of body) {
      const migrated = this.migrate(item);
      if (migrated) this.sounds.push(migrated);
      else this.unrecognized.push(item);
    }
  }
  private migrate(item: unknown): SoundCandidate | null {
    if (!item || typeof item !== 'object') return null;
    const old = item as Record<string, unknown>;
    if (typeof old.freesoundId === 'number' && typeof old.previewUrl === 'string') {
      return {
        ...old,
        provider: 'legacy-freesound',
        providerId: String(old.freesoundId),
        audioUrl: old.previewUrl,
        creator: String(old.username || ''),
        playable: false,
        managedByAdmin: true,
        locationEvidence:
          'Historical Freesound metadata; recording must be migrated to an active provider.',
      } as SoundCandidate;
    }
    if (
      typeof old.provider !== 'string' ||
      typeof old.providerId !== 'string' ||
      typeof old.audioUrl !== 'string'
    )
      return null;
    if (!['wikimedia', 'openverse', 'xeno-canto', 'legacy-freesound'].includes(old.provider))
      return null;
    const sound = old as unknown as SoundCandidate;
    if (sound.provider === 'legacy-freesound') sound.playable = false;
    return sound;
  }
  private async save(): Promise<void> {
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify([...this.sounds, ...this.unrecognized], null, 2), 'utf8');
  }
  list(): SoundCandidate[] {
    return [...this.sounds];
  }
  stats() {
    const countBy = (key: 'category' | 'countryName' | 'approvalStatus' | 'provider') =>
      this.sounds.reduce<Record<string, number>>((totals, sound) => {
        const value = String(sound[key] || 'Unknown');
        totals[value] = (totals[value] || 0) + 1;
        return totals;
      }, {});
    return {
      total: this.sounds.length,
      playable: this.sounds.filter(isGameSound).length,
      byCategory: countBy('category'),
      byCountry: countBy('countryName'),
      byStatus: countBy('approvalStatus'),
      byProvider: countBy('provider'),
    };
  }
  async add(sounds: SoundCandidate[], managedByAdmin = false): Promise<number> {
    const existing = new Map(this.sounds.map((sound) => [soundKey(sound), sound]));
    let added = 0,
      changed = false;
    for (const sound of sounds) {
      const previous = existing.get(soundKey(sound));
      if (previous) {
        if (managedByAdmin) {
          if (sound.playable && !previous.playable) {
            Object.assign(previous, {
              latitude: sound.latitude,
              longitude: sound.longitude,
              countryCode: sound.countryCode,
              countryName: sound.countryName,
              locationEvidence: sound.locationEvidence,
              playable: true,
            });
          }
          previous.managedByAdmin = true;
          previous.approvalStatus = sound.approvalStatus;
          changed = true;
        }
        continue;
      }
      const incoming = { ...sound, managedByAdmin };
      this.sounds.push(incoming);
      existing.set(soundKey(incoming), incoming);
      added++;
    }
    const protectedSounds = this.sounds.filter(
      (sound) => sound.managedByAdmin || sound.approvalStatus === 'approved',
    );
    const automatic = this.sounds.filter(
      (sound) => !sound.managedByAdmin && sound.approvalStatus !== 'approved',
    );
    const budget = Math.max(0, 1000 - protectedSounds.length);
    const playable = automatic.filter(isGameSound);
    const others = automatic.filter((sound) => !isGameSound(sound));
    const keptPlayable = budget ? playable.slice(-budget) : [];
    const remaining = Math.max(0, budget - keptPlayable.length);
    this.sounds = [
      ...protectedSounds,
      ...keptPlayable,
      ...(remaining ? others.slice(-remaining) : []),
    ];
    if (added || changed) await this.save();
    return added;
  }
  async review(id: string, status: ApprovalStatus): Promise<boolean> {
    const sound = this.sounds.find((entry) => entry.id === id);
    if (!sound) return false;
    if (status === 'approved' && !isGameSound(sound))
      throw new Error('Add verified recording coordinates and location evidence before approval.');
    sound.approvalStatus = status;
    sound.managedByAdmin = true;
    await this.save();
    return true;
  }
  async locate(
    id: string,
    latitude: number,
    longitude: number,
    evidence: string,
    originType: OriginType = 'recording_location',
  ): Promise<boolean> {
    const sound = this.sounds.find((entry) => entry.id === id);
    const location = { latitude, longitude };
    if (!sound || sound.provider === 'legacy-freesound') return false;
    const country = validCoordinates(location) ? countryAt(location) : null;
    if (!country || evidence.trim().length < 15)
      throw new Error(
        'Provide coordinates inside a country and a specific source for the recording location.',
      );
    if (!['recording_location', 'cultural_origin', 'broadcast_origin'].includes(originType))
      throw new Error('Choose a valid geographic origin type.');
    Object.assign(sound, location, {
      countryCode: country.id,
      countryName: country.properties.name,
      locationEvidence: evidence.trim(),
      originType,
      playable: true,
      approvalStatus: 'provisional',
      managedByAdmin: true,
    });
    await this.save();
    return true;
  }
  async search(
    options: SoundSearchOptions,
    providerId?: string,
  ): Promise<{ sounds: SoundCandidate[]; errors: string[] }> {
    const providers = this.providers.filter(
      (provider) => provider.enabled && (!providerId || provider.id === providerId),
    );
    if (!providers.length) throw new Error(`Provider ${providerId || ''} is unavailable.`);
    const responses = await Promise.allSettled(
      providers.map((provider) => provider.searchSounds(options)),
    );
    const sounds = responses.flatMap((response) =>
      response.status === 'fulfilled' ? response.value : [],
    );
    const errors = responses.flatMap((response, index) =>
      response.status === 'rejected'
        ? [
            `${providers[index].name}: ${response.reason instanceof Error ? response.reason.message : 'search failed'}`,
          ]
        : [],
    );
    if (!sounds.length && errors.length === providers.length) throw new Error(errors.join(' '));
    return { sounds, errors };
  }
  async refresh(force = false): Promise<void> {
    if (this.refreshTask) return this.refreshTask;
    if (!force && Date.now() - this.lastRefresh < REFRESH_INTERVAL_MS) return;
    this.refreshTask = (async () => {
      try {
        const commons = this.providers.find(
          (provider): provider is WikimediaProvider => provider instanceof WikimediaProvider,
        );
        const jobs: Promise<SoundCandidate[]>[] = [];
        if (commons)
          jobs.push(
            commons.getSounds(COMMONS_STARTERS, {
              'File:Thunder Claps.ogg': 'nature',
              'File:Steam Whistle at Georgia Tech.ogg': 'city',
              'File:Bugu.ogg': 'nature',
              'File:台北捷運廣播-月台間隙提示.ogg': 'city',
              "File:Arrivée et départ d'une rame MF 01.ogg": 'city',
              'File:2011-06-05 19-32 Berlin TXL Airplane Flyover plus Wingtip Vortex.ogg': 'city',
              'File:Northern California Folk Music - Mazurka.oga': 'music',
            }),
          );
        const themes: { query: string; category: SoundCategory }[] = [
          { query: 'field recording', category: 'nature' },
          { query: 'street ambience', category: 'city' },
          { query: 'bird call', category: 'nature' },
          { query: 'market ambience', category: 'city' },
          { query: 'festival', category: 'culture' },
        ];
        for (const provider of this.providers.filter((item) => item.enabled)) {
          if (provider.id === 'xeno-canto') {
            jobs.push(
              provider.searchSounds({
                query: 'q:A',
                category: 'nature',
                minDuration: 12,
                maxDuration: 90,
              }),
            );
            continue;
          }
          for (const theme of themes.slice(0, 3))
            jobs.push(provider.searchSounds({ ...theme, minDuration: 12, maxDuration: 90 }));
        }
        const results = await Promise.allSettled(jobs);
        const found = results.flatMap((result) =>
          result.status === 'fulfilled' ? result.value : [],
        );
        if (!found.length && !this.sounds.some(isGameSound)) {
          const first = results.find((result) => result.status === 'rejected');
          throw first && first.status === 'rejected'
            ? first.reason
            : new Error('No geographically documented recordings were found.');
        }
        await this.add(found);
        this.lastRefresh = Date.now();
      } finally {
        this.refreshTask = undefined;
      }
    })();
    return this.refreshTask;
  }
  private eligible(mode: 'casual' | 'curated'): SoundEntry[] {
    return this.sounds.filter(
      (sound): sound is SoundEntry =>
        isGameSound(sound) &&
        (sound.approvalStatus === 'approved' ||
          (mode === 'casual' && sound.approvalStatus === 'provisional')),
    );
  }
  async pick(count: number, mode: 'casual' | 'curated'): Promise<SoundEntry[]> {
    let available = this.eligible(mode);
    if (available.length < count * 2) {
      try {
        await this.refresh();
      } catch (error) {
        if (available.length < count) throw error;
      }
      available = this.eligible(mode);
    }
    if (available.length < count)
      throw new Error(
        mode === 'curated'
          ? `Only ${available.length} approved recordings are available for ${count} rounds. Choose Casual mode to use geographically documented provisional recordings.`
          : `Only ${available.length} geographically documented recordings are currently available for ${count} rounds. Choose fewer rounds or try again later.`,
      );
    const selected = selectSoundSequence(available, count, this.recentIds);
    this.recentIds = [...this.recentIds, ...selected.map(recordingKey)].slice(-40);
    return selected;
  }
  replacement(excluded: Set<string>, mode: 'casual' | 'curated'): SoundEntry | undefined {
    const excludedRecordings = new Set(
      this.sounds.filter((sound) => excluded.has(soundKey(sound))).map(recordingKey),
    );
    const choices = this.eligible(mode).filter(
      (sound) => !excludedRecordings.has(recordingKey(sound)),
    );
    return choices[Math.floor(Math.random() * choices.length)];
  }
}
