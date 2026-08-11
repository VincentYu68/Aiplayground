/**
 * Run the benchmark through the *shipped* browser code path.
 *
 * Everything else in bench/ scores algorithms; this scores the thing the user
 * actually gets. It drives a real Chromium against the dev server, imports the
 * same `sam.ts` the app imports, fetches the same model files the app fetches,
 * and writes masks in the same format as the Python runs — so a discrepancy
 * between the two shows up as a number rather than as a bug report weeks later.
 *
 * The preprocessing is the reason this exists. Resizing and normalising an
 * image is four lines of arithmetic that are easy to get subtly wrong, and a
 * half-pixel shift or a transposed channel does not throw, it just quietly
 * costs a few points of IoU.
 *
 *   node bench/browser.mjs [outputDir]
 *
 * Requires playwright-core and a Chromium; set CHROMIUM_PATH to override the
 * autodetected one.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const OUT = resolve(process.argv[2] ?? 'bench/out/browser-masks');
const BENCH = resolve('bench/out');
const PORT = Number(process.env.BENCH_PORT ?? 5178);

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
  for (const r of roots) if (existsSync(r)) return r;
  return undefined;
}

async function waitForServer(url, timeoutMs = 60000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - started > timeoutMs) throw new Error(`server never came up at ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const manifest = JSON.parse(readFileSync(join(BENCH, 'manifest.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });

const server = spawn(
  'npx',
  ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { stdio: 'ignore' },
);
process.on('exit', () => server.kill());

try {
  await waitForServer(`http://127.0.0.1:${PORT}/`);

  const browser = await chromium.launch({
    executablePath: findChromium(),
    // The container routes outbound HTTPS through a proxy; without these the
    // browser sends even 127.0.0.1 requests to it and every fetch fails.
    args: ['--no-sandbox', '--proxy-server=direct://', '--proxy-bypass-list=*'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [page]', m.text());
  });
  await page.goto(`http://127.0.0.1:${PORT}/`);

  await page.evaluate(async () => {
    const sam = await import('/src/core/image/sam.ts');
    const propose = await import('/src/core/image/propose.ts');
    window.__sam = sam;
    window.__propose = propose;
    const t0 = performance.now();
    await sam.loadSam({
      runtime: new URL('ort/', location.href).href,
      encoder: new URL('models/mobilesam-encoder.onnx', location.href).href,
      decoder: new URL('models/mobilesam-decoder.onnx', location.href).href,
    });
    window.__loadMs = performance.now() - t0;
  });
  console.log(`model loaded in ${Math.round(await page.evaluate(() => window.__loadMs))} ms`);

  let encodeTotal = 0;
  let decodeTotal = 0;
  const started = Date.now();

  for (const [i, entry] of manifest.entries()) {
    const result = await page.evaluate(async ({ file, useUserBox, box }) => {
      const sam = window.__sam;
      const propose = window.__propose;

      const blob = await (await fetch(`/bench/out/images/${file}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

      const t0 = performance.now();
      const embedding = await sam.encodeImage(data, width, height);
      const t1 = performance.now();
      const prompt = useUserBox
        ? sam.clampBox(box, width, height, 1)
        : propose.proposeBox(data, width, height);
      const mask = await sam.decodeMask(embedding, { box: prompt });
      const t2 = performance.now();

      return { mask: Array.from(mask), encodeMs: t1 - t0, decodeMs: t2 - t1 };
    }, { file: entry.file, useUserBox: process.env.USER_BOX === '1', box: entry.box });

    encodeTotal += result.encodeMs;
    decodeTotal += result.decodeMs;
    writeFileSync(join(OUT, entry.file.replace('.png', '.bin')), Buffer.from(result.mask));
    if ((i + 1) % 20 === 0) {
      console.log(`  ${i + 1}/${manifest.length}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  }

  const n = manifest.length;
  console.log(
    `browser: encode ${(encodeTotal / n).toFixed(0)} ms/photo, ` +
      `decode ${(decodeTotal / n).toFixed(0)} ms/prompt`,
  );
  console.log(`masks -> ${OUT}`);
  await browser.close();
} finally {
  server.kill();
}
