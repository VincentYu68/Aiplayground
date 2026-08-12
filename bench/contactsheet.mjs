/**
 * One picture you can judge the whole corpus from.
 *
 *   npx vite-node bench/photos3d.ts --clay     render the corpus and its truth
 *   npx tsc -b && npx vite build --outDir dist-bench
 *   node bench/contactsheet.mjs                drive the app and tile the result
 *
 * For every object: the test photograph, the true solid from four angles, and
 * the model the app built from that photograph from the same four angles,
 * stacked so truth sits directly above model. A number can tell you something
 * got worse; only this can tell you *how*, and it is the only artefact here a
 * person can look at once and form a judgement from.
 *
 * Two things it deliberately does not do. It does not screenshot on a timer —
 * the page pulls 35MB of depth weights before the first real build, so a fixed
 * delay photographs the fallback shape and reads as a regression that is not
 * there; it polls until the model stops changing. And it does not stop at the
 * first failure: a photo that crashes the app becomes a red tile in the sheet
 * and the rest of the corpus still gets shot. A harness that fails open loses
 * the corpus silently, which is worse than a harness that fails.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.BENCH_PORT ?? 5303);
const DIST = process.env.BENCH_DIST ?? 'dist-bench';
const CORPUS = resolve(process.env.CORPUS_OUT ?? 'bench/out/corpus');
const OUT = resolve(process.env.BENCH_OUT ?? 'bench/out/gallery-bench');
const VIEWS = ['ISO', 'FRONT', 'SIDE', 'TOP'];
const TILE = 320;

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

async function waitForServer(url, timeoutMs = 90000) {
  const started = Date.now();
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`server never came up at ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function dataUrl(file) {
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}

/** Per-object scores, if the shape bench has been run. */
function readScores() {
  const file = join(CORPUS, 'scores.tsv');
  if (!existsSync(file)) return new Map();
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const head = lines[0].split('\t');
  const out = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const row = {};
    head.forEach((h, i) => (row[h] = cells[i]));
    if (row.shot === 'hero') out.set(row.object, row);
  }
  return out;
}

/**
 * Wait until the model stops changing.
 *
 * The first `.summary` to appear is built from the fallback shape, because the
 * depth weights are still downloading. Screenshotting then is what made the
 * previous harness report a regression every time the network was slow.
 */
async function waitForSettled(page, timeoutMs = 300000) {
  const started = Date.now();
  let last = null;
  let stable = 0;
  for (;;) {
    const now = await page.evaluate(() => {
      const summary = document.querySelector('.summary')?.textContent ?? '';
      const slider = document.querySelector('.step-slider');
      return `${summary}|${slider ? slider.max : ''}`;
    });
    if (now === last && now.length > 1) stable++;
    else stable = 0;
    last = now;
    if (stable >= 5) return last;
    if (Date.now() - started > timeoutMs) throw new Error('model never settled');
    await page.waitForTimeout(2000);
  }
}

