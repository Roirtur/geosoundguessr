import { describe, expect, it, vi } from 'vitest';
import { publicAudioUrl, relayAudio } from './audio-relay';
import type { SoundEntry } from '../shared/types';

function playableSound(providerId: string): SoundEntry {
  return {
    id: providerId,
    provider: 'wikimedia',
    providerId,
    title: 'Relay test recording',
    description: '',
    audioUrl: `https://upload.wikimedia.org/wikipedia/commons/test-${providerId}.mp3`,
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Relay_test_recording.mp3',
    creator: 'Test recorder',
    tags: [],
    category: 'nature',
    latitude: 48.8566,
    longitude: 2.3522,
    countryCode: '250',
    countryName: 'France',
    originType: 'recording_location',
    license: 'CC BY 4.0',
    approvalStatus: 'provisional',
    attribution: 'Test attribution',
    lastCheckedAt: '2026-01-01',
    locationEvidence: 'Test recording location.',
    playable: true,
  };
}

function response(range?: string) {
  const headers = new Map<string, string>();
  const result = {
    headersSent: false,
    destroyed: false,
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn((name: string, value: string | number) => headers.set(name, String(value))),
    end: vi.fn(),
    sendStatus: vi.fn(),
  };
  return {
    req: { header: (name: string) => (name === 'range' ? range : undefined), method: 'GET' },
    res: result,
    headers,
  };
}

describe('remote audio URL safety', () => {
  it('accepts exact Wikimedia media hosts without platform-dependent DNS checks', async () => {
    const url = await publicAudioUrl(
      'https://upload.wikimedia.org/wikipedia/commons/transcoded/a/audio.ogg/audio.ogg.mp3',
    );
    expect(url?.hostname).toBe('upload.wikimedia.org');
  });

  it('rejects local, credentialed and insecure URLs', async () => {
    await expect(publicAudioUrl('http://upload.wikimedia.org/audio.ogg')).resolves.toBeNull();
    await expect(publicAudioUrl('https://localhost/audio.ogg')).resolves.toBeNull();
    await expect(publicAudioUrl('https://user:secret@example.com/audio.ogg')).resolves.toBeNull();
    await expect(publicAudioUrl('https://127.0.0.1/audio.ogg')).resolves.toBeNull();
  });

  it('shares a temporary remote fetch and serves browser byte ranges from memory', async () => {
    const requester = vi.fn(
      async () =>
        new Response(Buffer.from('abcdef'), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    ) as unknown as typeof fetch;
    const sound = playableSound(`cache-${Date.now()}`);
    const first = response('bytes=1-3');
    const second = response('bytes=4-');

    await relayAudio(first.req as never, first.res as never, sound, requester);
    await relayAudio(second.req as never, second.res as never, sound, requester);

    expect(requester).toHaveBeenCalledTimes(1);
    expect(first.res.status).toHaveBeenCalledWith(206);
    expect(first.headers.get('Content-Range')).toBe('bytes 1-3/6');
    expect(first.res.end).toHaveBeenCalledWith(Buffer.from('bcd'));
    expect(second.res.end).toHaveBeenCalledWith(Buffer.from('ef'));
  });
});
