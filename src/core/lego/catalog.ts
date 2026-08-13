/**
 * The set of standard LEGO elements the generator is allowed to use, and which
 * colours each of them actually exists in.
 *
 * This file used to open by claiming that every footprint here was "available
 * from Bricklink / Pick-a-Brick in most solid colours". That was false, and the
 * generator leaned hardest on exactly the combinations where it was most false:
 * real generated output asked for `Brick 1 x 16 in Very Light Bluish Gray x3`
 * and `Brick 1 x 10 in Rust x1`. Availability is a property of the (element,
 * colour) pair, not a footnote, so it is modelled here — see `supply` below and
 * the supply note at the top of `colors.ts`.
 *
 * ## The part contract
 *
 * A `PartDef` is meant to be enough, on its own, for a renderer or an exporter
 * to draw or name the element without special cases:
 *
 *   shape    'brick' | 'plate' | 'tile' | 'slope'
 *   a, b     footprint in studs, a <= b
 *   height   height in plate units — 1 for a plate or tile, 3 for a brick or slope
 *   studs    how many studs are moulded on the top face (0 for a tile)
 *   supply   the narrowest colour tier the element is moulded in
 *   slope    present only on slopes: the family, and the wedge cut out of it
 *
 * A placement additionally carries `facing`, because a 2x1 slope pointing east
 * and one pointing west are the same element in two orientations; `w` and `d`
 * are always the footprint as laid on the grid and are never swapped to encode
 * a direction. See `SlopeFacing` and `SLOPE_ROTATION_DEG`.
 *
 * Anything that needs to know what is in each *cell* of a placed part — which
 * studs to draw, how full the cell is for a shading volume — should call
 * `partCells` rather than re-deriving it. That is the one place the wedge is
 * turned into per-cell geometry, so a renderer and an exporter cannot disagree
 * about where a slope's material is.
 *
 * The element numbers are Bricklink's, which is also LDraw's. Three tiles carry
 * a letter suffix (`3070b`, `3069b`, `3068b`) because a grooved and an ungrooved
 * mould both exist and the grooved one is the part in production; anything
 * validating an element id has to allow it.
 */

import { PLATES_PER_BRICK } from './units';
import { supplySupports, type ColorSupply, type LegoColor } from './colors';

export type PartHeight = 1 | 3;

/**
 * What the element is, geometrically.
 *
 * 'brick' and 'plate' are boxes with studs on top and differ only in height.
 * 'tile' is a box with no studs, used to finish a surface that nothing else
 * will be built on. 'slope' is a box with one top corner cut away along a
 * horizontal axis — see `SlopeGeometry`.
 */
export type PartShape = 'brick' | 'plate' | 'tile' | 'slope';

/**
 * Which way a sloped face descends, in grid axes.
 *
 * '+x' means the ramp's high end is at the part's low-x edge and it falls away
 * towards increasing x. Orientation lives here and only here: a placement's `w`
 * and `d` are always the footprint as laid on the grid, never swapped to encode
 * a direction, so a renderer or an exporter can size the box from `w` and `d`
 * and turn it with `SLOPE_ROTATION_DEG`.
 */
export type SlopeFacing = '+x' | '-x' | '+z' | '-z';

/** Rotation about +Y, in degrees, that turns the canonical '+x' part into each facing. */
export const SLOPE_ROTATION_DEG: Record<SlopeFacing, number> = {
  '+x': 0,
  '+z': 90,
  '-x': 180,
  '-z': 270,
};