async function shootOne(page, base, photo) {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[type=file]', photo);
  await page.waitForSelector('.summary', { timeout: 300000 });
  const summary = await waitForSettled(page);

  await page.$eval('.step-slider', (el) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(el, el.max);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // The finished model should be solid, not ghosted.
  for (const box of await page.$$('.viewer-toggles input[type=checkbox]')) {
    if (await box.isChecked()) await box.uncheck();
  }
  await page.waitForTimeout(1500);

  const shots = {};
  for (const view of VIEWS) {
    await page.$$eval(
      '.viewer-overlay-tools button',
      (btns, want) => btns.find((b) => b.textContent.trim().toUpperCase() === want)?.click(),
      view,
    );
    await page.waitForTimeout(900);
    const buffer = await page.locator('.viewer-canvas').screenshot();
    shots[view] = `data:image/png;base64,${buffer.toString('base64')}`;
  }
  return { shots, summary: summary.split('|')[0] };
}

/**
 * Tile everything into one image, in a browser, because it already has a
 * rasteriser and a text engine and node does not.
 */
async function compose(page, sheets, file) {
  const url = await page.evaluate(async (rows) => {
    const TILE = 320;
    const LABEL = 22;
    const HEAD = 30;
    const cols = 5;
    const blockHeight = HEAD + (TILE + LABEL) * 2;
    const canvas = document.createElement('canvas');
    canvas.width = TILE * cols;
    canvas.height = blockHeight * rows.length;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#15171c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const load = (src) =>
      new Promise((done) => {
        const img = new Image();
        img.onload = () => done(img);
        img.onerror = () => done(null);
        img.src = src;
      });

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const top = r * blockHeight;
      ctx.fillStyle = row.failure ? '#3a1c1c' : '#1d2027';
      ctx.fillRect(0, top, canvas.width, HEAD);
      ctx.fillStyle = row.failure ? '#ff8a8a' : '#e6e8ee';
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.fillText(row.title, 10, top + 20);

      const cells = [
        { src: row.photo, label: 'photograph' },
        ...['iso', 'front', 'side', 'top'].map((v) => ({ src: row.truth[v], label: `truth ${v}` })),
        { src: null, label: row.scoreLine },
        ...['ISO', 'FRONT', 'SIDE', 'TOP'].map((v) => ({
          src: row.model ? row.model[v] : null,
          label: `model ${v.toLowerCase()}`,
        })),
      ];

      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const cx = (i % cols) * TILE;
        const cy = top + HEAD + Math.floor(i / cols) * (TILE + LABEL);
        ctx.fillStyle = '#0e1014';
        ctx.fillRect(cx, cy, TILE, TILE);
        if (cell.src) {
          const img = await load(cell.src);
          if (img) {
            // Contain, so nothing is cropped and aspect is preserved: a model
            // squashed to fit would look like a shape error that is not there.
            const s = Math.min(TILE / img.width, TILE / img.height);
            const w = img.width * s;
            const h = img.height * s;
            ctx.drawImage(img, cx + (TILE - w) / 2, cy + (TILE - h) / 2, w, h);
          }
        } else if (i === 5) {
          ctx.fillStyle = '#8d94a6';
          ctx.font = '13px ui-monospace, monospace';
          const words = (cell.label || '').split('\n');
          words.forEach((line, n) => ctx.fillText(line, cx + 10, cy + 26 + n * 20));
        }
        ctx.fillStyle = '#7d8494';
        ctx.font = '12px system-ui, sans-serif';
        if (i !== 5) ctx.fillText(cell.label, cx + 6, cy + TILE + 15);
      }
    }
    return canvas.toDataURL('image/png');
  }, sheets);
  writeFileSync(file, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
}

const manifestFile = join(CORPUS, 'manifest.json');
if (!existsSync(manifestFile)) {
  console.error(`no corpus at ${CORPUS} — run "npx vite-node bench/photos3d.ts --clay" first`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')).filter((m) => m.shot === 'hero');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wanted = only.length ? manifest.filter((m) => only.includes(m.object)) : manifest;
const scores = readScores();

const server = spawn(
  'npx',
  ['vite', 'preview', '--outDir', DIST, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { stdio: 'ignore' },
);
process.on('exit', () => server.kill());
const base = `http://127.0.0.1:${PORT}/`;
await waitForServer(base);

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

const rows = [];
const failures = [];
for (const entry of wanted) {
  const photo = join(CORPUS, entry.photo);
  const score = scores.get(entry.object);
  const scoreLine = score
    ? `solid  ${(Number(score.solidIoU) * 100).toFixed(1)}%\n` +
      `unseen ${(Number(score.unseen) * 100).toFixed(1)}%\n` +
      `front  ${(Number(score.front) * 100).toFixed(1)}%\n` +
      `depth  ${Number(score.depthRatio).toFixed(2)}x true`
    : '(run bench/shapebench.ts\n for scores)';

  const truth = {};
  for (const v of ['iso', 'front', 'side', 'top']) {
    const file = join(CORPUS, `${entry.object}-truth-${v}.png`);
    truth[v] = existsSync(file) ? dataUrl(file) : null;
  }

  let model = null;
  let failure = null;
  try {
    const shot = await shootOne(page, base, photo);
    model = shot.shots;
    console.log(`${entry.object.padEnd(9)} ${shot.summary}`);
  } catch (error) {
    failure = String(error).split('\n')[0];
    failures.push(`${entry.object}: ${failure}`);
    console.error(`${entry.object.padEnd(9)} FAILED: ${failure}`);
  }

  rows.push({
    title: failure
      ? `${entry.object} — FAILED: ${failure}`
      : `${entry.object} — ${entry.note}`,
    photo: dataUrl(photo),
    truth,
    model,
    scoreLine,
    failure,
  });

  // Written after every object, so an interrupted run still leaves a sheet of
  // everything that had been shot by then.
  await compose(page, rows, join(OUT, 'contact-sheet.png'));
}

await browser.close();
server.kill();
console.log(`\nsheet: ${join(OUT, 'contact-sheet.png')}  (${rows.length} objects, ${TILE}px tiles)`);
if (failures.length) {
  console.error(`\n${failures.length} objects failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
process.exit(0);
