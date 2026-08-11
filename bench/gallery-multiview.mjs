/**
 * Same as gallery.mjs, but loads several angles of one object through the real
 * "Add angle" control, so the carved-hull path is what gets photographed.
 *
 *   node bench/gallery-multiview.mjs chair 0 90 180 270
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.BENCH_PORT ?? 5205);
const OUT = resolve(process.env.BENCH_OUT ?? 'bench/out/gallery');
mkdirSync(OUT, { recursive: true });

const [solid, ...angles] = process.argv.slice(2);
if (!solid) throw new Error('usage: gallery-multiview.mjs <solid> <angle...>');
const photos = (angles.length ? angles : ['0', '90']).map(
  (a) => `bench/out/photos3d/${solid}-${a}.png`,
);

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
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.setInputFiles('input[type=file]', resolve(photos[0]));
await page.waitForSelector('.summary', { timeout: 180000 });
await page.waitForTimeout(5000);

for (const photo of photos.slice(1)) {
  const inputs = await page.$$('input[type=file]');
  await inputs[inputs.length - 1].setInputFiles(resolve(photo));
  await page.waitForTimeout(9000);
}
await page
  .waitForFunction(
    (n) => {
      const shape = document.querySelectorAll('.metrics dd')[1]?.textContent ?? '';
      return new RegExp(`Carved from ${n} views`).test(shape);
    },
    photos.length,
    { timeout: 180000 },
  )
  .catch(() => console.log('(never reported the full view count)'));
await page.waitForTimeout(3000);

await page.$eval('.step-slider', (el) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, el.max);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
for (const b of await page.$$('.viewer-toggles input[type=checkbox]')) {
  if (await b.isChecked()) await b.uncheck();
}
await page.waitForTimeout(1500);

const summary = (await page.textContent('.summary')) ?? '';
const metrics = await page.$$eval('.metrics dd', (n) => n.map((x) => x.textContent.trim()));
console.log(`${solid} x${photos.length}  ${summary}`);
console.log(`  silhouette=${metrics[0]} shape=${metrics[1]} colour=${metrics[2]}`);

for (const view of ['ISO', 'SIDE']) {
  await page.$$eval(
    '.viewer-overlay-tools button',
    (btns, want) => btns.find((b) => b.textContent.trim().toUpperCase() === want)?.click(),
    view,
  );
  await page.waitForTimeout(900);
  await page
    .locator('.viewer-canvas')
    .screenshot({ path: `${OUT}/${solid}-x${photos.length}-${view.toLowerCase()}.png` });
}

await browser.close();
server.kill();
process.exit(0);
