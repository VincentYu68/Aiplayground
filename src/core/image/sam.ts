/**
 * Segment Anything, in the browser.
 *
 * The colour-model segmenter in `segment.ts` has no idea what an object is. It
 * groups pixels that look alike, which is why it merges an object with its own
 * shadow, wanders off onto the tablecloth, and loses a chair's legs — they are
 * thin, and thin things are cheap to delete when you are paying by boundary
 * length. On the benchmark in `bench/` it manages 75.8% mean IoU with no user
 * input, and a 60.4% boundary F1.
 *
 * SAM knows what objects are, because it was trained on a billion masks. Given
 * a box that actually bounds the object it scores 96.1% / 96.9% on the same
 * scenes. That is not a tuning difference, it is a different kind of answer.
 *
 * Two things about it are worth knowing before changing anything here.
 *
 * The model is split in half on purpose. The encoder is the expensive part and
 * depends only on the photo; the decoder is ~65ms and depends on the prompt. So
 * a photo is encoded once and then re-decoded on every box drag or brush
 * stroke, which is what makes the editor feel live rather than a 1s wait per
 * edit as GrabCut was.
 *
 * The prompt has to be a real box. SAM answers the question "what object is in
 * this box", so a box covering the whole frame is the question "what is this
 * scene", and it will faithfully answer with the background. Benchmarked: a box
 * inflated 15% beyond the object drops the mean IoU from 96.1% to 11.4%, and a
 * frame-filling box gives 1.1%. `clampBox` exists solely to make that
 * unreachable from the automatic path.
 */

import type { Mask } from './raster';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Point {
  x: number;
  y: number;
  /** 1 keeps the pixel, 0 pushes it out. */
  label: 0 | 1;
}

export interface SamUrls {
  /** Directory holding the onnxruntime .wasm/.mjs pair, with trailing slash. */
  runtime: string;
  encoder: string;
  decoder: string;
}

/** Side length the encoder was trained at; not negotiable. */
const INPUT_SIZE = 1024;
const PIXEL_MEAN = [123.675, 116.28, 103.53];
const PIXEL_STD = [58.395, 57.12, 57.375];

/** The embedding for one photo, plus what is needed to map coordinates into it. */
export interface Embedding {
  tensor: unknown;
  /** Factor taking original pixels to the 1024-frame the encoder saw. */
  scale: number;
  width: number;
  height: number;
}

type Ort = typeof import('onnxruntime-web/wasm');

let ortPromise: Promise<Ort> | null = null;
let encoderSession: unknown = null;
let decoderSession: unknown = null;

export interface LoadProgress {
  (loaded: number, total: number): void;
}

async function fetchWithProgress(url: string, onProgress?: LoadProgress): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length') ?? 0);
  if (!response.body || !total || !onProgress) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

/**
 * Load the runtime and both graphs. Safe to call repeatedly; the work happens
 * once. Throws if anything is unreachable, and callers are expected to fall
 * back to `segment()` rather than fail the whole upload.
 */
export async function loadSam(urls: SamUrls, onProgress?: LoadProgress): Promise<void> {
  if (encoderSession && decoderSession) return;
  if (!ortPromise) ortPromise = import('onnxruntime-web/wasm') as Promise<Ort>;
  const ort = await ortPromise;

  ort.env.wasm.wasmPaths = urls.runtime;
  // GitHub Pages cannot send the COOP/COEP headers that SharedArrayBuffer
  // needs, so threads are unavailable no matter what we ask for.
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';

  // Weights dominate the download, so progress is reported over their bytes.
  const encoderBytes = 14_132_462;
  const decoderBytes = 4_735_539;
  const totalBytes = encoderBytes + decoderBytes;
  let encoderLoaded = 0;
  let decoderLoaded = 0;
  const report = () => onProgress?.(encoderLoaded + decoderLoaded, totalBytes);

  const [encoderBuffer, decoderBuffer] = await Promise.all([
    fetchWithProgress(urls.encoder, (n) => {
      encoderLoaded = n;
      report();
    }),
    fetchWithProgress(urls.decoder, (n) => {
      decoderLoaded = n;
      report();
    }),
  ]);

  const options = { executionProviders: ['wasm'] as const, graphOptimizationLevel: 'all' as const };
  encoderSession = await ort.InferenceSession.create(new Uint8Array(encoderBuffer), options);
  decoderSession = await ort.InferenceSession.create(new Uint8Array(decoderBuffer), options);
}

export function samReady(): boolean {
  return encoderSession !== null && decoderSession !== null;
}

/** Free the sessions; used by tests and when falling back for good. */
export function unloadSam(): void {
  encoderSession = null;
  decoderSession = null;
}

