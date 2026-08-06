/// <reference lib="webworker" />

/**
 * Runs the generator off the main thread. A 48-stud model is tens of millions
 * of scoring operations; doing that inline would freeze the page for seconds
 * and make the settings sliders unusable.
 */

import { generateModel } from '../core/build/pipeline';
import { segment } from '../core/image/segment';
import type { WorkerRequest, WorkerResponse } from '../types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: WorkerResponse) => ctx.postMessage(msg);

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (request.kind === 'segment') {
    const { viewId, seq } = request;
    try {
      const { mask } = segment(request.rgba, request.width, request.height, {
        threshold: request.threshold,
        rect: request.rect,
        hints: request.hints,
      });
      post({ type: 'segmented', viewId, seq, mask });
    } catch (error) {
      post({
        type: 'segment-error',
        viewId,
        seq,
        message: error instanceof Error ? error.message : String(error),
      });
    }
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
