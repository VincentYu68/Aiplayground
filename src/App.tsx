import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MaskEditor } from './ui/MaskEditor';
import { SettingsPanel } from './ui/SettingsPanel';
import { ManualViewer } from './ui/ManualViewer';
import { ViewStrip } from './ui/ViewStrip';
import { ExportPanel, FidelityPanel, PartsPanel, StabilityPanel } from './ui/ResultPanels';
import { loadImageFile } from './lib/loadImage';
import { segment } from './core/image/segment';
import { generateModel } from './core/build/pipeline';
import {
  DEFAULT_OPTIONS,
  type BuildOptions,
  type BuildResult,
  type ViewState,
  type WorkerResponse,
} from './types';

/** Set at build time for single-file bundles, which have no worker to load. */
const SUPPORTS_WORKER =
  typeof Worker !== 'undefined' && import.meta.env.VITE_NO_WORKER !== '1';

/** Angles offered to a newly added view, in the order they get handed out. */
const NEXT_ANGLES = [90, 180, 270, 45, 135, 225, 315];

export default function App() {
  const [views, setViews] = useState<ViewState[]>([]);
  const [activeId, setActiveId] = useState(0);
  const [name, setName] = useState('Model');
  const [threshold, setThreshold] = useState(0.5);
  /** Cut-outs currently in flight; the outline is expensive enough to show. */
  const [segmenting, setSegmenting] = useState(0);
  /**
   * The segmentation model is ~19MB and downloads in the background. Until it
   * lands the app cuts photos out with the old colour-model segmenter, which
   * works but is markedly less accurate, so its state is worth showing.
   */
  const [model, setModel] = useState<{
    state: 'loading' | 'ready' | 'unavailable';
    fraction: number;
  }>({ state: 'loading', fraction: 0 });
  /** What the classifier thinks the object is, and the prior it implied. */
  const [recognised, setRecognised] = useState<{ label: string; confidence: number } | null>(null);
  const [priorNote, setPriorNote] = useState<string | null>(null);
  /** Once the user adjusts the shape controls, stop guessing for them. */
  const shapeTouched = useRef(false);

  const [options, setOptions] = useState<BuildOptions>(DEFAULT_OPTIONS);
  const [result, setResult] = useState<BuildResult | null>(null);
  const [step, setStep] = useState(0);
  const [progress, setProgress] = useState<{ stage: string; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const nextId = useRef(1);
  const autoBuild = useRef(false);
  const segmentSeq = useRef(new Map<number, number>());

  const active = views.find((v) => v.id === activeId) ?? views[0] ?? null;

  const onWorkerMessage = useCallback((message: WorkerResponse) => {
    if (message.type === 'model-progress') {
      setModel({ state: 'loading', fraction: message.total ? message.loaded / message.total : 0 });
      return;
    }
    if (message.type === 'model-ready') {
      setModel({ state: 'ready', fraction: 1 });
      return;
    }
    if (message.type === 'model-unavailable') {
      setModel({ state: 'unavailable', fraction: 0 });
      return;
    }

    if (message.type === 'recognised') {
      if (segmentSeq.current.get(message.viewId) !== message.seq) return;
      setRecognised({ label: message.label, confidence: message.confidence });
      // The guess sets the shape controls the user could have set themselves,
      // and only until they touch them — after that it would be overriding a
      // decision rather than saving one.
      if (message.prior && !shapeTouched.current) {
        setOptions((current) => ({
          ...current,
          solidMode: message.prior!.solidMode,
          depthScale: message.prior!.depthScale,
          roundness: message.prior!.roundness,
        }));
        setPriorNote(message.prior.explanation);
        setDirty(true);
      }
      return;
    }

    if (message.type === 'segmented' || message.type === 'segment-error') {
      // Drop anything the user has already superseded with a newer stroke.
      if (segmentSeq.current.get(message.viewId) !== message.seq) return;
      setSegmenting((busy) => Math.max(0, busy - 1));
      if (message.type === 'segment-error') {
        setError(message.message);
        return;
      }
      setViews((current) =>
        current.map((v) =>
          v.id === message.viewId ? { ...v, mask: message.mask, engine: message.engine } : v,
        ),
      );
      // The outline this model was built from has just been replaced. Whatever
      // is on screen is now out of date, and saying so is the whole point of
      // the dirty flag.
      setDirty(true);
      return;
    }

    if (message.id !== requestId.current) return;
    if (message.type === 'progress') {
      setProgress({ stage: message.stage, fraction: message.fraction });
    } else if (message.type === 'done') {
      setResult(message.result);
      setStep(0);
      setProgress(null);
      setDirty(false);
    } else {
      setError(message.message);
      setProgress(null);
    }
  }, []);

  // --- worker lifecycle ----------------------------------------------------
  // The worker keeps the sliders responsive while a big model generates, but
  // it is an optimisation, not a requirement: where a separate worker file
  // cannot be loaded — a single-file build, a restrictive sandbox — the
  // generator runs on the main thread instead.
  useEffect(() => {
    // No worker means no model: the single-file build has nowhere to fetch 19MB
    // of weights from, and running the encoder on the main thread would lock
    // the page for seconds per photo. Say so rather than showing a progress
    // figure that will never move.
    if (!SUPPORTS_WORKER) {
      setModel({ state: 'unavailable', fraction: 0 });
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(new URL('./worker/pipeline.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      setModel({ state: 'unavailable', fraction: 0 });
      return;
    }
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      onWorkerMessage(event.data);
    });
    worker.addEventListener('error', () => {
      worker.terminate();
      workerRef.current = null;
    });
    workerRef.current = worker;
    // Only the page knows where it is deployed — this app is mounted in a
    // subdirectory of a site it does not own — so the model URLs are resolved
    // here and handed over rather than guessed inside the worker.
    worker.postMessage({
      kind: 'configure' as const,
      urls: {
        runtime: new URL('ort/', document.baseURI).href,
        encoder: new URL('models/mobilesam-encoder.onnx', document.baseURI).href,
        decoder: new URL('models/mobilesam-decoder.onnx', document.baseURI).href,
        classifier: new URL('models/mobilenet-classifier.onnx', document.baseURI).href,
        depth: new URL('models/depth-anything-v2-small-int8.onnx', document.baseURI).href,
      },
    });
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [onWorkerMessage]);

  // --- segmentation --------------------------------------------------------
  // The cut-out is a graph cut over every pixel and costs about a second, so it
  // goes to the worker whenever there is one; on the main thread it would lock
  // the page on every brush stroke.
  const runSegmentation = useCallback(
    (viewId: number) => {
      setViews((current) => {
        const view = current.find((v) => v.id === viewId);
        if (!view) return current;

        const seq = (segmentSeq.current.get(viewId) ?? 0) + 1;
        segmentSeq.current.set(viewId, seq);
        setSegmenting((busy) => busy + 1);

        const request = {
          kind: 'segment' as const,
          viewId,
          seq,
          rgba: new Uint8ClampedArray(view.source.rgba),
          width: view.source.width,
          height: view.source.height,
          threshold: view.threshold,
          rect: view.rect,
          hints: new Uint8Array(view.hints),
        };

        const worker = workerRef.current;
        if (worker) {
          worker.postMessage(request);
        } else {
          window.setTimeout(() => {
            try {
              const { mask } = segment(request.rgba, request.width, request.height, {
                threshold: request.threshold,
                rect: request.rect,
                hints: request.hints,
              });
              onWorkerMessage({
                type: 'segmented',
                viewId,
                seq,
                mask,
                engine: 'grabcut',
                box: request.rect,
              });
            } catch (e) {
              onWorkerMessage({
                type: 'segment-error',
                viewId,
                seq,
                message: e instanceof Error ? e.message : String(e),
              });
            }
          }, 16);
        }
        return current;
      });
    },
    [onWorkerMessage],
  );

  // Photos dropped in before the model finished downloading were cut out by
  // the fallback. Redo them once it arrives: the gap between the two is large
  // enough (75.8% against 95.4% mean IoU on the benchmark) that leaving the
  // worse outline in place would be leaving the model unused.
  const viewsRef = useRef<ViewState[]>([]);
  viewsRef.current = views;
  const upgraded = useRef(false);
  useEffect(() => {
    if (model.state !== 'ready' || upgraded.current) return;
    upgraded.current = true;
    if (viewsRef.current.length === 0) return;
    // Rebuild once the better outlines land. Re-cutting the photos and then
    // leaving the old model on screen was the worst of both: the model was
    // still the one GrabCut produced, while the UI had already started saying
    // the outline came from the recognition model.
    autoBuild.current = true;
    for (const v of viewsRef.current) runSegmentation(v.id);
  }, [model.state, runSegmentation]);

  const build = useCallback(
    (ready: ViewState[], buildOptions: BuildOptions) => {
      const id = requestId.current + 1;
      requestId.current = id;
      setError(null);
      setProgress({ stage: 'Starting', fraction: 0 });

      const payload = ready.map((v) => ({
        rgba: new Uint8ClampedArray(v.source.rgba),
        mask: new Uint8Array(v.mask!),
        width: v.source.width,
        height: v.source.height,
        azimuth: v.azimuth,
      }));

      const worker = workerRef.current;
      if (worker) {
        worker.postMessage({ kind: 'build' as const, id, views: payload, options: buildOptions });
        return;
      }

      window.setTimeout(() => {
        try {
          onWorkerMessage({ id, type: 'done', result: generateModel(payload, buildOptions) });
        } catch (e) {
          onWorkerMessage({
            id,
            type: 'error',
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }, 32);
    },
    [onWorkerMessage],
  );

  const readyViews = useMemo(() => views.filter((v) => v.mask), [views]);

  // Build once automatically as soon as every view has a cut-out.
  useEffect(() => {
    if (!autoBuild.current) return;
    if (views.length === 0 || readyViews.length !== views.length) return;
    // Every photo already has *an* outline while they are being re-cut, so
    // without this the rebuild would fire on the first one back and use stale
    // masks for the rest.
    if (segmenting > 0) return;
    autoBuild.current = false;
    build(readyViews, options);
  }, [views, readyViews, options, build, segmenting]);

  const addView = useCallback(
    async (file: File, replaceAll: boolean) => {
      try {
        setError(null);
        const source = await loadImageFile(file);
        const id = nextId.current++;
        setViews((current) => {
          const base = replaceAll ? [] : current;
          const taken = new Set(base.map((v) => v.azimuth));
          const azimuth = base.length === 0 ? 0 : (NEXT_ANGLES.find((a) => !taken.has(a)) ?? 0);
          const view: ViewState = {
            id,
            source,
            hints: new Uint8Array(source.width * source.height),
            rect: null,
            mask: null,
            azimuth,
            threshold,
            engine: null,
          };
          return [...base, view];
        });
        setActiveId(id);
        if (replaceAll) {
          setName(file.name.replace(/\.[^.]+$/, '') || 'Model');
          setResult(null);
          setStep(0);
        }
        autoBuild.current = true;
        // Segment once the view is in state.
        window.setTimeout(() => runSegmentation(id), 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not read that image');
      }
    },
    [runSegmentation, threshold],
  );

  // Paste an image straight from the clipboard.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const item = [...(event.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (file) void addView(file, views.length === 0);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addView, views.length]);

  const patchOptions = useCallback((patch: Partial<BuildOptions>) => {
    // Touching the shape controls retires the automatic guess: after this the
    // user has an opinion, and a later photo must not quietly overrule it.
    if (patch.solidMode !== undefined || patch.depthScale !== undefined) {
      shapeTouched.current = true;
      setPriorNote(null);
    }
    setOptions((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }, []);

  const patchActive = useCallback(
    (patch: Partial<ViewState>) => {
      setViews((current) => current.map((v) => (v.id === activeId ? { ...v, ...patch } : v)));
    },
    [activeId],
  );

  const onThresholdChange = useCallback(
    (value: number) => {
      setThreshold(value);
      if (!active) return;
      patchActive({ threshold: value });
      window.setTimeout(() => runSegmentation(active.id), 0);
      setDirty(true);
    },
    [active, patchActive, runSegmentation],
  );

  const busy = progress !== null;
  const allReady = views.length > 0 && readyViews.length === views.length;
  const canBuild = allReady && !busy && segmenting === 0;

  const buildLabel = useMemo(() => {
    if (busy) return progress?.stage ?? 'Working';
    if (!result) return 'Build the model';
    return dirty ? 'Rebuild with these settings' : 'Rebuild';
  }, [busy, progress, result, dirty]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          <div>
            <h1>Brickify</h1>
            <p>Photos → buildable LEGO model → 3D manual</p>
          </div>
        </div>
        {views.length > 0 && (
          <label className="file-button subtle">
            Start over
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void addView(file, true);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </header>

      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}

      {views.length === 0 || !active ? (
        <Hero onFile={(f) => void addView(f, true)} />
      ) : (
        <main className="layout">
          <aside className="controls">
            <section className="panel">
              <h2>1. Photos of the object</h2>
              <ViewStrip
                views={views}
                activeId={active.id}
                onSelect={setActiveId}
                onAdd={(file) => void addView(file, false)}
                onRemove={(id) => {
                  setViews((current) => current.filter((v) => v.id !== id));
                  if (id === activeId) setActiveId(views[0]?.id ?? 0);
                  setDirty(true);
                }}
                onAzimuth={(id, azimuth) => {
                  setViews((current) =>
                    current.map((v) => (v.id === id ? { ...v, azimuth } : v)),
                  );
                  setDirty(true);
                }}
              />
            </section>

            <section className="panel">
              <h2>2. Isolate the object</h2>
              <MaskEditor
                key={active.id}
                source={active.source}
                mask={active.mask}
                hints={active.hints}
                rect={active.rect}
                onPaint={(nextHints, localMask) => {
                  patchActive({ hints: nextHints, ...(localMask ? { mask: localMask } : {}) });
                  // Correcting the cut-out changes the model, so the build
                  // button has to stop claiming to be up to date.
                  if (localMask) setDirty(true);
                }}
                onRect={(nextRect) => patchActive({ rect: nextRect })}
                onCommit={() => runSegmentation(active.id)}
              />
              {segmenting > 0 && <p className="hint working">Working out the outline…</p>}
              {model.state === 'loading' && (
                <p className="hint">
                  Loading the object-recognition model…{' '}
                  {Math.round(model.fraction * 100)}% — outlines will sharpen when it
                  lands.
                </p>
              )}
              {active?.engine === 'sam' && segmenting === 0 && (
                <p className="hint">Outline by the object-recognition model.</p>
              )}
              {model.state === 'unavailable' && (
                <p className="hint">
                  Running on the built-in outliner: the recognition model could not be
                  loaded. Drawing a box around the object helps it a lot.
                </p>
              )}
            </section>

            <section className="panel">
              <h2>3. Shape the build</h2>
              {priorNote && (
                <p className="hint">
                  {priorNote}{' '}
                  <button
                    type="button"
                    className="linky"
                    onClick={() => {
                      shapeTouched.current = true;
                      setPriorNote(null);
                      patchOptions({
                        solidMode: DEFAULT_OPTIONS.solidMode,
                        depthScale: DEFAULT_OPTIONS.depthScale,
                      });
                    }}
                  >
                    Not that? Reset the shape.
                  </button>
                </p>
              )}
              {!priorNote && recognised && recognised.confidence >= 0.2 && (
                <p className="hint">
                  Looks like a {recognised.label}, but not confidently enough to
                  change the shape settings.
                </p>
              )}
              <SettingsPanel
                options={options}
                threshold={active.threshold}
                cutoutEngine={active.engine}
                multiView={views.length >= 2}
                onChange={patchOptions}
                onThresholdChange={onThresholdChange}
                disabled={busy}
              />
            </section>

            <div className="build-bar">
              <button
                type="button"
                className={`build-button ${dirty && result ? 'dirty' : ''}`}
                disabled={!canBuild}
                onClick={() => build(readyViews, options)}
              >
                {buildLabel}
              </button>
              {busy && (
                <div className="progress">
                  <div className="progress-bar" style={{ width: `${(progress?.fraction ?? 0) * 100}%` }} />
                </div>
              )}
            </div>
          </aside>

          <section className="output">
            {result ? (
              <>
                <div className="panel viewer-panel">
                  <div className="viewer-head">
                    <h2>4. Build it</h2>
                    <p className="summary">
                      {result.totalParts} parts &middot; {result.steps.length} steps &middot;{' '}
                      {result.gridX}×{result.gridZ} studs, {result.gridY} plates tall &middot;{' '}
                      {Math.round(result.dimensionsMM.width)}×{Math.round(result.dimensionsMM.depth)}×
                      {Math.round(result.dimensionsMM.height)} mm
                    </p>
                  </div>
                  <ManualViewer result={result} step={step} onStepChange={setStep} />
                </div>
                <div className="report-grid">
                  <FidelityPanel result={result} source={active.source} />
                  <StabilityPanel result={result} />
                  <PartsPanel result={result} />
                  <ExportPanel result={result} name={name} />
                </div>
              </>
            ) : (
              <div className="panel empty-state">
                <h2>No model yet</h2>
                <p>
                  Check the cut-out on the left, then build. Generation runs entirely in your browser —
                  the photos never leave this device.
                </p>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

function Hero({ onFile }: { onFile: (file: File) => void }) {
  const [dragging, setDragging] = useState(false);

  return (
    <main
      className={`hero ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
    >
      <div className="hero-inner">
        <h2>Turn photos into something you can build</h2>
        <p className="lede">
          Drop in a photo of an object. Brickify carves out its shape, rebuilds it from standard
          LEGO bricks and plates with properly staggered joints, checks that the result actually
          holds together, and walks you through assembling it one step at a time.
        </p>
        <label className="file-button">
          Choose a photo
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFile(file);
              e.target.value = '';
            }}
          />
        </label>
        <p className="hint">…or drag one here, or paste from the clipboard</p>

        <ul className="tips">
          <li>
            <b>Shoot more than one angle</b> Front and side is the single biggest upgrade — the
            shape gets carved from both outlines instead of guessed. Add more once you have one.
          </li>
          <li>
            <b>Plain background</b> Anything that separates cleanly from the object works best.
          </li>
          <li>
            <b>Same distance, upright</b> Keep the object the same size in every shot so the
            outlines line up.
          </li>
        </ul>
      </div>
    </main>
  );
}
