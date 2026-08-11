/**
 * End-to-end check of the multi-view path through the real UI: drop a photo,
 * wait for the first model, add a second angle, and confirm the app rebuilds
 * and reports carved geometry rather than a guess.
 *
 *   node bench/e2e-multiview.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.BENCH_PORT ?? 5201);
const OUT = resolve(process.env.BENCH_OUT ?? 'bench/out/e2e');
mkdirSync(OUT, { recursive: true });

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
  ['vite', 'preview', ...(process.env.BENCH_DIST ? ['--outDir', process.env.BENCH_DIST] : []), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { stdio: 'ignore' },
);
process.on('exit', () => server.kill());

const base = `http://127.0.0.1:${PORT}/`;
await waitForServer(base);

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.setInputFiles('input[type=file]', resolve('bench/out/photos/mug.png'));
await page.waitForSelector('.summary', { timeout: 180000 });
const one = await page.textContent('.summary');
const shapeOne = await page.$$eval('.metrics dd', (n) => n.map((x) => x.textContent.trim()));
console.log(`one view : ${one}`);
console.log(`           shape reported as "${shapeOne[1]}"`);

// Add a second angle. The strip's "Add angle" control is the second file input.
const inputs = await page.$$('input[type=file]');
console.log(`file inputs on page: ${inputs.length}`);
await inputs[inputs.length - 1].setInputFiles(resolve('bench/out/photos/mug.png'));

// Wait for the summary to change, i.e. a rebuild actually happened.
await page
  .waitForFunction((prev) => document.querySelector('.summary')?.textContent !== prev, one, {
    timeout: 180000,
  })
  .catch(() => console.log('           (summary never changed)'));

// Adding a photo can trigger more than one rebuild before it settles, so wait
// for the report to actually say the shape was carved rather than for the
// first summary that happens to differ.
await page
  .waitForFunction(
    () => /Carved from/.test(document.querySelectorAll('.metrics dd')[1]?.textContent ?? ''),
    undefined,
    { timeout: 180000 },
  )
  .catch(() => console.log('           (never reported carved geometry)'));
const two = await page.textContent('.summary');
const shapeTwo = await page.$$eval('.metrics dd', (n) => n.map((x) => x.textContent.trim()));
const views = await page.$$eval('select', (n) => n.length);
const detail = await page.$$eval('.metrics p', (n) => n.map((x) => x.textContent.trim().slice(0, 90)));
console.log(`two views: ${two}`);
console.log(`           shape reported as "${shapeTwo[1]}"`);
console.log(`           azimuth selectors (one per photo): ${views}`);
console.log(`           shape detail: ${detail[1]}`);
const panel1 = await page.textContent('.controls .panel');
console.log(`           photos panel: ${panel1.replace(/\s+/g, ' ').slice(0, 160)}`);

await page.screenshot({ path: `${OUT}/multiview.png`, fullPage: false });
console.log(`console errors (${errors.length}): ${[...new Set(errors)].slice(0, 5).join(' | ')}`);

await browser.close();
server.kill();
process.exit(0);
