/**
 * Known solids, for measuring the 3D reconstruction rather than eyeballing it.
 *
 * The segmentation benchmark settled an argument that had been going in circles;
 * this is the same instrument pointed at the next stage. Each shape is defined
 * by an inside-test in object space, so the ground truth is exact at any
 * resolution, and views are rendered with *the pipeline's own* projection
 * convention (see `visualHull.ts`): a camera at azimuth a sees the horizontal
 * axis u = x·cos(a) + z·sin(a), orthographically, with the object one unit tall.
 * Rendering with a different convention would measure my misunderstanding of the
 * code instead of the code.
 *
 * Object space: y runs 0..1 from the ground up, x and z are centred on 0. So a
 * shape's x/z extents are its true proportions relative to its own height, which
 * is what makes "is the model too flat" a measurable question.
 *
 * The shapes are chosen to separate methods, not to flatter them. Some are
 * recoverable from silhouettes alone (a box, a sphere); some have concavities
 * that provably are not (the inside of a mug, the waist of a dumbbell seen from
 * every angle); and some are mostly empty space that a silhouette intersection
 * will confidently fill in (a chair's legs, a torus's hole).
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Solid {
  name: string;
  /** True inside the material. x,z centred on 0; y from 0 (ground) to 1 (top). */
  inside: (x: number, y: number, z: number) => boolean;
  colour: (x: number, y: number, z: number) => Rgb;
  /** Half-extent to march over; keep it just past the shape. */
  radius: number;
}

// --- helpers ---------------------------------------------------------------

const between = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

/** Distance to the axis of an upright cylinder. */
const radial = (x: number, z: number) => Math.hypot(x, z);

function box(x: number, y: number, z: number, hx: number, y0: number, y1: number, hz: number) {
  return Math.abs(x) <= hx && between(y, y0, y1) && Math.abs(z) <= hz;
}

// --- solids ----------------------------------------------------------------

const sphere: Solid = {
  name: 'sphere',
  radius: 0.6,
  inside: (x, y, z) => Math.hypot(x, y - 0.5, z) <= 0.5,
  colour: () => ({ r: 208, g: 72, b: 64 }),
};

/** Deliberately not square in plan: 2 wide, 1 tall, 0.55 deep. */
const brickBox: Solid = {
  name: 'box-2x1x0.55',
  radius: 1.1,
  inside: (x, y, z) => box(x, y, z, 1.0, 0, 1, 0.275),
  colour: (_x, y) => (y > 0.75 ? { r: 232, g: 196, b: 72 } : { r: 60, g: 110, b: 190 }),
};

const cylinder: Solid = {
  name: 'cylinder',
  radius: 0.5,
  inside: (x, y, z) => radial(x, z) <= 0.32 && between(y, 0, 1),
  colour: () => ({ r: 96, g: 172, b: 108 }),
};

/**
 * A mug: hollow, open at the top, with a handle standing off one side. The
 * bore is the case a silhouette method cannot see — no outline anywhere on a
 * turntable reveals it.
 */
const mug: Solid = {
  name: 'mug',
  radius: 0.75,
  inside: (x, y, z) => {
    const r = radial(x, z);
    // Hollow body: walls and a floor, open above y=0.14.
    if (r <= 0.34 && between(y, 0, 1)) {
      const bore = r <= 0.26 && y > 0.14;
      if (!bore) return true;
    }
    // Handle: a torus arc on the +x side, standing clear of the wall.
    const hx = x - 0.40;
    const ring = Math.hypot(Math.hypot(hx, 0) - 0.0, y - 0.5);
    void ring;
    const toroidal = Math.hypot(Math.hypot(x - 0.30, y - 0.5) - 0.20, z);
    if (x > 0.26 && toroidal <= 0.055) return true;
    return false;
  },
  colour: (x, y, z) => {
    const r = radial(x, z);
    if (between(y, 0.42, 0.60) && r > 0.30) return { r: 40, g: 92, b: 168 };
    return { r: 228, g: 230, b: 234 };
  },
};

/**
 * A chair: mostly empty space. Its silhouette from the front is nearly a solid
 * rectangle, so a two-view hull will happily deliver a slab.
 */
