/**
 * The segmentation benchmark corpus.
 *
 * Every scene is a known object composited over a generated background, so the
 * ground-truth mask is exact rather than hand-drawn — which means a method can
 * be scored to the pixel instead of judged by eye.
 *
 * The objects are drawn analytically and sampled 3x3 per pixel, so edges carry
 * real antialiasing and the truth mask is the >=50% coverage set. They are
 * deliberately awkward in the ways real photographed objects are: shading that
 * moves the colour across the body, specular highlights that are nothing like
 * the object's own colour, thin structures a few pixels wide, and genuine
 * holes (a mug handle, a gear centre) that are background, not object.
 *
 * The backgrounds are the point of the exercise. A method that only ever sees
 * a white studio sweep looks perfect; the same method on a wood table, on
 * clutter, or against a wall painted the object's own colour can fall apart.
 * Shadows are cast into the background and are deliberately NOT part of the
 * truth mask, because "dark pixels next to the object" is the single most
 * common way a segmenter is fooled.
 */

import { mulberry32 } from '../src/core/image/raster';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Scene {
  name: string;
  object: string;
  background: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** Exact ground truth: 1 where the object covers at least half the pixel. */
  truth: Uint8Array;
  /** A box a user would plausibly drag around the object (loose, not tight). */
  box: { x0: number; y0: number; x1: number; y1: number };
}

interface Sample {
  hit: boolean;
  r: number;
  g: number;
  b: number;
}

const MISS: Sample = { hit: false, r: 0, g: 0, b: 0 };

/** Object drawn in normalised coordinates; u,v both run 0..1 over the frame. */
type ObjectFn = (u: number, v: number) => Sample;

// ---------------------------------------------------------------------------
// drawing helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function inRect(u: number, v: number, x0: number, y0: number, x1: number, y1: number): boolean {
  return u >= x0 && u <= x1 && v >= y0 && v <= y1;
}

