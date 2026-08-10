/**
 * End-to-end check of the shipped app in a real browser.
 *
 * Serves the production build, drops a photo into the file input the way a user
 * would, waits for the model to generate, and reports what the page actually
 * shows — plus every console error and failed request along the way.
 *
 *   node bench/e2e.mjs [photo.png ...]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 5199;
const OUT = resolve('bench/out/e2e');
mkdirSync(OUT, { recursive: true });

const photos = process.argv.slice(2);
if (photos.length === 0) photos.push('bench/out/photos/mug.png');

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

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  stdio: 'ignore',
});
process.on('exit', () => server.kill());

const base = `http://127.0.0.1:${PORT}/`;
await waitForServer(base);

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

const consoleErrors = [];
const failedRequests = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
});

for (const photo of photos) {
  const label = photo.split('/').pop().replace(/\.png$/, '');
  console.log(`\n=== ${label} ===`);
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  const t0 = Date.now();
  await page.setInputFiles('input[type=file]', resolve(photo));

  // Wait for a model to appear (the summary line) or an error banner.
  let summary = null;
  try {
    await page.waitForSelector('.summary, .banner.error', { timeout: 180000 });
    summary = await page.textContent('.summary').catch(() => null);
  } catch (e) {
    console.log(`  TIMED OUT waiting for a model: ${e.message}`);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const err = await page.textContent('.banner.error').catch(() => null);
  const hints = await page.$$eval('.hint', (ns) => ns.map((n) => n.textContent.trim()));
  const fidelity = await page
    .$$eval('.report-grid .panel', (ns) => ns.map((n) => n.innerText.replace(/\n+/g, ' | ')))
    .catch(() => []);

  console.log(`  first build in ${elapsed}s`);
  console.log(`  summary: ${summary ?? '(none)'}`);
  if (err) console.log(`  ERROR BANNER: ${err}`);
  for (const h of hints) console.log(`  hint: ${h}`);
  for (const f of fidelity) console.log(`  panel: ${f.slice(0, 400)}`);

  await page.screenshot({ path: `${OUT}/${label}.png`, fullPage: true });
}

console.log(`\nconsole errors (${consoleErrors.length}):`);
for (const e of [...new Set(consoleErrors)].slice(0, 20)) console.log(`  ${e}`);
console.log(`failed requests (${failedRequests.length}):`);
for (const f of [...new Set(failedRequests)].slice(0, 20)) console.log(`  ${f}`);

await browser.close();
server.kill();
process.exit(0);