const chair: Solid = {
  name: 'chair',
  radius: 0.6,
  inside: (x, y, z) => {
    // Seat.
    if (box(x, y, z, 0.30, 0.46, 0.54, 0.30)) return true;
    // Back, with a gap between two slats.
    if (Math.abs(x) <= 0.30 && between(y, 0.54, 1) && between(z, 0.22, 0.30)) {
      if (between(y, 0.62, 0.74) || between(y, 0.82, 0.94)) return false;
      return true;
    }
    // Four legs.
    for (const lx of [-0.25, 0.25]) {
      for (const lz of [-0.25, 0.25]) {
        if (Math.hypot(x - lx, z - lz) <= 0.045 && between(y, 0, 0.46)) return true;
      }
    }
    return false;
  },
  colour: (_x, y) => (y > 0.5 ? { r: 150, g: 104, b: 60 } : { r: 122, g: 84, b: 48 }),
};

/** Two balls and a bar: a waist no silhouette can carve back in. */
const dumbbell: Solid = {
  name: 'dumbbell',
  radius: 0.6,
  inside: (x, y, z) => {
    if (Math.hypot(x, y - 0.22, z) <= 0.22) return true;
    if (Math.hypot(x, y - 0.78, z) <= 0.22) return true;
    return radial(x, z) <= 0.07 && between(y, 0.2, 0.8);
  },
  colour: (_x, y) => (Math.abs(y - 0.5) < 0.25 ? { r: 90, g: 92, b: 100 } : { r: 44, g: 46, b: 52 }),
};

/** A sharp step: a concavity that IS visible in silhouette from some angles. */
const stair: Solid = {
  name: 'stair',
  radius: 0.8,
  inside: (x, y, z) => {
    if (box(x, y, z, 0.45, 0, 0.34, 0.28)) return true;
    if (box(x - 0.15, y, z, 0.30, 0.34, 0.67, 0.28)) return true;
    if (box(x - 0.30, y, z, 0.15, 0.67, 1, 0.28)) return true;
    return false;
  },
  colour: (_x, y) => {
    if (y > 0.67) return { r: 220, g: 96, b: 60 };
    if (y > 0.34) return { r: 240, g: 176, b: 72 };
    return { r: 70, g: 130, b: 200 };
  },
};

/** An upright ring: the hole is real, and every silhouette shows it. */
const torus: Solid = {
  name: 'torus',
  radius: 0.6,
  inside: (x, y, z) => Math.hypot(Math.hypot(x, y - 0.5) - 0.34, z) <= 0.15,
  colour: () => ({ r: 176, g: 88, b: 176 }),
};

/** A body with one thin arm sticking out sideways. */
const teapot: Solid = {
  name: 'teapot',
  radius: 0.8,
  inside: (x, y, z) => {
    if (Math.hypot(x, (y - 0.45) * 1.25, z) <= 0.34) return true;
    // Spout.
    const t = (x + 0.30) / 0.36;
    if (between(t, 0, 1)) {
      const cy = 0.48 + 0.30 * t * t;
      if (Math.hypot(y - cy, z) <= 0.075 - 0.03 * t && x < 0.06) return true;
    }
    // Handle on the other side.
    if (x < -0.18 && Math.hypot(Math.hypot(x + 0.28, y - 0.5) - 0.19, z) <= 0.055) return true;
    // Lid knob.
    if (Math.hypot(x, y - 0.76, z) <= 0.07) return true;
    return false;
  },
  colour: (_x, y) => (y > 0.7 ? { r: 216, g: 216, b: 220 } : { r: 60, g: 150, b: 170 }),
};

export const SOLIDS: Solid[] = [
  sphere,
  brickBox,
  cylinder,
  mug,
  chair,
  dumbbell,
  stair,
  torus,
  teapot,
];

// --- rendering -------------------------------------------------------------

export interface RenderedView {
  rgba: Uint8ClampedArray;
  mask: Uint8Array;
  width: number;
  height: number;
  azimuth: number;
}

const SUPERSAMPLE = 2;

/**
 * Orthographic render at a given azimuth, matching `visualHull.ts` exactly:
 * u = x·cos + z·sin across the image, y up the image, camera looking from -w.
 */
