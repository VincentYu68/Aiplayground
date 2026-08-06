/**
 * Gaussian mixture colour models.
 *
 * A single nearest-cluster test asks "which colour is this pixel closest to",
 * which throws away the two things that actually separate an object from its
 * background: how *spread out* each colour population is, and how much of the
 * image each one accounts for. A shadow on a white wall is far from the wall's
 * mean and still obviously wall, because the wall's distribution is wide in
 * lightness and narrow in hue. A full-covariance mixture captures that; a
 * centroid cannot.
 *
 * Fitted in CIE L*a*b* so that distances mean roughly the same thing in every
 * part of the space, and with hard component assignment — the variant GrabCut
 * itself uses, which is both faster and steadier than soft EM at this size.
 */

const DIMS = 3;
/** Keeps a degenerate component (a flat colour patch) from blowing up. */
const COVARIANCE_FLOOR = 1e-3;

export interface Gmm {
  k: number;
  /** Share of the samples each component holds. */
  weight: Float64Array;
  mean: Float64Array;
  /** Inverse covariance, 9 entries per component. */
  inverse: Float64Array;
  /** log(det(covariance)) per component. */
  logDet: Float64Array;
}

function invert3x3(m: number[], out: Float64Array, offset: number): number {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    // Fall back to an isotropic blob rather than producing NaNs downstream.
    out.fill(0, offset, offset + 9);
    out[offset] = 1;
    out[offset + 4] = 1;
    out[offset + 8] = 1;
    return 0;
  }
  const inv = 1 / det;
  out[offset] = (e * i - f * h) * inv;
  out[offset + 1] = (c * h - b * i) * inv;
  out[offset + 2] = (b * f - c * e) * inv;
  out[offset + 3] = (f * g - d * i) * inv;
  out[offset + 4] = (a * i - c * g) * inv;
  out[offset + 5] = (c * d - a * f) * inv;
  out[offset + 6] = (d * h - e * g) * inv;
  out[offset + 7] = (b * g - a * h) * inv;
  out[offset + 8] = (a * e - b * d) * inv;
  return det;
}

/**
 * Fit `k` components to Lab samples held in a flat array, using the indices in
 * `members` (so a label map can be handed in without copying the pixels).
 */
