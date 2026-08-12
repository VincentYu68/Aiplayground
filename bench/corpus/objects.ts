/**
 * The photographic corpus: objects that break the pipeline in different ways.
 *
 * The point of this file is that every object is described once, in numbers,
 * and read twice — as an exact solid (`insideParts`, the ground truth) and as a
 * mesh spec the browser renders into something that looks like a photograph.
 * The old corpus in `scenes.ts` drew its objects analytically as flat vector
 * art with no perspective, no specular response and a synthetic sweep behind
 * them; it is a good segmentation unit test and a bad photograph, and every
 * number in the README was measured against it.
 *
 * Each object states, in its note, which assumption it is aimed at. An object
 * that no part of the pipeline can get wrong does not belong here.
 *
 * Sizes are fractions of the object's own height, which is 1 by construction.
 * `npx vite-node bench/corpus/check.ts` fails if that ever stops being true.
 */

import {
  circle,
  normaliseParts,
  partsBounds,
  rectangle,
  roundPolygon,
  type Material,
  type Part,
  type Vec2,
} from './parts';

/**
 * A lighting rig, stated relative to the camera.
 *
 * Relative rather than absolute because what makes a photograph hard is where
 * the light is with respect to the lens — a key light behind the camera flattens
 * an object into its own outline, and one at 70 degrees off-axis carves it into
 * light and shade that a depth network reads as shape. Both are worth shooting.
 */
export interface Lighting {
  /** Degrees clockwise from the camera's own direction. */
  keyAzimuth: number;
  keyElevation: number;
  keyIntensity: number;
  /** Kelvin-ish tint of the key, as a linear multiplier per channel. */
  keyTint: [number, number, number];
  fillIntensity: number;
  rimIntensity: number;
  ambientIntensity: number;
  /**
   * Angular size of the key, in degrees. A point source gives a hard-edged
   * shadow no real light makes; a softbox is several degrees across and its
   * penumbra widens with distance from the contact point.
   */
  keySoftness: number;
  /** Overall exposure, applied before tone mapping. */
  exposure: number;
}

export interface Background {
  /** 'sweep' is a studio cyclorama; the others put the object in a room. */
  kind: 'sweep' | 'desk' | 'shelf';
  seed: number;
  /** How many distractor objects to scatter around and behind the subject. */
  clutter: number;
  /** Base hue of the surroundings, degrees. */
  hue: number;
  /**
   * Whether one distractor is painted close to the subject's own colour. This
   * is the single most effective way to break a segmenter and it happens
   * constantly in real photographs.
   */
  camouflage: boolean;
  /** Filled in per shot: the subject's own colour, for the camouflaged one. */
  subjectColour?: [number, number, number];
}

export interface Shot {
  name: string;
  /** Degrees around the object's vertical axis; the camera's right-hand axis
   * ends up along (cos a, 0, sin a), which is the convention `visualHull.ts`
   * uses for its image horizontal. */
  azimuth: number;
  /** Degrees above the horizon. Photographs are almost never taken level. */
  elevation: number;
  /** Vertical field of view. A long lens keeps perspective mild but present. */
  fov: number;
  /** Fraction of the frame height the object fills. */
  fill: number;
  /** Where the object sits in frame, as a fraction of the half-frame. */
  offset: [number, number];
  lighting: Lighting;
  background: Background;
}

export interface CorpusObject {
  name: string;
  /** Which assumption in the pipeline this object is aimed at. */
  note: string;
  parts: Part[];
  shots: Shot[];
}

// --- lighting and background recipes ---------------------------------------

/** Three-quarter key, soft, warm: the flattering setup a product shot uses. */
const studio: Lighting = {
  keyAzimuth: -38,
  keyElevation: 42,
  keyIntensity: 4.4,
  keyTint: [1.0, 0.96, 0.9],
  fillIntensity: 0.3,
  rimIntensity: 0.55,
  ambientIntensity: 0.2,
  keySoftness: 7,
  exposure: 1.0,
};

/** Hard, low, raking side light: the one that carves shape out of a surface. */
const raking: Lighting = {
  keyAzimuth: 72,
  keyElevation: 22,
  keyIntensity: 5.0,
  keyTint: [1.0, 0.92, 0.8],
  fillIntensity: 0.14,
  rimIntensity: 0.28,
  ambientIntensity: 0.14,
  keySoftness: 2.5,
  exposure: 0.94,
};

