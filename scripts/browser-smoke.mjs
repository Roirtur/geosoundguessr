import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const executablePath =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const baseUrl = process.argv[2] || process.env.BASE_URL || 'http://localhost:5173/';
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: [
    '--enable-webgl',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
try {
  const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const bobContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  for (const page of [alice, bob]) {
    page.on('pageerror', (error) => console.error('Browser error:', error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('Console error:', message.text());
    });
    page.on('response', (response) => {
      if (response.status() >= 400) console.error('HTTP error:', response.status(), response.url());
    });
  }
  await alice.goto(baseUrl, { waitUntil: 'networkidle' });
  await alice.screenshot({ path: join(tmpdir(), 'echo-atlas-browser-menu.png') });
  console.log('Canvas count:', await alice.locator('canvas').count());
  await alice.locator('#nickname').fill('Alice');
  await alice.getByRole('button', { name: 'Create a game' }).click();
  const code = await alice.locator('.room-code-row strong').textContent();
  assert.match(code || '', /^[A-Z2-9]{5}$/);
  await bob.goto(baseUrl, { waitUntil: 'networkidle' });
  await bob.locator('#nickname').fill('Bob');
  await bob.getByRole('button', { name: 'Join a room' }).click();
  await bob.getByLabel('Room code').fill(code);
  await bob.getByRole('button', { name: /^Join/ }).last().click();
  await bob.getByText('Alice', { exact: true }).waitFor();
  await alice.getByText('Bob', { exact: true }).waitFor();
  await alice.screenshot({ path: join(tmpdir(), 'echo-atlas-browser-lobby.png') });
  await bob.setViewportSize({ width: 390, height: 844 });
  await bob.screenshot({ path: join(tmpdir(), 'echo-atlas-browser-mobile-lobby.png') });
  assert.equal(
    await bob.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  console.log(`Browser smoke passed: room ${code}, Alice and Bob joined from separate contexts.`);
} finally {
  await browser.close();
}
