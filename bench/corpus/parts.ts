/**
 * The primitive kit the photographic corpus is built from.
 *
 * Every primitive carries two readings of the same numbers: an exact
 * inside-test, which is the ground truth, and a serialisable mesh spec the
 * browser turns into three.js geometry for the photograph. They are not two
 * models of one object that have to be kept in step by hand — they are one set
 * of parameters read two ways, and that is the only reason a solid measured
 * here can be trusted against a picture rendered somewhere else.
 *
 * Nothing subtracts. Hollows and holes are expressed by the primitives that
 * hold them natively — a lathe profile that runs up the outside and back down
 * the inside, a polygon with a hole in it — because a CSG difference would have
 * to be implemented twice, exactly, in two languages, and would not be.
 *
 * Object space matches `shapes3d.ts` and `visualHull.ts`: y runs 0 at the
 * ground to 1 at the top of the object, x and z are centred on 0, so every
 * extent is stated as a fraction of the object's own height. "Is the model too
 * deep" is then a question with a number for an answer.
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

/** Physically-based surface, in the terms `MeshPhysicalMaterial` takes. */
export interface Material {
  /** Base colour, 0..255 sRGB. */
  colour: [number, number, number];
  roughness: number;
  metalness: number;
  /** A clear lacquer over the base — car paint, glazed ceramic. */
  clearcoat?: number;
  /** Fuzz, for anything knitted or flocked. */
  sheen?: number;
  /** Emissive fraction, for a screen or a lamp. */
  emissive?: number;
}

export type MeshSpec =
  | { kind: 'box'; half: Vec3; pos: Vec3; rotY?: number }
  | { kind: 'ellipsoid'; radii: Vec3; pos: Vec3 }
  | { kind: 'capsule'; a: Vec3; b: Vec3; r: number }
  | { kind: 'cylinder'; a: Vec3; b: Vec3; r: number }
  | {
      kind: 'torus';
      pos: Vec3;
      ring: number;
      tube: number;
      /** Which axis the hole runs along. */
      axis: 'x' | 'y' | 'z';
      /** Arc start and sweep in radians; a full ring is 0 and 2π. */
      arcFrom?: number;
      arcSweep?: number;
    }
  /** A closed cross-section revolved about the y axis. Points are (radius, y). */
  | { kind: 'lathe'; profile: Vec2[]; pos: Vec3 }
  /** A polygon with optional holes, extruded along z and then turned about y. */
  | { kind: 'prism'; outline: Vec2[]; holes: Vec2[][]; depth: number; pos: Vec3; rotY?: number };

export interface Part {
  mesh: MeshSpec;
  material: Material;
}

// --- geometry --------------------------------------------------------------

function rotateY(x: number, z: number, angle: number): [number, number] {
  if (!angle) return [x, z];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c + z * s, -x * s + z * c];
}

/** Even-odd crossing test on a closed polygon. */
export function insidePolygon(poly: Vec2[], u: number, v: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ui, vi] = poly[i];
    const [uj, vj] = poly[j];
    if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) hit = !hit;
  }
  return hit;
}

function distanceToSegment(
  x: number,
  y: number,
  z: number,
  a: Vec3,
  b: Vec3,
): { distance: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  const raw = len2 === 0 ? 0 : ((x - a[0]) * dx + (y - a[1]) * dy + (z - a[2]) * dz) / len2;
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  return {
    distance: Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy), z - (a[2] + t * dz)),
    t: raw,
  };
}

