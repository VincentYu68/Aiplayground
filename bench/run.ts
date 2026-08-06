/**
 * Benchmark runner.
 *
 *   npx vite-node bench/run.ts              score the in-repo methods
 *   npx vite-node bench/run.ts --dump       also write PNGs + manifest.json
 *   npx vite-node bench/run.ts --load DIR   score masks produced elsewhere
 *
 * The dump exists so a method that cannot run in this project (SAM, which
 * needs PyTorch) is scored on byte-identical inputs by the same code, rather
 * than on its own numbers reported from its own paper.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildCorpus, type Scene } from './scenes';
import { encodeMaskPng, encodePng } from './png';
import { mean, pct, score, type Score } from './metrics';
import { segment } from '../src/core/image/segment';
import { connectedComponents, type Mask } from '../src/core/image/raster';

type Method = (scene: Scene) => Mask;

const METHODS: Record<string, Method> = {
  // What the app does with no user input at all.
  'grabcut-auto': (s) => segment(s.rgba, s.width, s.height, {}).mask,
  // What it does once the user drags a box around the object.
  'grabcut-box': (s) => segment(s.rgba, s.width, s.height, { rect: s.box }).mask,
};

function safeName(name: string): string {
  return name.replace(/\//g, '__');
}

/** Grow a box by a fraction of its own size, clamped to the frame. */
function inflate(
  box: Scene['box'],
  fraction: number,
  width: number,
  height: number,
): Scene['box'] {
  const dx = Math.round((box.x1 - box.x0) * fraction);
  const dy = Math.round((box.y1 - box.y0) * fraction);
  return {
    x0: Math.max(0, box.x0 - dx),
    y0: Math.max(0, box.y0 - dy),
    x1: Math.min(width - 1, box.x1 + dx),
    y1: Math.min(height - 1, box.y1 + dy),
  };
}

function maskBounds(mask: Mask, width: number, height: number): Scene['box'] {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  return { x0, y0, x1, y1 };
}

/**
 * Bounding boxes of the plausible objects in a scene, best first.
 *
 * Scoring blobs by area alone picks whatever is biggest, which on a cluttered
 * desk is the desk. Weighting by how central a blob is encodes the one thing
 * that is reliably true of a photo someone took of an object: they pointed the
 * camera at it.
 */
function rankedComponentBoxes(scene: Scene): Array<Scene['box']> {
  const { width, height } = scene;
  const mask = segment(scene.rgba, width, height, {}).mask;
  const { labels, sizes } = connectedComponents(mask, width, height);
  const stats = new Map<number, { n: number; cx: number; cy: number; box: Scene['box'] }>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = labels[y * width + x];
      if (!l) continue;
      let s = stats.get(l);
      if (!s) {
        s = { n: 0, cx: 0, cy: 0, box: { x0: x, y0: y, x1: x, y1: y } };
        stats.set(l, s);
      }
      s.n++;
      s.cx += x;
      s.cy += y;
      if (x < s.box.x0) s.box.x0 = x;
      if (x > s.box.x1) s.box.x1 = x;
      if (y < s.box.y0) s.box.y0 = y;
      if (y > s.box.y1) s.box.y1 = y;
    }
  }
  const scored = [...stats.entries()].map(([, s]) => {
    const cx = s.cx / s.n / width;
    const cy = s.cy / s.n / height;
    const offCentre = Math.hypot(cx - 0.5, cy - 0.5) / Math.SQRT1_2;
    return { box: s.box, score: (s.n / (width * height)) * (1 - offCentre) ** 2 };
  });
  scored.sort((a, b) => b.score - a.score);
  void sizes;
  return scored.map((s) => s.box);
}

function centralComponentBox(scene: Scene): Scene['box'] {
  const boxes = rankedComponentBoxes(scene);
  return boxes[0] ?? { x0: 0, y0: 0, x1: scene.width - 1, y1: scene.height - 1 };
}

function candidateBoxes(scene: Scene): Array<Scene['box']> {
  return rankedComponentBoxes(scene).slice(0, 4);
}

function dump(scenes: Scene[], dir: string): void {
  mkdirSync(join(dir, 'images'), { recursive: true });
  mkdirSync(join(dir, 'truth'), { recursive: true });
  const manifest = scenes.map((s) => ({
    name: s.name,
    file: `${safeName(s.name)}.png`,
    object: s.object,
    background: s.background,
    width: s.width,
    height: s.height,
    box: s.box,
    // Progressively sloppier boxes, to find how much slack SAM tolerates
    // before the prompt stops meaning "this object".
    box15: inflate(s.box, 0.15, s.width, s.height),
    box30: inflate(s.box, 0.3, s.width, s.height),
    box60: inflate(s.box, 0.6, s.width, s.height),
    // The box the app could propose with no user input at all: whatever the
    // old colour-model segmenter thinks the object's extent is.
    autoBox: maskBounds(
      segment(s.rgba, s.width, s.height, {}).mask,
      s.width,
      s.height,
    ),
    // The same, but only the blob nearest the middle of the frame — clutter
    // touching the border otherwise stretches the box over the whole image,
    // and a box that big makes SAM answer "the background" instead.
    autoBoxCentral: centralComponentBox(s),
    candidateBoxes: candidateBoxes(s),
  }));
  for (const s of scenes) {
    writeFileSync(join(dir, 'images', `${safeName(s.name)}.png`), encodePng(s.rgba, s.width, s.height));
    writeFileSync(join(dir, 'truth', `${safeName(s.name)}.png`), encodeMaskPng(s.truth, s.width, s.height));
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`wrote ${scenes.length} scenes to ${dir}`);
}

