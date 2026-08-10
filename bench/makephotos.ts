/**
 * Write a handful of benchmark scenes out as PNGs, so the browser end-to-end
 * check has real image files to drop into the app.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildCorpus } from './scenes';
import { encodePng } from './png';

const out = 'bench/out/photos';
mkdirSync(out, { recursive: true });

const corpus = buildCorpus();
const seen = new Set<string>();
let n = 0;
for (const scene of corpus) {
  if (seen.has(scene.object)) continue;
  seen.add(scene.object);
  const png = encodePng(scene.rgba, scene.width, scene.height);
  const file = `${out}/${scene.object}.png`;
  writeFileSync(file, png);
  console.log(`${file}  ${scene.width}x${scene.height}  bg=${scene.background}`);
  n++;
}
console.log(`${n} photos written`);
