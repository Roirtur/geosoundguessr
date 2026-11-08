import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import type { SoundEntry } from '../shared/types';

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
  try {
    const addresses = await lookup(url.hostname, { all: true });
    return addresses.length && addresses.every((address) => publicAddress(address.address))
      ? url
      : null;
  } catch {
    return null;
  }
}

export async function relayAudio(
  req: Request,
  res: Response,
  sound: SoundEntry,
  requester: typeof fetch = fetch,
): Promise<void> {
  const range = req.header('range');
  if (range && !/^bytes=\d*-\d*$/.test(range)) {
    res.sendStatus(416);
    return;
  }
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let target = sound.audioUrl;
  try {
    for (let redirect = 0; redirect <= 3; redirect++) {
      const url = await publicAudioUrl(target);
      if (!url) {
        res.sendStatus(502);
        return;
      }
      const upstream = await requester(url, {
        headers: range ? { Range: range, Accept: 'audio/*' } : { Accept: 'audio/*' },
        redirect: 'manual',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90000)]),
      });
      if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location')) {
        await upstream.body?.cancel();
        target = new URL(upstream.headers.get('location')!, url).href;
        continue;
      }
      if (
        ![200, 206].includes(upstream.status) ||
        !upstream.body ||
        !/audio|ogg|octet-stream/i.test(upstream.headers.get('content-type') || '')
      ) {
        await upstream.body?.cancel();
        res.sendStatus(502);
        return;
      }
      res.status(upstream.status);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      await pipeline(
        Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream),
        res,
      );
      return;
    }
    res.sendStatus(502);
  } catch {
    if (!res.headersSent && !res.destroyed) res.sendStatus(502);
    else if (!res.destroyed) res.destroy();
  }
}