export function renderView(solid: Solid, azimuthDeg: number, height = 260): RenderedView {
  const rad = (azimuthDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const pixelsPerUnit = height * 0.78;
  const bottomY = height * 0.92;

  // The frame has to hold the widest the object can project, or the silhouette
  // is clipped and the pipeline is being asked to reproduce a cropped object.
  // Since u = x·cos + z·sin, |u| never exceeds the shape's radius.
  const width = Math.ceil(2 * solid.radius * pixelsPerUnit) + 24;
  const centreX = width / 2;

  const steps = 320;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const mask = new Uint8Array(width * height);
  const step = 1 / SUPERSAMPLE;

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let hits = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const u = (px + (sx + 0.5) * step - centreX) / pixelsPerUnit;
          const y = (bottomY - (py + (sy + 0.5) * step)) / pixelsPerUnit;
          if (y < -0.05 || y > 1.05) continue;

          // March front to back along the camera axis.
          let found = false;
          for (let i = 0; i < steps; i++) {
            const w = -solid.radius + (2 * solid.radius * i) / (steps - 1);
            const wx = u * cos - w * sin;
            const wz = u * sin + w * cos;
            if (!solid.inside(wx, y, wz)) continue;

            // Surface normal by central differences, for plain Lambert shading.
            const e = 0.006;
            const nx =
              (solid.inside(wx + e, y, wz) ? 1 : 0) - (solid.inside(wx - e, y, wz) ? 1 : 0);
            const ny =
              (solid.inside(wx, y + e, wz) ? 1 : 0) - (solid.inside(wx, y - e, wz) ? 1 : 0);
            const nz =
              (solid.inside(wx, y, wz + e) ? 1 : 0) - (solid.inside(wx, y, wz - e) ? 1 : 0);
            const len = Math.hypot(nx, ny, nz) || 1;
            // Light over the camera's left shoulder.
            const lambert = Math.max(0, (-nx / len) * 0.4 + (ny / len) * 0.5 + (-nz / len) * 0.75);
            const shade = 0.55 + 0.55 * lambert;

            const c = solid.colour(wx, y, wz);
            r += c.r * shade;
            g += c.g * shade;
            b += c.b * shade;
            hits++;
            found = true;
            break;
          }
          void found;
        }
      }

      const total = SUPERSAMPLE * SUPERSAMPLE;
      const i = py * width + px;
      const coverage = hits / total;
      // Mid-grey studio background, so nothing depends on the cut-out being easy.
      const bg = 140;
      rgba[i * 4] = hits ? (r / hits) * coverage + bg * (1 - coverage) : bg;
      rgba[i * 4 + 1] = hits ? (g / hits) * coverage + bg * (1 - coverage) : bg;
      rgba[i * 4 + 2] = hits ? (b / hits) * coverage + bg * (1 - coverage) : bg;
      rgba[i * 4 + 3] = 255;
      mask[i] = coverage >= 0.5 ? 1 : 0;
    }
  }

  return { rgba, mask, width, height, azimuth: azimuthDeg };
}

/**
 * True depth of the first surface along the camera axis, for scoring a depth
 * estimator directly instead of inferring its quality from the finished model.
 * Values are in object-height units, measured from the camera side; NaN where
 * the ray misses.
 */
export function renderDepth(solid: Solid, azimuthDeg: number, height = 260): {
  depth: Float32Array;
  width: number;
  height: number;
} {
  const rad = (azimuthDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const pixelsPerUnit = height * 0.78;
  const bottomY = height * 0.92;
  const width = Math.ceil(2 * solid.radius * pixelsPerUnit) + 24;
  const centreX = width / 2;
  const steps = 320;

  const depth = new Float32Array(width * height).fill(NaN);
  for (let py = 0; py < height; py++) {
    const y = (bottomY - (py + 0.5)) / pixelsPerUnit;
    if (y < -0.05 || y > 1.05) continue;
    for (let px = 0; px < width; px++) {
      const u = (px + 0.5 - centreX) / pixelsPerUnit;
      for (let i = 0; i < steps; i++) {
        const w = -solid.radius + (2 * solid.radius * i) / (steps - 1);
        if (solid.inside(u * cos - w * sin, y, u * sin + w * cos)) {
          depth[py * width + px] = w + solid.radius; // 0 at the near clip plane
          break;
        }
      }
    }
  }
  return { depth, width, height };
}

/**
 * Azimuths for n views, spread over 180 degrees rather than 360.
 *
 * Under orthographic projection the silhouette at a and at a+180 are mirror
 * images of each other, so they constrain the hull identically — a front and a
 * back photo are, for carving purposes, one photo. Spreading over a half turn
 * is therefore information-optimal, and spreading over a full turn wastes half
 * the shots. (Colour is a different matter: the back photo is the only thing
 * that can paint the back, which is why the app still asks for the full turn.)
 */
export function azimuthsFor(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((180 / n) * i);
  return out;
}
