/** Scratch: revolve mode, the path the recogniser sends mugs and bottles down. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateModel } from '../src/core/build/pipeline';
import { DEFAULT_OPTIONS } from '../src/types';
import { buildCorpus } from './scenes';
import { encodePng } from './png';
import { latheProfile } from '../src/core/image/depth';

const out = 'bench/out/quality';
mkdirSync(out, { recursive: true });

function upscale(rgba: Uint8ClampedArray, w: number, h: number, f: number) {
  const W = w * f;
  const H = h * f;
  const o = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = (Math.floor(y / f) * w + Math.floor(x / f)) * 4;
      const d = (y * W + x) * 4;
      if (rgba[s + 3] === 0) {
        o[d] = 25;
        o[d + 1] = 27;
        o[d + 2] = 32;
      } else {
        o[d] = rgba[s];
        o[d + 1] = rgba[s + 1];
        o[d + 2] = rgba[s + 2];
      }
      o[d + 3] = 255;
    }
  return { rgba: o, width: W, height: H };
}

const seen = new Set<string>();
for (const scene of buildCorpus()) {
  if (!['mug', 'bottle', 'plant'].includes(scene.object)) continue;
  if (seen.has(scene.object)) continue;
  seen.add(scene.object);

  const p = latheProfile(scene.truth, scene.width, scene.height);
  let minX = scene.width;
  let maxX = 0;
  let maxR = 0;
  for (let y = 0; y < scene.height; y++) {
    for (let x = 0; x < scene.width; x++)
      if (scene.truth[y * scene.width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    maxR = Math.max(maxR, p.radius[y]);
  }
  console.log(
    `${scene.object}: silhouette x ${minX}..${maxX} (half-width ${((maxX - minX) / 2).toFixed(1)}, ` +
      `naive centre ${((minX + maxX) / 2).toFixed(1)}) -> fitted axis ${p.axis.toFixed(1)}, max body radius ${maxR.toFixed(1)}`,
  );

  const r = generateModel(
    [{ rgba: scene.rgba, mask: scene.truth, width: scene.width, height: scene.height, azimuth: 0 }] as never,
    { ...DEFAULT_OPTIONS, studsWide: 32, solidMode: 'revolve' },
  );
  const up = upscale(r.fidelity.preview.rgba, r.fidelity.preview.width, r.fidelity.preview.height, 8);
  writeFileSync(`${out}/${scene.object}-revolve.png`, encodePng(up.rgba, up.width, up.height));
  console.log(
    `  revolve: parts=${r.totalParts} steps=${r.steps.length} IoU=${(r.fidelity.silhouetteIoU * 100).toFixed(1)}% ` +
      `dE=${r.fidelity.meanDeltaE.toFixed(1)} ${r.gridX}x${r.gridY}x${r.gridZ}`,
  );
}