const sweep = (seed: number, hue: number): Background => ({
  kind: 'sweep',
  seed,
  clutter: 0,
  hue,
  camouflage: false,
});

const desk = (seed: number, hue: number): Background => ({
  kind: 'desk',
  seed,
  clutter: 7,
  hue,
  camouflage: true,
});

/**
 * The two shots every object gets.
 *
 * `hero` is the photograph someone would actually take and is what the shape
 * metrics score. `clutter` is the same object turned further, lit harder and
 * put on a messy desk — if a change only helps on `hero` it has probably been
 * tuned to the benchmark.
 */
function shots(azimuth: number, elevation: number, hue: number, seed: number): Shot[] {
  return [
    {
      name: 'hero',
      azimuth,
      elevation,
      fov: 30,
      fill: 0.78,
      offset: [0, 0],
      lighting: studio,
      background: sweep(seed, hue),
    },
    {
      name: 'clutter',
      azimuth: azimuth + 52,
      elevation: elevation + 9,
      fov: 38,
      fill: 0.66,
      offset: [-0.1, 0.04],
      lighting: raking,
      background: desk(seed + 977, (hue + 150) % 360),
    },
  ];
}

// --- materials -------------------------------------------------------------

const paint = (colour: [number, number, number]): Material => ({
  colour,
  roughness: 0.22,
  metalness: 0.05,
  clearcoat: 0.9,
});

const glass = (colour: [number, number, number]): Material => ({
  colour,
  roughness: 0.08,
  metalness: 0.2,
  clearcoat: 1,
});

const rubber = (colour: [number, number, number]): Material => ({
  colour,
  roughness: 0.85,
  metalness: 0,
});

const chrome: Material = { colour: [196, 198, 204], roughness: 0.18, metalness: 0.95 };

// --- the objects -----------------------------------------------------------

/**
 * A car, seen from the side.
 *
 * The reference failure. Photographed side-on the widest thing in frame is the
 * car's *length*, so a pipeline that sets its depth from the silhouette's width
 * extrudes a 2.3-long, 0.8-wide car into a cube. Its true depth is 0.34 of its
 * length; anything near 1.0 is the loaf.
 */
function car(): CorpusObject {
  const bodyProfile: Vec2[] = roundPolygon(
    [
      [-1.12, 0.18],
      [1.12, 0.18],
      [1.16, 0.36],
      [1.12, 0.58],
      [-1.12, 0.58],
      [-1.16, 0.34],
    ],
    0.05,
  );
  const cabinProfile: Vec2[] = roundPolygon(
    [
      [-0.52, 0.55],
      [0.72, 0.55],
      [0.6, 0.7],
      [0.44, 1.0],
      [-0.16, 0.98],
    ],
    0.045,
  );
  const roofProfile: Vec2[] = roundPolygon(
    [
      [-0.14, 0.9],
      [0.42, 0.9],
      [0.44, 1.0],
      [-0.16, 0.98],
    ],
    0.03,
  );

  const parts: Part[] = [
    { mesh: { kind: 'prism', outline: bodyProfile, holes: [], depth: 0.8, pos: [0, 0, 0] }, material: paint([182, 38, 44]) },
    { mesh: { kind: 'prism', outline: cabinProfile, holes: [], depth: 0.7, pos: [0, 0, 0] }, material: glass([38, 52, 62]) },
    { mesh: { kind: 'prism', outline: roofProfile, holes: [], depth: 0.7, pos: [0, 0, 0] }, material: paint([182, 38, 44]) },
  ];
  // Wheels stand proud of the flanks, which is what stops the silhouette from
  // being a plain slab and gives the shadow something to sit on.
  for (const wx of [-0.62, 0.66]) {
    for (const side of [-1, 1]) {
      parts.push({
        mesh: { kind: 'cylinder', a: [wx, 0.2, side * 0.34], b: [wx, 0.2, side * 0.44], r: 0.2 },
        material: rubber([26, 26, 30]),
      });
      parts.push({
        mesh: { kind: 'cylinder', a: [wx, 0.2, side * 0.42], b: [wx, 0.2, side * 0.455], r: 0.095 },
        material: chrome,
      });
    }
  }
  return {
    name: 'car',
    note: 'elongated, photographed side-on: depth-from-width turns it into a cube',
    parts,
    shots: shots(12, 11, 24, 1301),
  };
}