/** Read masks a external tool wrote, as raw bytes: one byte per pixel, 0 or 1. */
function loadMasks(dir: string, scenes: Scene[]): Map<string, Mask> | null {
  const out = new Map<string, Mask>();
  for (const s of scenes) {
    const path = join(dir, `${safeName(s.name)}.bin`);
    if (!existsSync(path)) return null;
    const buf = readFileSync(path);
    if (buf.length !== s.width * s.height) {
      throw new Error(`${path}: expected ${s.width * s.height} bytes, got ${buf.length}`);
    }
    const m = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) m[i] = buf[i] ? 1 : 0;
    out.set(s.name, m);
  }
  return out;
}

function report(results: Map<string, Map<string, Score>>, scenes: Scene[]): void {
  const methods = [...results.keys()];
  const backgrounds = [...new Set(scenes.map((s) => s.background))];
  const objects = [...new Set(scenes.map((s) => s.object))];

  const nameWidth = Math.max(...methods.map((m) => m.length), 14);
  const pad = (s: string, n: number) => s.padEnd(n);

  console.log('\n=== mean IoU by background ===');
  console.log(pad('method', nameWidth) + backgrounds.map((b) => b.slice(0, 11).padStart(12)).join(''));
  for (const m of methods) {
    const row = backgrounds.map((b) => {
      const vals = scenes.filter((s) => s.background === b).map((s) => results.get(m)!.get(s.name)!.iou);
      return pct(mean(vals)).padStart(12);
    });
    console.log(pad(m, nameWidth) + row.join(''));
  }

  console.log('\n=== mean IoU by object ===');
  console.log(pad('method', nameWidth) + objects.map((o) => o.slice(0, 11).padStart(12)).join(''));
  for (const m of methods) {
    const row = objects.map((o) => {
      const vals = scenes.filter((s) => s.object === o).map((s) => results.get(m)!.get(s.name)!.iou);
      return pct(mean(vals)).padStart(12);
    });
    console.log(pad(m, nameWidth) + row.join(''));
  }

  console.log('\n=== overall ===');
  console.log(
    pad('method', nameWidth) +
      'meanIoU'.padStart(9) +
      'medIoU'.padStart(9) +
      'bF1'.padStart(9) +
      'missed'.padStart(9) +
      'invented'.padStart(10) +
      'IoU<0.5'.padStart(9),
  );
  for (const m of methods) {
    const all = scenes.map((s) => results.get(m)!.get(s.name)!);
    const ious = all.map((s) => s.iou).sort((a, b) => a - b);
    const median = ious[Math.floor(ious.length / 2)];
    const bad = ious.filter((v) => v < 0.5).length;
    console.log(
      pad(m, nameWidth) +
        pct(mean(ious)).padStart(9) +
        pct(median).padStart(9) +
        pct(mean(all.map((s) => s.boundaryF1))).padStart(9) +
        pct(mean(all.map((s) => s.missed))).padStart(9) +
        pct(mean(all.map((s) => s.invented))).padStart(10) +
        String(bad).padStart(9),
    );
  }

  console.log('\n=== worst 12 scenes, by the best method available ===');
  const best = methods[methods.length - 1];
  const ranked = scenes
    .map((s) => ({ name: s.name, ...results.get(best)!.get(s.name)! }))
    .sort((a, b) => a.iou - b.iou)
    .slice(0, 12);
  for (const r of ranked) {
    console.log(`  ${r.name.padEnd(26)} IoU ${pct(r.iou)}  bF1 ${pct(r.boundaryF1)}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const scenes = buildCorpus();

  if (args.includes('--dump')) {
    dump(scenes, join(process.cwd(), 'bench', 'out'));
  }

  const results = new Map<string, Map<string, Score>>();

  for (const [name, fn] of Object.entries(METHODS)) {
    const started = Date.now();
    const per = new Map<string, Score>();
    for (const s of scenes) {
      per.set(s.name, score(fn(s), s.truth, s.width, s.height));
    }
    results.set(name, per);
    console.log(`${name}: ${scenes.length} scenes in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  const loadIdx = args.indexOf('--load');
  if (loadIdx >= 0) {
    for (const dir of args.slice(loadIdx + 1).filter((a) => !a.startsWith('--'))) {
      const masks = loadMasks(dir, scenes);
      if (!masks) {
        console.log(`skipping ${dir}: incomplete`);
        continue;
      }
      const per = new Map<string, Score>();
      for (const s of scenes) per.set(s.name, score(masks.get(s.name)!, s.truth, s.width, s.height));
      results.set(dir.split('/').filter(Boolean).pop()!, per);
    }
  }

  report(results, scenes);
}

main();
