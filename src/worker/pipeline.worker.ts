/// <reference lib="webworker" />

/**
 * Runs the generator off the main thread. A 48-stud model is tens of millions
 * of scoring operations; doing that inline would freeze the page for seconds
 * and make the settings sliders unusable.
 */

import { generateModel } from '../core/build/pipeline';
import type { WorkerRequest, WorkerResponse } from '../types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const { id, views, options } = event.data;
  const post = (msg: WorkerResponse) => ctx.postMessage(msg);

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
