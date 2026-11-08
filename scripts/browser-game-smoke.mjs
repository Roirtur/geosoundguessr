import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const location = [
  { latitude: 48.8566, longitude: 2.3522, countryCode: '250', countryName: 'France' },
  { latitude: 35.6762, longitude: 139.6503, countryCode: '392', countryName: 'Japan' },
];
const fixtures = location.map((place, index) => ({
  id: `browser-fixture-${index + 1}`,
  freesoundId: index + 1,
  previewUrl: `https://cdn.freesound.org/previews/browser-fixture-${index + 1}.mp3`,
  sourceUrl: `https://freesound.org/s/${index + 1}/`,
  title: `Browser fixture ${index + 1}`,
  description: 'Mocked browser test only',
  username: 'fixture',
  tags: [],
  category: 'nature',
  duration: 30,
  ...place,
  originType: 'recording_location',
  license: 'Attribution',
  approvalStatus: 'provisional',
  attribution: 'Mocked browser test only',
  lastCheckedAt: '2026-01-01',
}));
const wav = (() => {
  const samples = 8000 * 4;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
})();
const freePort = () =>
  new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolvePort(address.port));
    });
  });
const port = await freePort();
const directory = await mkdtemp(join(tmpdir(), 'echo-atlas-browser-game-'));
const metadataFile = join(directory, 'sounds.json');
await writeFile(metadataFile, JSON.stringify(fixtures));
const server = spawn(process.execPath, ['server/start.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    FREESOUND_API_KEY: 'mock-test-key',
    SOUND_METADATA_FILE: metadataFile,
  },
  stdio: 'ignore',
  windowsHide: true,
});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* waiting */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(ready, 'Compiled fixture server did not start. Run npm run build first.');
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: [
      '--enable-webgl',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
  const makePage = async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('https://cdn.freesound.org/previews/browser-fixture-*.mp3', (route) =>
      route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }),
    );
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error('Browser error:', error.message));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    return page;
  };
  const alice = await makePage();
  const bob = await makePage();
  await alice.locator('#nickname').fill('Alice');
  await alice.getByRole('button', { name: 'Create a game' }).click();
  const code = await alice.locator('.room-code-row strong').textContent();
  await bob.locator('#nickname').fill('Bob');
  await bob.getByRole('button', { name: 'Join a room' }).click();
  await bob.getByLabel('Room code').fill(code);
  await bob.getByRole('button', { name: /^Join/ }).last().click();
  await alice.getByText('Bob', { exact: true }).waitFor();
  await alice.locator('.lobby-settings select').first().selectOption('1');
  await alice.getByRole('button', { name: 'Start listening' }).click();
  await Promise.all([
    alice.locator('.app-guessing').waitFor({ timeout: 25000 }),
    bob.locator('.app-guessing').waitFor({ timeout: 25000 }),
  ]);
  await alice.screenshot({ path: join(tmpdir(), 'echo-atlas-game-guessing.png') });
  const placeGuess = async (page) => {
    for (const [x, y] of [
      [860, 350],
      [820, 400],
      [910, 380],
      [780, 340],
      [900, 450],
    ]) {
      await page.mouse.move(x, y, { steps: 8 });
      await page.waitForTimeout(250);
      await page.mouse.click(x, y);
      await page.waitForTimeout(100);
      const text = await page.locator('.guess-panel strong').textContent();
      if (text !== 'Choose a place on the globe') return text;
    }
    console.log('Guess panel after clicks:', await page.locator('.guess-panel').innerText());
    throw new Error('Could not select land by clicking the globe.');
  };
  const aliceCountry = await placeGuess(alice);
  const bobCountry = await placeGuess(bob);
  await alice.getByRole('button', { name: 'Confirm guess' }).click();
  await bob.getByRole('button', { name: 'Confirm guess' }).click();
  await Promise.all([
    alice.locator('.app-results').waitFor(),
    bob.locator('.app-results').waitFor(),
  ]);
  await alice.waitForTimeout(2200);
  await alice.screenshot({ path: join(tmpdir(), 'echo-atlas-game-results.png') });
  const answerA = await alice.locator('.results-header h1').textContent();
  const answerB = await bob.locator('.results-header h1').textContent();
  assert.equal(answerA, answerB);
  assert.equal(await alice.locator('.result-row').count(), 2);
  await alice.getByRole('button', { name: 'View final leaderboard' }).click();
  await Promise.all([
    alice.locator('.app-finished').waitFor(),
    bob.locator('.app-finished').waitFor(),
  ]);
  await alice.screenshot({ path: join(tmpdir(), 'echo-atlas-game-final.png') });
  await alice.getByRole('button', { name: 'Play again' }).click();
  await Promise.all([
    alice.locator('.app-guessing').waitFor({ timeout: 25000 }),
    bob.locator('.app-guessing').waitFor({ timeout: 25000 }),
  ]);
  assert.equal(await alice.locator('.score-chip strong').textContent(), '0 PTS');
  console.log(
    `Browser gameplay passed: Alice and Bob selected ${aliceCountry} / ${bobCountry}, confirmed, and saw ${answerA}. Audio was mocked in memory.`,
  );
} finally {
  await browser?.close();
  server.kill();
  await rm(directory, { recursive: true, force: true });
}