export function fitGmm(lab: Float32Array, members: Int32Array, count: number, k: number): Gmm {
  const kk = Math.max(1, Math.min(k, Math.max(1, count)));
  const gmm: Gmm = {
    k: kk,
    weight: new Float64Array(kk),
    mean: new Float64Array(kk * DIMS),
    inverse: new Float64Array(kk * 9),
    logDet: new Float64Array(kk),
  };
  if (count === 0) {
    gmm.weight[0] = 1;
    for (let c = 0; c < kk; c++) {
      gmm.inverse[c * 9] = 1;
      gmm.inverse[c * 9 + 4] = 1;
      gmm.inverse[c * 9 + 8] = 1;
    }
    return gmm;
  }

  // Deterministic farthest-point seeding: no RNG, so a given photo always
  // segments the same way.
  const centres = new Float64Array(kk * DIMS);
  const first = members[0] * DIMS;
  centres[0] = lab[first];
  centres[1] = lab[first + 1];
  centres[2] = lab[first + 2];
  for (let c = 1; c < kk; c++) {
    let bestIdx = members[0];
    let bestDist = -1;
    for (let s = 0; s < count; s++) {
      const p = members[s] * DIMS;
      let nearest = Infinity;
      for (let q = 0; q < c; q++) {
        const d =
          (lab[p] - centres[q * DIMS]) ** 2 +
          (lab[p + 1] - centres[q * DIMS + 1]) ** 2 +
          (lab[p + 2] - centres[q * DIMS + 2]) ** 2;
        if (d < nearest) nearest = d;
      }
      if (nearest > bestDist) {
        bestDist = nearest;
        bestIdx = members[s];
      }
    }
    centres[c * DIMS] = lab[bestIdx * DIMS];
    centres[c * DIMS + 1] = lab[bestIdx * DIMS + 1];
    centres[c * DIMS + 2] = lab[bestIdx * DIMS + 2];
  }

  const assign = new Int32Array(count);
  for (let iteration = 0; iteration < 6; iteration++) {
    for (let s = 0; s < count; s++) {
      const p = members[s] * DIMS;
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const d =
          (lab[p] - centres[c * DIMS]) ** 2 +
          (lab[p + 1] - centres[c * DIMS + 1]) ** 2 +
          (lab[p + 2] - centres[c * DIMS + 2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assign[s] = best;
    }
    const sums = new Float64Array(kk * DIMS);
    const counts = new Int32Array(kk);
    for (let s = 0; s < count; s++) {
      const p = members[s] * DIMS;
      const c = assign[s];
      sums[c * DIMS] += lab[p];
      sums[c * DIMS + 1] += lab[p + 1];
      sums[c * DIMS + 2] += lab[p + 2];
      counts[c]++;
    }
    for (let c = 0; c < kk; c++) {
      if (counts[c] === 0) continue;
      centres[c * DIMS] = sums[c * DIMS] / counts[c];
      centres[c * DIMS + 1] = sums[c * DIMS + 1] / counts[c];
      centres[c * DIMS + 2] = sums[c * DIMS + 2] / counts[c];
    }
  }

  // Component statistics: weight, mean and full covariance.
  const counts = new Int32Array(kk);
  const sums = new Float64Array(kk * DIMS);
  const products = new Float64Array(kk * 9);
  for (let s = 0; s < count; s++) {
    const p = members[s] * DIMS;
    const c = assign[s];
    counts[c]++;
    for (let a = 0; a < DIMS; a++) {
      sums[c * DIMS + a] += lab[p + a];
      for (let b = 0; b < DIMS; b++) {
        products[c * 9 + a * DIMS + b] += lab[p + a] * lab[p + b];
      }
    }
  }

  for (let c = 0; c < kk; c++) {
    const n = counts[c];
    gmm.weight[c] = n / count;
    if (n === 0) {
      gmm.inverse[c * 9] = 1;
      gmm.inverse[c * 9 + 4] = 1;
      gmm.inverse[c * 9 + 8] = 1;
      gmm.logDet[c] = 0;
      continue;
    }
    const cov: number[] = new Array(9);
    for (let a = 0; a < DIMS; a++) {
      gmm.mean[c * DIMS + a] = sums[c * DIMS + a] / n;
    }
    for (let a = 0; a < DIMS; a++) {
      for (let b = 0; b < DIMS; b++) {
        cov[a * DIMS + b] =
          products[c * 9 + a * DIMS + b] / n -
          gmm.mean[c * DIMS + a] * gmm.mean[c * DIMS + b];
      }
    }
    cov[0] += COVARIANCE_FLOOR;
    cov[4] += COVARIANCE_FLOOR;
    cov[8] += COVARIANCE_FLOOR;
    const det = invert3x3(cov, gmm.inverse, c * 9);
    gmm.logDet[c] = det > 0 ? Math.log(det) : 0;
  }

  return gmm;
}

/**
 * Cost of explaining a colour with this model: -log of the mixture density,
 * dropping the constants that are the same for both models.
 */
export function negLogProb(gmm: Gmm, l: number, a: number, b: number): number {
  let total = 0;
  for (let c = 0; c < gmm.k; c++) {
    const w = gmm.weight[c];
    if (w <= 0) continue;
    const dl = l - gmm.mean[c * DIMS];
    const da = a - gmm.mean[c * DIMS + 1];
    const db = b - gmm.mean[c * DIMS + 2];
    const inv = gmm.inverse;
    const o = c * 9;
    const mahalanobis =
      dl * (dl * inv[o] + da * inv[o + 3] + db * inv[o + 6]) +
      da * (dl * inv[o + 1] + da * inv[o + 4] + db * inv[o + 7]) +
      db * (dl * inv[o + 2] + da * inv[o + 5] + db * inv[o + 8]);
    total += (w / Math.sqrt(Math.exp(gmm.logDet[c]))) * Math.exp(-0.5 * mahalanobis);
  }
  return total > 1e-30 ? -Math.log(total) : 69; // -log(1e-30)
}