/**
 * The wedge cut out of a slope, in grid units.
 *
 * `run` and `rise` are the geometry and `angle` is the label: a stud is 8mm and
 * a brick is 9.6mm, so LEGO's "45 degree" slope is really about 50, and 45 is
 * the number on the box and in Bricklink's search. Anything drawing the part
 * should measure it from `run` and `rise` and use `angle` only to tell one
 * family from another.
 *
 * `length` is the footprint along the ramp axis and is the first number in the
 * element's name: LEGO's "Slope 45 2 x 4" is two studs deep with the ramp over
 * one of them, and four studs wide. Getting that the wrong way round produces a
 * parts list whose element numbers name a different shape from the one the
 * model was built out of, which is worse than having no slopes at all.
 *
 * Taking '+x' as the example, with the placed box spanning `w` studs along X,
 * `height` plates vertically and `d` studs along Z, corner at the origin. The
 * ramp axis is X here, so `w === length` and `d` is the width:
 *
 *   - The part is full height over the first `w - run` studs of X.
 *   - Over the last `run` studs the top face falls linearly from `height` plates
 *     down to `height - rise`.
 *   - Studs sit on the flat part only — `(w - run) x d` of them.
 *   - `inverted` mirrors that vertically: the top stays flat and fully studded
 *     and it is the *underside* that rises from 0 to `rise` over the same run.
 *     That is what you put under an overhang, and it changes both which cells
 *     hold material and where the studs are.
 *
 * The other three facings are that geometry turned about +Y. Rather than
 * re-deriving any of it, call `partCells`, which returns the per-cell stud
 * flags and material extents for a part as placed.
 *
 * Every slope in this catalogue is one brick tall with `rise === height`, so its
 * ramp reaches the bottom face. The steeper families (65 and 75 degrees) are
 * two and three bricks tall and cannot be described by `PartHeight`, which is
 * why they are not here; a shallower one (18 degrees) would fit and would
 * simply arrive as another entry with a longer `run`.
 */
export interface SlopeGeometry {
  angle: number;
  /** Footprint along the ramp axis, in studs. The placed `w` or `d` must match it. */
  length: number;
  /** Studs of that length the ramp covers, at the facing end. */
  run: number;
  /** Plates the ramp descends over that run. */
  rise: number;
  inverted: boolean;
}

export interface PartDef {
  /** Stable id, e.g. "brick-2x4". */
  id: string;
  /** LDraw / Bricklink part number used by the exporter and the parts list. */
  code: string;
  name: string;
  /** Footprint in studs, always stored with a <= b. */
  a: number;
  b: number;
  /** Height in plate units: 1 for a plate or tile, 3 for a brick or slope. */
  height: PartHeight;
  shape: PartShape;
  /**
   * Studs moulded on the top face. A tile has none; a slope has them only on
   * the flat part it did not cut away.
   */
  studs: number;
  /**
   * The narrowest colour supply tier this element is moulded in. A colour may
   * be used in this element only when `supplySupports(colour.supply, part.supply)`.
   */
  supply: ColorSupply;
  /** Present on slopes only. */
  slope?: SlopeGeometry;
}

/**
 * Footprints, element numbers and how widely each is made.
 *
 * The size at which an element stops being available in anything but the
 * workhorse colours is a real boundary, not a guess about pricing: the long
 * 1x10 / 1x12 / 1x16 bricks and the big plates are low-volume mouldings that
 * only ever ran in the structural colours.
 */
const BRICK_FOOTPRINTS: Array<[number, number, string, ColorSupply]> = [
  [1, 1, '3005', 'limited'],
  [1, 2, '3004', 'limited'],
  [1, 3, '3622', 'limited'],
  [1, 4, '3010', 'limited'],
  [1, 6, '3009', 'common'],
  [1, 8, '3008', 'common'],
  [1, 10, '6111', 'core'],
  [1, 12, '6112', 'core'],
  [1, 16, '2465', 'core'],
  [2, 2, '3003', 'limited'],
  [2, 3, '3002', 'limited'],
  [2, 4, '3001', 'limited'],
  [2, 6, '2456', 'common'],
  [2, 8, '3007', 'common'],
  [2, 10, '3006', 'core'],
];

