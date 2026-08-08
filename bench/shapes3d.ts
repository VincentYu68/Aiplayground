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

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

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


// ---------------------------------------------------------------------------
// the cases that actually matter
//
// The solids above are geometric primitives, and a method that handles a sphere
// and a cylinder has proved nothing about the things people photograph. These
// four are the stated targets: a person, a car, a bag and a drawing. They break
// different assumptions — a person is articulated and thin-limbed, a car is
// long and wheeled, a bag is soft with a handle loop, and a drawing is not a
// solid at all.
// ---------------------------------------------------------------------------

/** Distance to a capsule (a segment with thickness) — limbs and straps. */
function capsule(
  x: number,
  y: number,
  z: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  const t = len2 === 0 ? 0 : clamp01(((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / len2);
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy), z - (az + t * dz)) <= r;
}

/** A standing figure: articulated, thin limbs, and a gap between the legs. */
const person: Solid = {
  name: 'person',
  radius: 0.35,
  inside: (x, y, z) => {
    if (Math.hypot(x, (y - 0.90) * 1.05, z) <= 0.085) return true; // head
    if (capsule(x, y, z, 0, 0.78, 0, 0, 0.82, 0, 0.045)) return true; // neck
    // Torso: tapered, deeper than it is thick at the shoulders.
    if (y >= 0.44 && y <= 0.80) {
      const t = (y - 0.44) / 0.36;
      const hw = 0.10 + 0.075 * t;
      const hd = 0.055 + 0.02 * t;
      if ((x / hw) ** 2 + (z / hd) ** 2 <= 1) return true;
    }
    // Arms, held slightly away from the body.
    if (capsule(x, y, z, 0.16, 0.78, 0, 0.23, 0.44, 0.02, 0.038)) return true;
    if (capsule(x, y, z, -0.16, 0.78, 0, -0.23, 0.44, 0.02, 0.038)) return true;
    // Legs, with real space between them.
    if (capsule(x, y, z, 0.07, 0.46, 0, 0.08, 0.02, 0.01, 0.052)) return true;
    if (capsule(x, y, z, -0.07, 0.46, 0, -0.08, 0.02, 0.01, 0.052)) return true;
    return false;
  },
  colour: (_x, y) => {
    if (y > 0.82) return { r: 214, g: 172, b: 140 };
    if (y > 0.44) return { r: 70, g: 110, b: 180 };
    return { r: 48, g: 52, b: 68 };
  },
};

/** A car: long, low, with wheels that stand proud of the body. */
const carSolid: Solid = {
  name: 'car',
  radius: 1.3,
  inside: (x, y, z) => {
    // Wheels: discs on the flanks, axis along x.
    for (const wx of [-0.72, 0.72]) {
      for (const wz of [-0.34, 0.34]) {
        if (Math.abs(x - wx) <= 0.42 && Math.hypot(y - 0.19, z - wz) <= 0.19 &&
            Math.abs(z - wz) <= 0.09 + 0.0 && Math.abs(x - wx) <= 0.30) return true;
      }
    }
    // Body.
    if (Math.abs(x) <= 1.15 && y >= 0.16 && y <= 0.52 && Math.abs(z) <= 0.40) {
      const taper = 1 - 0.25 * Math.max(0, (Math.abs(x) - 0.7) / 0.45);
      if (Math.abs(z) <= 0.40 * taper) return true;
    }
    // Cabin, set back and narrower.
    if (x >= -0.55 && x <= 0.45 && y > 0.52 && y <= 0.78) {
      const t = (y - 0.52) / 0.26;
      if (x <= 0.45 - 0.18 * t && x >= -0.55 + 0.10 * t && Math.abs(z) <= 0.34 - 0.06 * t) return true;
    }
    return false;
  },
  colour: (_x, y) => {
    if (y < 0.30) return { r: 40, g: 40, b: 46 };
    if (y > 0.54) return { r: 150, g: 196, b: 220 };
    return { r: 190, g: 44, b: 48 };
  },
};

/** A soft bag: rounded body, flat-ish base, and a handle loop with a hole. */
const bag: Solid = {
  name: 'bag',
  radius: 0.5,
  inside: (x, y, z) => {
    // Body: a superellipsoid, wider at the top than the base.
    if (y >= 0 && y <= 0.66) {
      const t = y / 0.66;
      const hw = 0.24 + 0.07 * t;
      const hd = 0.11 + 0.035 * t;
      const p = 2.6; // squarer than an ellipse — a bag, not a balloon
      if (Math.abs(x / hw) ** p + Math.abs(z / hd) ** p <= 1) return true;
    }
    // Handle: an arch standing clear of the mouth, so there is a real hole.
    const arch = Math.hypot(Math.hypot(x, 0) - 0.0, 0);
    void arch;
    const r = Math.hypot(x, (y - 0.66) * 1.0);
    if (y > 0.62 && r >= 0.15 && r <= 0.20 && Math.abs(z) <= 0.035) return true;
    return false;
  },
  colour: (_x, y) => (y > 0.62 ? { r: 92, g: 66, b: 48 } : { r: 176, g: 132, b: 92 }),
};

/**
 * A drawing: a picture, not a solid.
 *
 * This is the case that breaks every depth prior in the codebase. The right
 * answer is a flat plaque a few millimetres thick — the depth is near zero and
 * no amount of reasoning about the *subject* changes that. Anything that
 * inflates it into a 3D figure has answered a different question.
 */
const drawing: Solid = {
  name: 'drawing',
  radius: 0.45,
  inside: (x, y, z) => {
    if (Math.abs(z) > 0.018) return false; // ~3mm on a 200mm sheet
    // A simple drawn figure: house with a roof, inside a sheet border.
    if (Math.abs(x) <= 0.34 && y >= 0.06 && y <= 0.94) {
      const body = Math.abs(x) <= 0.26 && y >= 0.12 && y <= 0.62;
      const roof = y > 0.62 && y <= 0.86 && Math.abs(x) <= 0.30 * (1 - (y - 0.62) / 0.26);
      return body || roof;
    }
    return false;
  },
  colour: (x, y) => {
    if (y > 0.62) return { r: 190, g: 70, b: 60 };
    if (Math.abs(x) < 0.07 && y < 0.34) return { r: 90, g: 62, b: 44 };
    return { r: 238, g: 226, b: 196 };
  },
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
  person,
  carSolid,
  bag,
  drawing,
];

/** The four cases the app is explicitly expected to handle. */
export const TARGET_CASES = ['person', 'car', 'bag', 'drawing'];

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
