/**
 * Copy the onnxruntime WASM runtime out of node_modules into public/.
 *
 * It has to sit on disk because the dev server and the production build both
 * serve it as a plain static file — we deliberately use onnxruntime's
 * external-wasm entry point so the 13MB binary is cached by the browser
 * separately from the app bundle, instead of being inlined into it.
 *
 * It is copied rather than committed because it is a build output of a
 * dependency: committing it would mean a stale binary silently surviving an
 * onnxruntime upgrade.
 */

import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const to = join(root, 'public', 'ort');
const files = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

if (!existsSync(from)) {
  console.error('onnxruntime-web is not installed; run npm install first');
  process.exit(1);
}

mkdirSync(to, { recursive: true });
for (const file of files) {
  const src = join(from, file);
  const dst = join(to, file);
  if (existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs) continue;
  copyFileSync(src, dst);
  console.log(`ort: ${file}`);
}