const PLATE_FOOTPRINTS: Array<[number, number, string, ColorSupply]> = [
  [1, 1, '3024', 'limited'],
  [1, 2, '3023', 'limited'],
  [1, 3, '3623', 'limited'],
  [1, 4, '3710', 'limited'],
  [1, 6, '3666', 'limited'],
  [1, 8, '3460', 'common'],
  [1, 10, '4477', 'core'],
  [1, 12, '60479', 'core'],
  [2, 2, '3022', 'limited'],
  [2, 3, '3021', 'limited'],
  [2, 4, '3020', 'limited'],
  [2, 6, '3795', 'common'],
  [2, 8, '3034', 'common'],
  [2, 10, '3832', 'core'],
  [2, 12, '2445', 'core'],
  [2, 16, '4282', 'core'],
  [4, 4, '3031', 'common'],
  [4, 6, '3032', 'common'],
  [4, 8, '3035', 'common'],
  [4, 10, '3030', 'core'],
  [4, 12, '3029', 'core'],
  [6, 6, '3958', 'common'],
  [6, 8, '3036', 'common'],
  [6, 10, '3033', 'core'],
  [6, 12, '3028', 'core'],
  [6, 16, '3027', 'core'],
  [8, 8, '41539', 'core'],
  [8, 16, '4204', 'core'],
];

/**
 * Tiles: a plate with no studs.
 *
 * These are what makes a finished surface read as a designed model rather than
 * as the top of a voxel stack, and the catalogue used to exclude them on the
 * grounds that they kept "the geometry a clean axis-aligned voxel problem".
 * They do not disturb the voxel problem at all — a tile occupies exactly the
 * same cell a plate would — they simply say "nothing is built on this".
 *
 * The 1x1, 1x2 and 2x2 tiles carry a letter in their element number because
 * both a grooved and an ungrooved mould exist. The grooved one is the part in
 * production and the one both LDraw and Bricklink mean by that number.
 */
const TILE_FOOTPRINTS: Array<[number, number, string, ColorSupply]> = [
  [1, 1, '3070b', 'limited'],
  [1, 2, '3069b', 'limited'],
  [1, 3, '63864', 'limited'],
  [1, 4, '2431', 'limited'],
  [1, 6, '6636', 'common'],
  [1, 8, '4162', 'common'],
  [2, 2, '3068b', 'limited'],
  [2, 4, '87079', 'common'],
  [2, 6, '69729', 'core'],
  [6, 6, '10202', 'core'],
];

/**
 * Slopes.
 *
 * A stepped diagonal reads as Minecraft and a sloped one reads as LEGO; this is
 * the single biggest visual difference between a voxel dump and a designed
 * model, and the catalogue used to exclude these outright.
 *
 * `[length, width, code, angle, run, inverted, supply]`, in the order the
 * element's own name uses: `length` runs along the ramp and `width` across it,
 * so the 45 degree family is two studs long in every width and the 33 degree
 * family is three. Every one of these is brick height, and the ramp reaches the
 * bottom face.
 */
const SLOPE_SPECS: Array<[number, number, string, number, number, boolean, ColorSupply]> = [
  [2, 1, '3040', 45, 1, false, 'limited'],
  [2, 2, '3039', 45, 1, false, 'limited'],
  [2, 3, '3038', 45, 1, false, 'common'],
  [2, 4, '3037', 45, 1, false, 'common'],
  [3, 1, '4286', 33, 2, false, 'common'],
  [3, 2, '3298', 33, 2, false, 'common'],
  [2, 1, '3665', 45, 1, true, 'limited'],
  [2, 2, '3660', 45, 1, true, 'limited'],
];

function build(
  list: Array<[number, number, string, ColorSupply]>,
  height: PartHeight,
  shape: 'brick' | 'plate' | 'tile',
): PartDef[] {
  const label = shape === 'brick' ? 'Brick' : shape === 'plate' ? 'Plate' : 'Tile';
  return list.map(([a, b, code, supply]) => ({
    id: `${shape}-${a}x${b}`,
    code,
    name: `${label} ${a} x ${b}`,
    a,
    b,
    height,
    shape,
    studs: shape === 'tile' ? 0 : a * b,
    supply,
  }));
}

