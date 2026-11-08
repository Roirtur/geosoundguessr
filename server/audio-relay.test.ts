import { describe, expect, it } from 'vitest';
import { publicAudioUrl } from './audio-relay';

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
});
