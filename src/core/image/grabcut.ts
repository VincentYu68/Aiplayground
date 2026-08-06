/**
 * GrabCut: iterated colour models plus a global min-cut.
 *
 * The previous segmenter scored each pixel on its own — distance to the nearest
 * background colour versus the nearest foreground colour — and then thresholded.
 * That has no notion of a boundary, so it speckles wherever the two populations
 * overlap and its edges wander wherever lighting shifts.
 *
 * This minimises one energy over the whole image instead:
 *
 *     E(labels) = Σ_p  −log P(colour_p | model of its label)      (fit)
 *               + Σ_pq  γ · exp(−β‖I_p − I_q‖²) · [label_p ≠ label_q]   (edges)
 *
 * The first term is a full-covariance Gaussian mixture per label, so a colour
 * is judged against the *shape* of each population rather than its centroid.
 * The second charges for every boundary the labelling draws, discounted where
 * the image itself has a strong edge — so the cut is cheap exactly along real
 * object outlines and expensive through flat regions. Because a min-cut solves
 * it globally, single stray pixels never survive: they would cost boundary on
 * all sides for one pixel's worth of fit.
 *
 * The models and the labelling are refined against each other for a few
 * rounds, which is what lets it start from nothing more than "the border is
 * probably background".
 */

import { fitGmm, negLogProb, type Gmm } from './gmm';
import { MaxFlow } from './maxflow';
import { boxBlur } from './raster';

/** Pixel is free to take either label. */
export const UNKNOWN = 0;
/** Pixel is pinned to the object. */
export const DEFINITE_FG = 1;
/** Pixel is pinned to the background. */
export const DEFINITE_BG = 2;

export interface GrabCutOptions {
  /** Blur radius applied before measuring edges; 0 disables it. */
  edgeBlur: number;
  /** Rounds of (refit models, recut). */
  iterations: number;
  /** Weight on boundary length. Higher is smoother and less detailed. */
  gamma: number;
  /** Mixture components per label. */
  components: number;
  /**
   * Pushes the decision toward background when positive, in nats of fit cost.
   * This is what the sensitivity slider drives.
   */
  bias: number;
}

export const DEFAULT_GRABCUT: GrabCutOptions = {
  // Denoising the edge term was an attempt to stop the trivial labelling
  // winning on low-contrast photos. It worked, but by eroding exactly the thin
  // structures — a chair leg, a handle — that are hardest to keep. The real
  // cause was the boundary weight below, so this stays off.
  edgeBlur: 0,
  iterations: 4,
  /**
   * Boundary-length weight. Set by sweeping it against low-contrast objects,
   * thin protrusions and objects that fade into the background: above about 6
   * the cheapest labelling on a low-contrast photo becomes "no boundary at
   * all", and the cut collapses to entirely background. Three keeps speckle
   * suppressed with a wide margin before that cliff.
   */
  gamma: 3,
  components: 5,
  bias: 0,
};

/** Capacities are integers so the flow always terminates; this is the scale. */
const SCALE = 64;
/** Cost of violating a pinned pixel: never worth paying. */
const PINNED = 1 << 28;

/**
 * Neighbour offsets: 8-connected, taken once per pair. Diagonals are weighted
 * by 1/√2 for their longer step, which keeps the boundary from preferring
 * staircases over clean diagonals.
 */
const NEIGHBOURS: Array<[number, number, number]> = [
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, Math.SQRT1_2],
  [-1, 1, Math.SQRT1_2],
];

/**
 * A lightly smoothed copy, used only for the boundary term.
 *
 * The smoothness weight is calibrated against the *average* neighbour
 * difference in the image. Where sensor noise is comparable to the contrast
 * between object and background, that average is mostly noise: every edge then
 * looks equally expensive, including the real one, and the cheapest labelling
 * becomes the trivial one — no boundary anywhere, everything background. A
 * one-pixel blur costs nothing in boundary accuracy at this resolution and
 * removes the failure entirely.
 *
 * The data term still sees the unblurred colours, so fine texture continues to
 * inform which population a pixel belongs to.
 */
function smoothForEdges(
  lab: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  if (radius <= 0) return lab;
  const out = new Float32Array(lab.length);
  const channel = new Float32Array(width * height);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < width * height; i++) channel[i] = lab[i * 3 + c];
    const blurred = boxBlur(channel, width, height, radius, 1);
    for (let i = 0; i < width * height; i++) out[i * 3 + c] = blurred[i];
  }
  return out;
}