/** Is this point in the solid material of one primitive? Exact, at any scale. */
export function insideMesh(mesh: MeshSpec, x: number, y: number, z: number): boolean {
  switch (mesh.kind) {
    case 'box': {
      const [px, pz] = rotateY(x - mesh.pos[0], z - mesh.pos[2], mesh.rotY ?? 0);
      const py = y - mesh.pos[1];
      return (
        Math.abs(px) <= mesh.half[0] && Math.abs(py) <= mesh.half[1] && Math.abs(pz) <= mesh.half[2]
      );
    }
    case 'ellipsoid': {
      const dx = (x - mesh.pos[0]) / mesh.radii[0];
      const dy = (y - mesh.pos[1]) / mesh.radii[1];
      const dz = (z - mesh.pos[2]) / mesh.radii[2];
      return dx * dx + dy * dy + dz * dz <= 1;
    }
    case 'capsule':
      return distanceToSegment(x, y, z, mesh.a, mesh.b).distance <= mesh.r;
    case 'cylinder': {
      const { distance, t } = distanceToSegment(x, y, z, mesh.a, mesh.b);
      // A cylinder is a capsule with its ends cut off flat, which is what
      // separates a wheel from a pill.
      return t >= 0 && t <= 1 && distance <= mesh.r;
    }
    case 'torus': {
      const px = x - mesh.pos[0];
      const py = y - mesh.pos[1];
      const pz = z - mesh.pos[2];
      // Put the hole on +z, whichever axis it was asked for, then one test does.
      let a: number;
      let b: number;
      let through: number;
      if (mesh.axis === 'z') {
        a = px;
        b = py;
        through = pz;
      } else if (mesh.axis === 'y') {
        a = px;
        b = pz;
        through = py;
      } else {
        a = py;
        b = pz;
        through = px;
      }
      const radial = Math.hypot(a, b) - mesh.ring;
      if (Math.hypot(radial, through) > mesh.tube) return false;
      const sweep = mesh.arcSweep ?? Math.PI * 2;
      if (sweep >= Math.PI * 2) return true;
      const from = mesh.arcFrom ?? 0;
      let angle = Math.atan2(b, a) - from;
      angle -= Math.floor(angle / (Math.PI * 2)) * (Math.PI * 2);
      return angle <= sweep;
    }
    case 'lathe': {
      const radius = Math.hypot(x - mesh.pos[0], z - mesh.pos[2]);
      return insidePolygon(mesh.profile, radius, y - mesh.pos[1]);
    }
    case 'prism': {
      const [px, pz] = rotateY(x - mesh.pos[0], z - mesh.pos[2], mesh.rotY ?? 0);
      const py = y - mesh.pos[1];
      if (Math.abs(pz) > mesh.depth / 2) return false;
      if (!insidePolygon(mesh.outline, px, py)) return false;
      for (const hole of mesh.holes) if (insidePolygon(hole, px, py)) return false;
      return true;
    }
  }
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

function grow(into: Bounds, x: number, y: number, z: number): void {
  if (x < into.min[0]) into.min[0] = x;
  if (y < into.min[1]) into.min[1] = y;
  if (z < into.min[2]) into.min[2] = z;
  if (x > into.max[0]) into.max[0] = x;
  if (y > into.max[1]) into.max[1] = y;
  if (z > into.max[2]) into.max[2] = z;
}

/**
 * Analytic bounds of one primitive.
 *
 * Sampling for the bounds would work but would quietly round the object's
 * height down to the nearest sample, and the whole comparison frame is
 * calibrated on that height.
 */
export function meshBounds(mesh: MeshSpec, into?: Bounds): Bounds {
  const b: Bounds = into ?? {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  switch (mesh.kind) {
    case 'box': {
      const angle = mesh.rotY ?? 0;
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          // Rotating the corners is exact for a box and never over-reports the
          // way rotating the axis-aligned extent would.
          const c = Math.cos(angle);
          const s = Math.sin(angle);
          const lx = sx * mesh.half[0];
          const lz = sz * mesh.half[2];
          const wx = lx * c - lz * s;
          const wz = lx * s + lz * c;
          grow(b, mesh.pos[0] + wx, mesh.pos[1] - mesh.half[1], mesh.pos[2] + wz);
          grow(b, mesh.pos[0] + wx, mesh.pos[1] + mesh.half[1], mesh.pos[2] + wz);
        }
      break;
    }
    case 'ellipsoid':
      grow(
        b,
        mesh.pos[0] - mesh.radii[0],
        mesh.pos[1] - mesh.radii[1],
        mesh.pos[2] - mesh.radii[2],
      );
      grow(
        b,
        mesh.pos[0] + mesh.radii[0],
        mesh.pos[1] + mesh.radii[1],
        mesh.pos[2] + mesh.radii[2],
      );
      break;
    case 'capsule':
    case 'cylinder':
      for (const p of [mesh.a, mesh.b]) {
        grow(b, p[0] - mesh.r, p[1] - mesh.r, p[2] - mesh.r);
        grow(b, p[0] + mesh.r, p[1] + mesh.r, p[2] + mesh.r);
      }
      break;
    case 'torus': {
      const wide = mesh.ring + mesh.tube;
      const half: Vec3 =
        mesh.axis === 'z'
          ? [wide, wide, mesh.tube]
          : mesh.axis === 'y'
            ? [wide, mesh.tube, wide]
            : [mesh.tube, wide, wide];
      grow(b, mesh.pos[0] - half[0], mesh.pos[1] - half[1], mesh.pos[2] - half[2]);
      grow(b, mesh.pos[0] + half[0], mesh.pos[1] + half[1], mesh.pos[2] + half[2]);
      break;
    }
    case 'lathe': {
      let radius = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (const [r, y] of mesh.profile) {
        if (r > radius) radius = r;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      grow(b, mesh.pos[0] - radius, mesh.pos[1] + lo, mesh.pos[2] - radius);
      grow(b, mesh.pos[0] + radius, mesh.pos[1] + hi, mesh.pos[2] + radius);
      break;
    }
    case 'prism': {
      const angle = mesh.rotY ?? 0;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const halfDepth = mesh.depth / 2;
      for (const [u, v] of mesh.outline)
        for (const w of [-halfDepth, halfDepth]) {
          grow(b, mesh.pos[0] + u * c - w * s, mesh.pos[1] + v, mesh.pos[2] + u * s + w * c);
        }
      break;
    }
  }
  return b;
}

/** Bounds of a whole object. */
export function partsBounds(parts: Part[]): Bounds {
  const b: Bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  for (const part of parts) meshBounds(part.mesh, b);
  return b;
}

/** True anywhere in the object's material. */
export function insideParts(parts: Part[], x: number, y: number, z: number): boolean {
  for (const part of parts) if (insideMesh(part.mesh, x, y, z)) return true;
  return false;
}

// --- polygon helpers -------------------------------------------------------

/**
 * Round a polygon's corners with circular arcs.
 *
 * A hard 90-degree edge is the giveaway that something was modelled rather than
 * photographed: real edges have a roundover a millimetre wide, and it is that
 * roundover that catches the highlight running along an object's edge. Doing it
 * in the polygon rather than with a bevel modifier keeps the mesh and the
 * inside-test the same shape, which a bevel would not.
 */
export function roundPolygon(poly: Vec2[], radius: number, segments = 8): Vec2[] {
  const out: Vec2[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const prev = poly[(i + n - 1) % n];
    const here = poly[i];
    const next = poly[(i + 1) % n];

    const inDx = here[0] - prev[0];
    const inDy = here[1] - prev[1];
    const outDx = next[0] - here[0];
    const outDy = next[1] - here[1];
    const inLen = Math.hypot(inDx, inDy);
    const outLen = Math.hypot(outDx, outDy);
    if (inLen === 0 || outLen === 0) {
      out.push(here);
      continue;
    }
    // Never round away more than half of either edge, or neighbouring corners
    // eat each other and the polygon self-intersects.
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const start: Vec2 = [here[0] - (inDx / inLen) * r, here[1] - (inDy / inLen) * r];
    const end: Vec2 = [here[0] + (outDx / outLen) * r, here[1] + (outDy / outLen) * r];
    out.push(start);
    for (let s = 1; s < segments; s++) {
      const t = s / segments;
      // Quadratic Bezier through the corner: close enough to an arc at this
      // scale, and it cannot overshoot the way a circle fitted by angle can.
      const mt = 1 - t;
      out.push([
        mt * mt * start[0] + 2 * mt * t * here[0] + t * t * end[0],
        mt * mt * start[1] + 2 * mt * t * here[1] + t * t * end[1],
      ]);
    }
    out.push(end);
  }
  return out;
}

/** A rectangle as a polygon, corners optionally rounded. */
export function rectangle(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  round = 0,
): Vec2[] {
  const poly: Vec2[] = [
    [cx - halfW, cy - halfH],
    [cx + halfW, cy - halfH],
    [cx + halfW, cy + halfH],
    [cx - halfW, cy + halfH],
  ];
  return round > 0 ? roundPolygon(poly, round) : poly;
}

/** A closed circle as a polygon, for holes and round profiles. */
export function circle(cx: number, cy: number, r: number, segments = 32): Vec2[] {
  const poly: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    poly.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return poly;
}
