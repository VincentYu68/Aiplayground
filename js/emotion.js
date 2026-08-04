/**
 * Emotion estimation from MediaPipe FaceLandmarker blendshapes.
 *
 * The landmarker emits 52 ARKit-style blendshape activations per face (0..1).
 * Each emotion below is a weighted vote over those activations: `pos` terms
 * push the score up, `neg` terms pull it down so that co-occurring signals
 * cancel (a smile should suppress "angry" even while the brows are lowered).
 *
 * This is a rule-based estimate, not a trained classifier. It reads strong,
 * posed expressions well and is deliberately conservative about subtle ones —
 * weak activations fall back to "neutral" via NEUTRAL_BIAS.
 */

export const EMOTION_LABELS = [
  'neutral', 'happy', 'surprised', 'angry', 'sad', 'fearful', 'disgusted',
];

export const EMOTION_COLORS = {
  neutral:   '#8b93a7',
  happy:     '#34d67a',
  surprised: '#ffc53d',
  angry:     '#ff5c6c',
  sad:       '#4f8cff',
  fearful:   '#b46cff',
  disgusted: '#5ad1c4',
};

export const EMOTION_EMOJI = {
  neutral: '😐', happy: '🙂', surprised: '😮', angry: '😠',
  sad: '🙁', fearful: '😨', disgusted: '🤢',
};

/** Baseline score assigned to "neutral"; expressions must beat this to win. */
const NEUTRAL_BIAS = 0.22;

/** Sharpening exponent applied before normalising to confidences. */
const SHARPEN = 1.6;

const RULES = {
  happy: {
    pos: [
      ['mouthSmileLeft', 1.6], ['mouthSmileRight', 1.6],
      ['cheekSquintLeft', 0.7], ['cheekSquintRight', 0.7],
      ['mouthDimpleLeft', 0.3], ['mouthDimpleRight', 0.3],
    ],
    neg: [
      ['mouthFrownLeft', 0.9], ['mouthFrownRight', 0.9],
      ['browInnerUp', 0.3],
    ],
  },
  surprised: {
    pos: [
      ['jawOpen', 1.2], ['browInnerUp', 1.0],
      ['browOuterUpLeft', 0.7], ['browOuterUpRight', 0.7],
      ['eyeWideLeft', 0.8], ['eyeWideRight', 0.8],
    ],
    neg: [
      ['mouthSmileLeft', 0.6], ['mouthSmileRight', 0.6],
      ['browDownLeft', 0.9], ['browDownRight', 0.9],
    ],
  },
  angry: {
    pos: [
      ['browDownLeft', 1.4], ['browDownRight', 1.4],
      ['eyeSquintLeft', 0.5], ['eyeSquintRight', 0.5],
      ['mouthPressLeft', 0.6], ['mouthPressRight', 0.6],
      ['noseSneerLeft', 0.25], ['noseSneerRight', 0.25],
    ],
    neg: [
      ['mouthSmileLeft', 1.1], ['mouthSmileRight', 1.1],
      ['browInnerUp', 0.9], ['jawOpen', 0.3],
    ],
  },
  sad: {
    pos: [
      ['mouthFrownLeft', 1.4], ['mouthFrownRight', 1.4],
      ['browInnerUp', 1.0], ['mouthShrugLower', 0.5],
      ['eyeLookDownLeft', 0.15], ['eyeLookDownRight', 0.15],
    ],
    neg: [
      ['mouthSmileLeft', 1.2], ['mouthSmileRight', 1.2],
      ['jawOpen', 0.5], ['eyeWideLeft', 0.3], ['eyeWideRight', 0.3],
    ],
  },
  fearful: {
    pos: [
      ['eyeWideLeft', 1.1], ['eyeWideRight', 1.1],
      ['browInnerUp', 1.1], ['jawOpen', 0.7],
      ['mouthStretchLeft', 0.7], ['mouthStretchRight', 0.7],
    ],
    neg: [
      ['mouthSmileLeft', 0.9], ['mouthSmileRight', 0.9],
      ['browDownLeft', 0.5], ['browDownRight', 0.5],
    ],
  },
  disgusted: {
    pos: [
      ['noseSneerLeft', 1.5], ['noseSneerRight', 1.5],
      ['mouthUpperUpLeft', 0.8], ['mouthUpperUpRight', 0.8],
      ['browDownLeft', 0.4], ['browDownRight', 0.4],
    ],
    neg: [
      ['mouthSmileLeft', 0.7], ['mouthSmileRight', 0.7],
      ['browInnerUp', 0.4],
    ],
  },
};