/**
 * A mug: turned on a lathe, hollow, with a handle that stands clear.
 *
 * The bore is invisible from every angle, so no silhouette method can find it;
 * the handle is a thin part with a real hole behind it, which is the first
 * thing a bulge-shaped depth prior swallows.
 */
function mug(): CorpusObject {
  const profile: Vec2[] = [
    [0, 0],
    [0.3, 0],
    [0.325, 0.05],
    [0.335, 0.9],
    [0.34, 1.0],
    [0.3, 1.0],
    [0.295, 0.9],
    [0.285, 0.12],
    [0, 0.1],
  ];
  const ceramic: Material = { colour: [222, 226, 230], roughness: 0.14, metalness: 0.02, clearcoat: 0.9 };
  return {
    name: 'mug',
    note: 'lathe-turned and hollow, with a thin handle and a hole behind it',
    parts: [
      { mesh: { kind: 'lathe', profile, pos: [0, 0, 0] }, material: ceramic },
      {
        mesh: {
          kind: 'torus',
          pos: [0.42, 0.55, 0],
          ring: 0.2,
          tube: 0.045,
          axis: 'z',
          arcFrom: (-140 * Math.PI) / 180,
          arcSweep: (280 * Math.PI) / 180,
        },
        material: ceramic,
      },
      // A glazed band, standing a few thousandths proud: colour to get wrong,
      // and a specular break across an otherwise featureless revolve.
      {
        mesh: {
          kind: 'lathe',
          profile: [
            [0.336, 0.42],
            [0.346, 0.44],
            [0.346, 0.66],
            [0.336, 0.68],
          ],
          pos: [0, 0, 0],
        },
        material: { colour: [30, 86, 158], roughness: 0.12, metalness: 0.02, clearcoat: 0.9 },
      },
    ],
    shots: shots(28, 14, 205, 2207),
  };
}

/** A hardback standing on its bottom edge: 0.19 as deep as it is wide. */
function book(): CorpusObject {
  const cover = rectangle(0, 0.5, 0.34, 0.5, 0.018);
  const pages = rectangle(-0.006, 0.505, 0.325, 0.484, 0.006);
  const cloth: Material = { colour: [122, 34, 40], roughness: 0.62, metalness: 0.02 };
  return {
    name: 'book',
    note: 'flat: true depth is a fifth of its width, and depth-from-width is five times over',
    parts: [
      { mesh: { kind: 'prism', outline: cover, holes: [], depth: 0.012, pos: [0, 0, -0.059] }, material: cloth },
      { mesh: { kind: 'prism', outline: cover, holes: [], depth: 0.012, pos: [0, 0, 0.059] }, material: cloth },
      {
        mesh: { kind: 'prism', outline: pages, holes: [], depth: 0.106, pos: [0, 0, 0] },
        material: { colour: [232, 226, 208], roughness: 0.88, metalness: 0 },
      },
      { mesh: { kind: 'cylinder', a: [-0.335, 0, 0], b: [-0.335, 1.0, 0], r: 0.065 }, material: cloth },
    ],
    shots: shots(18, 12, 96, 3313),
  };
}

/** A chair: mostly air, with legs a fortieth of the object's height thick. */
function chair(): CorpusObject {
  const wood: Material = { colour: [148, 104, 62], roughness: 0.5, metalness: 0.02, clearcoat: 0.25 };
  const parts: Part[] = [
    {
      mesh: { kind: 'prism', outline: rectangle(0, 0, 0.24, 0.028, 0.012), holes: [], depth: 0.44, pos: [0, 0.485, 0] },
      material: wood,
    },
  ];
  for (const lx of [-0.2, 0.2]) {
    for (const lz of [-0.18, 0.18]) {
      parts.push({
        mesh: { kind: 'cylinder', a: [lx, 0, lz], b: [lx, 0.49, lz], r: 0.024 },
        material: wood,
      });
    }
  }
  for (const ux of [-0.2, 0.2]) {
    parts.push({
      mesh: { kind: 'box', half: [0.026, 0.26, 0.022], pos: [ux, 0.75, 0.185] },
      material: wood,
    });
  }
  parts.push({ mesh: { kind: 'box', half: [0.225, 0.055, 0.024], pos: [0, 0.945, 0.185] }, material: wood });
  parts.push({ mesh: { kind: 'box', half: [0.225, 0.04, 0.019], pos: [0, 0.7, 0.185] }, material: wood });
  return {
    name: 'chair',
    note: 'thin parts and real gaps: a bulge fills the space between the legs',
    parts,
    shots: shots(40, 13, 40, 4231),
  };
}

