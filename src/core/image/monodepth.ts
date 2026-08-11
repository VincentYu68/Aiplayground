/**
 * Monocular depth, in the browser.
 *
 * The thing this replaces is worth naming, because it looked plausible for a
 * long time: depth used to be *invented* from the silhouette's distance
 * transform. Points deep inside the outline were thick, points near the edge
 * tapered. That is a pillow, not a shape — every object came out as an inflated
 * version of its own outline, which is why finished models read as a featureless
 * loaf the moment you orbited them.
 *
 * Depth Anything V2 was trained on 62M images and does know what a car looks
 * like from the side: it puts the wheels in front of the body and the greenhouse
 * behind it. That structure is the entire difference between a red loaf and
 * something that reads as a car.
 *
 * Three things about it matter to the caller.
 *
 * The output is **inverse relative depth**: larger means nearer, and the scale
 * and shift are arbitrary and differ from photo to photo. There is no metric
 * depth in here and no way to get one from a single image without knowing the
 * camera. Everything downstream treats it as *relief* — the shape of the surface
 * facing the camera — and never as a distance.
 *
 * The input size is baked into the export at 518x518 and cannot be changed
 * without re-exporting from the PyTorch checkpoint. The reference preprocessing
 * squashes the image to that square rather than letter-boxing it, so the aspect
 * ratio is deliberately not preserved and is restored on the way out.
 *
 * It is 35MB and takes seconds in WASM. Callers load it in the background and
 * are expected to fall back to `estimateDepth`'s bulge rather than fail an
 * upload — a worse shape is better than no model.
 */

/** Side length the export was frozen at; changing it needs a new export. */
const INPUT_SIZE = 518;
/** ImageNet statistics, as fractions of 1 — the reference normalises in 0..1. */
const PIXEL_MEAN = [0.485, 0.456, 0.406];
const PIXEL_STD = [0.229, 0.224, 0.225];

export interface MonoDepthUrls {
  /** Directory holding the onnxruntime .wasm/.mjs pair, with trailing slash. */
  runtime: string;
  depth: string;
}

export interface LoadProgress {
  (loaded: number, total: number): void;
}

type Ort = typeof import('onnxruntime-web/wasm');

let ortPromise: Promise<Ort> | null = null;
let session: unknown = null;
let inputName = 'l_x_';

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

/** Weights, for the progress bar — the download dwarfs everything else. */
export const MONODEPTH_BYTES = 35_322_347;

/**
 * Load the runtime and the graph. Safe to call repeatedly; the work happens
 * once. Throws if the weights are unreachable, and callers are expected to fall
 * back to the geometric bulge rather than fail the build.
 */
export async function loadMonoDepth(urls: MonoDepthUrls, onProgress?: LoadProgress): Promise<void> {
  if (session) return;
  if (!ortPromise) ortPromise = import('onnxruntime-web/wasm') as Promise<Ort>;
  const ort = await ortPromise;

  ort.env.wasm.wasmPaths = urls.runtime;
  // Same constraint as the segmenter: GitHub Pages cannot send the COOP/COEP
  // headers SharedArrayBuffer needs, so threads are unavailable regardless.
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';

  const buffer = await fetchWithProgress(urls.depth, onProgress);
  const created = await ort.InferenceSession.create(new Uint8Array(buffer), {
    executionProviders: ['wasm'] as const,
    graphOptimizationLevel: 'all' as const,
  });
  // The exporter named the input `l_x_` and the quantiser preserved it, but
  // that is an artefact of the tracer rather than a contract, so it is read
  // back rather than hardcoded.
  inputName = created.inputNames[0];
  session = created;
}

export function monoDepthReady(): boolean {
  return session !== null;
}

/** Free the session; used by tests and when falling back for good. */
export function unloadMonoDepth(): void {
  session = null;
}

/**
 * Squash into the model's frame.
 *
 * Deliberately does *not* preserve the aspect ratio: the reference
 * implementation resizes straight to 518x518, and the network's position
 * embeddings were interpolated for that grid at export time. Letter-boxing
 * instead would hand it a black border it has never seen and which it reads as
 * a wall behind the object.
 *
 * Half-pixel convention — destination centres map to source centres — matching
 * the segmenter's resample so the two agree about where a pixel is.
 */
function preprocess(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const plane = INPUT_SIZE * INPUT_SIZE;
  const out = new Float32Array(3 * plane);

  for (let y = 0; y < INPUT_SIZE; y++) {
    const sy = Math.min(height - 1, Math.max(0, ((y + 0.5) * height) / INPUT_SIZE - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < INPUT_SIZE; x++) {
      const sx = Math.min(width - 1, Math.max(0, ((x + 0.5) * width) / INPUT_SIZE - 0.5));
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
        const v = (top * (1 - fy) + bottom * fy) / 255;
        out[c * plane + dst] = (v - PIXEL_MEAN[c]) / PIXEL_STD[c];
      }
    }
  }
  return out;
}

/** Bilinear resample the square prediction back onto the photo's pixel grid. */
function resampleToImage(
  depth: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(INPUT_SIZE - 1, Math.max(0, ((y + 0.5) * INPUT_SIZE) / height - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(INPUT_SIZE - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(INPUT_SIZE - 1, Math.max(0, ((x + 0.5) * INPUT_SIZE) / width - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(INPUT_SIZE - 1, x0 + 1);
      const fx = sx - x0;
      const top = depth[y0 * INPUT_SIZE + x0] * (1 - fx) + depth[y0 * INPUT_SIZE + x1] * fx;
      const bottom = depth[y1 * INPUT_SIZE + x0] * (1 - fx) + depth[y1 * INPUT_SIZE + x1] * fx;
      out[y * width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

/**
 * Inverse relative depth for one photo, on the photo's own pixel grid.
 *
 * Larger is nearer. Scale and shift are arbitrary; only differences within one
 * image mean anything, and even those are only ordinal.
 */
export async function predictDepth(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Float32Array> {
  if (!session) throw new Error('The depth model is not loaded');
  const ort = await ortPromise!;
  const active = session as import('onnxruntime-web/wasm').InferenceSession;
  const input = new ort.Tensor('float32', preprocess(rgba, width, height), [
    1,
    3,
    INPUT_SIZE,
    INPUT_SIZE,
  ]);
  const output = await active.run({ [inputName]: input });
  const raw = output[active.outputNames[0]].data as Float32Array;
  return resampleToImage(raw, width, height);
}
