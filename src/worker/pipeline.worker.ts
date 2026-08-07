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
    post({ type: 'segmented', viewId, seq, mask: outcome.mask, engine, box: outcome.box });

    // Recognising the object needs the cut-out — an ImageNet model handed a
    // whole desk shot answers "desk" — so it runs after, not in parallel.
    if (recogniserReady()) {
      try {
        const what = await recognise(request.rgba, request.width, request.height, outcome.mask);
        post({
          type: 'recognised',
          viewId,
          seq,
          label: what.label,
          confidence: what.labelConfidence,
          prior: shapePriorFor(what),
        });
      } catch {
        // A failed guess is not worth surfacing; the defaults still apply.
      }
    }
  } catch (error) {
    post({
      type: 'segment-error',
      viewId,
      seq,
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
    loadSam(request.urls, (loaded, total) => post({ type: 'model-progress', loaded, total }))
      .then(() => post({ type: 'model-ready' }))
      .catch((error) =>
        post({
          type: 'model-unavailable',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    return;
  }

  if (request.kind === 'segment') {
    void handleSegment(request);
    return;
  }

  const { id, views, options } = request;
  try {
    const result = generateModel(views, options, (stage, fraction) => {
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
});
