import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MaskEditor } from './ui/MaskEditor';
import { SettingsPanel } from './ui/SettingsPanel';
import { ManualViewer } from './ui/ManualViewer';
import { ExportPanel, FidelityPanel, PartsPanel, StabilityPanel } from './ui/ResultPanels';
import { loadImageFile, type SourceImage } from './lib/loadImage';
import { segment } from './core/image/segment';
import { generateModel } from './core/build/pipeline';
import { DEFAULT_OPTIONS, type BuildOptions, type BuildResult, type WorkerResponse } from './types';

/** Set at build time for single-file bundles, which have no worker to load. */
const SUPPORTS_WORKER =
  typeof Worker !== 'undefined' && import.meta.env.VITE_NO_WORKER !== '1';

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export default function App() {
  const [source, setSource] = useState<SourceImage | null>(null);
  const [name, setName] = useState('Model');
  const [hints, setHints] = useState<Uint8Array | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [threshold, setThreshold] = useState(0.5);
  const [mask, setMask] = useState<Uint8Array | null>(null);
  const [segmenting, setSegmenting] = useState(false);

  const [options, setOptions] = useState<BuildOptions>(DEFAULT_OPTIONS);
  const [result, setResult] = useState<BuildResult | null>(null);
  const [step, setStep] = useState(0);
  const [progress, setProgress] = useState<{ stage: string; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const autoBuild = useRef(false);

  const onWorkerMessage = useCallback((message: WorkerResponse) => {
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
    if (!SUPPORTS_WORKER) return;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./worker/pipeline.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      return;
    }
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      onWorkerMessage(event.data);
    });
    worker.addEventListener('error', () => {
      // Fall back for anything queued after this point.
      worker.terminate();
      workerRef.current = null;
    });
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [onWorkerMessage]);

  // --- segmentation --------------------------------------------------------
  const runSegmentation = useCallback(
    (src: SourceImage, hintBuffer: Uint8Array | null, box: Rect | null, t: number) => {
      setSegmenting(true);
      // Yield a frame so the spinner paints before the synchronous work starts.
      window.setTimeout(() => {
        try {
          const { mask: next } = segment(src.rgba, src.width, src.height, {
            threshold: t,
            rect: box,
            hints: hintBuffer,
          });
          setMask(next);
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setSegmenting(false);
        }
      }, 16);
    },
    [],
  );

  const build = useCallback(
    (src: SourceImage, currentMask: Uint8Array, buildOptions: BuildOptions) => {
      const id = requestId.current + 1;
      requestId.current = id;
      setError(null);
      setProgress({ stage: 'Starting', fraction: 0 });

      const worker = workerRef.current;
      if (worker) {
        worker.postMessage({
          id,
          rgba: new Uint8ClampedArray(src.rgba),
          width: src.width,
          height: src.height,
          mask: new Uint8Array(currentMask),
          options: buildOptions,
        });
        return;
      }

      // Main-thread fallback. Yielding first lets the progress bar paint, and
      // generation is well under a second even for the largest models.
      window.setTimeout(() => {
        try {
          const result = generateModel(
            src.rgba,
            currentMask,
            src.width,
            src.height,
            buildOptions,
          );
          onWorkerMessage({ id, type: 'done', result });
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

  // Build once automatically as soon as the first mask is ready.
  useEffect(() => {
    if (!autoBuild.current || !source || !mask) return;
    autoBuild.current = false;
    build(source, mask, options);
  }, [mask, source, options, build]);

  const onFile = useCallback(
    async (file: File) => {
      try {
        setError(null);
        const src = await loadImageFile(file);
        const nextHints = new Uint8Array(src.width * src.height);
        setSource(src);
        setName(file.name.replace(/\.[^.]+$/, '') || 'Model');
        setHints(nextHints);
        setRect(null);
        setMask(null);
        setResult(null);
        setStep(0);
        autoBuild.current = true;
        runSegmentation(src, nextHints, null, threshold);
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
      if (file) void onFile(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onFile]);

  const patchOptions = useCallback((patch: Partial<BuildOptions>) => {
    setOptions((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }, []);

  const onThresholdChange = useCallback(
    (value: number) => {
      setThreshold(value);
      if (source) runSegmentation(source, hints, rect, value);
      setDirty(true);
    },
    [source, hints, rect, runSegmentation],
  );

  const busy = progress !== null;
  const canBuild = Boolean(source && mask && !busy && !segmenting);

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
            <p>Photo → buildable LEGO model → 3D manual</p>
          </div>
        </div>
        {source && (
          <label className="file-button subtle">
            Change photo
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
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

      {!source ? (
        <Hero onFile={onFile} />
      ) : (
        <main className="layout">
          <aside className="controls">
            <section className="panel">
              <h2>1. Isolate the object</h2>
              <MaskEditor
                source={source}
                mask={mask}
                hints={hints ?? new Uint8Array(source.width * source.height)}
                rect={rect}
                onPaint={(nextHints, localMask) => {
                  setHints(nextHints);
                  if (localMask) setMask(localMask);
                }}
                onRect={(nextRect) => setRect(nextRect)}
                onCommit={() => runSegmentation(source, hints, rect, threshold)}
              />
              {segmenting && <p className="hint working">Working out the outline…</p>}
            </section>

            <section className="panel">
              <h2>2. Shape the build</h2>
              <SettingsPanel
                options={options}
                threshold={threshold}
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
                onClick={() => source && mask && build(source, mask, options)}
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
                    <h2>3. Build it</h2>
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
                  <FidelityPanel result={result} source={source} />
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
                  the photo never leaves this device.
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
        <h2>Turn a photo into something you can build</h2>
        <p className="lede">
          Drop in a photo of an object. Brickify works out its shape, rebuilds it from standard LEGO
          bricks and plates with properly staggered joints, checks that the result actually holds
          together, and walks you through assembling it one step at a time.
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
            <b>Plain background</b> Anything that separates cleanly from the object works best.
          </li>
          <li>
            <b>Straight on</b> Front-on shots keep proportions honest; angled ones get skewed.
          </li>
          <li>
            <b>Even light</b> Hard shadows read as depth and will show up in the model.
          </li>
        </ul>
      </div>
    </main>
  );
}
