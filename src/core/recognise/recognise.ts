/**
 * Recognising what the object is, so the shape can be more than a guess.
 *
 * Everything upstream of this reasons about pixels. SAM knows *that* something
 * is an object and where its edges are; it does not know it is a mug. That
 * distinction is what the reconstruction runs out of road on: from a single
 * photograph a cylinder and a box cast exactly the same rectangle, and no
 * amount of silhouette analysis can separate them. Only knowing what the thing
 * is can.
 *
 * Measured, that knowledge is worth a lot. `bench/run3d.ts` scores the model
 * against known solids; the best single fixed depth prior reaches 53.7% mean 3D
 * IoU, while an oracle allowed to pick the right prior per object reaches
 * 65.1%. The gains are concentrated exactly where geometry is blind — a flat
 * box gains 35 points, a ring 37, a teapot 20.
 *
 * MobileNetV2 supplies the label. It is not a large foundation model, but it is
 * 3.6MB quantised, it reuses the runtime SAM already loads, and ImageNet-1k
 * happens to cover the things people photograph on a table: coffee mug, wine
 * bottle, teapot, folding chair, vase, binder. Its top-k classes are pooled
 * into a handful of shape archetypes rather than trusted individually, since
 * "cup" and "coffee mug" disagree on the label and agree completely on the
 * shape.
 *
 * The result is a *suggestion*. It sets the shape controls the user could have
 * set themselves, it is shown as plain text ("Looks like a coffee mug"), and a
 * single click overrides it — which matters, because on unfamiliar objects the
 * classifier is confidently wrong and the user can see that instantly.
 */

import { ARCHETYPE_BY_CLASS, CLASS_NAMES } from './imagenet';

/** Where the classifier lives; same directory as the segmentation model. */
export interface RecogniseUrls {
  classifier: string;
}

/**
 * T turned on a lathe, R rounded/organic, B boxy, F flat, U unrecognised.
 */
export type Archetype = 'T' | 'R' | 'B' | 'F' | 'U';

export interface Recognition {
  /** Best-guess class name, for showing the user. */
  label: string;
  /** Confidence of that single class, 0..1. */
  labelConfidence: number;
  /** Winning archetype after pooling the top classes. */
  archetype: Archetype;
  /** Pooled probability behind the winning archetype, 0..1. */
  confidence: number;
}

const INPUT = 224;
// ImageNet's usual normalisation; the ONNX model zoo graph expects it.
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

type Ort = typeof import('onnxruntime-web/wasm');

let session: unknown = null;
let ortPromise: Promise<Ort> | null = null;

export function recogniserReady(): boolean {
  return session !== null;
}

export async function loadRecogniser(urls: RecogniseUrls): Promise<void> {
  if (session) return;
  if (!ortPromise) ortPromise = import('onnxruntime-web/wasm') as Promise<Ort>;
  const ort = await ortPromise;
  const response = await fetch(urls.classifier);
  if (!response.ok) throw new Error(`${urls.classifier}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
}

export function unloadRecogniser(): void {
  session = null;
}

/**
 * Crop to the object before classifying.
 *
 * ImageNet models expect the subject to fill the frame. Handing over the whole
 * photo asks "what is this scene", which on a desk shot answers "desk" — the
 * same failure mode SAM has with a frame-filling box. The cut-out is already
 * known by the time this runs, so the object's own bounding box is used, with a
 * little context around it because these models were trained on crops that
 * include some.
 */
function cropToObject(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8Array | null,
): Float32Array {
  let x0 = 0;
  let y0 = 0;
  let x1 = width - 1;
  let y1 = height - 1;
  if (mask) {
    x0 = width;
    y0 = height;
    x1 = -1;
    y1 = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!mask[y * width + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) {
      x0 = 0;
      y0 = 0;
      x1 = width - 1;
      y1 = height - 1;
    }
  }

  // Square the crop so nothing is stretched, with 12% context, clamped.
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const half = Math.max(x1 - x0, y1 - y0) * 0.5 * 1.12;
  const sx0 = cx - half;
  const sy0 = cy - half;
  const side = half * 2;

  const out = new Float32Array(3 * INPUT * INPUT);
  const plane = INPUT * INPUT;
  for (let y = 0; y < INPUT; y++) {
    const sy = sy0 + ((y + 0.5) / INPUT) * side - 0.5;
    const yy = Math.min(height - 1, Math.max(0, sy));
    const y0i = Math.floor(yy);
    const y1i = Math.min(height - 1, y0i + 1);
    const fy = yy - y0i;
    for (let x = 0; x < INPUT; x++) {
      const sx = sx0 + ((x + 0.5) / INPUT) * side - 0.5;
      const xx = Math.min(width - 1, Math.max(0, sx));
      const x0i = Math.floor(xx);
      const x1i = Math.min(width - 1, x0i + 1);
      const fx = xx - x0i;

      const i00 = (y0i * width + x0i) * 4;
      const i01 = (y0i * width + x1i) * 4;
      const i10 = (y1i * width + x0i) * 4;
      const i11 = (y1i * width + x1i) * 4;
      for (let c = 0; c < 3; c++) {
        const top = rgba[i00 + c] * (1 - fx) + rgba[i01 + c] * fx;
        const bottom = rgba[i10 + c] * (1 - fx) + rgba[i11 + c] * fx;
        const v = (top * (1 - fy) + bottom * fy) / 255;
        out[c * plane + y * INPUT + x] = (v - MEAN[c]) / STD[c];
      }
    }
  }
  return out;
}

export async function recognise(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8Array | null,
): Promise<Recognition> {
  if (!session) throw new Error('the classifier is not loaded');
  const ort = await ortPromise!;
  const s = session as import('onnxruntime-web/wasm').InferenceSession;
  const input = new ort.Tensor('float32', cropToObject(rgba, width, height, mask), [
    1,
    3,
    INPUT,
    INPUT,
  ]);
  const output = await s.run({ [s.inputNames[0]]: input });
  const logits = output[s.outputNames[0]].data as Float32Array;

  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
  let sum = 0;
  const probs = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    probs[i] = Math.exp(logits[i] - max);
    sum += probs[i];
  }

  // Pool the top classes by archetype: "cup" and "coffee mug" disagree on the
  // label and agree on the shape, which is the only part that is used.
  const order = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]).slice(0, 8);
  const pooled = new Map<Archetype, number>();
  for (const i of order) {
    const a = (ARCHETYPE_BY_CLASS[i] ?? 'U') as Archetype;
    pooled.set(a, (pooled.get(a) ?? 0) + probs[i] / sum);
  }
  let archetype: Archetype = 'U';
  let confidence = 0;
  for (const [a, p] of pooled) {
    // 'U' never wins a vote it merely participates in; an unrecognised class
    // is an absence of information, not evidence for a default shape.
    if (a !== 'U' && p > confidence) {
      confidence = p;
      archetype = a;
    }
  }

  const top = order[0];
  return {
    label: CLASS_NAMES[top] ?? 'something',
    labelConfidence: probs[top] / sum,
    archetype,
    confidence,
  };
}
