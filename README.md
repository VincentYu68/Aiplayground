# Brickify

Turn a photo of an object into a LEGO model you can actually build, with a 3D
interactive step-by-step manual.

Everything runs in the browser. The photo never leaves the device — there is no
server, no upload, and no API key.

```bash
npm install
npm run dev           # http://localhost:5173
npm test              # 81 tests over the generator, the cut-out and the shape
npm run build         # static site in dist/
npm run build:single  # one self-contained page, dist-single/brickify.html
```

`build:single` inlines the CSS and JS into a single HTML file for hosts that
serve one page and block external requests. It cannot carry the 19MB
segmentation model, so it falls back to GrabCut and says so in the UI. It sets `VITE_NO_WORKER=1`, which
drops the web worker and runs the generator on the main thread instead — the
page freezes for the fraction of a second the build takes, rather than staying
responsive. Use the normal build anywhere a second file can be served.

## What it does

1. **Cuts the object out of each photo** with Segment Anything, running in the
   browser — see below. A brush and a bounding box are there for the photos it
   still gets wrong.
2. **Lifts the silhouette into a solid.** Three modes: a rounded solid that
   bulges front and back, a solid of revolution for anything turned on a lathe,
   and a flat-backed relief. The far side is treated as unknown rather than
   assumed — see below.
3. **Samples it onto the LEGO lattice** — 8mm across, 3.2mm per plate — and
   reduces the colours to a chosen number of real LEGO colours using CIEDE2000.
4. **Chooses the bricks**, scoring every candidate placement for size, stud
   overlap and — most importantly — whether it reproduces a joint in the course
   below.
5. **Checks that it holds together**, repairs what it can, and reports what it
   could not.
6. **Writes the manual**: a 3D viewer you can step through, plus LDraw, a
   printable booklet, a CSV parts list and a Bricklink wanted list.

## Constraints it respects

**Only standard parts.** Bricks and plates from 1x1 up to 8x16, every one of
them an ordinary System element that has been in production for decades. No
slopes, tiles, brackets or SNOT parts. Exported LDraw files reference real
element numbers, and the Bricklink export is a wanted list you can buy from.

**It has to stand up.** Three separate properties are checked, and they are not
the same thing:

- *Connectivity.* Two parts side by side in the same layer are **not** joined —
  only a part above or below that spans them joins anything. The generator
  builds the part graph on vertical overlap alone and repairs anything that
  falls out of it.
- *Buildability.* Every part must have something under it when its turn comes,
  or be clamped by the course above. The second case is legitimate LEGO and the
  manual flags those parts as "hold this until the next course".
- *Bond.* Joints are staggered against the course below, the way a bricklayer
  lays a running bond. A model whose joints stack up is a set of loose columns.

**It has to look like the photo.** Reported, not asserted: silhouette overlap
as intersection-over-union against the cut-out, and mean CIEDE2000 colour error
against the source pixels. The front-on model preview is drawn at the real
8 : 3.2 stud-to-plate ratio so the side-by-side comparison is honest.

## Cutting the object out

The object is cut out by **Segment Anything** (MobileSAM), running entirely in
the browser on WebAssembly. The colour-model segmenter described further down
is still in the codebase — it is the fallback, and it proposes the initial
prompt — but it is no longer what produces the outline.

### Why, measured

Colour models do not know what an object is. They group pixels that look alike,
which is why they merge an object with its own shadow, wander onto the
tablecloth, and delete a chair's legs — thin things are cheap to remove when you
are paying by boundary length. That is a property of the formulation, not a
tuning problem, so the only honest way to settle it was to build a benchmark and
measure.

`bench/` composites eight known objects over ten backgrounds — eighty scenes with
exact ground truth. The objects are drawn analytically with shading, specular
highlights, thin structures and real holes; the backgrounds run from a studio
sweep to a wood table, clutter, and a wall painted the object's own colour. Each
scene casts a soft shadow that is deliberately *not* part of the truth mask,
because "dark pixels next to the object" is the most common way a segmenter is
fooled.

| method | mean IoU | boundary F1 | invented area | scenes below 50% |
|---|---|---|---|---|
| GrabCut, no user input | 75.8% | 60.4% | 47.9% | 19 / 80 |
| GrabCut, user box | 78.7% | 64.3% | 35.0% | 14 / 80 |
| **SAM, automatic box** | **95.4%** | **95.0%** | **3.8%** | **0 / 80** |
| SAM, user box | 96.1% | 96.9% | 4.0% | 1 / 80 |

