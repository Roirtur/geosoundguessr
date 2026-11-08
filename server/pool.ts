import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ApprovalStatus, SoundCategory, SoundEntry } from '../shared/types';
import { FreesoundClient, FreesoundError } from './freesound';

const FILE =
  process.env.SOUND_METADATA_FILE || join(process.cwd(), 'server', 'data', 'sounds.json');
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export function selectSoundSequence(
  available: SoundEntry[],
  count: number,
  recentIds: number[] = [],
  random = Math.random,
): SoundEntry[] {
  if (available.length < count) throw new Error('Not enough sounds.');
  const selected: SoundEntry[] = [];
  const countryCounts = new Map<string, number>();
  const candidates = [...new Map(available.map((sound) => [sound.freesoundId, sound])).values()];
  if (candidates.length < count) throw new Error('Not enough unique sounds.');
  while (selected.length < count) {
    const previous = selected.at(-1);
    const ranked = candidates
      .map((sound) => ({
        sound,
        weight:
          random() * 3 +
          (recentIds.includes(sound.freesoundId) ? -4 : 0) +
          (countryCounts.get(sound.countryCode) ?? 0) * -5 +
          (previous?.category === sound.category ? -2 : 0),
      }))
      .sort((a, b) => b.weight - a.weight);
    const chosen = ranked[0].sound;
    selected.push(chosen);
    countryCounts.set(chosen.countryCode, (countryCounts.get(chosen.countryCode) ?? 0) + 1);
    candidates.splice(
      candidates.findIndex((entry) => entry.freesoundId === chosen.freesoundId),
      1,
    );
  }
  return selected;
}

export class SoundPool {
  private sounds: SoundEntry[] = [];
  private lastRefresh = 0;
  private refreshTask?: Promise<void>;
  private recentIds: number[] = [];
  constructor(public client: FreesoundClient) {}

  async load(): Promise<void> {
    try {
      const body = JSON.parse(await readFile(FILE, 'utf8')) as unknown;
      this.sounds = Array.isArray(body)
        ? body.filter(
            (item): item is SoundEntry =>
              item &&
              typeof item === 'object' &&
              Number.isInteger(item.freesoundId) &&
              typeof item.previewUrl === 'string' &&
              typeof item.countryName === 'string' &&
              ['approved', 'provisional', 'rejected'].includes(item.approvalStatus),
          )
        : [];
    } catch {
      this.sounds = [];
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(this.sounds, null, 2), 'utf8');
  }

  list(): SoundEntry[] {
    return [...this.sounds];
  }
  stats() {
    const countBy = (key: 'category' | 'countryName' | 'approvalStatus') =>
      this.sounds.reduce<Record<string, number>>((totals, sound) => {
        totals[sound[key]] = (totals[sound[key]] || 0) + 1;
        return totals;
      }, {});
    return {
      total: this.sounds.length,
      byCategory: countBy('category'),
      byCountry: countBy('countryName'),
      byStatus: countBy('approvalStatus'),
    };
  }

  async add(sounds: SoundEntry[]): Promise<number> {
    const ids = new Set(this.sounds.map((sound) => sound.freesoundId));
    const fresh = sounds.filter(
      (sound) => !ids.has(sound.freesoundId) && (ids.add(sound.freesoundId), true),
    );
    this.sounds = [...this.sounds, ...fresh].slice(-500);
    if (fresh.length) await this.save();
    return fresh.length;
  }

  async review(id: string, status: ApprovalStatus): Promise<boolean> {
    const sound = this.sounds.find((entry) => entry.id === id);
    if (!sound) return false;
    sound.approvalStatus = status;
    await this.save();
    return true;
  }

  async search(
    query: string,
    category: SoundCategory,
    page = 1,
    filter?: string,
  ): Promise<SoundEntry[]> {
    return this.client.search(query, category, page, filter);
  }

  async refresh(force = false): Promise<void> {
    if (this.refreshTask) return this.refreshTask;
    if (!force && Date.now() - this.lastRefresh < REFRESH_INTERVAL_MS) return;
    this.refreshTask = (async () => {
      try {
        const discovered = await this.client.discover();
        await this.add(discovered);
        this.lastRefresh = Date.now();
      } finally {
        this.refreshTask = undefined;
      }
    })();
    return this.refreshTask;
  }

  async pick(count: number, mode: 'casual' | 'curated'): Promise<SoundEntry[]> {
    if (!this.client.configured)
      throw new FreesoundError(
        'Freesound API not configured. Add FREESOUND_API_KEY to .env.',
        'configuration',
      );
    let available = this.sounds.filter(
      (sound) =>
        sound.approvalStatus === 'approved' ||
        (mode === 'casual' && sound.approvalStatus === 'provisional'),
    );
    if (available.length < count * 2) {
      try {
        await this.refresh();
      } catch (error) {
        if (available.length < count) throw error;
      }
      available = this.sounds.filter(
        (sound) =>
          sound.approvalStatus === 'approved' ||
          (mode === 'casual' && sound.approvalStatus === 'provisional'),
      );
    }
    if (available.length < count)
      throw new FreesoundError(
        `Only ${available.length} eligible recordings are available for ${count} rounds. Try discovery in Admin or choose fewer rounds.`,
        'empty',
      );
    const selected = selectSoundSequence(available, count, this.recentIds);
    this.recentIds = [...this.recentIds, ...selected.map((sound) => sound.freesoundId)].slice(-40);
    return selected;
  }

  replacement(excluded: Set<number>, mode: 'casual' | 'curated'): SoundEntry | undefined {
    const choices = this.sounds.filter(
      (sound) =>
        !excluded.has(sound.freesoundId) &&
        (sound.approvalStatus === 'approved' ||
          (mode === 'casual' && sound.approvalStatus === 'provisional')),
    );
    return choices[Math.floor(Math.random() * choices.length)];
  }
}
