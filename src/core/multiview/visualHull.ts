/**
 * Recovering real 3D geometry from several photographs.
 *
 * A single photograph cannot describe a solid. Extruding its silhouette and
 * rounding the result gives something that reads correctly from the camera's
 * position and falls apart the moment you orbit — the shape was never there,
 * it was a relief with a guess behind it.
 *
 * Two or more photographs taken around the object do contain the shape, and
 * shape-from-silhouette extracts it: each silhouette back-projects to a
 * generalised cone containing the object, and the object is contained in the
 * intersection of all of them. That intersection — the visual hull — is a
 * genuine 3D solid. Four views around a turntable pin down most everyday
 * objects; two perpendicular views already beat any single-view guess by a
 * wide margin.
 *
 * What the visual hull cannot recover is concavity that never shows up on any
 * silhouette: the inside of a bowl seen only from outside, the dimple in the
 * base of a bottle. That is a property of the method, not of this
 * implementation, and it is stated in the report rather than papered over.
 *
 * Projection is orthographic. Recovering perspective would need the camera's
 * focal length and its distance to the object, which a dropped photo does not
 * carry; at any sensible shooting distance the error from assuming parallel
 * rays is far smaller than the error from guessing a bulge.
 */

import { bounds, type Mask } from '../image/raster';
import { PLATE_MM, STUD_MM } from '../lego/units';

export interface View {
  rgba: Uint8ClampedArray;
  mask: Mask;
  width: number;
  height: number;
  /**
   * Where the camera stood, in degrees clockwise around the object's vertical
   * axis. 0 is the front, 90 the right side, 180 the back.
   */
  azimuth: number;
  /**
   * Measured inverse relative depth for this photo, larger meaning nearer, on
   * the photo's own pixel grid. Optional because the weights are a 35MB
   * background download and the build has to work before they land.
   *
   * The carve does not use it — a silhouette intersection is already real
   * geometry and depth cannot improve on it without a camera model — but the
   * single-photo path lives or dies by it.
   */
  relief?: Float32Array;
}

/** A view with its silhouette measured and its scale normalised. */
interface CalibratedView extends View {
  centreX: number;
  bottomY: number;
  /** Pixels per object-height unit. */
  pixelsPerUnit: number;
  /** Half the silhouette width, in object-height units. */
  halfWidth: number;
  cos: number;
  sin: number;
}

/**
 * Put every view on a common scale.
 *
 * The object's height is the one measurement every view shares, so it is the
 * unit: the silhouette is one unit tall in all of them. That carries an
 * assumption worth being explicit about — that the photos were taken from
 * roughly the same distance, with the object upright — and it is the only
 * assumption available without camera calibration.
 */
function calibrate(views: View[]): CalibratedView[] {
  const out: CalibratedView[] = [];
  // Angles are taken relative to the first view, so the grid's +x axis is that
  // view's horizontal axis and its camera looks straight down -z. That makes
  // the front projection exact rather than approximate, whatever absolute
  // angle the user assigned.
  const reference = views[0]?.azimuth ?? 0;
  for (const view of views) {
    const box = bounds(view.mask, view.width, view.height);
    if (!box || box.height < 2 || box.width < 1) continue;
    const radians = ((view.azimuth - reference) * Math.PI) / 180;
    out.push({
      ...view,
      centreX: (box.minX + box.maxX) / 2,
      bottomY: box.maxY,
      pixelsPerUnit: box.height,
      halfWidth: box.width / 2 / box.height,
      cos: Math.cos(radians),
      sin: Math.sin(radians),
    });
  }
  return out;
}

export interface HullOptions {
  /** Width of the model in studs, measured on the first view. */
  studsWide: number;
  /**
   * Views a voxel may be missing from and still survive. Zero is the strict
   * intersection; one lets a single bad cut-out lose a limb without taking the
   * whole model with it.
   */
  tolerance: number;
}