Boundary F1 is reported next to IoU because IoU alone is forgiving: an outline
that is two pixels wrong *everywhere* still scores about 0.97 on a chunky
object, and two pixels is a whole stud once the model is carved.

### Three findings, all of them load-bearing

- **The prompt has to be a real box.** SAM answers "what object is in this box",
  so a box covering the frame is the question "what is this scene" — and it
  answers, faithfully, with the background. A box inflated 15% beyond the object
  drops the mean IoU from 96.1% to 11.4%; a frame-filling one gives 1.1%. This
  is why `clampBox` exists, and why it is applied to every automatic proposal.
  Clamping the guess to at most 85% of the frame is the single change that took
  the automatic path from 88.6% with six catastrophic failures to 95.4% with
  none.
- **Quantisation breaks the encoder, but only in one place.** Int8 across the
  whole encoder costs more than SAM gains — 94.9% down to 68.4%, worse than
  GrabCut. The intuition that ViT attention is the fragile part is backwards
  here: quantising only the `Conv` nodes gives 68.5%, while quantising only the
  `MatMul` nodes gives **95.4%** at half the file size. The shipped encoder is
  MatMul-only int8, 13.5MB instead of 27MB, and loses nothing.
- **An automatic box only needs to be roughly right.** The old segmenter is a
  poor mask but a fine *guesser*: it rarely misses the object (1.5% of its
  pixels) even while dragging in half the background (48%), and a bounding box
  barely notices the second failure. So the thing it is bad at is no longer on
  the critical path.

### How it runs

The model is split in two on purpose. The encoder depends only on the photo and
is the expensive half; the decoder depends only on the prompt and takes about
half a second in WASM. So a photo is encoded once and re-decoded on every box
drag or brush stroke, which is what makes the editor feel live — GrabCut charged
a full second for every single edit.

Weights are ~19MB and download in the background; until they land, photos are cut
out with the fallback and re-cut automatically once the model is ready. If the
download fails the app keeps working, just less accurately, and says so. Threads
are off because GitHub Pages cannot send the COOP/COEP headers that
`SharedArrayBuffer` requires.

`bench/browser.mjs` runs the whole thing in a real Chromium against the shipped
code, and scores it with the same metrics: 95.2% against the Python reference's
95.4%, the gap being canvas image decoding versus PIL. Preprocessing is four
lines of arithmetic that are easy to get quietly wrong, and a half-pixel shift
does not throw — it just costs IoU.

```
npm run bench            # score the cut-out methods
npm run bench -- --dump  # write PNGs + manifest for external tools
npm run bench:browser    # score the shipped browser path in Chromium
npm run bench:3d         # score the reconstructed volume against known solids
```

### The fallback: GrabCut

Scoring each pixel on its own — nearest background colour versus nearest
foreground colour, then threshold — has no notion of a boundary. It speckles
wherever the two populations overlap and its edges wander with the lighting.
Since the shape is now carved from silhouettes, a mistake here is not a
blemish, it is a hole in the model.

GrabCut minimises one energy over the whole image instead:

```
E = Σ_p  −log P(colour_p | model of its label)                    (fit)
  + Σ_pq  γ · exp(−β‖I_p − I_q‖²) · [label_p ≠ label_q]           (edges)
```

Each label gets a full-covariance Gaussian mixture, so a colour is judged
against the *shape* of its population rather than a centroid — a shadow on a
white wall is far from the wall's mean and still obviously wall. The second
term charges for boundary, discounted where the image has a real edge, so the
cut is cheap along object outlines and expensive through flat regions. A
min-cut solves it globally, so stray pixels never survive. Models and labelling
are refined against each other for a few rounds.

Measured against the per-pixel segmenter it replaced:

| Case | before | after |
|---|---|---|
| Object barely differing from the background | 26.9% | **99.7%** |
| Object fading toward the background colour | 97.1% | **100%** |
| Clutter along the frame border | 100% | 100% |
| Four thin legs | 100% | 100% |

Two things that cost real time to get right, both recorded in the code:

