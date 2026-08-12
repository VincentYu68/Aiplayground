/// <reference lib="webworker" />

/**
 * Runs the generator off the main thread. A 48-stud model is tens of millions
 * of scoring operations; doing that inline would freeze the page for seconds
 * and make the settings sliders unusable.
 *
 * The segmentation model lives here too, for the same reason and one more: the
 * image embedding is several megabytes and is reused across every brush stroke
 * and box drag on a photo, so it wants to sit next to the code that consumes
 * it rather than be posted back and forth.
 */

import { generateModel } from '../core/build/pipeline';
import { segment } from '../core/image/segment';
import { hintsToPoints, maskBox, proposeBox } from '../core/image/propose';
import {
  clampBox,
  decodeMask,
  encodeImage,
  loadSam,
  samReady,
  type Embedding,
} from '../core/image/sam';
import {
  loadMonoDepth,
  monoDepthReady,
  MONODEPTH_BYTES,
  predictDepth,
} from '../core/image/monodepth';
import { loadRecogniser, recognise, recogniserReady } from '../core/recognise/recognise';
import { shapePriorFor } from '../core/recognise/shapePrior';
import type { Rect, SegmentEngine, WorkerRequest, WorkerResponse } from '../types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: WorkerResponse) => ctx.postMessage(msg);

/**
 * Encoded photos, keyed by view. Encoding is the expensive half (seconds in
 * WASM) and depends only on the pixels, so it is done once per photo and every
 * later edit re-runs only the decoder.
 */
const embeddings = new Map<number, Embedding>();
const EMBEDDING_LIMIT = 8;

function cacheEmbedding(viewId: number, embedding: Embedding): void {
  embeddings.set(viewId, embedding);
  while (embeddings.size > EMBEDDING_LIMIT) {
    const oldest = embeddings.keys().next().value;
    if (oldest === undefined) break;
    embeddings.delete(oldest);
  }
}

/**
 * Measured depth maps, keyed by the pixels they came from.
 *
 * Depth costs seconds in WASM and depends only on the photograph — not on the
 * mask, not on any slider — so re-running it every time someone nudges the width
 * would make the settings unusable. The key is a hash of the pixels rather than
 * a view id because the build message carries only pixels; that keeps the whole
 * mechanism inside the worker instead of threading an identifier through the
 * page for the sake of a cache.
 */
const depthMaps = new Map<number, Float32Array>();
const DEPTH_LIMIT = 8;