export interface HullResult {
  /**
   * Per view, the number of voxels that view alone rejected while every other
   * view accepted them.
   *
   * A visual hull is an intersection, so one bad cut-out silently removes
   * material every other photograph agreed was there — and the user is handed
   * a model with most of the object missing and nothing pointing at the photo
   * responsible. This is what makes that attributable.
   */
  vetoes: Int32Array;
  /** 1 where the object is, indexed [(y * sz + z) * sx + x]. */
  occupancy: Uint8Array;
  sx: number;
  sy: number;
  sz: number;
  /** Object-space size of one stud, for projecting back into the views. */
  unitsPerStud: number;
  /** Half the model's horizontal extent, in object units. */
  extent: number;
  views: CalibratedView[];
}

/**
 * Carve the voxel grid down to the intersection of the silhouettes.
 */
export function carveVisualHull(viewsIn: View[], options: HullOptions): HullResult | null {
  const views = calibrate(viewsIn);
  if (views.length === 0) return null;

  // The model has to be wide enough to hold the widest silhouette, whichever
  // view that came from.
  let extent = 0;
  for (const v of views) extent = Math.max(extent, v.halfWidth);
  extent *= 1.02; // a hair of margin so the widest view is not clipped

  // The user's "width in studs" refers to the first view — the one they framed.
  const unitsPerStud = (views[0].halfWidth * 2) / Math.max(1, options.studsWide);
  const unitsPerPlate = unitsPerStud * (PLATE_MM / STUD_MM);

  const sx = Math.max(1, Math.ceil((extent * 2) / unitsPerStud));
  const sz = sx;
  const sy = Math.max(1, Math.round(1 / unitsPerPlate));

  const occupancy = new Uint8Array(sx * sy * sz);
  const allowedMisses = Math.max(0, Math.min(views.length - 1, options.tolerance));
  /** Voxels each view alone removed, which every other view agreed were solid. */
  const vetoes = new Int32Array(views.length);

  for (let gy = 0; gy < sy; gy++) {
    const y = (gy + 0.5) * unitsPerPlate;
    for (let gz = 0; gz < sz; gz++) {
      const z = -extent + (gz + 0.5) * unitsPerStud;
      for (let gx = 0; gx < sx; gx++) {
        const x = -extent + (gx + 0.5) * unitsPerStud;

        let misses = 0;
        // Which view rejected it, when exactly one did. A voxel every
        // photograph but one agrees on is the evidence that that one photo's
        // cut-out is wrong, and it is the only place that evidence exists.
        let soleObjector = -1;
        for (let vi = 0; vi < views.length; vi++) {
          const v = views[vi];
          const u = x * v.cos + z * v.sin;
          const px = Math.round(v.centreX + u * v.pixelsPerUnit);
          const py = Math.round(v.bottomY - y * v.pixelsPerUnit);
          const inside =
            px >= 0 &&
            py >= 0 &&
            px < v.width &&
            py < v.height &&
            v.mask[py * v.width + px] === 1;
          if (!inside) {
            misses++;
            soleObjector = misses === 1 ? vi : -1;
            if (misses > allowedMisses && misses > 1) break;
          }
        }
        if (misses === 1 && soleObjector >= 0) vetoes[soleObjector]++;
        if (misses <= allowedMisses) occupancy[(gy * sz + gz) * sx + gx] = 1;
      }
    }
  }

  return { occupancy, sx, sy, sz, unitsPerStud, extent, views, vetoes };
}

/**
 * Colour every surface voxel from whichever photograph sees it best.
 *
 * "Best" is the view whose direction most squarely faces the surface, among
 * those that can actually see it — a voxel hidden behind the object from one
 * camera must not take its colour from that camera. Visibility is resolved
 * with a depth buffer per view, which is the same test the camera itself
 * performed when the photo was taken.
 */