- **The boundary weight has a cliff.** Boundary cost scales with the object's
  perimeter and fit cost with its area, so above a certain weight "no boundary
  anywhere" is genuinely the cheaper labelling and the cut returns *everything
  is background*. Its position moves with image size and contrast, so no fixed
  weight is safe. The weight is backed off until the cut says something is the
  object.
- **Degenerate has to mean nearly-empty, not empty.** At the cliff the cut does
  not return zero foreground, it returns a single pixel, which sails straight
  through a `> 0` check and is then erased by the cleanup.

The cut runs at reduced resolution — it is by far the expensive step — and the
boundary is then re-decided at full resolution against the same energy, since
colour models do not care about resolution.

## How good is the 3D, actually

`bench/run3d.ts` renders known solids — sphere, box, cylinder, mug, chair,
dumbbell, stair, torus, teapot — from N angles using the pipeline's own
projection convention, runs the real pipeline, and scores the *volume* it
produces against the solid it came from.

| photos | mean 3D IoU | what the app used to report |
|---|---|---|
| 1 | 53.0% | 97.7% silhouette match |
| 2 | 70.8% | 97.3% |
| 4 | 76.6% | 97.0% |
| 8 | 78.1% | 97.0% |

That gap is the whole problem, and it is now stated in the UI rather than left
to be discovered by orbiting the model: matching the outline of the one photo
you framed is not evidence about depth. A flat slab scores 97% on silhouette.

Three things came out of building this.

**The single-view depth prior was wrong by a factor of two.** `depthScale`
defaulted to 0.55 — peak thickness as a fraction of width — which made a sphere
just over half as deep as it is wide. Measured across the corpus, mean 3D IoU
runs 40.9% at 0.4, 43.8% at 0.55, 51.9% at 0.85 and 53.0% at 1.0. The default is
now 1.0: assume a roughly circular cross-section, "as deep as it is wide".

**A cylinder and a box cast the same silhouette.** From one photograph they are
the same rectangle, and no geometric rule can separate them — the change above
buys 9 points by picking the better prior, not by learning anything. Rounded
objects gain a lot (sphere 54.9% → 92.2%, cylinder 51.1% → 86.3%); boxy ones
lose (box 62.6% → 36.6%). Only recognising the object could do better, which is
what the next section is about.

**Views should be spread over half a turn, not a whole one.** Under orthographic
projection the silhouette at angle a and at a+180 are mirror images, so they
constrain the hull identically: front-and-back is, for carving, one photo. (For
colour it is not — only the back photo can paint the back.)

### Knowing what the object is

Everything above reasons about pixels. SAM knows *that* something is an object;
it does not know it is a mug. That is where the reconstruction runs out of road:
from one photograph a cylinder and a box cast exactly the same rectangle, and no
silhouette analysis can separate them.

How much is that knowledge worth? The benchmark answers it directly. The best
single fixed depth prior reaches **53.7%** mean 3D IoU; an oracle allowed to pick
the right prior per object reaches **65.1%**. The gap is concentrated exactly
where geometry is blind:

| object | oracle pick | oracle | fixed prior | gain |
|---|---|---|---|---|
| flat box | 0.4 | 72.0% | 36.6% | **+35.4** |
| ring | 0.4 | 65.6% | 28.4% | **+37.2** |
| teapot | 0.4 | 38.6% | 18.4% | **+20.2** |
| cylinder | revolve | 94.1% | 86.3% | +7.8 |
| sphere | revolve | 92.6% | 92.2% | +0.4 |

So the app now recognises the object. **MobileNetV2**, 3.6MB quantised, reusing
the runtime SAM already loads. It is not a large foundation model, but ImageNet-1k
covers what people photograph on a table — coffee mug, wine bottle, teapot,
folding chair, vase, binder — and the label is only used to pick among a handful
of shape archetypes, so "cup" and "coffee mug" disagreeing on the noun does not
matter.

Three things make it safe to act on:

- **It classifies the cut-out, not the photo.** An ImageNet model handed a whole
  desk shot answers "desk" — the same failure as SAM with a frame-filling box.
  The mask is already known by then, so the object's own bounding box is used.
- **Top-k classes are pooled by archetype**, and an unrecognised class never wins
  a vote it merely takes part in — no evidence is not evidence for a default.
- **It abstains.** Below 35% pooled confidence the neutral prior stands. Measured
  over the 80-scene cut-out corpus: it acts on 58 of 80 images and gets the
  archetype right on **54 of those 58 (93%)**. The object it is worst at — a toy
  car — is one it mostly declines to guess at (3 of 10, all wrong), which is the
  behaviour that matters: confident when right, quiet when not.

