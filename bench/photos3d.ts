/**
 * Photograph the corpus.
 *
 *   npx vite-node bench/photos3d.ts                  every object, every shot
 *   npx vite-node bench/photos3d.ts --only car       one object, while iterating
 *   npx vite-node bench/photos3d.ts --clay           also the ground-truth views
 *
 * Writes `bench/out/corpus/<object>-<shot>.png` — the test photograph — next to
 * `<object>-<shot>-mask.png`, the exact cut-out of the object in it. Both come
 * out of a real renderer in headless Chromium: perspective, an environment the
 * specular lobe reflects, a key light with angular size so the shadow has a
 * penumbra, and a floor and background with texture on them.
 *
 * The masks are not there to be scored against — they are what lets the shape
 * benchmark hand the geometry stage a perfect cut-out, so that a bad model can
 * be blamed on the geometry rather than on the segmenter. `bench/run.ts` is
 * where segmentation is scored.
 *
 * Nothing here is committed: `bench/out/` is ignored, and the repository has a
 * standing policy of no photographs in it. Regenerating is this one command.
 */

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { CORPUS, shotSpec, type ShotSpec } from './corpus/objects';

const OUT = resolve(process.env.CORPUS_OUT ?? 'bench/out/corpus');
const SIZE = Number(process.env.CORPUS_SIZE ?? 512);

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

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

/**
 * A twenty-line static server rather than the project's dev server.
 *
 * The renderer page needs exactly two files and no transform. Going through
 * Vite would drag the app's dependency pre-bundling into a benchmark run, and
 * three agents sharing one `node_modules/.vite` is a race nobody needs.
 */
function serve(): Promise<{ base: string; close: () => void }> {
  const root = resolve('bench/corpus');
  const three = resolve('node_modules/three/build/three.module.js');
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.mjs': 'text/javascript',
    '.js': 'text/javascript',
  };
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const file = path === '/three.module.js' ? three : join(root, path);
    if (!file.startsWith(root) && file !== three) {
      response.writeHead(403).end();
      return;
    }
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  });
  return new Promise((done) => {
    // Port zero: the kernel picks a free one. Three agents share this tree and
    // a hard-coded port turns "someone else is also benchmarking" into a crash.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      done({ base: `http://127.0.0.1:${port}/render.html`, close: () => server.close() });
    });
  });
}

function writeDataUrl(file: string, dataUrl: string): void {
  const comma = dataUrl.indexOf(',');
  writeFileSync(file, Buffer.from(dataUrl.slice(comma + 1), 'base64'));
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const only = option('only');
  const objects = only ? CORPUS.filter((o) => only.split(',').includes(o.name)) : CORPUS;
  if (objects.length === 0) throw new Error(`no corpus object matched ${only}`);

  const { base, close } = await serve();
  const browser = await chromium.launch({ executablePath: findChromium() });
  const page = await browser.newPage({ viewport: { width: SIZE + 40, height: SIZE + 40 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof (window as never as { renderShot?: unknown }).renderShot === 'function');
  const gl = await page.evaluate(() => (window as never as { rendererInfo: () => string }).rendererInfo());
  console.log(`renderer: ${gl}`);

  const manifest: Array<Record<string, unknown>> = [];
  for (const object of objects) {
    for (const shot of object.shots) {
      const label = `${object.name}-${shot.name}`;
      for (const pass of ['beauty', 'mask'] as const) {
        const spec = shotSpec(object, shot, pass, SIZE);
        const url = await page.evaluate(
          (s) => (window as never as { renderShot: (s: ShotSpec) => string }).renderShot(s),
          spec as never,
        );
        writeDataUrl(join(OUT, pass === 'beauty' ? `${label}.png` : `${label}-mask.png`), url);
      }
      manifest.push({
        object: object.name,
        note: object.note,
        shot: shot.name,
        azimuth: shot.azimuth,
        elevation: shot.elevation,
        fov: shot.fov,
        photo: `${label}.png`,
        mask: `${label}-mask.png`,
      });
      console.log(`${label.padEnd(16)} az=${shot.azimuth}  el=${shot.elevation}  fov=${shot.fov}`);
    }

    if (flag('clay')) {
      // Reference renders of the true solid from the same four angles the app's
      // viewer offers, so a contact sheet can put truth and model side by side.
      const hero = object.shots[0];
      for (const [view, turn, lift] of [
        ['iso', 45, 24],
        ['front', 0, 0],
        ['side', 90, 0],
        ['top', 0, 88],
      ] as Array<[ShotSpec['view'], number, number]>) {
        const spec = shotSpec(
          object,
          { ...hero, azimuth: hero.azimuth + turn, elevation: lift, fill: 0.82, offset: [0, 0] },
          'clay',
          SIZE,
        );
        spec.view = view;
        const url = await page.evaluate(
          (s) => (window as never as { renderShot: (s: ShotSpec) => string }).renderShot(s),
          spec as never,
        );
        writeDataUrl(join(OUT, `${object.name}-truth-${view}.png`), url);
      }
      console.log(`${object.name.padEnd(16)} clay reference views written`);
    }
  }

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n${manifest.length} shots in ${OUT}`);
  if (errors.length) console.log(`page errors:\n  ${errors.slice(0, 10).join('\n  ')}`);

  await browser.close();
  close();
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