/**
 * Turn a FaceLandmarker blendshape result into a normalised emotion vector.
 * @param {{categories: Array<{categoryName: string, score: number}>}} blendshapes
 * @returns {Record<string, number>} confidences summing to 1
 */
export function scoreEmotions(blendshapes) {
  const shape = new Map();
  if (blendshapes?.categories) {
    for (const c of blendshapes.categories) shape.set(c.categoryName, c.score);
  }
  const get = (n) => shape.get(n) ?? 0;

  const raw = { neutral: NEUTRAL_BIAS };

  for (const [emotion, rule] of Object.entries(RULES)) {
    let score = 0;
    for (const [name, w] of rule.pos) score += w * get(name);
    for (const [name, w] of rule.neg) score -= w * get(name);
    // Normalise by the positive weight mass so emotions with more terms
    // are not structurally favoured over ones with fewer.
    const mass = rule.pos.reduce((s, [, w]) => s + w, 0);
    raw[emotion] = Math.max(0, score / mass);
  }

  return normalise(raw);
}

function normalise(raw) {
  const out = {};
  let total = 0;
  for (const k of EMOTION_LABELS) {
    const v = Math.pow(raw[k] ?? 0, SHARPEN);
    out[k] = v;
    total += v;
  }
  if (total <= 0) {
    for (const k of EMOTION_LABELS) out[k] = k === 'neutral' ? 1 : 0;
    return out;
  }
  for (const k of EMOTION_LABELS) out[k] /= total;
  return out;
}

/** @returns {{label: string, score: number}} the winning emotion */
export function topEmotion(vec) {
  let label = 'neutral';
  let score = -1;
  for (const k of EMOTION_LABELS) {
    if (vec[k] > score) { score = vec[k]; label = k; }
  }
  return { label, score };
}

/**
 * Frame-to-frame face tracker with exponential smoothing.
 *
 * FaceLandmarker returns faces in an arbitrary order with no stable identity,
 * so raw per-frame labels flicker badly. This matches each detected face to
 * the nearest track from the previous frame (by normalised centroid) and
 * smooths that track's emotion vector over time.
 */
export class EmotionTracker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.alpha]      smoothing factor, higher = more reactive
   * @param {number} [opts.maxDist]    max normalised centroid distance to match
   * @param {number} [opts.maxMissing] frames a track survives without a match
   */
  constructor({ alpha = 0.3, maxDist = 0.18, maxMissing = 8 } = {}) {
    this.alpha = alpha;
    this.maxDist = maxDist;
    this.maxMissing = maxMissing;
    this.tracks = new Map();
    this.nextId = 1;
  }

  reset() {
    this.tracks.clear();
    this.nextId = 1;
  }

  /**
   * @param {Array<{cx: number, cy: number, vec: Record<string, number>}>} faces
   *        normalised centroids plus this frame's raw emotion vectors
   * @returns {Array<{id: number, vec: Record<string, number>}>} smoothed, input order
   */
  update(faces) {
    const unmatched = new Set(this.tracks.keys());
    const results = new Array(faces.length);

    // Greedy nearest-neighbour: shortest candidate pair wins first.
    const pairs = [];
    faces.forEach((face, fi) => {
      for (const id of unmatched) {
        const t = this.tracks.get(id);
        const d = Math.hypot(face.cx - t.cx, face.cy - t.cy);
        if (d <= this.maxDist) pairs.push({ d, fi, id });
      }
    });
    pairs.sort((a, b) => a.d - b.d);

    const takenFaces = new Set();
    const assign = new Map();
    for (const p of pairs) {
      if (takenFaces.has(p.fi) || !unmatched.has(p.id)) continue;
      takenFaces.add(p.fi);
      unmatched.delete(p.id);
      assign.set(p.fi, p.id);
    }

    faces.forEach((face, fi) => {
      let id = assign.get(fi);
      let track;
      if (id === undefined) {
        id = this.nextId++;
        track = { cx: face.cx, cy: face.cy, vec: { ...face.vec }, missing: 0 };
        this.tracks.set(id, track);
      } else {
        track = this.tracks.get(id);
        const a = this.alpha;
        for (const k of EMOTION_LABELS) {
          track.vec[k] = a * (face.vec[k] ?? 0) + (1 - a) * (track.vec[k] ?? 0);
        }
        track.cx = face.cx;
        track.cy = face.cy;
        track.missing = 0;
      }
      results[fi] = { id, vec: { ...track.vec } };
    });

    // Age out tracks that went unmatched this frame.
    for (const id of unmatched) {
      const t = this.tracks.get(id);
      if (++t.missing > this.maxMissing) this.tracks.delete(id);
    }

    return results;
  }
}