function buildSlopes(): PartDef[] {
  return SLOPE_SPECS.map(([length, width, code, angle, run, inverted, supply]) => ({
    // Angle and inversion are both in the id because 3039 and 3660 share a
    // footprint and 3038 and 3298 differ only in how far the ramp runs.
    id: `slope${inverted ? 'inv' : ''}${angle}-${length}x${width}`,
    code,
    name: `Slope ${inverted ? 'Inverted ' : ''}${angle} ${length} x ${width}`,
    a: Math.min(length, width),
    b: Math.max(length, width),
    height: PLATES_PER_BRICK as PartHeight,
    shape: 'slope' as const,
    // The ramp eats the studs it passes under; an inverted slope keeps a full
    // flat top and cuts the underside instead.
    studs: inverted ? length * width : (length - run) * width,
    supply,
    slope: { angle, length, run, rise: PLATES_PER_BRICK, inverted },
  }));
}

export const BRICKS: PartDef[] = build(BRICK_FOOTPRINTS, PLATES_PER_BRICK as PartHeight, 'brick');
export const PLATES: PartDef[] = build(PLATE_FOOTPRINTS, 1, 'plate');
export const TILES: PartDef[] = build(TILE_FOOTPRINTS, 1, 'tile');
export const SLOPES: PartDef[] = buildSlopes();
export const ALL_PARTS: PartDef[] = [...BRICKS, ...PLATES, ...TILES, ...SLOPES];

export const PART_BY_ID: ReadonlyMap<string, PartDef> = new Map(ALL_PARTS.map((p) => [p.id, p]));

/**
 * One stud position of a placed part, with what is actually there.
 *
 * Everything that draws or reasons about a part cell-by-cell should come
 * through here rather than re-deriving the wedge from `SlopeGeometry`: the
 * renderer needs to know which cells carry a stud, and the ambient-occlusion
 * volume needs to know how full each cell is or it shades the space under a
 * slope as though the slope were a solid brick.
 */
export interface PartCell {
  /** Offset from the placement's own corner, in studs. */
  dx: number;
  dz: number;
  /** A stud is moulded on top of this cell. */
  stud: boolean;
  /**
   * Where the material is, in plates measured up from the part's bottom face.
   * `bottom` is 0 and `top` is `height` everywhere except under a slope's ramp:
   * an ordinary slope lowers `top`, an inverted one raises `bottom`.
   *
   * These are the cell's *mean* extents, which is what a voxel-resolution
   * shading volume wants. The exact wedge is a straight line across the ramp
   * and is described by `PartDef.slope`.
   */
  bottom: number;
  top: number;
  /** `(top - bottom) / height` — 1 for a solid cell, 0.5 under a 45 degree ramp. */
  fill: number;
}

/**
 * Describe a placed part cell by cell.
 *
 * `w` and `d` are the footprint as placed, never swapped; `facing` says which
 * way a slope's ramp descends and is ignored for every other shape.
 */
export function partCells(
  part: PartDef,
  w: number,
  d: number,
  facing: SlopeFacing = '+x',
): PartCell[] {
  const cells: PartCell[] = [];
  const ramp = part.shape === 'slope' ? part.slope : undefined;
  const alongX = facing === '+x' || facing === '-x';
  const ascending = facing === '+x' || facing === '+z';
  // How many studs of the ramp axis the wedge covers, clamped so a malformed
  // placement degrades to a plain box rather than producing negative material.
  const span = alongX ? w : d;
  const run = ramp ? Math.min(ramp.run, span) : 0;

  for (let dz = 0; dz < d; dz++) {
    for (let dx = 0; dx < w; dx++) {
      let bottom = 0;
      let top = part.height;
      let stud = part.shape !== 'tile';

      if (ramp && run > 0) {
        const along = alongX ? dx : dz;
        // Distance into the ramp, counting from its high end.
        const step = ascending ? along - (span - run) : run - 1 - along;
        if (step >= 0) {
          const drop = (ramp.rise * (step + 0.5)) / run;
          if (ramp.inverted) bottom = drop;
          else top = part.height - drop;
          // The ramp cuts the studs away with the material under them; an
          // inverted slope keeps its flat top and every stud on it.
          stud = ramp.inverted;
        }
      }

      cells.push({ dx, dz, stud, bottom, top, fill: (top - bottom) / part.height });
    }
  }
  return cells;
}

