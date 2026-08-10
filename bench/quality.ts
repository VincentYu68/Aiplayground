/**
 * Scratch: render what the model actually looks like, next to the photo, so
 * quality can be judged rather than inferred from a number.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateModel } from '../src/core/build/pipeline';
import { DEFAULT_OPTIONS, type BuildOptions } from '../src/types';
import { buildCorpus } from './scenes';
import { encodePng } from './png';

const out = 'bench/out/quality';
mkdirSync(out, { recursive: true });

/** Nearest-neighbour upscale so a 32-stud preview is actually visible. */
function upscale(rgba: Uint8ClampedArray, w: number, h: number, f: number) {
  const W = w * f;
  const H = h * f;
  const o = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = (Math.floor(y / f) * w + Math.floor(x / f)) * 4;
      const d = (y * W + x) * 4;
      o[d] = rgba[s];
      o[d + 1] = rgba[s + 1];
      o[d + 2] = rgba[s + 2];
      o[d + 3] = rgba[s + 3] === 0 ? 255 : 255;
      if (rgba[s + 3] === 0) {
        o[d] = 25;
        o[d + 1] = 27;
        o[d + 2] = 32;
      }
    }
  return { rgba: o, width: W, height: H };
}

const corpus = buildCorpus();
const seen = new Set<string>();
const rows: string[] = [];

for (const scene of corpus) {
  if (seen.has(scene.object)) continue;
  seen.add(scene.object);

  const view = {
    rgba: scene.rgba,
    mask: scene.truth,
    width: scene.width,
    height: scene.height,
    azimuth: 0,
  };
  const options: BuildOptions = { ...DEFAULT_OPTIONS, studsWide: 32 };
  const r = generateModel([view] as never, options);

  const up = upscale(r.fidelity.preview.rgba, r.fidelity.preview.width, r.fidelity.preview.height, 8);
  writeFileSync(`${out}/${scene.object}-model.png`, encodePng(up.rgba, up.width, up.height));

  const oneByOne = r.partsList
    .filter((p) => p.partId.endsWith('1x1'))
    .reduce((n, p) => n + p.count, 0);
  rows.push(
    `${scene.object.padEnd(8)} parts=${String(r.totalParts).padStart(5)} ` +
      `steps=${String(r.steps.length).padStart(4)} ` +
      `1x1=${String(oneByOne).padStart(5)} (${((oneByOne / r.totalParts) * 100).toFixed(0)}%) ` +
      `IoU=${(r.fidelity.silhouetteIoU * 100).toFixed(1)}% dE=${r.fidelity.meanDeltaE.toFixed(1)} ` +
      `score=${r.stability.score} held=${r.stability.cantilevered} ` +
      `colours=${new Set(r.partsList.map((p) => p.colorName)).size} ` +
      `${r.gridX}x${r.gridY}x${r.gridZ} ${(r.elapsedMs / 1000).toFixed(1)}s`,
  );
  console.log(rows[rows.length - 1]);
}