function inRoundedRect(
  u: number,
  v: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): boolean {
  if (!inRect(u, v, x0, y0, x1, y1)) return false;
  const cx = Math.min(Math.max(u, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(v, y0 + radius), y1 - radius);
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function inCircle(u: number, v: number, cx: number, cy: number, r: number): boolean {
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

function inEllipse(u: number, v: number, cx: number, cy: number, rx: number, ry: number): boolean {
  const dx = (u - cx) / rx;
  const dy = (v - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

/** Distance from a point to a line segment, for drawing stems and legs. */
function distToSegment(u: number, v: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp01(((u - ax) * dx + (v - ay) * dy) / len2);
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.hypot(u - px, v - py);
}

function shade(base: Rgb, factor: number): Sample {
  return {
    hit: true,
    r: clamp01(factor) * base.r,
    g: clamp01(factor) * base.g,
    b: clamp01(factor) * base.b,
  };
}

/** Cylindrical shading across a body spanning x0..x1 — bright band, dark edges. */
function cylinder(u: number, x0: number, x1: number): number {
  const t = (u - x0) / Math.max(1e-6, x1 - x0); // 0..1 across the body
  const n = Math.cos((t - 0.38) * Math.PI); // brightest a little left of centre
  return 0.58 + 0.52 * Math.max(0, n);
}

/** Spherical shading with the light up and to the left. */
function sphere(u: number, v: number, cx: number, cy: number, r: number): number {
  const dx = (u - cx) / r;
  const dy = (v - cy) / r;
  const d2 = dx * dx + dy * dy;
  const nz = Math.sqrt(Math.max(0, 1 - d2));
  const lambert = clamp01(-dx * 0.5 - dy * 0.6 + nz * 0.75);
  return 0.55 + 0.7 * lambert;
}

// ---------------------------------------------------------------------------
// objects
// ---------------------------------------------------------------------------

/** A mug: cylindrical shading, a coloured band, and a handle with a real hole. */
const mug: ObjectFn = (u, v) => {
  const bodyX0 = 0.28;
  const bodyX1 = 0.68;
  // Handle first so the gap between handle and body stays open.
  const hx = 0.70;
  const hy = 0.55;
  const d = Math.hypot(u - hx, (v - hy) * 1.15);
  if (u > 0.655 && d <= 0.145 && d >= 0.082) {
    return shade({ r: 232, g: 236, b: 240 }, 0.75 + 0.5 * (1 - d / 0.145));
  }
  if (inRoundedRect(u, v, bodyX0, 0.30, bodyX1, 0.82, 0.05)) {
    const f = cylinder(u, bodyX0, bodyX1);
    // A painted band, so the object is not one flat colour.
    if (v > 0.46 && v < 0.60) return shade({ r: 44, g: 96, b: 168 }, f);
    return shade({ r: 232, g: 236, b: 240 }, f);
  }
  // The rim, seen slightly from above.
  if (inEllipse(u, v, 0.48, 0.305, 0.20, 0.035)) {
    return shade({ r: 186, g: 190, b: 196 }, 0.95);
  }
  return MISS;
};

/** A bottle: tapered, with a specular stripe that is nowhere near its own hue. */
const bottle: ObjectFn = (u, v) => {
  const glass: Rgb = { r: 42, g: 116, b: 64 };
  let x0 = 0;
  let x1 = 0;
  if (v >= 0.36 && v <= 0.88) {
    x0 = 0.36;
    x1 = 0.64;
  } else if (v >= 0.26 && v < 0.36) {
    const t = (v - 0.26) / 0.1; // shoulder taper
    x0 = 0.455 - 0.095 * t;
    x1 = 0.545 + 0.095 * t;
  } else if (v >= 0.14 && v < 0.26) {
    x0 = 0.455;
    x1 = 0.545;
  } else if (v >= 0.09 && v < 0.14) {
    if (inRect(u, v, 0.445, 0.09, 0.555, 0.14)) return shade({ r: 190, g: 172, b: 60 }, 1);
    return MISS;
  } else {
    return MISS;
  }
  if (!inRoundedRect(u, v, x0, Math.min(v, 0.09), x1, 0.88, 0.02) && !inRect(u, v, x0, 0.09, x1, 0.88)) {
    return MISS;
  }
  const f = cylinder(u, x0, x1);
  // Specular highlight: near-white on a dark green bottle.
  const spec = Math.exp(-(((u - (x0 + (x1 - x0) * 0.28)) / 0.022) ** 2));
  const s = shade(glass, f);
  return {
    hit: true,
    r: s.r + spec * 170,
    g: s.g + spec * 170,
    b: s.b + spec * 160,
  };
};

/** A toy car: several distinct colour populations in one object. */
const car: ObjectFn = (u, v) => {
  if (inCircle(u, v, 0.30, 0.735, 0.085)) {
    return inCircle(u, v, 0.30, 0.735, 0.036)
      ? shade({ r: 190, g: 194, b: 200 }, 1)
      : shade({ r: 34, g: 34, b: 38 }, 1);
  }
  if (inCircle(u, v, 0.72, 0.735, 0.085)) {
    return inCircle(u, v, 0.72, 0.735, 0.036)
      ? shade({ r: 190, g: 194, b: 200 }, 1)
      : shade({ r: 34, g: 34, b: 38 }, 1);
  }
  // Cabin: a trapezoid sitting on the body.
  if (v >= 0.30 && v < 0.50) {
    const t = (v - 0.30) / 0.20;
    const x0 = 0.40 - 0.10 * t;
    const x1 = 0.66 + 0.06 * t;
    if (u >= x0 && u <= x1) {
      const inset = u > x0 + 0.02 && u < x1 - 0.02 && v > 0.335 && v < 0.47;
      if (inset) return shade({ r: 150, g: 196, b: 220 }, 0.85 + 0.3 * (1 - t));
      return shade({ r: 196, g: 40, b: 44 }, cylinder(u, 0.30, 0.72));
    }
  }
  if (inRoundedRect(u, v, 0.12, 0.49, 0.88, 0.72, 0.055)) {
    const f = 0.7 + 0.55 * Math.exp(-(((v - 0.545) / 0.06) ** 2));
    return shade({ r: 196, g: 40, b: 44 }, f);
  }
  return MISS;
};

/** A potted plant: thin stems only a couple of pixels wide. */
const plant: ObjectFn = (u, v) => {
  // Pot.
  if (v >= 0.66 && v <= 0.90) {
    const t = (v - 0.66) / 0.24;
    const x0 = 0.36 + 0.045 * t;
    const x1 = 0.64 - 0.045 * t;
    if (u >= x0 && u <= x1) {
      const f = cylinder(u, x0, x1);
      if (v < 0.70) return shade({ r: 152, g: 84, b: 58 }, f * 1.08);
      return shade({ r: 176, g: 96, b: 66 }, f);
    }
  }
  const stems: Array<[number, number, number, number]> = [
    [0.50, 0.68, 0.30, 0.30],
    [0.50, 0.68, 0.70, 0.26],
    [0.50, 0.68, 0.44, 0.14],
    [0.50, 0.68, 0.60, 0.40],
    [0.50, 0.68, 0.36, 0.52],
  ];
  for (let i = 0; i < stems.length; i++) {
    const [ax, ay, bx, by] = stems[i];
    // Bowed rather than straight, so the stem is not axis-aligned anywhere.
    const mx = (ax + bx) / 2 + (i % 2 === 0 ? -0.05 : 0.05);
    const my = (ay + by) / 2;
    if (
      distToSegment(u, v, ax, ay, mx, my) < 0.006 ||
      distToSegment(u, v, mx, my, bx, by) < 0.006
    ) {
      return shade({ r: 62, g: 118, b: 54 }, 1);
    }
    // A leaf at the tip, angled off the stem.
    const lx = bx + (i % 2 === 0 ? -0.035 : 0.035);
    if (inEllipse(u, v, lx, by - 0.01, 0.055, 0.028)) {
      return shade({ r: 74, g: 140, b: 62 }, 0.85 + 0.3 * (i / stems.length));
    }
  }
  return MISS;
};

/** A chair: thin legs, and large gaps that are background, not holes to fill. */
const chair: ObjectFn = (u, v) => {
  const wood: Rgb = { r: 158, g: 112, b: 66 };
  // Back uprights and slats.
  if (v >= 0.10 && v <= 0.52) {
    if (Math.abs(u - 0.31) < 0.022 || Math.abs(u - 0.69) < 0.022) return shade(wood, 0.9);
    // Three horizontal slats with gaps between them.
    for (const sv of [0.15, 0.26, 0.37]) {
      if (Math.abs(v - sv) < 0.028 && u > 0.31 && u < 0.69) return shade(wood, 1.05);
    }
  }
  if (inRoundedRect(u, v, 0.24, 0.52, 0.76, 0.585, 0.012)) return shade(wood, 1.15);
  // Legs: thin, and splayed so none of them is vertical.
  const legs: Array<[number, number]> = [
    [0.28, 0.24],
    [0.72, 0.76],
    [0.34, 0.30],
    [0.66, 0.70],
  ];
  for (let i = 0; i < legs.length; i++) {
    const [topX, botX] = legs[i];
    if (distToSegment(u, v, topX, 0.585, botX, 0.93) < 0.014) {
      return shade(wood, i < 2 ? 0.82 : 0.68);
    }
  }
  return MISS;
};

/** A soft toy: rounded, low contrast internally, spherical shading. */
const teddy: ObjectFn = (u, v) => {
  const fur: Rgb = { r: 168, g: 126, b: 82 };
  const parts: Array<[number, number, number]> = [
    [0.38, 0.185, 0.072],
    [0.62, 0.185, 0.072],
    [0.50, 0.285, 0.150],
    [0.50, 0.590, 0.215],
    [0.255, 0.520, 0.090],
    [0.745, 0.520, 0.090],
    [0.375, 0.830, 0.098],
    [0.625, 0.830, 0.098],
  ];
  // Muzzle and eyes, so the object has internal structure.
  if (inEllipse(u, v, 0.50, 0.335, 0.070, 0.052)) return shade({ r: 216, g: 190, b: 156 }, 1);
  if (inCircle(u, v, 0.455, 0.265, 0.017) || inCircle(u, v, 0.545, 0.265, 0.017)) {
    return shade({ r: 28, g: 24, b: 22 }, 1);
  }
  for (const [cx, cy, r] of parts) {
    if (inCircle(u, v, cx, cy, r)) return shade(fur, sphere(u, v, cx, cy, r));
  }
  return MISS;
};

/** A book, rotated: long straight edges at an angle to the pixel grid. */
const book: ObjectFn = (u, v) => {
  const a = (13 * Math.PI) / 180;
  const cx = 0.5;
  const cy = 0.5;
  const ru = (u - cx) * Math.cos(a) + (v - cy) * Math.sin(a);
  const rv = -(u - cx) * Math.sin(a) + (v - cy) * Math.cos(a);
  if (Math.abs(ru) > 0.24 || Math.abs(rv) > 0.33) return MISS;
  // Page block along one long edge.
  if (ru > 0.185) return shade({ r: 236, g: 231, b: 214 }, 0.92 + 0.1 * Math.sin(rv * 160));
  if (ru < -0.205) return shade({ r: 96, g: 30, b: 44 }, 0.8);
  const f = 0.86 + 0.22 * Math.exp(-(((ru + 0.05) / 0.12) ** 2));
  if (Math.abs(rv) < 0.16 && Math.abs(ru + 0.02) < 0.10) {
    return shade({ r: 214, g: 186, b: 120 }, f); // title panel
  }
  return shade({ r: 122, g: 40, b: 56 }, f);
};

/** A gear: many concavities and a hole through the middle. */
const gear: ObjectFn = (u, v) => {
  const cx = 0.5;
  const cy = 0.5;
  const dx = u - cx;
  const dy = v - cy;
  const d = Math.hypot(dx, dy);
  if (d <= 0.105) return MISS; // the bore is background, not object
  const theta = Math.atan2(dy, dx);
  const teeth = 11;
  const wave = Math.cos(theta * teeth);
  const radius = 0.30 + 0.055 * (wave > 0.25 ? 1 : wave < -0.25 ? 0 : (wave + 0.25) / 0.5);
  if (d > radius) return MISS;
  const f = 0.62 + 0.5 * clamp01(0.5 - dx * 0.8 - dy * 1.1);
  if (d < 0.155) return shade({ r: 120, g: 124, b: 132 }, f * 0.9);
  return shade({ r: 158, g: 162, b: 170 }, f);
};

const OBJECTS: Array<{ name: string; fn: ObjectFn }> = [
  { name: 'mug', fn: mug },
  { name: 'bottle', fn: bottle },
  { name: 'car', fn: car },
  { name: 'plant', fn: plant },
  { name: 'chair', fn: chair },
  { name: 'teddy', fn: teddy },
  { name: 'book', fn: book },
  { name: 'gear', fn: gear },
];

// ---------------------------------------------------------------------------
// backgrounds
// ---------------------------------------------------------------------------

/**
 * @param mean the object's average colour, so a background can be built to
 *   deliberately match it — the case that defeats colour-model methods.
 */
type BackgroundFn = (
  u: number,
  v: number,
  mean: Rgb,
  rand: (x: number, y: number) => number,
) => Rgb;

/** Value noise: smooth, repeatable, and cheap. */
function makeNoise(seed: number) {
  const rng = mulberry32(seed);
  const table = new Float32Array(4096);
  for (let i = 0; i < table.length; i++) table[i] = rng();
  const at = (x: number, y: number) => table[(((x * 73856093) ^ (y * 19349663)) >>> 0) % 4096];
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };
}

const BACKGROUNDS: Array<{ name: string; fn: BackgroundFn }> = [
  {
    name: 'studio-white',
    fn: (_u, v) => {
      const g = 246 - 26 * clamp01(v - 0.35);
      return { r: g, g: g, b: g + 2 };
    },
  },
  {
    name: 'flat-grey',
    fn: () => ({ r: 128, g: 129, b: 131 }),
  },
  {
    // The hard one: a wall painted almost exactly the object's own colour.
    name: 'camouflage',
    fn: (u, v, mean, rand) => {
      const n = rand(u * 9, v * 9) - 0.5;
      return { r: mean.r + n * 10, g: mean.g + n * 10, b: mean.b + n * 10 };
    },
  },
  {
    name: 'gradient',
    fn: (_u, v) => ({ r: 70 + 150 * v, g: 110 + 120 * v, b: 190 - 40 * v }),
  },
  {
    name: 'wood-table',
    fn: (u, v, _mean, rand) => {
      const grain = rand(u * 3, v * 34) * 0.55 + rand(u * 11, v * 90) * 0.45;
      const plank = Math.sin(v * 26) > 0.93 ? 0.72 : 1;
      const t = (0.72 + 0.5 * grain) * plank;
      return { r: 176 * t, g: 128 * t, b: 78 * t };
    },
  },
  {
    name: 'checker-tiles',
    fn: (u, v) => {
      const c = (Math.floor(u * 9) + Math.floor(v * 9)) % 2 === 0;
      return c ? { r: 224, g: 220, b: 210 } : { r: 92, g: 96, b: 104 };
    },
  },
  {
    // Other objects in frame, including some touching the border.
    name: 'clutter',
    fn: (u, v, _mean, rand) => {
      let base = { r: 198, g: 196, b: 190 };
      const blobs: Array<[number, number, number, Rgb]> = [
        [0.08, 0.20, 0.16, { r: 210, g: 72, b: 60 }],
        [0.92, 0.34, 0.14, { r: 60, g: 140, b: 190 }],
        [0.14, 0.86, 0.18, { r: 240, g: 196, b: 70 }],
        [0.86, 0.90, 0.15, { r: 96, g: 176, b: 96 }],
        [0.50, 0.03, 0.12, { r: 150, g: 90, b: 190 }],
      ];
      for (const [cx, cy, r, col] of blobs) {
        if (Math.hypot(u - cx, v - cy) < r) base = col;
      }
      const n = rand(u * 20, v * 20) * 0.1 + 0.95;
      return { r: base.r * n, g: base.g * n, b: base.b * n };
    },
  },
  {
    name: 'bokeh',
    fn: (u, v, _mean, rand) => {
      const a = rand(u * 2.5, v * 2.5);
      const b = rand(u * 5 + 40, v * 5 + 40);
      return { r: 60 + 150 * a, g: 80 + 120 * b, b: 70 + 140 * (1 - a) };
    },
  },
  {
    name: 'noisy-carpet',
    fn: (u, v, _mean, rand) => {
      const n = rand(u * 120, v * 120);
      const m = rand(u * 40, v * 40);
      const t = 0.55 + 0.5 * n * m;
      return { r: 120 * t, g: 106 * t, b: 96 * t };
    },
  },
  {
    // Low light: everything compressed into a narrow, dark range.
    name: 'dim-lowcontrast',
    fn: (u, v, _mean, rand) => {
      const n = rand(u * 7, v * 7);
      const t = 0.30 + 0.10 * n + 0.05 * v;
      return { r: 255 * t, g: 252 * t, b: 246 * t };
    },
  },
];

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

const SUPERSAMPLE = 3;

/** Render an object to per-pixel coverage and premultiplied colour. */
function renderObject(fn: ObjectFn, width: number, height: number) {
  const alpha = new Float32Array(width * height);
  const colour = new Float32Array(width * height * 3);
  const step = 1 / SUPERSAMPLE;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let a = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const u = (x + (sx + 0.5) * step) / width;
          const v = (y + (sy + 0.5) * step) / height;
          const s = fn(u, v);
          if (!s.hit) continue;
          a++;
          r += s.r;
          g += s.g;
          b += s.b;
        }
      }
      const i = y * width + x;
      const n = SUPERSAMPLE * SUPERSAMPLE;
      alpha[i] = a / n;
      if (a > 0) {
        colour[i * 3] = r / a;
        colour[i * 3 + 1] = g / a;
        colour[i * 3 + 2] = b / a;
      }
    }
  }
  return { alpha, colour };
}