/**
 * How sharply the smoothness term reacts to image contrast: the reciprocal of
 * twice the mean squared neighbour difference, so it adapts to each photo
 * rather than assuming a fixed contrast.
 */
function estimateBeta(lab: Float32Array, width: number, height: number): number {
  let total = 0;
  let pairs = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        total +=
          (lab[i * 3] - lab[j * 3]) ** 2 +
          (lab[i * 3 + 1] - lab[j * 3 + 1]) ** 2 +
          (lab[i * 3 + 2] - lab[j * 3 + 2]) ** 2;
        pairs++;
      }
    }
  }
  if (pairs === 0 || total === 0) return 1;
  return 1 / (2 * (total / pairs));
}

export interface GrabCutResult {
  /** 1 for object, 0 for background. */
  labels: Uint8Array;
  foreground: Gmm;
  background: Gmm;
}

/**
 * @param initial optional starting labelling. It matters more than it looks:
 * the first model fit is made from it, and if it calls every unpinned pixel
 * foreground then the foreground model is born full of background colours and
 * never fully recovers. Seeding it from where the object probably is costs
 * nothing and fixes the case where object and background tones overlap.
 */
export function grabCut(
  lab: Float32Array,
  width: number,
  height: number,
  trimap: Uint8Array,
  optionsIn: Partial<GrabCutOptions> = {},
  initial?: Uint8Array,
): GrabCutResult {
  const options = { ...DEFAULT_GRABCUT, ...optionsIn };
  const n = width * height;

  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (trimap[i] === DEFINITE_BG) labels[i] = 0;
    else if (trimap[i] === DEFINITE_FG) labels[i] = 1;
    else labels[i] = initial ? initial[i] : 1;
  }

  // Boundary costs are measured on a denoised copy; see smoothForEdges.
  const edgeLab = smoothForEdges(lab, width, height, options.edgeBlur);
  const beta = estimateBeta(edgeLab, width, height);

  // Precompute the shape of the boundary cost once, at unit weight. The weight
  // itself is applied per attempt so it can be backed off (see below).
  const edgeFrom: number[] = [];
  const edgeTo: number[] = [];
  const edgeBase: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      for (const [dx, dy, scale] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        const d2 =
          (edgeLab[i * 3] - edgeLab[j * 3]) ** 2 +
          (edgeLab[i * 3 + 1] - edgeLab[j * 3 + 1]) ** 2 +
          (edgeLab[i * 3 + 2] - edgeLab[j * 3 + 2]) ** 2;
        edgeFrom.push(i);
        edgeTo.push(j);
        edgeBase.push(scale * Math.exp(-beta * d2));
      }
    }
  }

  const fgIndex = new Int32Array(n);
  const bgIndex = new Int32Array(n);
  let foreground = fitGmm(lab, fgIndex, 0, options.components);
  let background = fitGmm(lab, bgIndex, 0, options.components);

  let gamma = options.gamma;

  for (let round = 0; round < options.iterations; round++) {
    let fgCount = 0;
    let bgCount = 0;
    for (let i = 0; i < n; i++) {
      if (labels[i]) fgIndex[fgCount++] = i;
      else bgIndex[bgCount++] = i;
    }
    // Nothing to separate — leave the labelling as it stands.
    if (fgCount === 0 || bgCount === 0) break;

    foreground = fitGmm(lab, fgIndex, fgCount, options.components);
    background = fitGmm(lab, bgIndex, bgCount, options.components);

    /**
     * Cut, and back the boundary weight off if the answer is degenerate.
     *
     * Boundary cost scales with the object's perimeter while the data term
     * scales with its area, so on a low-contrast photo there is a weight above
     * which "no boundary anywhere" — everything background — is genuinely the
     * cheaper labelling. That cliff moves with image size and contrast, so no
     * fixed weight avoids it on every photo. Halving the weight until the cut
     * says something is the object turns a silent total failure into a slightly
     * softer boundary.
     */
    // "Degenerate" has to mean *nearly* empty, not exactly empty: at the cliff
    // the cut does not return zero foreground, it returns a handful of pixels,
    // which is just as useless and sails through a `> 0` test.
    const minForeground = Math.max(4, Math.round(n * 0.005));
    let accepted: Uint8Array | null = null;
    let best: Uint8Array | null = null;
    let bestCount = -1;

    for (let attempt = 0; attempt < 6 && !accepted; attempt++) {
      const flow = new MaxFlow(n, edgeBase.length);
      for (let e = 0; e < edgeBase.length; e++) {
        const w = Math.max(1, Math.round(edgeBase[e] * gamma * SCALE));
        flow.addEdge(edgeFrom[e], edgeTo[e], w, w);
      }
      for (let i = 0; i < n; i++) {
        if (trimap[i] === DEFINITE_FG) {
          flow.addTerminals(i, PINNED, 0);
        } else if (trimap[i] === DEFINITE_BG) {
          flow.addTerminals(i, 0, PINNED);
        } else {
          const l = lab[i * 3];
          const a = lab[i * 3 + 1];
          const b = lab[i * 3 + 2];
          // Source side is foreground, so the edge to the sink carries the cost
          // of *being* foreground, and vice versa.
          const costFg = negLogProb(foreground, l, a, b) + options.bias;
          const costBg = negLogProb(background, l, a, b);
          flow.addTerminals(
            i,
            Math.max(0, Math.round(costBg * SCALE)),
            Math.max(0, Math.round(costFg * SCALE)),
          );
        }
      }
      flow.compute();
      const side = flow.sourceSide();

      let fg = 0;
      for (let i = 0; i < n; i++) if (side[i]) fg++;

      const labelling = new Uint8Array(n);
      for (let i = 0; i < n; i++) labelling[i] = side[i] ? 1 : 0;
      if (fg > bestCount) {
        bestCount = fg;
        best = labelling;
      }
      if (fg >= minForeground) accepted = labelling;
      else gamma /= 2;
    }
    // Nothing convincing at any weight: take the fullest attempt rather than
    // hand back an empty mask.
    if (!accepted) accepted = best;
    if (!accepted) break;

    let changed = 0;
    for (let i = 0; i < n; i++) {
      if (accepted[i] !== labels[i]) changed++;
      labels[i] = accepted[i];
    }
    // Converged: another round would return the same cut.
    if (changed === 0) break;
  }

  return { labels, foreground, background };
}