/** A teddy: soft, lumpy, no straight edges for a depth prior to lock onto. */
function teddy(): CorpusObject {
  const fur: Material = { colour: [196, 152, 104], roughness: 0.95, metalness: 0, sheen: 0.7 };
  const parts: Part[] = [
    { mesh: { kind: 'ellipsoid', radii: [0.23, 0.22, 0.19], pos: [0, 0.48, 0] }, material: fur },
    { mesh: { kind: 'ellipsoid', radii: [0.175, 0.175, 0.17], pos: [0, 0.8, 0.01] }, material: fur },
    { mesh: { kind: 'ellipsoid', radii: [0.072, 0.072, 0.06], pos: [-0.14, 0.928, 0] }, material: fur },
    { mesh: { kind: 'ellipsoid', radii: [0.072, 0.072, 0.06], pos: [0.14, 0.928, 0] }, material: fur },
    {
      mesh: { kind: 'ellipsoid', radii: [0.085, 0.065, 0.07], pos: [0, 0.765, 0.155] },
      material: { colour: [226, 206, 176], roughness: 0.9, metalness: 0, sheen: 0.5 },
    },
    {
      mesh: { kind: 'ellipsoid', radii: [0.03, 0.024, 0.028], pos: [0, 0.79, 0.212] },
      material: { colour: [26, 22, 22], roughness: 0.35, metalness: 0.05, clearcoat: 0.6 },
    },
  ];
  for (const side of [-1, 1]) {
    parts.push({
      mesh: { kind: 'capsule', a: [side * 0.21, 0.58, 0], b: [side * 0.29, 0.36, 0.05], r: 0.072 },
      material: fur,
    });
    parts.push({
      mesh: { kind: 'capsule', a: [side * 0.13, 0.28, 0.01], b: [side * 0.13, 0.1, 0.01], r: 0.085 },
      material: fur,
    });
    parts.push({
      mesh: { kind: 'ellipsoid', radii: [0.09, 0.06, 0.11], pos: [side * 0.13, 0.06, 0.035] },
      material: fur,
    });
  }
  return {
    name: 'teddy',
    note: 'soft and lumpy: nothing here is a box, a cylinder or a revolve',
    parts,
    shots: shots(15, 12, 320, 5417),
  };
}

/**
 * A picture frame: a genuine hole, and 0.06 as deep as it is wide.
 *
 * The cruellest case for silhouette IoU. A single-view extrusion reproduces the
 * hole perfectly in the front view and scores near-perfectly there, while being
 * sixteen times too deep — which is exactly the gap the front-view number
 * cannot see and the multi-view number cannot miss.
 */
function frame(): CorpusObject {
  const outer = rectangle(0, 0.5, 0.38, 0.5, 0.02);
  const inner = rectangle(0, 0.53, 0.29, 0.4, 0.012);
  const gilt: Material = { colour: [206, 168, 82], roughness: 0.28, metalness: 0.9 };
  return {
    name: 'frame',
    note: 'a real hole through a very thin object: front-view IoU cannot fail here',
    parts: [
      {
        mesh: { kind: 'prism', outline: outer, holes: [inner], depth: 0.045, pos: [0, 0, 0] },
        material: gilt,
      },
    ],
    shots: shots(14, 12, 260, 6151),
  };
}

