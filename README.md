# Mood Cam

A phone-friendly web app that takes your camera stream, detects the people in
frame, and annotates each visible face with its emotion — live, and entirely
on-device. No frame ever leaves the phone.

<!-- Face box + person box + emotion label, drawn on a live camera preview. -->

## Getting it on your iPhone

iOS only grants camera access over **HTTPS**, so the page has to be served from
a real origin — opening the files directly (`file://`) or over plain `http://`
will not work.

A GitHub Pages workflow is included. To turn it on, once:

1. Push this branch (already done if you're reading it on GitHub).
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Wait for the *Deploy to GitHub Pages* action to go green.
4. Open the resulting `https://<user>.github.io/<repo>/` URL in **Safari** on
   your phone and tap **Start camera**.

Add it to your home screen (Share → Add to Home Screen) and it opens fullscreen
without Safari's chrome.

> **First load pulls about 20 MB** of WebAssembly and model weights. Do it on
> Wi-Fi. It's cached afterwards, so subsequent launches are fast.

### Running it locally

Any static server works, and `localhost` counts as a secure context:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

To reach it from a phone on your LAN you still need HTTPS — use a tunnel
(`ngrok http 8000`, `cloudflared tunnel`, Tailscale Funnel) rather than the
raw LAN IP.

## What it does

Two models run against each camera frame:

| | model | runs | purpose |
|---|---|---|---|
| **Faces** | MediaPipe `FaceLandmarker` (float16, 3.7 MB) | every frame, GPU | 478 landmarks + 52 blendshapes per face, up to 5 faces |
| **People** | MediaPipe `ObjectDetector`, EfficientDet-Lite0 (int8, 4.6 MB) | every 3rd frame, CPU | full-body person boxes |

Each face is matched to the person box that best contains it, so the emotion
label rides on the person's box. People detected without a usable face (turned
away, too far) are still boxed and labelled `person (no face)`.

### How the emotion is derived

The landmarker emits 52 ARKit-style blendshape activations per face
(`mouthSmileLeft`, `browDownRight`, `jawOpen`, …). `js/emotion.js` turns those
into seven emotions with a weighted vote — each emotion has positive terms that
raise its score and negative terms that suppress it, so co-occurring signals
cancel rather than stack. A smile beats lowered brows, so a wry grin reads as
*happy* and not *angry*.

**This is a rule-based estimate, not a trained classifier.** It reads clear,
posed expressions well — smiles and surprise especially — and is deliberately
conservative about subtle ones: anything that fails to clear the `NEUTRAL_BIAS`
floor falls back to *neutral*. Expect it to be decent at happy/surprised/angry
and shakier at distinguishing sad from fearful. All the weights are in the
`RULES` table at the top of `js/emotion.js` and are meant to be tuned.

Raw per-frame labels flicker badly, so `EmotionTracker` matches faces between
frames by centroid and exponentially smooths each track's emotion vector.

```bash
node test/emotion.test.mjs   # no dependencies
```

## Controls

| | |
|---|---|
| **Flip** | switch between front and rear camera |
| **People** | show/hide the person boxes |
| **Mesh** | overlay facial contours (eyes, brows, lips, iris, jaw) |
| **Mirror** | selfie-mirror the preview; on by default for the front camera |
| **Stop** | release the camera |

The panel underneath shows the full seven-way emotion breakdown for the
largest face in frame.

## Layout

```
index.html            markup and UI shell
css/style.css         styling, safe-area insets, landscape tweaks
js/app.js             camera lifecycle, render loop, UI wiring
js/pipeline.js        MediaPipe setup, per-frame inference, face↔person matching
js/emotion.js         blendshape → emotion mapping + temporal smoothing
js/overlay.js         canvas rendering of boxes, contours and labels
models/               model weights
vendor/tasks-vision/  MediaPipe runtime, vendored — no CDN, no build step
```

There is no bundler and no install step: it is plain ES modules served as-is.

## Notes from building it

Two things are load-bearing and easy to regress:

- **The person detector is pinned to CPU on purpose.** This EfficientDet build
  is int8-quantised, and TFLite's WebGL delegate mishandles that quantisation —
  it does not error, it returns confident but *wrong* classes (a person scores
  as "dining table" at 0.41, while the same model on CPU gives "person" at
  0.95). Moving it to the GPU delegate will silently break person detection.
  XNNPACK handles int8 well, and it only runs every third frame.
- **The overlay mirrors its own coordinates rather than being CSS-flipped.**
  Flipping the canvas in CSS would mirror the label text too, so `#video` gets
  the `scaleX(-1)` and `overlay.mirror` flips x for the boxes. Those two must
  stay in sync or the annotations land in the wrong place — which is invisible
  when your subject is centred and obvious when they aren't.

Model paths are anchored to `import.meta.url`, not the document, so the app
works from a project-Pages subpath as well as a domain root.

## Verified

Tested headlessly in Chromium against a synthetic camera feed (a still driven
in through `--use-file-for-fake-video-capture`): models load, the loop runs,
one face and one person are detected, the emotion label and confidence bars
populate, and the boxes align in both mirrored and unmirrored states. The
emotion mapping and tracker have unit coverage in `test/`.

**Not tested on physical iPhone hardware** — that needs your device. The
iOS-specific pieces (the `playsinline` attributes, the user-gesture gate before
`getUserMedia`, safe-area insets, wake lock) are written to Safari's documented
requirements but are unverified in practice. Frame rate in headless software
rendering is ~3 fps and says nothing useful about a real phone GPU; expect
substantially better, and if it feels slow, raise `PERSON_INTERVAL` in
`js/pipeline.js` or drop `MAX_FACES`.
