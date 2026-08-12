/**
 * Real monocular depth, in node, through the app's own code.
 *
 * The benchmarks used to call `generateModel` with no depth map attached, which
 * meant they exercised the fallback bulge — a path no user hits now that the
 * weights ship. Every 3D number produced that way was measuring an algorithm
 * nobody runs.
 *
 * So this loads the same weights through the same `monodepth.ts` the worker
 * uses, with the same preprocessing, and hands the result to the pipeline the
 * same way the worker does. The only concession to node is that the runtime and
 * the weights are served over a loopback HTTP server, because `loadMonoDepth`
 * fetches URLs and node's fetch will not open a file path.
 *
 * Predictions are cached on disk. A forward pass is about twenty seconds here,
 * the network is deterministic, and a benchmark nobody wants to wait for is a
 * benchmark nobody runs.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMonoDepth, predictDepth } from '../../src/core/image/monodepth';

const CACHE = resolve('bench/out/corpus/relief');

/**
 * The weights, best first.
 *
 * The app serves an int8 quantisation, and that is what should be measured. It
 * does not load under the onnxruntime build node resolves — the quantiser left
 * `com.microsoft.nchwc` ops in the graph and the wasm backend has no kernel for
 * them — so an fp32 export is the fallback. Which one was used is reported with
 * every score rather than assumed, because they are not the same network and a
 * number from one does not transfer to the other.
 */
const WEIGHTS = [
  { name: 'int8 (as shipped)', path: resolve('public/models/depth-anything-v2-small-int8.onnx') },
  {
    name: 'fp32 (reference)',
    path: resolve(
      process.env.DEPTH_FP32 ??
        '/tmp/claude-0/-home-user-Aiplayground/71fc575b-1b01-5ad4-a232-5a5f19aae5d0/scratchpad/models/depth_anything_v2_vits.onnx',
    ),
  },
];

let loaded: string | null = null;

function serveLocal(files: Record<string, string>): Promise<{ base: string; close: () => void }> {
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const file = files[path];
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      response.writeHead(404).end();
      return;
    }
    const type = extname(file) === '.mjs' ? 'text/javascript' : 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'content-length': String(body.length) });
    response.end(body);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      done({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

/** Which weights are in use; null until the first prediction. */
export function depthWeights(): string | null {
  return loaded;
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  const runtimeDir = resolve('public/ort');
  const failures: string[] = [];
  for (const candidate of WEIGHTS) {
    if (!existsSync(candidate.path)) {
      failures.push(`${candidate.name}: not on disk`);
      continue;
    }
    const { base, close } = await serveLocal({ '/depth.onnx': candidate.path });
    try {
      // The two URLs need different schemes and there is no way around it. The
      // runtime is `import`ed, and node's ESM loader only opens file: and data:;
      // the weights go through `fetch`, and node's fetch only opens http:. The
      // browser is happy with one origin for both, which is why this looks odd.
      await loadMonoDepth({
        runtime: pathToFileURL(`${runtimeDir}/`).href,
        depth: `${base}/depth.onnx`,
      });
      loaded = candidate.name;
      close();
      return;
    } catch (error) {
      failures.push(`${candidate.name}: ${String(error).split('\n')[0]}`);
      close();
    }
  }
  throw new Error(`no depth weights would load\n  ${failures.join('\n  ')}`);
}

/**
 * Inverse relative depth for one photo, cached.
 *
 * The key covers the pixels, so a re-rendered corpus invalidates itself and
 * there is no stale-cache failure mode where a change to the photographs is
 * scored against the depth of the photographs they replaced.
 */
export async function reliefFor(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Float32Array> {
  await ensureLoaded();
  mkdirSync(CACHE, { recursive: true });
  const digest = createHash('sha1')
    .update(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength))
    .update(`${width}x${height}|${loaded}`)
    .digest('hex')
    .slice(0, 16);
  const file = join(CACHE, `${digest}.f32`);
  if (existsSync(file)) {
    const bytes = readFileSync(file);
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
  }
  const relief = await predictDepth(rgba, width, height);
  writeFileSync(file, Buffer.from(relief.buffer, relief.byteOffset, relief.byteLength));
  return relief;
}