/** A bottle: tall enough that the buildable-height cap has to intervene. */
function bottle(): CorpusObject {
  const profile: Vec2[] = [
    [0, 0],
    [0.155, 0],
    [0.16, 0.03],
    [0.16, 0.55],
    [0.152, 0.61],
    [0.1, 0.69],
    [0.062, 0.76],
    [0.062, 0.9],
    [0, 0.9],
  ];
  return {
    name: 'bottle',
    note: 'three times as tall as it is wide: the height cap and the aspect prior both bite',
    parts: [
      {
        mesh: { kind: 'lathe', profile, pos: [0, 0, 0] },
        material: { colour: [58, 128, 92], roughness: 0.22, metalness: 0.05, clearcoat: 0.9 },
      },
      {
        mesh: {
          kind: 'lathe',
          profile: [
            [0, 0.885],
            [0.082, 0.885],
            [0.082, 1.0],
            [0, 1.0],
          ],
          pos: [0, 0, 0],
        },
        material: { colour: [220, 214, 206], roughness: 0.4, metalness: 0.05 },
      },
      {
        mesh: {
          kind: 'lathe',
          profile: [
            [0.158, 0.18],
            [0.167, 0.2],
            [0.167, 0.46],
            [0.158, 0.48],
          ],
          pos: [0, 0, 0],
        },
        material: { colour: [232, 226, 214], roughness: 0.75, metalness: 0 },
      },
    ],
    shots: shots(20, 10, 140, 7477),
  };
}

/** A gear: a hole through it and teeth a segmenter has to keep. */
function gear(): CorpusObject {
  const teeth = 14;
  const outline: Vec2[] = [];
  const rRoot = 0.4;
  const rTip = 0.48;
  for (let i = 0; i < teeth; i++) {
    const base = (i / teeth) * Math.PI * 2;
    const step = (Math.PI * 2) / teeth;
    for (const [t, r] of [
      [0.02, rRoot],
      [0.16, rTip],
      [0.34, rTip],
      [0.48, rRoot],
    ] as Array<[number, number]>) {
      const a = base + step * t;
      outline.push([Math.cos(a) * r, 0.5 + Math.sin(a) * r]);
    }
  }
  return {
    name: 'gear',
    note: 'a bore straight through, plus teeth small enough to be smoothed away',
    parts: [
      {
        mesh: {
          kind: 'prism',
          outline,
          holes: [circle(0, 0.5, 0.13, 24)],
          depth: 0.14,
          pos: [0, 0, 0],
        },
        material: { colour: [148, 152, 160], roughness: 0.35, metalness: 0.88 },
      },
    ],
    shots: shots(16, 13, 200, 8543),
  };
}

export const CORPUS: CorpusObject[] = [
  car(),
  mug(),
  book(),
  chair(),
  teddy(),
  frame(),
  bottle(),
  gear(),
].map((object) => ({ ...object, parts: normaliseParts(object.parts) }));

export function objectByName(name: string): CorpusObject {
  const found = CORPUS.find((o) => o.name === name);
  if (!found) throw new Error(`no corpus object called ${name}`);
  return found;
}

/**
 * What the browser needs to render one photograph.
 *
 * The whole spec is JSON: the geometry is authored here, in TypeScript, where
 * the ground truth is derived from the same numbers, and the page only ever
 * turns numbers into meshes. Nothing about the shape is decided in the browser.
 */
export interface ShotSpec {
  object: string;
  shot: string;
  width: number;
  height: number;
  pass: 'beauty' | 'mask' | 'clay';
  parts: Part[];
  camera: {
    azimuth: number;
    elevation: number;
    fov: number;
    fill: number;
    offset: [number, number];
  };
  lighting: Lighting;
  background: Background;
  bounds: { min: number[]; max: number[] };
  /** Set for the clay reference renders, which orbit an already-framed shot. */
  view?: 'iso' | 'front' | 'side' | 'top';
  /**
   * An orthographic window in object units, shared with the node side.
   *
   * Set only by the consistency check, which rasterises the same window from
   * the inside-test. If those two pictures disagree, the mesh and the ground
   * truth are not the same solid and nothing measured against either means
   * anything — so it is worth being able to prove they agree.
   */
  ortho?: { halfWidth: number; yLow: number; yHigh: number };
}

export function shotSpec(
  object: CorpusObject,
  shot: Shot,
  pass: ShotSpec['pass'],
  size = 512,
): ShotSpec {
  const b = partsBounds(object.parts);
  return {
    object: object.name,
    shot: shot.name,
    width: size,
    height: size,
    pass,
    parts: object.parts,
    camera: {
      azimuth: shot.azimuth,
      elevation: shot.elevation,
      fov: shot.fov,
      fill: shot.fill,
      offset: shot.offset,
    },
    lighting: shot.lighting,
    background: { ...shot.background, subjectColour: object.parts[0].material.colour },
    bounds: { min: b.min, max: b.max },
  };
}