The result is a *suggestion*. It sets the shape controls the user could have set
themselves, says what it saw in plain words ("Looks like a coffee mug — treating
it as turned about a vertical axis"), and stops guessing the moment the user
touches those controls.

Two honest limits. This only affects the single-photograph path — with two or
more views the depth is measured, not guessed, and nothing here is consulted.
And the +11.4 point figure is the *oracle's* headroom; the classifier captures
part of it, and how much on real photographs is not something this benchmark can
answer, because its own renders are too crude for the classifier to read (it
calls the benchmark cylinder a wardrobe). The recognition accuracy above is
measured on the more detailed cut-out corpus instead.

### Two things measured and rejected

Both were built and benchmarked rather than argued about, and neither shipped.

**Monocular depth estimation.** MiDaS v2.1-small scores a mean correlation of
about 0.2 against true depth on these renders, with several views *anti*
correlated; MiDaS v3.1 swin2-tiny (42M params) reaches 0.43, still with a box
face coming out backwards. Carving geometry with a depth map that wrong would
lose more than it gained. The honest caveat: these are synthetic renders on a
flat background, which is out of distribution for models trained on photographs,
so this is evidence about *this benchmark*, not a general verdict.

**Photo-consistency carving (space carving).** The principled attack on phantom
volume: a voxel in empty space is seen as different colours by different
cameras, a voxel on a real surface is not. Implemented with visibility recomputed
per pass and silhouette protection, then swept over the disagreement threshold:

| CIEDE2000 tolerance | off | 6 | 8 | 10 | 12 |
|---|---|---|---|---|---|
| 2 views | 70.8% | 55.5% | 55.5% | 60.4% | 65.3% |
| 4 views | 76.6% | 77.1% | 77.5% | 77.5% | 77.1% |
| 8 views | 78.1% | 70.0% | 74.9% | 76.1% | 76.7% |

It does remove phantom volume — at 8 views the excess drops from 53% to 36% —
but it removes real material at the same rate, and it is badly harmful at two
views. A knob that costs a pass over the grid and makes the common case worse
is not worth shipping, so it was taken out.

### What is still wrong

The mean hides two shapes. At eight views: mug 37%, teapot 24%, with the teapot
carrying 316% more volume than it should. Everything else is 84–98%. Both fail
the same way — a visual hull cannot see a hollow nothing looks into (a mug's
bore) and cannot remove the space trapped between parts that stick out (a
spout and a handle both sweep wedges, and every camera sees material in the slab
between them). Fixing that needs a method that knows what the object is, not a
better silhouette.

## Recovering real 3D from several photos

One photograph cannot describe a solid. Extruding its silhouette and rounding
the result reads correctly from the camera's position and falls apart the
moment you orbit it — the shape was never there.

Two or more photographs taken around the object do contain the shape.
Each silhouette back-projects to a generalised cone containing the object, and
the object lies in the intersection of all of them. That intersection — the
visual hull — is genuine recovered geometry, not a guess:

| Object | 1 view | 2 views | 4 views | 8 views |
|---|---|---|---|---|
| Box, truly 2:1 wide vs deep | 0.96:1 | **2.00:1** | 2.00:1 | — |
| Cylinder (a circle fills 79% of its bounding square) | 100% | 100% | 82% | **79%** |

Two perpendicular views pin a box exactly; eight views reproduce a circle to
the decimal. Add angles in the first panel and set each one's direction.

Scale is shared between views by assuming the object is the same height in all
of them — so shoot from roughly the same distance, upright. Angles are taken
relative to the first view, so only the angles *between* photos matter.
Projection is orthographic: recovering perspective would need the camera's
focal length and distance, which a dropped photo does not carry.

**What it cannot recover** is concavity that never breaks the silhouette — the
inside of a bowl seen only from outside. That is a property of shape-from-
silhouette, not of this implementation. With a single photo the app falls back
to silhouette extrusion and says so in the report.

## The side the camera never saw

Half of any solid model is a side the photograph does not show, and the
tempting default — mirroring the front — is the one answer that is reliably
wrong. It puts a second face on the back of a head and a second grille on the
back of a car, and because those features are bright and recognisable, the
error is far more visible than any amount of smoothing would be.

Two things are therefore kept off the back:

- **Shading relief.** Luminance only describes the surface facing the camera,
  so it shapes the front alone. The back gets the bare geometric bulge that the
  silhouette implies.
- **Front colours.** There is one part of the photo that genuinely describes
  the far side: the pixels along the silhouette, which are the surface seen
  edge-on at the point where it turns away and continues round the back.
  Carrying that colour inwards — a nearest-boundary feature transform — gives
  the object's own wrap-around colour: the hair around a face, the paint around
  a grille.

These apply to the single-photo fallback. With several views the far side is
photographed rather than guessed, and each surface voxel takes its colour from
whichever camera faces it most squarely, resolved through a per-view depth
buffer so a voxel never takes colour from a camera that could not see it.

`Back of the model` offers **wrap the edges round** (the default), **plain
back** (one solid colour, cheapest and most honest), and **mirror the front**
for the cases where the object really is symmetric.

On a synthetic head, wrapping removes skin tones from the back entirely
(under 2% of the rear surface, against 33% when mirrored) while leaving the
photographed front pixel-for-pixel identical.

## Two findings worth knowing about

**Colour boundaries are structural.** A part can only be one colour, so a colour
boundary is a line no part can cross. A photo with broad vertical shading — a
vase, a bottle, a face lit from one side — puts that boundary at the same stud
on every course, and the result is a crack running the full height that splits
the model into slabs leaning on each other. The generator nudges the colour
decision by a fraction of a percent per course, which moves the boundary a stud
either way between courses without any visible change, and lets the next course
reach across. On the test vase this took the model from 8 loose sections to one
piece.

**A colour boundary is a structural joint, in every axis.** The front/back
colour change is a plane no part may cross, and pinned at a fixed depth it
becomes a crack running through the whole model — the vertical-band problem
lying on its side. Walking that boundary a stud back and forth between courses
fixed it and then paid for itself: the wrapped back ends up using *fewer* parts
than the old mirrored one (2818 vs 2944 on the test head) and scores higher for
stability (91 vs 90).

**Hollowing has to be measured in millimetres.** A voxel step is 8mm sideways
and 3.2mm vertically. Carving out "two voxels" of shell leaves 16mm through a
wall but 6.4mm through a floor — thinner than a single brick — and the model
quietly separates into unconnected shells. Shell thickness is a real distance,
found with a bucket-queue Dijkstra over the true step costs.

## Choosing settings

The defaults are chosen to produce something buildable; the two that change the
result most:

- **Bricks only** (on by default) builds in whole 3-plate courses. Turning it
  off doubles vertical resolution, but on a curved object each extra plate layer
  is a one-plate ring overhanging the layer beneath, which roughly doubles the
  part count and tends to leave the model in sections. The stability score says
  so when it happens.
- **Colours** trades fidelity against cost and strength. More colours track the
  photo more closely but make narrower bands, which forces smaller parts.

## Credits

The segmentation model is **MobileSAM** (Zhang et al.), a distilled Segment
Anything with a TinyViT image encoder, itself built on Meta AI's **Segment
Anything**. Both are Apache-2.0. The files in `public/models/` are ONNX exports
of MobileSAM's published `vit_t` checkpoint, quantised as described above; they
are redistributions of that work, not something trained here. Object recognition is **MobileNetV2** from the ONNX Model Zoo (Apache-2.0),
quantised to int8 as published. Inference is onnxruntime-web, MIT.

## Layout

```
src/core/lego/       units, colour palette with LDraw codes, part catalogue
src/core/image/      segmentation (SAM + GrabCut fallback), depth, raster helpers
src/core/recognise/  object recognition and the shape prior it implies
bench/               benchmarks: 2D cut-out scenes, 3D solids, metrics, runners
public/models/       MobileSAM encoder and decoder, MobileNet classifier, ONNX
src/core/voxel/      the grid, sampling, colour reduction, hollowing
src/core/build/      tiling, stability analysis and repair, steps, pipeline
src/core/export/     LDraw, printable manual, parts list, Bricklink
src/render/          three.js brick geometry and the manual viewer
src/ui/              React components
src/worker/          runs the generator off the main thread
tests/               unit and end-to-end tests of the generator
```

`src/core` is pure and synchronous — no DOM, no canvas, no network — so it runs
in a worker, is testable in node, and is reproducible for a given seed.