/**
 * Bilinear resample into the encoder's frame.
 *
 * Uses the half-pixel convention — destination centres map to source centres —
 * which is what the reference implementation's resize does. Getting this wrong
 * shifts every mask by half a pixel against the photo it came from.
 */
function preprocess(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const scale = INPUT_SIZE / Math.max(width, height);
  const dstW = Math.max(1, Math.round(width * scale));
  const dstH = Math.max(1, Math.round(height * scale));
  const plane = INPUT_SIZE * INPUT_SIZE;
  const out = new Float32Array(3 * plane); // zero padding, bottom and right

  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(height - 1, Math.max(0, ((y + 0.5) * height) / dstH - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(width - 1, Math.max(0, ((x + 0.5) * width) / dstW - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;

      const i00 = (y0 * width + x0) * 4;
      const i01 = (y0 * width + x1) * 4;
      const i10 = (y1 * width + x0) * 4;
      const i11 = (y1 * width + x1) * 4;
      const dst = y * INPUT_SIZE + x;

      for (let c = 0; c < 3; c++) {
        const top = rgba[i00 + c] * (1 - fx) + rgba[i01 + c] * fx;
        const bottom = rgba[i10 + c] * (1 - fx) + rgba[i11 + c] * fx;
        const v = top * (1 - fy) + bottom * fy;
        out[c * plane + dst] = (v - PIXEL_MEAN[c]) / PIXEL_STD[c];
      }
    }
  }
  return out;
}

export async function encodeImage(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Embedding> {
  if (!encoderSession) throw new Error('SAM is not loaded');
  const ort = await ortPromise!;
  const data = preprocess(rgba, width, height);
  const input = new ort.Tensor('float32', data, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const session = encoderSession as import('onnxruntime-web/wasm').InferenceSession;
  const output = await session.run({ image: input });
  return {
    tensor: output[session.outputNames[0]],
    scale: INPUT_SIZE / Math.max(width, height),
    width,
    height,
  };
}

/**
 * Keep a proposed box from growing into "the whole picture".
 *
 * The centre is kept and only the extent is limited, because the centre of a
 * rough proposal is reliable — the photographer aimed at the object — while its
 * edges are not, since they chase shadows and clutter to the frame border.
 */
export function clampBox(box: Box, width: number, height: number, maxFraction = 0.85): Box {
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const w = Math.min(box.x1 - box.x0, width * maxFraction);
  const h = Math.min(box.y1 - box.y0, height * maxFraction);
  const clampedCx = Math.min(Math.max(cx, w / 2), width - w / 2);
  const clampedCy = Math.min(Math.max(cy, h / 2), height - h / 2);
  return {
    x0: clampedCx - w / 2,
    y0: clampedCy - h / 2,
    x1: clampedCx + w / 2,
    y1: clampedCy + h / 2,
  };
}

export interface Prompt {
  box: Box;
  points?: Point[];
}

export async function decodeMask(embedding: Embedding, prompt: Prompt): Promise<Mask> {
  if (!decoderSession) throw new Error('SAM is not loaded');
  const ort = await ortPromise!;
  const { scale, width, height } = embedding;

  // Labels 2 and 3 mark a box's two corners; 1 and 0 are keep/drop points.
  const coords: number[] = [
    prompt.box.x0 * scale,
    prompt.box.y0 * scale,
    prompt.box.x1 * scale,
    prompt.box.y1 * scale,
  ];
  const labels: number[] = [2, 3];
  for (const p of prompt.points ?? []) {
    coords.push(p.x * scale, p.y * scale);
    labels.push(p.label);
  }
  const n = labels.length;

  const session = decoderSession as import('onnxruntime-web/wasm').InferenceSession;
  const output = await session.run({
    image_embeddings: embedding.tensor as import('onnxruntime-web/wasm').Tensor,
    point_coords: new ort.Tensor('float32', Float32Array.from(coords), [1, n, 2]),
    point_labels: new ort.Tensor('float32', Float32Array.from(labels), [1, n]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
    orig_im_size: new ort.Tensor('float32', Float32Array.from([height, width]), [2]),
  });

  // Four mask tokens come back. Token 0 is the model's single best answer;
  // 1..3 are the ambiguity candidates meant for bare point prompts, and
  // choosing among those by predicted score measured slightly *worse* here
  // (95.4% against 96.1%) because it sometimes returns a sub-part.
  const masks = output[session.outputNames[0]];
  const logits = masks.data as Float32Array;
  const pixels = width * height;
  const mask = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) mask[i] = logits[i] > 0 ? 1 : 0;
  return mask;
}