/** FNV-1a over a stride through the image, plus its shape. */
function pixelKey(rgba: Uint8ClampedArray, width: number, height: number): number {
  let h = 0x811c9dc5 ^ width ^ (height << 16);
  const stride = 4 * Math.max(1, Math.floor(rgba.length / 4 / 8192));
  for (let i = 0; i < rgba.length; i += stride) {
    h ^= rgba[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Whatever the depth model is doing, as one promise.
 *
 * A build must not race the download: starting before the weights land would
 * silently produce the inflated-silhouette fallback and look like a finished
 * answer. So the build waits, and if the load failed it carries on without it.
 */
let depthLoad: Promise<void> | null = null;
/** Why the depth model is not being used, when it is not. */
let depthFailure: string | null = null;

async function reliefFor(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Float32Array | undefined> {
  if (!depthLoad) return undefined;
  try {
    await depthLoad;
  } catch {
    return undefined;
  }
  if (!monoDepthReady()) return undefined;

  const key = pixelKey(rgba, width, height);
  const cached = depthMaps.get(key);
  if (cached) return cached;
  try {
    const relief = await predictDepth(rgba, width, height);
    depthMaps.set(key, relief);
    while (depthMaps.size > DEPTH_LIMIT) {
      const oldest = depthMaps.keys().next().value;
      if (oldest === undefined) break;
      depthMaps.delete(oldest);
    }
    return relief;
  } catch (error) {
    // A model that loaded but failed on this image is not worth losing the
    // build over; the bulge still produces something. It is still said out
    // loud, because the resulting shape is visibly worse.
    depthFailure = error instanceof Error ? error.message : String(error);
    post({
      type: 'model-unavailable',
      message: `The depth model failed on this photo, so the shape is guessed from the outline: ${depthFailure}`,
    });
    return undefined;
  }
}

function applyHints(mask: Uint8Array, hints: Uint8Array | null): void {
  if (!hints) return;
  for (let i = 0; i < mask.length; i++) {
    if (hints[i] === 1) mask[i] = 1;
    else if (hints[i] === 2) mask[i] = 0;
  }
}

async function segmentWithSam(
  request: Extract<WorkerRequest, { kind: 'segment' }>,
): Promise<{ mask: Uint8Array; box: Rect }> {
  const { viewId, rgba, width, height, rect, hints } = request;

  let embedding = embeddings.get(viewId);
  if (!embedding || embedding.width !== width || embedding.height !== height) {
    embedding = await encodeImage(rgba, width, height);
    cacheEmbedding(viewId, embedding);
  }

  // A box the user dragged is taken at face value; without one, guess — but
  // never let the guess grow to fill the frame, or SAM answers with the
  // background instead of the object.
  const box = rect
    ? clampBox(rect, width, height, 1)
    : proposeBox(rgba, width, height);

  const mask = await decodeMask(embedding, {
    box,
    points: hintsToPoints(hints, width, height),
  });
  // A painted stroke is an instruction, not a hint to weigh up.
  applyHints(mask, hints);
  return { mask, box };
}

function segmentWithGrabCut(
  request: Extract<WorkerRequest, { kind: 'segment' }>,
): { mask: Uint8Array; box: Rect | null } {
  const { mask } = segment(request.rgba, request.width, request.height, {
    threshold: request.threshold,
    rect: request.rect,
    hints: request.hints,
  });
  return { mask, box: request.rect ?? maskBox(mask, request.width, request.height) };
}

async function handleSegment(request: Extract<WorkerRequest, { kind: 'segment' }>): Promise<void> {
  const { viewId, seq } = request;
  let engine: SegmentEngine = 'grabcut';
  try {
    let outcome: { mask: Uint8Array; box: Rect | null };
    if (samReady()) {
      try {
        outcome = await segmentWithSam(request);
        engine = 'sam';
      } catch {
        // A model that loaded but failed on this image is not worth losing the
        // upload over; the old segmenter still produces something usable.
        outcome = segmentWithGrabCut(request);
      }
    } else {
      outcome = segmentWithGrabCut(request);
    }
    // Recognising the object needs the cut-out — an ImageNet model handed a
    // whole desk shot answers "desk" — so it runs after the segmenter, not in
    // parallel.
    //
    // It is also *posted* first, which matters more than it looks. The page
    // starts a build the moment a new cut-out lands, so sending the outline
    // first builds with whatever shape settings were already there and leaves
    // the prior to apply to the next build — one the user has to ask for. That
    // is what made a photographed mug come out as an extruded slab: revolve mode
    // was chosen correctly, a few hundred milliseconds after the model that
    // needed it had already been built.
    let recognised: Extract<WorkerResponse, { type: 'recognised' }> | null = null;
    if (recogniserReady()) {
      try {
        const what = await recognise(request.rgba, request.width, request.height, outcome.mask);
        recognised = {
          type: 'recognised',
          viewId,
          seq,
          label: what.label,
          confidence: what.labelConfidence,
          prior: shapePriorFor(what),
        };
      } catch {
        // A failed guess is not worth surfacing; the defaults still apply.
      }
    }
    if (recognised) post(recognised);
    post({ type: 'segmented', viewId, seq, mask: outcome.mask, engine, box: outcome.box });
  } catch (error) {
    post({
      type: 'segment-error',
      viewId,
      seq,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Build, with the depth map attached to the photo the user framed.
 *
 * Only the first view gets one. With two or more photographs the shape is
 * carved from the silhouettes, which is measured geometry that a relative depth
 * map cannot improve on, so paying seconds per extra photo would buy nothing.
 */
async function handleBuild(request: Extract<WorkerRequest, { kind: 'build' }>): Promise<void> {
  const { id, views, options } = request;
  try {
    let relief: Float32Array | undefined;
    if (views.length === 1 && depthLoad) {
      post({ id, type: 'progress', stage: 'Measuring depth', fraction: 0.02 });
      relief = await reliefFor(views[0].rgba, views[0].width, views[0].height);
    }
    const withDepth = views.map((v, i) => (i === 0 && relief ? { ...v, relief } : v));
    const result = generateModel(withDepth, options, (stage, fraction) => {
      post({ id, type: 'progress', stage, fraction });
    });
    post({ id, type: 'done', result });
  } catch (error) {
    post({
      id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (request.kind === 'configure') {
    // The classifier is small and independent; a failure to load it must not
    // stop the segmentation model from arriving.
    void loadRecogniser({ classifier: request.urls.classifier }).catch(() => {});

    // Two independent downloads, one progress bar. Reporting them separately
    // would make the depth weights — the larger half of the wait — look like a
    // second, unexplained stall after the segmenter said it was ready.
    const samBytes = 14_132_462 + 4_735_539;
    const total = samBytes + MONODEPTH_BYTES;
    let samLoaded = 0;
    let depthLoaded = 0;
    const report = () => post({ type: 'model-progress', loaded: samLoaded + depthLoaded, total });

    depthLoad = loadMonoDepth(
      { runtime: request.urls.runtime, depth: request.urls.depth },
      (loaded) => {
        depthLoaded = loaded;
        report();
      },
    );
    // Nothing awaits this here; the build path does, and an unhandled rejection
    // in a worker takes the whole worker down.
    //
    // It is reported rather than merely swallowed. Falling back to the bulge
    // silently is how a car came out three studs deep with a 95% silhouette
    // score next to it and nothing anywhere saying the depth model had not
    // been used: the shape is much worse and every number still looks fine.
    depthLoad.catch((error: unknown) => {
      depthFailure = error instanceof Error ? error.message : String(error);
      post({
        type: 'model-unavailable',
        message: `Depth model unavailable, so the shape is guessed from the outline instead of measured: ${depthFailure}`,
      });
    });

    loadSam(request.urls, (loaded) => {
      samLoaded = loaded;
      report();
    })
      .then(() => post({ type: 'model-ready' }))
      .catch((error) =>
        post({
          type: 'model-unavailable',
          message: `Running on the built-in outliner: the cut-out model could not be loaded (${
            error instanceof Error ? error.message : String(error)
          }). Drawing a box around the object helps it a lot.`,
        }),
      );
    return;
  }

  if (request.kind === 'segment') {
    void handleSegment(request);
    return;
  }

  void handleBuild(request);
});
