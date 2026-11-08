import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Request, Response as ExpressResponse } from 'express';
import type { SoundEntry } from '../shared/types';

// These providers own their public media hosts. Trusting the exact host avoids
// platform-specific DNS representations (for example IPv4-mapped IPv6) from
// incorrectly rejecting known remote audio while the generic SSRF guard remains
// in place for Openverse's varied media hosts.
const TRUSTED_AUDIO_HOSTS = new Set([
  'upload.wikimedia.org',
  'xeno-canto.org',
  'www.xeno-canto.org',
]);
const MEMORY_CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_MEMORY_CACHE_ENTRIES = 8;
const MAX_REMOTE_AUDIO_BYTES = 16 * 1024 * 1024;

interface CachedAudio {
  body: Buffer;
  contentType: string;
}
interface CacheEntry {
  expiresAt: number;
  promise: Promise<CachedAudio>;
}
const memoryCache = new Map<string, CacheEntry>();

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return /^[23]/.test(lower) && !lower.startsWith('2001:db8:');
  }
  return false;
}
export async function publicAudioUrl(value: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.local') ||
    isIP(url.hostname)
  )
    return null;
  if (TRUSTED_AUDIO_HOSTS.has(url.hostname.toLowerCase())) return url;
  try {
    const addresses = await lookup(url.hostname, { all: true });
    return addresses.length && addresses.every((address) => publicAddress(address.address))
      ? url
      : null;
  } catch {
    return null;
  }
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function readAudioBody(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_REMOTE_AUDIO_BYTES) {
        await reader.cancel();
        throw new Error('Remote audio exceeds the temporary relay size limit.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function fetchRemoteAudio(sound: SoundEntry, requester: typeof fetch): Promise<CachedAudio> {
  let target = sound.audioUrl;
  for (let redirect = 0; redirect <= 3; redirect++) {
    const url = await publicAudioUrl(target);
    if (!url) throw new Error(`Rejected remote audio host: ${new URL(target).hostname}`);
    let upstream: globalThis.Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      upstream = await requester(url, {
        headers: {
          Accept: 'audio/*',
          'User-Agent':
            'EchoAtlas/1.0 (remote audio relay; https://github.com/Roirtur/geosoundguessr)',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(90000),
      });
      if (upstream.status !== 429 || attempt === 2) break;
      await upstream.body?.cancel();
      await wait(1000 * (attempt + 1));
    }
    if (!upstream) throw new Error('Remote audio request did not produce a response.');
    if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location')) {
      await upstream.body?.cancel();
      target = new URL(upstream.headers.get('location')!, url).href;
      continue;
    }
    const contentType = upstream.headers.get('content-type') || '';
    const contentLength = Number(upstream.headers.get('content-length'));
    if (
      !upstream.ok ||
      !upstream.body ||
      !/audio|ogg|octet-stream/i.test(contentType) ||
      (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_AUDIO_BYTES)
    ) {
      await upstream.body?.cancel();
      throw new Error(
        `Upstream ${url.hostname} returned ${upstream.status} (${contentType || 'no content type'}).`,
      );
    }
    return { body: await readAudioBody(upstream.body), contentType };
  }
  throw new Error('Remote audio redirected too many times.');
}

function cacheKey(sound: SoundEntry): string {
  return `${sound.provider}:${sound.providerId}:${sound.audioUrl}`;
}

function cachedRemoteAudio(sound: SoundEntry, requester: typeof fetch): Promise<CachedAudio> {
  const now = Date.now();
  for (const [key, entry] of memoryCache) if (entry.expiresAt <= now) memoryCache.delete(key);
  const key = cacheKey(sound);
  const existing = memoryCache.get(key);
  if (existing) return existing.promise;
  while (memoryCache.size >= MAX_MEMORY_CACHE_ENTRIES)
    memoryCache.delete(memoryCache.keys().next().value!);
  const entry: CacheEntry = {
    expiresAt: now + MEMORY_CACHE_TTL_MS,
    promise: fetchRemoteAudio(sound, requester),
  };
  memoryCache.set(key, entry);
  entry.promise.catch(() => {
    if (memoryCache.get(key) === entry) memoryCache.delete(key);
  });
  return entry.promise;
}

function rangeFor(
  bodyLength: number,
  raw: string | undefined,
): { start: number; end: number } | null {
  if (!raw) return { start: 0, end: bodyLength - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, bodyLength - suffixLength), end: bodyLength - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), bodyLength - 1) : bodyLength - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    start >= bodyLength
  )
    return null;
  return { start, end };
}

export async function relayAudio(
  req: Request,
  res: ExpressResponse,
  sound: SoundEntry,
  requester: typeof fetch = fetch,
): Promise<void> {
  const range = req.header('range');
  if (range && !/^bytes=\d*-\d*$/.test(range)) {
    res.sendStatus(416);
    return;
  }
  try {
    const audio = await cachedRemoteAudio(sound, requester);
    const selectedRange = rangeFor(audio.body.length, range);
    if (!selectedRange) {
      res.setHeader('Content-Range', `bytes */${audio.body.length}`);
      res.sendStatus(416);
      return;
    }
    const { start, end } = selectedRange;
    const partial = !!range;
    res.status(partial ? 206 : 200);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', audio.contentType);
    res.setHeader('Content-Length', end - start + 1);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${audio.body.length}`);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(audio.body.subarray(start, end + 1));
  } catch (error) {
    console.warn(
      `[audio-relay] ${error instanceof Error ? error.message : 'Unknown remote audio error.'}`,
    );
    if (!res.headersSent && !res.destroyed) res.sendStatus(502);
    else if (!res.destroyed) res.destroy();
  }
}
