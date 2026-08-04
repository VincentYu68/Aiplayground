/**
 * Canvas rendering of person boxes, face boxes, contours and emotion labels.
 *
 * All drawing happens in video-pixel space (the canvas backing store matches
 * videoWidth x videoHeight), so detector output needs no rescaling. When the
 * preview is mirrored, x coordinates are flipped here rather than via a CSS
 * transform on the canvas — a CSS flip would mirror the label text too.
 */

import { FaceLandmarker } from '../vendor/tasks-vision/vision_bundle.mjs';
import { EMOTION_COLORS, EMOTION_EMOJI, topEmotion } from './emotion.js';

const PERSON_COLOR = '#4f8cff';

export class Overlay {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mirror = true;
    this.showPersons = true;
    this.showMesh = false;
  }

  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Flip an x coordinate when mirroring is on. */
  fx(x) {
    return this.mirror ? this.canvas.width - x : x;
  }

  /** Flip a box's origin when mirroring is on. */
  fbox(b) {
    return this.mirror
      ? { x: this.canvas.width - (b.x + b.w), y: b.y, w: b.w, h: b.h }
      : b;
  }

  get scale() {
    // Keep stroke widths and type legible across 480p .. 1080p inputs.
    return Math.max(1, this.canvas.width / 640);
  }

  /**
   * @param {Array} faces      pipeline faces (pixel-space boxes)
   * @param {Array} persons    pipeline person detections
   * @param {Array} emotions   smoothed emotion vectors, aligned to `faces`
   * @param {Array} faceToPerson person index per face, or null
   */
  draw(faces, persons, emotions, faceToPerson) {
    this.clear();
    const s = this.scale;

    // Person boxes first, so face annotations sit on top.
    if (this.showPersons) {
      persons.forEach((p, pi) => {
        const owner = faceToPerson.indexOf(pi);
        const emo = owner >= 0 ? topEmotion(emotions[owner]) : null;
        const color = emo ? EMOTION_COLORS[emo.label] : PERSON_COLOR;
        this.strokeBox(this.fbox(p.box), color, 2 * s, 10 * s);

        const b = this.fbox(p.box);
        const text = emo
          ? `${EMOTION_EMOJI[emo.label]} ${emo.label} ${Math.round(emo.score * 100)}%`
          : 'person (no face)';
        this.label(b.x, b.y, text, color, s, 'above');
      });
    }

    faces.forEach((face, fi) => {
      const emo = topEmotion(emotions[fi]);
      const color = EMOTION_COLORS[emo.label];

      if (this.showMesh) this.contours(face.landmarks, color, s);

      const b = this.fbox(face.box);
      this.strokeBox(b, color, 1.5 * s, 6 * s, 0.85);

      // If this face has no person box, it carries its own label.
      if (!this.showPersons || faceToPerson[fi] === null) {
        const text = `${EMOTION_EMOJI[emo.label]} ${emo.label} ${Math.round(emo.score * 100)}%`;
        this.label(b.x, b.y, text, color, s, 'above');
      }
    });
  }

  strokeBox(b, color, width, radius, alpha = 1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const r = Math.min(radius, b.w / 2, b.h / 2);
    if (ctx.roundRect) {
      ctx.roundRect(b.x, b.y, b.w, b.h, r);
    } else {
      ctx.rect(b.x, b.y, b.w, b.h);
    }
    ctx.stroke();
    ctx.restore();
  }

  label(x, y, text, color, s, placement = 'above') {
    const ctx = this.ctx;
    const fontSize = Math.round(13 * s);
    const padX = 7 * s;
    const padY = 5 * s;

    ctx.save();
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`;
    ctx.textBaseline = 'top';

    const w = ctx.measureText(text).width + padX * 2;
    const h = fontSize + padY * 2;

    let bx = x;
    let by = placement === 'above' ? y - h - 4 * s : y + 4 * s;
    // Keep the chip on screen.
    if (by < 0) by = y + 4 * s;
    bx = Math.max(0, Math.min(bx, this.canvas.width - w));
    by = Math.max(0, Math.min(by, this.canvas.height - h));

    ctx.fillStyle = 'rgba(8, 10, 15, 0.78)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, w, h, 6 * s);
    else ctx.rect(bx, by, w, h);
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * s;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, bx + padX, by + padY);
    ctx.restore();
  }

  contours(landmarks, color, s) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(0.8, 1 * s);
    ctx.beginPath();
    for (const c of CONNECTORS) {
      const a = landmarks[c.start];
      const b = landmarks[c.end];
      if (!a || !b) continue;
      ctx.moveTo(this.fx(a.x * W), a.y * H);
      ctx.lineTo(this.fx(b.x * W), b.y * H);
    }
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Facial contours only (oval, brows, eyes, irises, lips) — roughly 140 line
 * segments. The full tesselation is ~2600 segments and is far too expensive to
 * stroke every frame on a phone.
 */
const CONNECTORS = [
  ...FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
  ...FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
  ...FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
  ...FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,
  ...FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,
  ...FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS,
  ...FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS,
  ...FaceLandmarker.FACE_LANDMARKS_LIPS,
];
