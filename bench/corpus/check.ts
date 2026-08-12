/**
 * Does the ground truth describe the same solid as the picture?
 *
 *   npx vite-node bench/corpus/check.ts
 *
 * The corpus rests on one claim: that the exact inside-test in `parts.ts` and
 * the three.js mesh built from the same numbers are the same object. If they
 * are not, every measurement taken against the renders is measuring the gap
 * between two descriptions of a car rather than anything about the app — and it
 * would look like a plausible number the whole time.
 *
 * So this rasterises an orthographic silhouette from the inside-test, has the
 * browser render the identical window, and compares them. It also checks the
 * things the comparison frame assumes: every object exactly one unit tall,
 * standing on the ground.
 *
 * Anything below 0.99 agreement is a bug, not tolerance. The two renderers
 * disagree only on antialiased edge pixels, which on a 384-pixel silhouette is
 * a few tenths of a percent.
 */

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { CORPUS, shotSpec, type ShotSpec } from './objects';
import { insideParts, partsBounds } from './parts';
import { decodePng, encodeMaskPng } from '../png';

const PORT = Number(process.env.CORPUS_PORT ?? 5313);
const OUT = resolve('bench/out/corpus/check');
const SIZE = 384;

function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const path of [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ]) {
    if (existsSync(path)) return path;
  }
  return undefined;
}

function serve(): Promise<{ base: string; close: () => void }> {
  const root = resolve('bench/corpus');
  const three = resolve('node_modules/three/build/three.module.js');
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const file = path === '/three.module.js' ? three : join(root, path);
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      response.writeHead(404).end();
      return;
    }
    const type = extname(file) === '.html' ? 'text/html' : 'text/javascript';
    response.writeHead(200, { 'content-type': type });
    response.end(body);
  });
  return new Promise((done) => {
    server.listen(PORT, '127.0.0.1', () =>
      done({ base: `http://127.0.0.1:${PORT}/render.html`, close: () => server.close() }),
    );
  });
}

/**
 * The same orthographic silhouette, marched straight out of the inside-test.
 *
 * Marching rather than voxelising: a voxel projection is chunky by a whole cell
 * and would put a floor under how well the two can ever agree, which is exactly
 * the tolerance a real disagreement could hide in.
 */
function marchSilhouette(
  parts: Parameters<typeof insideParts>[0],
  azimuthDeg: number,
  window: { halfWidth: number; yLow: number; yHigh: number },
  reach: number,
): Uint8Array {
  const a = (azimuthDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const mask = new Uint8Array(SIZE * SIZE);
  const steps = 260;
  for (let py = 0; py < SIZE; py++) {
    const y = window.yHigh - ((py + 0.5) / SIZE) * (window.yHigh - window.yLow);
    for (let px = 0; px < SIZE; px++) {
      const u = -window.halfWidth + ((px + 0.5) / SIZE) * window.halfWidth * 2;
      for (let i = 0; i < steps; i++) {
        const w = -reach + (2 * reach * i) / (steps - 1);
        if (insideParts(parts, u * cos + w * sin, y, u * sin - w * cos)) {
          mask[py * SIZE + px] = 1;
          break;
        }
      }
    }
  }
  return mask;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { base, close } = await serve();
  const browser = await chromium.launch({ executablePath: findChromium() });
  const page = await browser.newPage({ viewport: { width: SIZE + 40, height: SIZE + 40 } });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(
    () => typeof (window as never as { renderShot?: unknown }).renderShot === 'function',
  );

  let worst = 1;
  const rows: string[] = [];
  for (const object of CORPUS) {
    const b = partsBounds(object.parts);
    const height = b.max[1] - b.min[1];
    const standing = Math.abs(b.min[1]) < 1e-9;
    const unitTall = Math.abs(height - 1) < 1e-6;

    const shot = object.shots[0];
    const reach = Math.max(
      Math.hypot(b.max[0], b.max[2]),
      Math.hypot(b.min[0], b.min[2]),
      Math.hypot(b.max[0], b.min[2]),
      Math.hypot(b.min[0], b.max[2]),
    );
    const orthoWindow = { halfWidth: reach * 1.05, yLow: -0.06, yHigh: 1.06 };

    const spec = shotSpec(object, shot, 'mask', SIZE);
    spec.ortho = orthoWindow;
    // Level, whatever the shot's own elevation is: the node side rasterises a
    // level orthographic window, and comparing that against a tilted render
    // measures the tilt rather than the geometry.
    spec.camera.elevation = 0;
    const url = await page.evaluate(
      (s) => (window as never as { renderShot: (s: ShotSpec) => string }).renderShot(s),
      spec as never,
    );
    const decoded = decodePng(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    const rendered = new Uint8Array(SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) rendered[i] = decoded.rgba[i * 4] >= 128 ? 1 : 0;

    const marched = marchSilhouette(object.parts, shot.azimuth, orthoWindow, reach);
    let intersection = 0;
    let union = 0;
    for (let i = 0; i < marched.length; i++) {
      if (marched[i] && rendered[i]) intersection++;
      if (marched[i] || rendered[i]) union++;
    }
    const agreement = union === 0 ? 0 : intersection / union;
    worst = Math.min(worst, agreement);

    // A picture of the disagreement, which is far quicker to read than a number
    // when the number is bad: white is agreed, grey is one or the other.
    const diff = new Uint8Array(SIZE * SIZE);
    for (let i = 0; i < diff.length; i++) diff[i] = marched[i] !== rendered[i] ? 1 : 0;
    writeFileSync(join(OUT, `${object.name}-disagreement.png`), encodeMaskPng(diff, SIZE, SIZE));

    rows.push(
      `${object.name.padEnd(9)} mesh-vs-truth ${(agreement * 100).toFixed(2).padStart(6)}%  ` +
        `height ${height.toFixed(6)}${unitTall ? '' : '  <-- NOT 1'}  ` +
        `ground ${b.min[1].toFixed(6)}${standing ? '' : '  <-- NOT 0'}`,
    );
    console.log(rows[rows.length - 1]);
  }

  await browser.close();
  close();
  console.log(`\ndisagreement maps in ${OUT}`);
  if (worst < 0.99) {
    console.error(`\nFAIL: worst agreement ${(worst * 100).toFixed(2)}% is below 99%`);
    process.exit(1);
  }
  console.log(`\nOK: worst agreement ${(worst * 100).toFixed(2)}%`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