const byKey = new Map<string, PartDef>();
for (const p of [...BRICKS, ...PLATES]) {
  byKey.set(`${p.height}:${p.a}x${p.b}`, p);
}

/**
 * Look up the *solid* element for a footprint — the brick or the plate. `w`
 * runs along X and `d` along Z, so both orientations of an asymmetric part
 * resolve to the same element.
 *
 * Tiles share a height with plates and slopes share one with bricks, so a
 * footprint alone no longer identifies an element. Anything that starts from a
 * `Placement` should go through `PART_BY_ID.get(placement.partId)` instead;
 * this stays footprint-keyed for the callers that are choosing a shape rather
 * than describing one that has already been chosen.
 */
export function findPart(w: number, d: number, height: PartHeight): PartDef | undefined {
  const a = Math.min(w, d);
  const b = Math.max(w, d);
  return byKey.get(`${height}:${a}x${b}`);
}

const byShape = new Map<string, PartDef>();
for (const p of ALL_PARTS) {
  // Slopes are keyed on their run as well, because a 45 degree 2x3 and a 33
  // degree 3x2 are the same footprint and different elements.
  if (p.shape === 'slope') continue;
  byShape.set(`${p.shape}:${p.a}x${p.b}`, p);
}

/** Look up a brick, plate or tile by footprint. */
export function findShapePart(
  shape: 'brick' | 'plate' | 'tile',
  w: number,
  d: number,
): PartDef | undefined {
  return byShape.get(`${shape}:${Math.min(w, d)}x${Math.max(w, d)}`);
}

/** Can this element be had in this colour? See the supply note in `colors.ts`. */
export function isAvailable(part: PartDef, color: Pick<LegoColor, 'supply'>): boolean {
  return supplySupports(color.supply, part.supply);
}

export interface Footprint {
  w: number;
  d: number;
  part: PartDef;
  area: number;
}

/**
 * Every placeable (w, d) orientation for a set of elements, largest first.
 * The tiler walks this list, so ordering it by area up front means the greedy
 * pass naturally reaches for big, strong parts before falling back to 1x1s.
 */
export function footprintsFor(parts: readonly PartDef[]): Footprint[] {
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
export const TILE_FOOTPRINT_LIST = footprintsFor(TILES);

/** Baseplates the finished model can be mounted on. */
export const BASEPLATES: Array<{ studs: number; code: string; name: string }> = [
  { studs: 16, code: '3867', name: 'Baseplate 16 x 16' },
  { studs: 32, code: '3811', name: 'Baseplate 32 x 32' },
  { studs: 48, code: '4186', name: 'Baseplate 48 x 48' },
];

/**
 * What to stand the model on.
 *
 * The old version returned the smallest single plate that covered the model, or
 * nothing at all above 48 studs — so the models that most needed a base were
 * the ones told nothing about it, and the advice quietly vanished at exactly
 * the size where a model stops being liftable in one piece. LEGO's largest
 * baseplate is 48x48; beyond that a real builder tiles them, so that is what
 * this says.
 */
export interface BaseplateChoice {
  code: string;
  name: string;
  /** How many to buy. Above 48 studs the base is tiled from the largest plate. */
  count: number;
  /** Plates across each axis, so the UI can say "2 x 2 of them". */
  across: number;
  deep: number;
  studs: number;
}

export function baseplateFor(studsX: number, studsZ: number): BaseplateChoice {
  const need = Math.max(studsX, studsZ);
  const single = BASEPLATES.find((b) => b.studs >= need);
  if (single) {
    return { ...single, count: 1, across: 1, deep: 1 };
  }
  const largest = BASEPLATES[BASEPLATES.length - 1];
  const across = Math.ceil(studsX / largest.studs);
  const deep = Math.ceil(studsZ / largest.studs);
  return { ...largest, count: across * deep, across, deep };
}