export function sampleHullColours(hull: HullResult): {
  rgb: Uint8ClampedArray;
  coloured: Uint8Array;
} {
  const { occupancy, sx, sy, sz, unitsPerStud, extent, views } = hull;
  const unitsPerPlate = unitsPerStud * (PLATE_MM / STUD_MM);
  const n = sx * sy * sz;

  const rgb = new Uint8ClampedArray(n * 3);
  const coloured = new Uint8Array(n);
  const bestScore = new Float32Array(n).fill(-Infinity);

  const at = (x: number, y: number, z: number) =>
    x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz
      ? 0
      : occupancy[(y * sz + z) * sx + x];

  for (const v of views) {
    // Depth buffer over the projected grid: nearest surface per image cell.
    const cols = sx + sz;
    const depth = new Float32Array(cols * sy).fill(Infinity);
    const owner = new Int32Array(cols * sy).fill(-1);

    const project = (gx: number, gy: number, gz: number) => {
      const x = -extent + (gx + 0.5) * unitsPerStud;
      const z = -extent + (gz + 0.5) * unitsPerStud;
      const u = x * v.cos + z * v.sin;
      const d = -x * v.sin + z * v.cos; // toward the camera is -d
      const col = Math.round((u + extent) / unitsPerStud);
      return { u, d, col: Math.max(0, Math.min(cols - 1, col)), gy };
    };

    for (let gy = 0; gy < sy; gy++) {
      for (let gz = 0; gz < sz; gz++) {
        for (let gx = 0; gx < sx; gx++) {
          const i = (gy * sz + gz) * sx + gx;
          if (!occupancy[i]) continue;
          const p = project(gx, gy, gz);
          const cell = p.gy * cols + p.col;
          if (p.d < depth[cell]) {
            depth[cell] = p.d;
            owner[cell] = i;
          }
        }
      }
    }

    // Give each visible voxel the pixel it projects to, weighted by how
    // squarely the surface faces this camera.
    for (let gy = 0; gy < sy; gy++) {
      for (let gz = 0; gz < sz; gz++) {
        for (let gx = 0; gx < sx; gx++) {
          const i = (gy * sz + gz) * sx + gx;
          if (!occupancy[i]) continue;
          const p = project(gx, gy, gz);
          if (owner[p.gy * cols + p.col] !== i) continue; // occluded

          // Outward normal from the occupancy gradient.
          const nx = at(gx - 1, gy, gz) - at(gx + 1, gy, gz);
          const nz = at(gx, gy, gz - 1) - at(gx, gy, gz + 1);
          const ny = at(gx, gy - 1, gz) - at(gx, gy + 1, gz);
          const len = Math.hypot(nx, ny, nz);
          if (len === 0) continue;

          // Camera direction in object space, pointing at the object.
          const camX = -v.sin;
          const camZ = v.cos;
          const facing = (nx * camX + nz * camZ) / len;
          const score = facing;
          if (score <= bestScore[i]) continue;

          const y = (gy + 0.5) * unitsPerPlate;
          const px = Math.round(v.centreX + p.u * v.pixelsPerUnit);
          const py = Math.round(v.bottomY - y * v.pixelsPerUnit);
          if (px < 0 || py < 0 || px >= v.width || py >= v.height) continue;
          const si = py * v.width + px;
          if (!v.mask[si]) continue;

          bestScore[i] = score;
          coloured[i] = 1;
          rgb[i * 3] = v.rgba[si * 4];
          rgb[i * 3 + 1] = v.rgba[si * 4 + 1];
          rgb[i * 3 + 2] = v.rgba[si * 4 + 2];
        }
      }
    }
  }

  return { rgb, coloured };
}

/**
 * Fill in voxels no camera could see — inside the model, and in any pocket
 * every view happened to miss — by spreading the nearest known colour.
 */
export function fillUnseenColours(
  hull: HullResult,
  rgb: Uint8ClampedArray,
  coloured: Uint8Array,
): void {
  const { occupancy, sx, sy, sz } = hull;
  const n = sx * sy * sz;
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) if (coloured[i]) queue[tail++] = i;
  if (tail === 0) return;

  while (head < tail) {
    const p = queue[head++];
    const gx = p % sx;
    const gz = ((p / sx) | 0) % sz;
    const gy = (p / (sx * sz)) | 0;
    const push = (q: number, ok: boolean) => {
      if (!ok || occupancy[q] === 0 || coloured[q]) return;
      coloured[q] = 1;
      rgb[q * 3] = rgb[p * 3];
      rgb[q * 3 + 1] = rgb[p * 3 + 1];
      rgb[q * 3 + 2] = rgb[p * 3 + 2];
      queue[tail++] = q;
    };
    push(p - 1, gx > 0);
    push(p + 1, gx < sx - 1);
    push(p - sx, gz > 0);
    push(p + sx, gz < sz - 1);
    push(p - sx * sz, gy > 0);
    push(p + sx * sz, gy < sy - 1);
  }
}
