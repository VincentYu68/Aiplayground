/**
 * Screenshot the finished 3D model for each test photo, so the output can be
 * judged by looking at it rather than by reading a score.
 *
 * Drives the real app: drops a photo, waits for the build, runs the manual to
 * the last step, turns ghosting off so the completed model is solid, and
 * captures the viewer from an isometric angle.
 *
 *   node bench/gallery.mjs [photo.png ...]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 5203;
const OUT = resolve('bench/out/gallery');
mkdirSync(OUT, { recursive: true });

const photos = process.argv.slice(2);
if (photos.length === 0) {
  for (const n of ['mug', 'car', 'bottle', 'teddy', 'book', 'chair', 'gear', 'plant'])
    photos.push(`bench/out/photos/${n}.png`);
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const r of [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ])
    if (existsSync(r)) return r;
  return undefined;
}

async function waitForServer(url, timeoutMs = 60000) {
  const started = Date.now();
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`server never came up at ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const server = spawn(
  'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { stdio: 'ignore' },
);
process.on('exit', () => server.kill());

const base = `http://127.0.0.1:${PORT}/`;
await waitForServer(base);

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

for (const photo of photos) {
  const label = photo.split('/').pop().replace(/\.png$/, '');
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[type=file]', resolve(photo));
  await page.waitForSelector('.summary', { timeout: 180000 });

  // Let the automatic re-cut after the weights land settle.
  await page.waitForTimeout(6000);

  // Run the manual to the end so the model is complete.
  await page.$eval('.step-slider', (el) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(el, el.max);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Turn ghosting off: the completed model should be solid, not translucent.
  const boxes = await page.$$('.viewer-toggles input[type=checkbox]');
  for (const b of boxes) if (await b.isChecked()) await b.uncheck();
  await page.waitForTimeout(1200);

  const summary = (await page.textContent('.summary')) ?? '';
  const metrics = await page.$$eval('.metrics dd', (n) => n.map((x) => x.textContent.trim()));

  for (const view of ['ISO', 'FRONT']) {
    await page.$$eval(
      '.viewer-overlay-tools button',
      (btns, want) => btns.find((b) => b.textContent.trim().toUpperCase() === want)?.click(),
      view,
    );
    await page.waitForTimeout(900);
    await page
      .locator('.viewer-canvas')
      .screenshot({ path: `${OUT}/${label}-${view.toLowerCase()}.png` });
  }
  // The photo/model comparison strip the app itself shows.
  await page.locator('.compare').screenshot({ path: `${OUT}/${label}-compare.png` });

  console.log(`${label.padEnd(8)} ${summary}`);
  console.log(`${''.padEnd(8)} silhouette=${metrics[0]} shape=${metrics[1]} colour=${metrics[2]}`);
}

console.log(`page errors: ${errors.length}`);
await browser.close();
server.kill();
process.exit(0);
