# Brickify

Turn a photo of an object into a LEGO model you can actually build, with a 3D
interactive step-by-step manual.

Everything runs in the browser. The photo never leaves the device — there is no
server, no upload, and no API key.

```bash
npm install
npm run dev           # http://localhost:5173
npm test              # 95 tests over the generator, the cut-out and the shape
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
   overlap and — most importantly — how it sits against the joints in the course
   below: punished for reproducing one, rewarded for spanning one.
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

Both of those numbers were wrong, and both were wrong in the flattering
direction, which is the way a metric fails when nobody has tried to break it.

- *Colour error* was re-derived by mapping grid columns across the whole image,
  while the grid had been sampled across the object's **bounding box**. Any
  photo with margin around the object was therefore scored against the wrong
  pixels: padding a photo with background moved the reported error on an
  identical model from 9.6 to 17.8. The colour a column was sampled from is now
  carried with the column, so the two cannot drift apart, and it is compared
  against the colour the model actually ended up with rather than the one the
  column asked for. Reported error across the corpus fell from 15.8 to 6.3 on
  the mug and 27.3 to 10.6 on the book — the models did not change, only the
  honesty of the number.
- *Silhouette match* was measured after cropping the silhouette to the model's
  own extent, which hid the single failure most worth seeing: a feature the
  model dropped **entirely** fell outside the window and stopped counting as
  missing. It is now counted before the crop.

A metric that is only ever read when it looks good is not a measurement. Both
have regression tests that assert the specific way they used to lie.

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
npm run bench:quality    # build the corpus and render what each model looks like
npm run bench:photos     # write corpus scenes out as PNGs, for the checks below
npm run e2e              # drive the built app in Chromium, one photo at a time
npm run e2e:multiview    # same, adding a second angle through the real UI
```

`bench:quality` exists because scoring a model is not the same as looking at
one. It writes a front-on render of every model next to its part count, 1x1
share, colour count and both fidelity numbers — which is how the grey mug, the
magenta bricks on the red car, the striped mug band and the speckle from the
per-course colour jitter were all found. Every one of those scored fine.

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
dumbbell, stair, torus, teapot, and then a person, a car, a bag and a flat
drawing — from N angles using the pipeline's own projection convention, runs the
real pipeline, and scores the *volume* it produces against the solid it came
from.

| photos | mean 3D IoU | what the app reports instead |
|---|---|---|
| 1 | 43.3% | 97.3% silhouette match |
| 2 | 66.1% | 97.3% |
| 4 | 70.6% | 97.2% |
| 8 | 71.4% | 97.1% |

Those are lower than the figures this section used to quote (53.0 / 70.8 / 76.6
/ 78.1) for a boring reason worth stating plainly: the corpus grew from nine
solids to thirteen, and the four that were added — a person, a car, a bag and a
flat drawing — are the hard ones. The old numbers were never re-measured against
the bigger corpus, so the README quietly kept claiming the easier average. The
per-solid figures quoted further down were not affected, and the sweeps below
that are explicitly marked as measured on the original nine.

That gap is the whole problem, and it is now stated in the UI rather than left
to be discovered by orbiting the model: matching the outline of the one photo
you framed is not evidence about depth. A flat slab scores 97% on silhouette.

Three things came out of building this.

**The single-view depth prior was wrong by a factor of two.** `depthScale`
defaulted to 0.55 — peak thickness as a fraction of width — which made a sphere
just over half as deep as it is wide. Measured across the original nine-solid
corpus, mean 3D IoU runs 40.9% at 0.4, 43.8% at 0.55, 51.9% at 0.85 and 53.0% at
1.0. The default is now 1.0: assume a roughly circular cross-section, "as deep as it is wide".

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
single fixed depth prior reaches **53.7%** mean 3D IoU on the original nine
solids; an oracle allowed to pick the right prior per object reaches **65.1%**. The gap is concentrated exactly
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

(Measured on the original nine solids, which is why the "off" column does not
match the table at the top of this section.)

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

The mean hides its failures. At eight views: mug 37%, teapot 24%, with the
teapot carrying 316% more volume than it should — and, among the solids added
later, car 43%, drawing 57%, person 57%, bag 66%. The nine that were there
first are 84–98% apart from those two. The mug and the teapot fail
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

## Turning something on a lathe

Revolve mode is where the recogniser sends every mug, vase, bottle and lamp, so
it is worth it being right. It was wrong in three separate ways, all of which
showed up the moment the finished model was rendered next to its photo instead
of only scored.

**The axis and the radius came from the row's leftmost and rightmost object
pixel.** A mug's handle is part of the silhouette, so that span covered the body,
the gap *and* the handle: the radius came out about 40% too large and the axis
25px off centre. The body is now the widest **contiguous** run in each row — a
detached handle is a different run and drops out — with the axis as the
width-weighted median of those runs' centres, which survives the few rows where
the handle really does touch the body. The radius is the *smaller* of the two
distances from the axis to the ends of the run through it, because it is the
handle's side that is inflated when they merge.

