/**
 * Refuse to ship a model the browser cannot load.
 *
 * The depth weights were quantised through an ORT session set to
 * ORT_ENABLE_ALL, which does not only fold constants: it applies *layout*
 * transforms and serialises com.microsoft.nchwc fused ops into the graph. Those
 * are x86 CPU kernels. The model then loaded perfectly in node on the machine
 * that produced it and failed in every browser with
 *
 *   Fatal error: com.microsoft.nchwc:Conv(-1) is not a registered function/op
 *
 * which the app caught and quietly answered by falling back to the old
 * inflated-silhouette depth. The shape was visibly wrong, every number beside
 * it still read fine, and nothing in the build said a word.
 *
 * So the operator domains are checked here instead. onnxruntime-web's WASM
 * backend implements the standard operator set plus com.microsoft; a node in
 * any other domain is a kernel compiled for hardware a browser does not have.
 *
 *   node scripts/check-models.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'public/models';

/**
 * Domains onnxruntime-web's WASM backend actually implements.
 *
 * `com.microsoft` proper is fine — that is where the quantised MatMul lives,
 * and the WASM build ships those kernels. It is the hardware-specific
 * sub-domains (`com.microsoft.nchwc`) that are not there.
 */
const ALLOWED = new Set(['', 'ai.onnx', 'ai.onnx.ml', 'com.microsoft']);

// A hand-rolled reader rather than a dependency. Only three nested fields are
// needed and the alternative is pulling protobufjs into the build to read one
// string per node.
function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

/** Yield `[fieldNumber, wireType, value, nextPos]` over one message. */
function* fields(buf, start, end) {
  let pos = start;
  while (pos < end) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      yield [field, wire, [pos, pos + len]];
      pos += len;
    } else if (wire === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      yield [field, wire, value];
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
}

/** Every distinct `NodeProto.domain` in the model's graph. */
function nodeDomains(buf) {
  const found = new Set();
  // ModelProto.graph is field 7.
  for (const [f, w, v] of fields(buf, 0, buf.length)) {
    if (f !== 7 || w !== 2) continue;
    const [gStart, gEnd] = v;
    // GraphProto.node is field 1, repeated.
    for (const [gf, gw, gv] of fields(buf, gStart, gEnd)) {
      if (gf !== 1 || gw !== 2) continue;
      const [nStart, nEnd] = gv;
      let domain = '';
      // NodeProto.domain is field 7.
      for (const [nf, nw, nv] of fields(buf, nStart, nEnd)) {
        if (nf === 7 && nw === 2) domain = buf.toString('utf8', nv[0], nv[1]);
      }
      found.add(domain);
    }
  }
  return found;
}

let bad = 0;
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.onnx'))) {
  const found = nodeDomains(readFileSync(join(DIR, file)));
  const offending = [...found].filter((d) => !ALLOWED.has(d));
  if (offending.length) {
    console.error(`${file}: operator domains the browser cannot load: ${offending.join(', ')}`);
    bad++;
  } else {
    console.log(`${file}: ok (${[...found].map((d) => d || 'ai.onnx').join(', ')})`);
  }
}
if (bad) {
  console.error(
    '\nRe-export without ORT_ENABLE_ALL. ORT_ENABLE_BASIC folds the constants the\n' +
      'quantiser needs without baking in hardware-specific kernels.',
  );
  process.exit(1);
}
