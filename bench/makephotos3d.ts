/**
 * Write true multi-angle renders of the known solids as PNGs, so the
 * multi-photo path can be driven through the real UI with real angles.
 *
 *   npx vite-node bench/makephotos3d.ts [solid ...]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderView, SOLIDS } from './shapes3d';
import { encodePng } from './png';

const out = 'bench/out/photos3d';
mkdirSync(out, { recursive: true });

const wanted = process.argv.slice(2);
const solids = wanted.length ? SOLIDS.filter((s) => wanted.includes(s.name)) : SOLIDS;

// The angles the app hands out to added views, in order.
const ANGLES = [0, 90, 180, 270];

for (const solid of solids) {
  for (const az of ANGLES) {
    const v = renderView(solid, az, 320);
    writeFileSync(`${out}/${solid.name}-${az}.png`, encodePng(v.rgba, v.width, v.height));
  }
  console.log(`${solid.name}: ${ANGLES.length} views at ${ANGLES.join(', ')} deg`);
}
