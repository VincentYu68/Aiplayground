/**
 * Drive one photo through the real app and shoot it from every side.
 *
 *   BENCH_DIST=dist-depth3d BENCH_PORT=5301 node scripts/probe.mjs <photo> [mask]
 *
 * A variant of `bench/probe.mjs` that honours BENCH_DIST, so several agents can
 * run it against their own builds at once without racing over `dist/`.
 *
 * It shoots SIDE and TOP as well as ISO and FRONT, because FRONT cannot tell you
 * anything at all about a shape extruded along z — the view that made a solid
 * red loaf look like a finished car for two rounds.
 *
 * It also reports what the classifier decided, because a shape prior that never
 * fires is indistinguishable from one that fires and is wrong.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.BENCH_PORT ?? 5301);
const DIST = process.env.BENCH_DIST;
const OUT = resolve(process.env.BENCH_OUT ?? 'bench/out/probe-depth3d');
mkdirSync(OUT, { recursive: true });

const photos = process.argv.slice(2);
if (photos.length === 0) photos.push('bench/out/photos/car.png');

function findChromium() {
  for (const r of [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ])
    if (existsSync(r)) return r;
  return process.env.CHROMIUM_PATH;
}

async function waitForServer(url, timeoutMs = 60000) {
  const started = Date.now();
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`no server at ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const server = spawn(
  'npx',
  [
    'vite',
    'preview',
    ...(DIST ? ['--outDir', DIST] : []),
    '--port',
    String(PORT),
    '--strictPort',
    '--host',
    '127.0.0.1',
  ],
  { stdio: 'ignore' },
);
process.on('exit', () => server.kill());
const base = `http://127.0.0.1:${PORT}/`;
await waitForServer(base);

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const noise = [];
page.on('pageerror', (e) => noise.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') noise.push(`[console] ${m.text()}`);
});

for (const photo of photos) {
  const label = photo.split('/').pop().replace(/\.png$/, '');
  const started = Date.now();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[type=file]', resolve(photo));
  await page.waitForSelector('.summary', { timeout: 240000 });
  const firstModel = Math.round((Date.now() - started) / 1000);

  // Poll until the summary stops changing rather than guessing a delay: the
  // weights land at their own pace and each arrival triggers another build.
  let last = '';
  let stableFor = 0;
  for (let i = 0; i < 90; i++) {
    const now = (await page.textContent('.summary')) ?? '';
    if (now === last) stableFor++;
    else stableFor = 0;
    last = now;
    if (stableFor >= 5) break;
    await page.waitForTimeout(1500);
  }

  const hints = await page.$$eval('.hint', (n) => n.map((x) => x.textContent.trim()));
  const shape = await page.$$eval('select, input[type=range]', (n) =>
    n.map((x) => `${x.id || x.name || x.className}=${x.value}`),
  );
  console.log(`\n=== ${label} ===`);
  console.log(`first model after ${firstModel}s, settled after ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`summary: ${last}`);
  console.log(`hints  : ${hints.filter((h) => /Looks like|Assuming|could not/.test(h)).join(' | ') || '(none)'}`);
  console.log(`shape  : ${shape.join('  ')}`);

  // Drive the controls through React's own event path rather than clicking:
  // the viewer animates continuously, so Playwright's actionability checks
  // never settle.
  await page.$$eval('.viewer-toggles input[type=checkbox]', (els) => {
    for (const el of els) {
      if (!el.checked) continue;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'checked',
      ).set;
      setter.call(el, false);
      el.dispatchEvent(new Event('click', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.$eval('.step-slider', (el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, el.max);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1500);
  for (const view of ['ISO', 'FRONT', 'SIDE', 'TOP']) {
    await page.$$eval(
      '.viewer-overlay-tools button',
      (btns, want) => btns.find((b) => b.textContent.trim().toUpperCase() === want)?.click(),
      view,
    );
    await page.waitForTimeout(900);
    // Clip a page screenshot rather than shooting the element: the viewer runs
    // an idle animation, so waiting for the canvas to be "stable" never returns.
    const clip = await page.$eval('.viewer-canvas', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await page.screenshot({ path: `${OUT}/${label}-${view.toLowerCase()}.png`, clip });
  }
}

console.log(`\nshots in ${OUT}`);
console.log(`page errors: ${noise.length ? '\n' + [...new Set(noise)].slice(0, 10).join('\n') : '0'}`);
await browser.close();
server.kill();
process.exit(0);
