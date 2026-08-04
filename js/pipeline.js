/**
 * MediaPipe Tasks Vision setup and per-frame inference.
 *
 * Two models run against the camera stream:
 *   - FaceLandmarker  — 478 landmarks + 52 blendshapes per face, every frame.
 *   - ObjectDetector  — person bounding boxes, every Nth frame (people move
 *                       slowly relative to expressions, and it is the more
 *                       expensive of the two).
 *
 * Everything is vendored locally under ../vendor and ../models so the app has
 * no third-party runtime dependency and works from any static host.
 */

import {
  FilesetResolver,
  FaceLandmarker,
  ObjectDetector,
} from '../vendor/tasks-vision/vision_bundle.mjs';

// These are fetched as URLs rather than imported as modules, so they resolve
// against the *document* base unless anchored explicitly. Anchoring to
// import.meta.url keeps them correct no matter where index.html is served
// from (repo root, a /docs subpath, a project Pages URL, ...).
const asset = (p) => new URL(p, import.meta.url).href;

const WASM_PATH  = asset('../vendor/tasks-vision/wasm');
const FACE_MODEL = asset('../models/face_landmarker.task');
const OBJ_MODEL  = asset('../models/efficientdet_lite0.tflite');

export const MAX_FACES = 5;

/** Run the person detector once every N frames. */
const PERSON_INTERVAL = 3;

/**
 * Fetch a model with byte-level progress so the 20 MB first load is not a
 * blank screen. MediaPipe accepts the bytes directly via modelAssetBuffer.
 */
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url} (HTTP ${res.status})`);

  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) {
    onProgress?.(1);
    return new Uint8Array(await res.arrayBuffer());
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(Math.min(1, received / total));
  }

  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export class VisionPipeline {
  constructor() {
    this.faceLandmarker = null;
    this.objectDetector = null;
    this.frame = 0;
    this.lastPersons = [];
    this.lastFaceTs = -1;
    this.lastObjTs = -1;
    this.delegate = null;
  }

  /**
   * @param {(stage: string, fraction: number) => void} [onProgress]
   */
  async load(onProgress) {
    onProgress?.('Loading vision runtime', 0);
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    onProgress?.('Loading vision runtime', 1);

    onProgress?.('Downloading face model', 0);
    const faceBuf = await fetchWithProgress(FACE_MODEL, (f) =>
      onProgress?.('Downloading face model', f));

    onProgress?.('Downloading person model', 0);
    const objBuf = await fetchWithProgress(OBJ_MODEL, (f) =>
      onProgress?.('Downloading person model', f));

    onProgress?.('Starting models', 0);

    // Face landmarker is float16 and behaves correctly on the WebGL delegate,
    // so prefer GPU and fall back to CPU only if it fails to initialise (some
    // older iOS/Android WebViews).
    for (const delegate of ['GPU', 'CPU']) {
      try {
        this.faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: faceBuf, delegate },
          runningMode: 'VIDEO',
          numFaces: MAX_FACES,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: false,
          minFaceDetectionConfidence: 0.4,
          minFacePresenceConfidence: 0.4,
          minTrackingConfidence: 0.4,
        });
        this.delegate = delegate;
        break;
      } catch (err) {
        this.faceLandmarker?.close?.();
        this.faceLandmarker = null;
        if (delegate === 'CPU') throw err;
        console.warn('GPU delegate unavailable for face landmarker, using CPU:', err);
      }
    }

    // Object detector is pinned to CPU on purpose. This EfficientDet build is
    // int8-quantised, and TFLite's WebGL delegate mishandles that quantisation:
    // it returns confident but wrong classes (a person scores as "dining
    // table") rather than failing outright, so there is nothing to catch. On
    // CPU the same model goes through XNNPACK, which is both correct and quick
    // for int8 — and it only runs every PERSON_INTERVAL frames.
    this.objectDetector = await ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: objBuf, delegate: 'CPU' },
      runningMode: 'VIDEO',
      scoreThreshold: 0.45,
      maxResults: 8,
      categoryAllowlist: ['person'],
    });

    onProgress?.('Ready', 1);
    return this;
  }

  /**
   * Run inference on the current video frame.
   * @param {HTMLVideoElement} video
   * @param {number} nowMs monotonic timestamp
   * @returns {{faces: Array, persons: Array}} in video-pixel coordinates
   */
  detect(video, nowMs) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return { faces: [], persons: this.lastPersons };

    // Each task requires strictly increasing timestamps of its own.
    const faceTs = Math.max(nowMs, this.lastFaceTs + 1);
    this.lastFaceTs = faceTs;

    const faceRes = this.faceLandmarker.detectForVideo(video, faceTs);
    const faces = [];
    const landmarkSets = faceRes.faceLandmarks ?? [];

    for (let i = 0; i < landmarkSets.length; i++) {
      const lm = landmarkSets[i];
      if (!lm?.length) continue;

      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (const p of lm) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }

      faces.push({
        landmarks: lm,
        blendshapes: faceRes.faceBlendshapes?.[i] ?? null,
        // normalised centroid, used by the tracker
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        // pixel-space box
        box: {
          x: minX * w,
          y: minY * h,
          w: (maxX - minX) * w,
          h: (maxY - minY) * h,
        },
      });
    }

    if (this.frame % PERSON_INTERVAL === 0) {
      const objTs = Math.max(nowMs, this.lastObjTs + 1);
      this.lastObjTs = objTs;
      const objRes = this.objectDetector.detectForVideo(video, objTs);
      this.lastPersons = (objRes.detections ?? []).map((d) => ({
        box: {
          x: d.boundingBox.originX,
          y: d.boundingBox.originY,
          w: d.boundingBox.width,
          h: d.boundingBox.height,
        },
        score: d.categories?.[0]?.score ?? 0,
      }));
    }
    this.frame++;

    return { faces, persons: this.lastPersons };
  }

  close() {
    this.faceLandmarker?.close?.();
    this.objectDetector?.close?.();
    this.faceLandmarker = null;
    this.objectDetector = null;
  }
}

/**
 * Attach each face to the person box that best contains it.
 * @returns {Array<number|null>} person index per face, aligned to `faces`
 */
export function associateFacesToPersons(faces, persons, minOverlap = 0.5) {
  return faces.map((face) => {
    let best = null;
    let bestFrac = minOverlap;
    persons.forEach((p, pi) => {
      const frac = containedFraction(face.box, p.box);
      if (frac > bestFrac) { bestFrac = frac; best = pi; }
    });
    return best;
  });
}

/** Fraction of box `a` that lies inside box `b`. */
function containedFraction(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const area = a.w * a.h;
  return area > 0 ? inter / area : 0;
}
