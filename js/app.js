/**
 * App shell: camera lifecycle, render loop and UI wiring.
 */

import { VisionPipeline, associateFacesToPersons } from './pipeline.js';
import { Overlay } from './overlay.js';
import {
  EmotionTracker, scoreEmotions, topEmotion,
  EMOTION_LABELS, EMOTION_COLORS,
} from './emotion.js';

const el = (id) => document.getElementById(id);

const dom = {
  video: el('video'),
  canvas: el('overlay'),
  gate: el('gate'),
  loader: el('loader'),
  loaderTitle: el('loaderTitle'),
  loaderNote: el('loaderNote'),
  progressBar: el('progressBar'),
  errorPanel: el('errorPanel'),
  errorMsg: el('errorMsg'),
  startBtn: el('startBtn'),
  retryBtn: el('retryBtn'),
  controls: el('controls'),
  readout: el('readout'),
  readoutLabel: el('readoutLabel'),
  readoutScore: el('readoutScore'),
  bars: el('bars'),
  fps: el('fps'),
  faceCount: el('faceCount'),
  liveDot: el('liveDot'),
  flipBtn: el('flipBtn'),
  personBtn: el('personBtn'),
  meshBtn: el('meshBtn'),
  mirrorBtn: el('mirrorBtn'),
  stopBtn: el('stopBtn'),
};

const overlay = new Overlay(dom.canvas);
const tracker = new EmotionTracker();

let pipeline = null;
let stream = null;
let running = false;
let facingMode = 'user';
let rafHandle = null;
let usingVFC = false;
let wakeLock = null;

const fpsMeter = { last: performance.now(), frames: 0, value: 0 };

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */

function showPanel(which) {
  for (const p of ['gate', 'loader', 'errorPanel']) {
    dom[p].classList.toggle('hidden', p !== which);
  }
}

function hidePanels() {
  for (const p of ['gate', 'loader', 'errorPanel']) dom[p].classList.add('hidden');
}

function setProgress(stage, fraction) {
  dom.loaderTitle.textContent = stage;
  dom.progressBar.style.width = `${Math.round(fraction * 100)}%`;
}

function fail(message) {
  console.error(message);
  dom.errorMsg.textContent = message;
  showPanel('errorPanel');
  dom.controls.classList.add('hidden');
  dom.readout.classList.add('hidden');
  dom.liveDot.classList.remove('live');
}

function buildBars() {
  dom.bars.innerHTML = '';
  for (const label of EMOTION_LABELS) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML =
      `<span class="name">${label}</span>` +
      `<span class="track"><span class="fill" data-fill="${label}" ` +
      `style="background:${EMOTION_COLORS[label]}"></span></span>` +
      `<span class="val" data-val="${label}">0%</span>`;
    dom.bars.appendChild(row);
  }
}

function updateBars(vec) {
  for (const label of EMOTION_LABELS) {
    const pct = Math.round((vec?.[label] ?? 0) * 100);
    dom.bars.querySelector(`[data-fill="${label}"]`).style.width = `${pct}%`;
    dom.bars.querySelector(`[data-val="${label}"]`).textContent = `${pct}%`;
  }
}

/** Keep the video's CSS flip, the overlay's coordinate flip and the button in sync. */
function applyMirror() {
  dom.video.classList.toggle('mirrored', overlay.mirror);
  dom.mirrorBtn.classList.toggle('active', overlay.mirror);
}

function toggle(btn, key) {
  const next = !overlay[key];
  overlay[key] = next;
  btn.classList.toggle('active', next);
  return next;
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

async function openCamera() {
  stopStream();
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (err?.name === 'OverconstrainedError') {
      // Fall back to whatever the device will give us.
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    } else {
      throw err;
    }
  }

  dom.video.srcObject = stream;
  // Safari needs both of these set as attributes before play() to keep the
  // preview inline instead of jumping to the native fullscreen player.
  dom.video.setAttribute('playsinline', '');
  dom.video.setAttribute('muted', '');
  await dom.video.play();

  await new Promise((resolve) => {
    if (dom.video.videoWidth) return resolve();
    dom.video.onloadedmetadata = () => resolve();
  });

  overlay.resize(dom.video.videoWidth, dom.video.videoHeight);
  // Rear camera should not be mirrored; front camera reads more naturally when it is.
  overlay.mirror = facingMode === 'user';
  applyMirror();
}

function stopStream() {
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
  }
  dom.video.srcObject = null;
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* not critical */ }
}

