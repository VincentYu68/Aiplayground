/**
 * Does the depth model actually load and get used in the browser?
 *
 * The gallery screenshot still looks like a loaf, which has two very different
 * explanations: the model never ran, or it ran and the shape logic ignored it.
 * This separates them.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.PROBE_PORT ?? 5320);
const OUT = resolve('bench/out/probe');
mkdirSync(OUT, { recursive: true });
const photo = process.argv[2] ?? 'bench/out/photos/car.png';
const label = photo.split('/').pop().replace(/\.png$/, '');

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
  ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { stdio: 'ignore' },
);
process.on('exit', () => server.kill());
const base = `http://127.0.0.1:${PORT}/`;
await waitForServer(base);

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
// Software rendering makes every interaction slow; the default 30s is not enough.
page.setDefaultTimeout(180000);

const console_ = [];
const requests = [];
page.on('console', (m) => console_.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console_.push(`[pageerror] ${e.message}`));
page.on('requestfinished', async (r) => {
  if (/\.onnx|\.wasm/.test(r.url())) {
    const res = await r.response();
    requests.push(`${res?.status()} ${r.url().split('/').pop()}`);
  }
});
page.on('requestfailed', (r) => requests.push(`FAILED ${r.url().split('/').pop()} ${r.failure()?.errorText}`));

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.setInputFiles('input[type=file]', resolve(photo));
await page.waitForSelector('.summary', { timeout: 240000 });

// Wait for the model-driven re-cut to settle: poll the summary until it stops
// changing, rather than guessing a fixed delay.
let last = '';
let stableFor = 0;
for (let i = 0; i < 90; i++) {
  const now = (await page.textContent('.summary')) ?? '';
  if (now === last) stableFor++;
  else stableFor = 0;
  last = now;
  if (stableFor >= 6) break;
  await page.waitForTimeout(2000);
}

console.log('--- summary ---');
console.log(last);
const status = await page
  .$$eval('.status, .notice, .prior-note, .model-status', (n) => n.map((x) => x.textContent.trim()))
  .catch(() => []);
console.log('--- status text ---');
console.log(status.join('\n') || '(none)');
console.log('--- onnx/wasm requests ---');
console.log([...new Set(requests)].join('\n') || '(none)');
console.log('--- console ---');
console.log(console_.slice(0, 40).join('\n') || '(none)');

// Screenshot every angle, not just the flattering one.
//
// Toggles and the slider are driven through the DOM rather than by clicking.
// Playwright's actionability check waits for the element to be "stable", and a
// software-rendered WebGL canvas repainting at about a frame a second never
// looks stable, so a real click times out on a model that is otherwise fine.
await page.$$eval('.viewer-toggles input[type=checkbox]', (boxes) => {
  for (const b of boxes) if (b.checked) b.click();
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
  await page.waitForTimeout(2500);
  await page.locator('.viewer-canvas').screenshot({ path: `${OUT}/${label}-${view.toLowerCase()}.png` });
}
console.log(`shots in ${OUT}`);
await browser.close();
server.kill();
process.exit(0);
