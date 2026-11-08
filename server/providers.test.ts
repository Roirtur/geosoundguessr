import { describe, expect, it, vi } from 'vitest';
import { OpenverseProvider, WikimediaProvider, XenoCantoProvider } from './providers';
import { selectSoundSequence } from './pool';
import type { SoundEntry } from '../shared/types';

const commonsPage = {
  title: 'File:Paris sound.ogg',
  coordinates: [{ lat: 48.8566, lon: 2.3522, type: 'camera' }],
  imageinfo: [
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/Paris_sound.ogg',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Paris_sound.ogg',
      mime: 'application/ogg',
      extmetadata: {
        LicenseShortName: { value: 'CC BY-SA 4.0' },
        Artist: { value: '<a>Recorder</a>' },
        ImageDescription: { value: 'A Paris street recording' },
      },
      metadata: [{ name: 'length', value: 32 }],
    },
  ],
};
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('remote audio providers', () => {
  it('uses Commons file coordinates, license and remote URL', async () => {
    const requester = vi.fn(async () =>
      response({ query: { pages: { '1': commonsPage } } }),
    ) as unknown as typeof fetch;
    const provider = new WikimediaProvider(requester);
    const sound = await provider.getSound('File:Paris sound.ogg');
    expect(sound).toMatchObject({
      provider: 'wikimedia',
      countryName: 'France',
      duration: 32,
      playable: true,
      approvalStatus: 'provisional',
    });
    expect(sound?.locationEvidence).toContain('Wikimedia Commons file coordinates');
    expect(String(vi.mocked(requester).mock.calls[0][0])).toContain(
      'commons.wikimedia.org/w/api.php',
    );
  });
  it('leaves Commons sounds without coordinates out of gameplay', async () => {
    const requester = async () =>
      response({ query: { pages: { '1': { ...commonsPage, coordinates: undefined } } } });
    const sound = await new WikimediaProvider(requester).getSound('File:Paris sound.ogg');
    expect(sound?.playable).toBe(false);
    expect(sound?.countryCode).toBeUndefined();
  });
  it('excludes Freesound indexed by Openverse and never invents locations', async () => {
    const result = {
      id: '11111111-1111-1111-1111-111111111111',
      title: 'Forest ambience',
      url: 'https://upload.wikimedia.org/a.ogg',
      foreign_landing_url: 'https://commons.wikimedia.org/wiki/File:a.ogg',
      creator: 'Recorder',
      license: 'by',
      license_version: '4.0',
      source: 'wikimedia_audio',
      duration: 33000,
    };
    const requester = vi.fn(async () =>
      response({
        results: [
          result,
          { ...result, id: '22222222-2222-2222-2222-222222222222', source: 'freesound' },
          {
            ...result,
            id: '33333333-3333-3333-3333-333333333333',
            url: 'https://cdn.freesound.org/a.mp3',
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const found = await new OpenverseProvider(requester).searchSounds({
      query: 'forest',
      category: 'nature',
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      provider: 'openverse',
      license: 'CC BY 4.0',
      duration: 33,
      playable: false,
    });
    expect(
      new URL(String(vi.mocked(requester).mock.calls[0][0])).searchParams.get('excluded_source'),
    ).toBe('freesound');
  });
  it('enables Xeno-canto only with a key and reads uploader coordinates', async () => {
    const requester = vi.fn(async () =>
      response({
        recordings: [
          {
            id: '123',
            file: 'https://xeno-canto.org/sounds/123.mp3',
            url: 'https://xeno-canto.org/123',
            en: 'Nightingale',
            rec: 'Observer',
            lic: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
            lat: '48.8566',
            lon: '2.3522',
            length: '0:30',
            loc: 'Paris',
            cnt: 'France',
          },
        ],
      }),
    ) as unknown as typeof fetch;
    expect(new XenoCantoProvider('', requester).enabled).toBe(false);
    const provider = new XenoCantoProvider('private-key', requester);
    const found = await provider.searchSounds({ query: 'Nightingale', category: 'nature' });
    expect(found[0]).toMatchObject({
      provider: 'xeno-canto',
      countryName: 'France',
      duration: 30,
      license: 'CC BY-NC-SA 4.0',
      playable: true,
    });
    expect(new URL(String(vi.mocked(requester).mock.calls[0][0])).searchParams.get('key')).toBe(
      'private-key',
    );
    expect(found[0].audioUrl).not.toContain('private-key');
  });
  it('selects unique provider-qualified IDs and diverse countries', async () => {
    const sound = (await new WikimediaProvider(async () =>
      response({ query: { pages: { '1': commonsPage } } }),
    ).getSound('File:Paris sound.ogg')) as SoundEntry;
    const choices: SoundEntry[] = [
      sound,
      { ...sound, id: 'duplicate' },
      {
        ...sound,
        id: 'japan',
        providerId: 'japan',
        audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/Japan_sound.ogg',
        latitude: 35.6762,
        longitude: 139.6503,
        countryCode: '392',
        countryName: 'Japan',
        category: 'city',
      },
      {
        ...sound,
        id: 'france2',
        providerId: 'france2',
        audioUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/Paris_sound_2.ogg',
      },
      { ...sound, id: 'cross-provider', provider: 'openverse', providerId: 'uuid' },
    ];
    const picked = selectSoundSequence(choices, 2, [], () => 0.5);
    expect(new Set(picked.map((item) => `${item.provider}:${item.providerId}`)).size).toBe(2);
    expect(new Set(picked.map((item) => item.countryCode)).size).toBe(2);
    expect(selectSoundSequence(choices.slice(0, 2).concat(choices.at(-1)!), 1)[0].provider).toBe(
      'wikimedia',
    );
  });
});