/**
 * Sharpen an upscaled labelling back to full resolution.
 *
 * The cut runs at reduced resolution for speed, which leaves the boundary
 * quantised to that grid. The colour models are resolution-independent though,
 * so the pixels in a narrow band around the boundary can be re-decided against
 * the full-resolution image — a few sweeps of iterated conditional modes,
 * using the same fit-versus-boundary trade-off as the cut itself.
 */
export function refineBoundary(
  lab: Float32Array,
  width: number,
  height: number,
  labels: Uint8Array,
  trimap: Uint8Array,
  foreground: Gmm,
  background: Gmm,
  bandRadius: number,
  gamma: number,
): void {
  const n = width * height;
  const beta = estimateBeta(lab, width, height);

  // Only pixels near the current boundary are in play.
  const band = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const here = labels[i];
      let edge = false;
      for (const [dx, dy] of NEIGHBOURS) {
        for (const s of [1, -1]) {
          const nx = x + dx * s;
          const ny = y + dy * s;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (labels[ny * width + nx] !== here) {
            edge = true;
            break;
          }
        }
        if (edge) break;
      }
      if (edge) band[i] = 1;
    }
  }
  for (let pass = 0; pass < bandRadius; pass++) {
    const grown = Uint8Array.from(band);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!band[y * width + x]) continue;
        for (const [dx, dy] of NEIGHBOURS) {
          for (const s of [1, -1]) {
            const nx = x + dx * s;
            const ny = y + dy * s;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            grown[ny * width + nx] = 1;
          }
        }
      }
    }
    band.set(grown);
  }

  for (let sweep = 0; sweep < 3; sweep++) {
    let changed = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!band[i] || trimap[i] !== UNKNOWN) continue;

        const l = lab[i * 3];
        const a = lab[i * 3 + 1];
        const b = lab[i * 3 + 2];
        let costFg = negLogProb(foreground, l, a, b);
        let costBg = negLogProb(background, l, a, b);

        for (const [dx, dy, scale] of NEIGHBOURS) {
          for (const s of [1, -1]) {
            const nx = x + dx * s;
            const ny = y + dy * s;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const j = ny * width + nx;
            const d2 =
              (l - lab[j * 3]) ** 2 + (a - lab[j * 3 + 1]) ** 2 + (b - lab[j * 3 + 2]) ** 2;
            const w = gamma * scale * Math.exp(-beta * d2);
            if (labels[j]) costBg += w;
            else costFg += w;
          }
        }

        const next = costFg < costBg ? 1 : 0;
        if (next !== labels[i]) {
          labels[i] = next;
          changed++;
        }
      }
    }
    if (changed === 0) break;
  }
}
