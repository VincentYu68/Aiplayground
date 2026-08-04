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

## Live translation

Tap **Talk**. You speak, and the phone speaks back in the other language while
the camera keeps detecting faces and emotions.

The loop is speech → text → translation → speech:

| stage | what runs |
|---|---|
| recognition | `webkitSpeechRecognition` (Web Speech API) |
| translation | on-device Marian, or a cloud API — switchable |
| speech | `speechSynthesis`, best matching voice for the target language |

Direction is English ↔ Chinese; the chip in the panel swaps it. Swapping
re-arms the recogniser with the new source language and, on the on-device
engine, loads that direction's model.

It is **utterance-level, not simultaneous**. Interim words appear greyed as you
speak, but a phrase is only translated and spoken once the recogniser marks it
final — translating partial text would mean retracting audio already played.
Keep talking through a translation and the next utterance queues behind it.

Two details that matter in practice:

- **The mic goes deaf while the phone speaks.** Otherwise the speaker output is
  picked up and translated again, and it loops. `Interpreter` pauses recognition
  for the duration of playback and resumes after.
- **The vision loop halves its rate while a translation is in flight**, so
  speech stays responsive instead of competing with two neural nets for the CPU.

### Choosing an engine

**On-device** (default) — Marian/opus-mt through transformers.js. No key, no
account, nothing leaves the phone. One model per direction, roughly 40–80 MB,
downloaded on first use and cached.

Unlike the vision models, this path is **not** self-contained: transformers.js
and its ~31 MB onnxruntime-web dependency are far too large to vendor here, so
the runtime comes from a CDN and the weights from Hugging Face. The camera and
emotion pipeline remain fully local and work with no connection at all.

**Cloud** — Google Translate or OpenAI. Better quality, no download, any
language pair. The transcript text leaves the device.

Your key is typed into the app and kept in `localStorage` on that device. It is
never committed and never leaves the browser except as the `Authorization`
header to the provider you picked. **This repository is public — do not put a
key in the source.** Anyone loading the site supplies their own.

DeepL is deliberately absent: its API sends no CORS headers, so a browser cannot
call it from a static page without a server to proxy the request.

### Tuning

Model IDs live in `HF_MODELS` at the top of `js/translate.js`. If a download
404s, that is the place to correct it — see the caveat in *Verified* below.

## Controls

| | |
|---|---|
| **Flip** | switch between front and rear camera |
| **People** | show/hide the person boxes |
| **Mesh** | overlay facial contours (eyes, brows, lips, iris, jaw) |
| **Mirror** | selfie-mirror the preview; on by default for the front camera |
| **Talk** | start/stop live translation |
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
js/interpreter.js     speech → translate → speak loop, queueing, mic gating
js/speech.js          Web Speech recognition wrapper (restart, pause/resume)
js/translate.js       on-device and cloud translators behind one interface
js/tts.js             speechSynthesis wrapper, voice selection, iOS unlock
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

**Vision** — tested headlessly in Chromium against a synthetic camera feed (a
still driven in through `--use-file-for-fake-video-capture`): models load, the
loop runs, one face and one person are detected, the emotion label and
confidence bars populate, and the boxes align in both mirrored and unmirrored
states. The emotion mapping and tracker have unit coverage in `test/`.

**Translation** — tested with the browser speech APIs stubbed, since headless
Chromium has neither a recognition engine nor installed voices, and with the
translation endpoint mocked. Everything between those two edges is real
application code, and it is covered: interim vs final transcript handling, the
outgoing request's text and language pair, HTML-entity decoding of the reply,
speaking in the target language, picking the matching local voice, muting the
mic during playback and resuming after, direction swap re-arming the recogniser,
settings persistence, and the vision loop continuing throughout.

Three things are genuinely unverified, and worth knowing before you rely on them:

- **No real speech has ever gone through this.** Recognition accuracy, latency
  and how `continuous` behaves on iOS are unknown to me. The restart-on-`onend`
  logic is written to Safari's documented behaviour, not to observed behaviour.
- **The on-device engine has never successfully loaded.** Both `huggingface.co`
  and the CDN are blocked by this build environment's network policy, so the
  model IDs in `HF_MODELS` are unconfirmed and could 404. If that happens the
  app now says so clearly and leaves settings open so you can switch to cloud —
  that failure path *is* tested.
- **Neither cloud provider was called for real.** The request shape is tested
  against a mock; no key was ever exercised against a live endpoint.

**Not tested on physical iPhone hardware** — that needs your device. The
iOS-specific pieces (the `playsinline` attributes, the user-gesture gates before
`getUserMedia` and before `speechSynthesis`, safe-area insets, wake lock) are
written to Safari's documented requirements but are unverified in practice.
Frame rate in headless software rendering is ~3 fps and says nothing useful
about a real phone GPU; expect substantially better, and if it feels slow, raise
`PERSON_INTERVAL` in `js/pipeline.js` or drop `MAX_FACES`.