**Colour was sampled at the matching distance from the axis.** Every voxel on
the outer surface sits at the full radius, so the whole body took the colour of
the silhouette edge — the grazing, most-shaded pixels in the photo — and a white
mug came out mid-grey. Worse, sampling that far out lands on the anti-aliased
boundary, where a rounded lookup falls outside the mask about half the time; the
voxel was skipped and the colour came from whatever sat behind it, striping the
band into ribbons. A lathe-turned object is one colour all the way round at a
given height, and the honest place to read it is where the surface faces the
camera.

**A lathe cannot make a handle, and dropping it is not the answer.** With the
axis fixed, the handle stopped being swallowed into a fattened body — and simply
disappeared, taking the silhouette match from 98.9% to 89.8%. A mug without its
handle is not a mug. The lathe now reports which columns the body covers and the
silhouette extrudes whatever lies outside it, so the body is still a true solid
of revolution and the handle is still there. Back to 98.3%, at 1137 parts
against the 1264 of the version that had no handle at all.

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

## Three findings worth knowing about

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
- **Colours** is a *cap*, not a target. More colours track the photo more closely
  but make narrower bands, which forces smaller parts, so the budget is only
  spent while spending it measurably helps: colours are added one at a time,
  each time whichever LEGO colour most reduces the error actually being made,
  stopping when the next one would improve the mean by less than a third of a
  ΔE unit. Asking for 12 typically gets 3–7. Before this, cluster centres were
  snapped onto *distinct* colours, so a second cluster that also wanted White
  was pushed onto whatever was next — a white mug came out in two greys, and a
  red car had magenta bricks in it.

### Two things the app decides for you

**Height is capped at 40 courses (about 39cm).** Width sets the width and the
height follows from the object's proportions, which is fine right up until
someone photographs a bottle: at the default 32 studs the test bottle came out
225 plates tall — 72cm, 3678 parts and 489 steps — from a setting that produces
a sensible model for anything roughly as tall as it is wide. Nobody chose that.
The width is reduced until the model fits, and the report says so and by how
much. The bottle becomes 18 studs, 38cm, 1134 parts. Ordinary proportions are
untouched. There is a floor of 6 studs, so something as extreme as a pencil
still ends up over the cap — better a little too tall than four studs of
nothing.

**The manual will not exceed about 120 steps.** "Parts per step" is a preference
about how gentle the instructions are, and at its default of eight it produced
489 steps for that bottle and 211 for a mug. It is honoured until it collides
with the ceiling, and then the steps grow instead of the manual. Across the
corpus the manual now settles at 112–138 steps rather than 112–491.

### What the bond costs, measured

Two things were true at once: the model was a third smaller than it needed to
be, and the reason was not the one that looked obvious.

Colour is not the cause. Rebuilding the whole corpus in a *single* colour, so
that no colour boundary constrains any part anywhere, only moves the 1x1 share
from 34% to 28%. Painting the enclosed interior one colour — on the theory that
nobody can see inside a hollow model — is much worse than not doing it: 1591
parts becomes 2824 and stability falls from 99 to 87, because repainting the
core of an otherwise uniform region *adds* a boundary where there was none. A
three-stud shell instead of two is worse on both counts at once.

The cause was the bond score, and it was one-sided. Reproducing a joint in the
course below was punished; **spanning** one was not rewarded at all. Under a
penalty with no matching reward, the cheapest way for a part to score well is to
have as little boundary as possible — so the tiler bought its bond by using
smaller parts, which is close to the opposite of what a running bond is for.
Turning the penalty off entirely dropped the corpus from 11875 parts to 8215 and
the 1x1 count from 4282 to 1597: the bond, as scored, was costing 31% of the
build.

Sweeping the penalty against everything it is supposed to buy shows it was also
set well past the knee of its own curve:

| seam penalty | parts | 1x1 | stability | joints aligned | models in pieces |
|---|---|---|---|---|---|
| 0 | 8215 | 19% | 91.5 | 33% | 1 |
| 4 | 8783 | 24% | 93.9 | 28% | 1 |
| 6 | 10311 | 35% | 98.0 | 20% | 0 |
| 8 | 10667 | 38% | 98.5 | 19% | 0 |
| 14 *(as shipped)* | 11875 | 36% | 98.6 | 17% | 0 |

Everything from 6 upwards produces one connected model. Going from 6 to 14 buys
six tenths of a stability point for 15% more parts.

So the reward was added — joints below that fall strictly inside a part's
footprint, counted in constant time from a second pair of prefix sums — and the
penalty was re-tuned against it over a two-dimensional sweep. At a penalty of 8
and a reward of 4 the corpus builds in **10379 parts against 11875**, with the
*highest* mean stability in the whole sweep (98.8), the highest worst-case
model (98), and the same joint alignment. The test mug goes from 1591 parts to
1293, and from 34% 1x1 to 28%.

What is left is genuinely geometric, and it is the reason the share does not
fall further: a hollow shell two studs thick over a curved surface is a
staircase one or two cells wide in plan, and a rectangle cannot follow a
diagonal. There are settings that do better on parts — a penalty of 2 with a
reward of 12 reaches 8680 parts and 22% 1x1 — but they take the worst model in
the corpus from 98 to 89 and add 44% more parts the builder has to hold in
mid-air. That is a worse model, not a cheaper one.

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
