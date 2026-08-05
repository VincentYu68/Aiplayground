/**
 * The set of standard LEGO elements the generator is allowed to use.
 *
 * Deliberately conservative: every footprint here is an ordinary System brick
 * or plate that has been in continuous production for decades and is available
 * from Bricklink / Pick-a-Brick in most solid colours. No slopes, tiles,
 * brackets, SNOT parts or specialty elements — that keeps the build honest
 * (a real person can actually source the parts) and keeps the geometry a
 * clean axis-aligned voxel problem.
 */

import { PLATES_PER_BRICK } from './units';

export type PartHeight = 1 | 3;

export interface PartDef {
  /** Stable id, e.g. "brick-2x4". */
  id: string;
  /** LDraw / Bricklink part number used by the exporter and the parts list. */
  code: string;
  name: string;
  /** Footprint in studs, always stored with a <= b. */
  a: number;
  b: number;
  /** Height in plate units: 1 for a plate, 3 for a brick. */
  height: PartHeight;
}

const BRICK_FOOTPRINTS: Array<[number, number, string]> = [
  [1, 1, '3005'],
  [1, 2, '3004'],
  [1, 3, '3622'],
  [1, 4, '3010'],
  [1, 6, '3009'],
  [1, 8, '3008'],
  [1, 10, '6111'],
  [1, 12, '6112'],
  [1, 16, '2465'],
  [2, 2, '3003'],
  [2, 3, '3002'],
  [2, 4, '3001'],
  [2, 6, '2456'],
  [2, 8, '3007'],
  [2, 10, '3006'],
];

const PLATE_FOOTPRINTS: Array<[number, number, string]> = [
  [1, 1, '3024'],
  [1, 2, '3023'],
  [1, 3, '3623'],
  [1, 4, '3710'],
  [1, 6, '3666'],
  [1, 8, '3460'],
  [1, 10, '4477'],
  [1, 12, '60479'],
  [2, 2, '3022'],
  [2, 3, '3021'],
  [2, 4, '3020'],
  [2, 6, '3795'],
  [2, 8, '3034'],
  [2, 10, '3832'],
  [2, 12, '2445'],
  [2, 16, '4282'],
  [4, 4, '3031'],
  [4, 6, '3032'],
  [4, 8, '3035'],
  [4, 10, '3030'],
  [4, 12, '3029'],
  [6, 6, '3958'],
  [6, 8, '3036'],
  [6, 10, '3033'],
  [6, 12, '3028'],
  [6, 16, '3027'],
  [8, 8, '41539'],
  [8, 16, '4204'],
];

function build(list: Array<[number, number, string]>, height: PartHeight, label: string): PartDef[] {
  return list.map(([a, b, code]) => ({
    id: `${label}-${a}x${b}`,
    code,
    name: `${label === 'brick' ? 'Brick' : 'Plate'} ${a} x ${b}`,
    a,
    b,
    height,
  }));
}

export const BRICKS: PartDef[] = build(BRICK_FOOTPRINTS, PLATES_PER_BRICK as PartHeight, 'brick');
export const PLATES: PartDef[] = build(PLATE_FOOTPRINTS, 1, 'plate');
export const ALL_PARTS: PartDef[] = [...BRICKS, ...PLATES];

const byKey = new Map<string, PartDef>();
for (const p of ALL_PARTS) {
  byKey.set(`${p.height}:${p.a}x${p.b}`, p);
}

/**
 * Look up the element for a footprint. `w` runs along X and `d` along Z, so
 * both orientations of an asymmetric part resolve to the same element.
 */
export function findPart(w: number, d: number, height: PartHeight): PartDef | undefined {
  const a = Math.min(w, d);
  const b = Math.max(w, d);
  return byKey.get(`${height}:${a}x${b}`);
}

export interface Footprint {
  w: number;
  d: number;
  part: PartDef;
  area: number;
}

/**
 * Every placeable (w, d) orientation for a given height, largest first.
 * The tiler walks this list, so ordering it by area up front means the greedy
 * pass naturally reaches for big, strong parts before falling back to 1x1s.
 */
function footprintsFor(parts: PartDef[]): Footprint[] {
  const out: Footprint[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const [w, d] of [
      [part.a, part.b],
      [part.b, part.a],
    ]) {
      const key = `${w}x${d}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ w, d, part, area: w * d });
    }
  }
  out.sort((x, y) => y.area - x.area || x.w - y.w);
  return out;
}

export const BRICK_FOOTPRINT_LIST = footprintsFor(BRICKS);
export const PLATE_FOOTPRINT_LIST = footprintsFor(PLATES);

/** Baseplates the finished model can be mounted on. */
export const BASEPLATES: Array<{ studs: number; code: string; name: string }> = [
  { studs: 16, code: '3867', name: 'Baseplate 16 x 16' },
  { studs: 32, code: '3811', name: 'Baseplate 32 x 32' },
  { studs: 48, code: '4186', name: 'Baseplate 48 x 48' },
];

/** Smallest catalogued baseplate that covers a footprint, if one does. */
export function baseplateFor(studsX: number, studsZ: number) {
  const need = Math.max(studsX, studsZ);
  return BASEPLATES.find((b) => b.studs >= need);
}