function meanColour(alpha: Float32Array, colour: Float32Array): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] < 0.99) continue;
    r += colour[i * 3];
    g += colour[i * 3 + 1];
    b += colour[i * 3 + 2];
    n++;
  }
  if (n === 0) return { r: 128, g: 128, b: 128 };
  return { r: r / n, g: g / n, b: b / n };
}

export interface CorpusOptions {
  width?: number;
  height?: number;
  /** Sensor noise standard deviation, in 0..255 levels. */
  noise?: number;
  seed?: number;
}

export function buildCorpus(options: CorpusOptions = {}): Scene[] {
  const width = options.width ?? 320;
  const height = options.height ?? 320;
  const noiseSigma = options.noise ?? 3.5;
  const seed = options.seed ?? 20260806;

  const scenes: Scene[] = [];
  for (const obj of OBJECTS) {
    const { alpha, colour } = renderObject(obj.fn, width, height);
    const mean = meanColour(alpha, colour);

    // Truth and the box are properties of the object alone, so they are shared
    // by every background — the only thing that varies is what is behind it.
    const truth = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; i++) truth[i] = alpha[i] >= 0.5 ? 1 : 0;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!truth[y * width + x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    // Loose, the way a hand-dragged box is: a few percent of slack on each side.
    const padX = Math.round((maxX - minX) * 0.05) + 3;
    const padY = Math.round((maxY - minY) * 0.05) + 3;
    const box = {
      x0: Math.max(0, minX - padX),
      y0: Math.max(0, minY - padY),
      x1: Math.min(width - 1, maxX + padX),
      y1: Math.min(height - 1, maxY + padY),
    };

    for (const bg of BACKGROUNDS) {
      const rng = mulberry32(seed + obj.name.length * 7919 + bg.name.length * 104729);
      const noise = makeNoise(seed + bg.name.length);
      const rand = (x: number, y: number) => noise(x * 8, y * 8);
      const rgba = new Uint8ClampedArray(width * height * 4);

      // A soft contact shadow, offset down and right. Background, not object —
      // this is the classic way a segmenter is fooled into over-reaching.
      const shadow = new Float32Array(width * height);
      const offX = Math.round(width * 0.035);
      const offY = Math.round(height * 0.03);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const sx = x - offX;
          const sy = y - offY;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
          shadow[y * width + x] = alpha[sy * width + sx];
        }
      }
      const blurred = blurFloat(shadow, width, height, Math.max(2, Math.round(width * 0.02)));

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const u = x / width;
          const v = y / height;
          const back = bg.fn(u, v, mean, rand);
          const shade = 1 - 0.45 * Math.min(1, blurred[i]);
          let r = back.r * shade;
          let g = back.g * shade;
          let b = back.b * shade;

          const a = alpha[i];
          if (a > 0) {
            r = colour[i * 3] * a + r * (1 - a);
            g = colour[i * 3 + 1] * a + g * (1 - a);
            b = colour[i * 3 + 2] * a + b * (1 - a);
          }

          // Sensor noise, so no region is perfectly uniform.
          const n1 = (rng() + rng() + rng() - 1.5) * noiseSigma;
          rgba[i * 4] = r + n1;
          rgba[i * 4 + 1] = g + (rng() - 0.5) * noiseSigma * 2;
          rgba[i * 4 + 2] = b + (rng() - 0.5) * noiseSigma * 2;
          rgba[i * 4 + 3] = 255;
        }
      }

      scenes.push({
        name: `${obj.name}/${bg.name}`,
        object: obj.name,
        background: bg.name,
        width,
        height,
        rgba,
        truth,
        box,
      });
    }
  }
  return scenes;
}

function blurFloat(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let n = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= width) continue;
        sum += src[y * width + xx];
        n++;
      }
      tmp[y * width + x] = sum / Math.max(1, n);
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        sum += tmp[yy * width + x];
        n++;
      }
      out[y * width + x] = sum / Math.max(1, n);
    }
  }
  return out;
}