function releaseWakeLock() {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

/* ------------------------------------------------------------------ */
/* Render loop                                                         */
/* ------------------------------------------------------------------ */

function scheduleFrame() {
  if (!running) return;
  if (usingVFC) {
    rafHandle = dom.video.requestVideoFrameCallback(onFrame);
  } else {
    rafHandle = requestAnimationFrame(onFrame);
  }
}

function cancelFrame() {
  if (rafHandle == null) return;
  if (usingVFC) dom.video.cancelVideoFrameCallback?.(rafHandle);
  else cancelAnimationFrame(rafHandle);
  rafHandle = null;
}

function onFrame() {
  if (!running || !pipeline) return;

  const now = performance.now();

  if (dom.video.readyState >= 2 && dom.video.videoWidth) {
    overlay.resize(dom.video.videoWidth, dom.video.videoHeight);

    let result;
    try {
      result = pipeline.detect(dom.video, now);
    } catch (err) {
      // A single bad frame should not kill the session.
      console.warn('Inference error on frame:', err);
      scheduleFrame();
      return;
    }

    const { faces, persons } = result;

    const raw = faces.map((f) => ({
      cx: f.cx,
      cy: f.cy,
      vec: scoreEmotions(f.blendshapes),
    }));
    const smoothed = tracker.update(raw).map((t) => t.vec);
    const faceToPerson = associateFacesToPersons(faces, persons);

    overlay.draw(faces, persons, smoothed, faceToPerson);

    // Readout follows the largest face in frame.
    let primary = -1;
    let bestArea = 0;
    faces.forEach((f, i) => {
      const area = f.box.w * f.box.h;
      if (area > bestArea) { bestArea = area; primary = i; }
    });

    if (primary >= 0) {
      const emo = topEmotion(smoothed[primary]);
      dom.readoutLabel.textContent = emo.label;
      dom.readoutScore.textContent = `${Math.round(emo.score * 100)}% confidence`;
      updateBars(smoothed[primary]);
    } else {
      dom.readoutLabel.textContent = 'No face detected';
      dom.readoutScore.textContent = '';
      updateBars(null);
    }

    dom.faceCount.textContent =
      `${faces.length} face${faces.length === 1 ? '' : 's'} · ${persons.length} person${persons.length === 1 ? '' : 's'}`;

    fpsMeter.frames++;
    if (now - fpsMeter.last >= 500) {
      fpsMeter.value = (fpsMeter.frames * 1000) / (now - fpsMeter.last);
      fpsMeter.frames = 0;
      fpsMeter.last = now;
      dom.fps.textContent = `${fpsMeter.value.toFixed(0)} fps`;
    }
  }

  scheduleFrame();
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

async function start() {
  showPanel('loader');
  dom.loaderNote.textContent = 'Preparing the vision runtime';

  if (!navigator.mediaDevices?.getUserMedia) {
    fail('This browser does not expose a camera API. On iPhone, open the page in Safari.');
    return;
  }
  if (!window.isSecureContext) {
    fail('Camera access requires HTTPS. Open this page over https:// (or on localhost).');
    return;
  }

  try {
    if (!pipeline) {
      pipeline = await new VisionPipeline().load(setProgress);
      dom.loaderNote.textContent = `Faces on ${pipeline.delegate} · people on CPU`;
    }
  } catch (err) {
    fail(`Could not load the detection models. ${err?.message ?? err}`);
    return;
  }

  setProgress('Starting camera', 1);
  try {
    await openCamera();
  } catch (err) {
    fail(cameraErrorMessage(err));
    return;
  }

  usingVFC = typeof dom.video.requestVideoFrameCallback === 'function';
  tracker.reset();
  running = true;
  hidePanels();
  dom.controls.classList.remove('hidden');
  dom.readout.classList.remove('hidden');
  dom.liveDot.classList.add('live');
  requestWakeLock();
  scheduleFrame();
}

function stop() {
  running = false;
  cancelFrame();
  stopStream();
  releaseWakeLock();
  overlay.clear();
  tracker.reset();
  dom.controls.classList.add('hidden');
  dom.readout.classList.add('hidden');
  dom.liveDot.classList.remove('live');
  dom.fps.textContent = '-- fps';
  dom.faceCount.textContent = '0 faces';
  showPanel('gate');
}

function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Camera permission was denied. Enable it in Settings › Safari › Camera, then reload.';
    case 'NotFoundError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is already in use by another app. Close it and try again.';
    default:
      return `Could not start the camera. ${err?.message ?? err}`;
  }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

dom.startBtn.addEventListener('click', start);
dom.retryBtn.addEventListener('click', start);
dom.stopBtn.addEventListener('click', stop);

dom.flipBtn.addEventListener('click', async () => {
  if (!running) return;
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  cancelFrame();
  try {
    await openCamera();
    tracker.reset();
    scheduleFrame();
  } catch (err) {
    fail(cameraErrorMessage(err));
  }
});

dom.personBtn.addEventListener('click', () => toggle(dom.personBtn, 'showPersons'));
dom.meshBtn.addEventListener('click', () => toggle(dom.meshBtn, 'showMesh'));
dom.mirrorBtn.addEventListener('click', () => {
  overlay.mirror = !overlay.mirror;
  applyMirror();
});

// Pause inference while backgrounded; iOS suspends the video track anyway.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelFrame();
  } else if (running) {
    requestWakeLock();
    scheduleFrame();
  }
});

window.addEventListener('pagehide', stop);

buildBars();
