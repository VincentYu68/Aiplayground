/**
 * The interactive manual: a 3D view of the model at the current step, plus the
 * transport controls for moving through the build.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { BrickScene } from '../render/BrickScene';
import { COLOR_BY_LDRAW } from '../core/lego/colors';
import type { BuildResult } from '../types';

interface Props {
  result: BuildResult;
  step: number;
  onStepChange: (step: number) => void;
}

export function ManualViewer({ result, step, onStepChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<BrickScene | null>(null);
  const [playing, setPlaying] = useState(false);
  const [showGhost, setShowGhost] = useState(true);
  const [highlightSupports, setHighlightSupports] = useState(false);
  const [followStep, setFollowStep] = useState(true);

  useEffect(() => {
    if (!canvasRef.current) return;
    const scene = new BrickScene(canvasRef.current);
    sceneRef.current = scene;

    const wrap = wrapRef.current;
    const observer = new ResizeObserver(() => {
      if (!wrap) return;
      scene.resize(wrap.clientWidth, wrap.clientHeight);
    });
    if (wrap) {
      observer.observe(wrap);
      scene.resize(wrap.clientWidth, wrap.clientHeight);
    }

    return () => {
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setModel(result);
  }, [result]);

  useEffect(() => {
    sceneRef.current?.setStep(step);
  }, [step]);

  useEffect(() => {
    sceneRef.current?.setOptions({ showGhost, highlightSupports, followStep });
  }, [showGhost, highlightSupports, followStep]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      onStepChange(step + 1 >= result.steps.length ? 0 : step + 1);
    }, 850);
    return () => window.clearInterval(timer);
  }, [playing, step, result.steps.length, onStepChange]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === 'ArrowRight') {
        onStepChange(Math.min(result.steps.length - 1, step + 1));
      } else if (event.key === 'ArrowLeft') {
        onStepChange(Math.max(0, step - 1));
      } else if (event.key === ' ') {
        event.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, result.steps.length, onStepChange]);

  const current = result.steps[step];
  const stepParts = useMemo(() => {
    const counts = new Map<string, { label: string; hex: string; name: string; n: number }>();
    for (const p of current?.placements ?? []) {
      const key = `${p.partId}|${p.color}`;
      const existing = counts.get(key);
      if (existing) {
        existing.n++;
        continue;
      }
      const color = COLOR_BY_LDRAW.get(p.color);
      counts.set(key, {
        label: `${p.height === 3 ? 'Brick' : 'Plate'} ${p.w}×${p.d}`,
        hex: color?.hex ?? '#888',
        name: color?.name ?? `LDraw ${p.color}`,
        n: 1,
      });
    }
    return [...counts.values()];
  }, [current]);

  return (
    <div className="viewer">
      <div className="viewer-canvas" ref={wrapRef}>
        <canvas ref={canvasRef} />
        <div className="viewer-overlay-tools">
          {(['iso', 'front', 'side', 'top'] as const).map((view) => (
            <button key={view} type="button" onClick={() => sceneRef.current?.setView(view)}>
              {view}
            </button>
          ))}
        </div>
      </div>

      <div className="transport">
        <button
          type="button"
          className="icon-button"
          onClick={() => onStepChange(0)}
          disabled={step === 0}
          aria-label="First step"
        >
          ⏮
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => onStepChange(Math.max(0, step - 1))}
          disabled={step === 0}
          aria-label="Previous step"
        >
          ◀
        </button>
        <button
          type="button"
          className="icon-button primary"
          onClick={() => setPlaying((p) => !p)}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => onStepChange(Math.min(result.steps.length - 1, step + 1))}
          disabled={step >= result.steps.length - 1}
          aria-label="Next step"
        >
          ▶
        </button>
        <input
          className="step-slider"
          type="range"
          min={0}
          max={Math.max(0, result.steps.length - 1)}
          value={step}
          onChange={(e) => onStepChange(Number(e.target.value))}
          aria-label="Build step"
        />
        <span className="step-counter">
          Step <b>{step + 1}</b> / {result.steps.length}
        </span>
      </div>

      <div className="step-detail">
        <div className="step-parts">
          <h3>Add these {current?.placements.length ?? 0} parts</h3>
          <ul>
            {stepParts.map((p) => (
              <li key={`${p.label}-${p.name}`}>
                <span className="swatch" style={{ background: p.hex }} />
                <b>{p.n}&times;</b> {p.label}
                <em>{p.name}</em>
              </li>
            ))}
          </ul>
          {current?.placements.some((p) => p.needsHold) && (
            <p className="step-note">
              Some of these overhang with nothing underneath — hold them in place until the next
              course locks them in.
            </p>
          )}
          <p className="step-meta">
            {current?.cumulativeParts ?? 0} of {result.totalParts} parts placed &middot; layer{' '}
            {current?.placements[0]?.y ?? 0} of {result.gridY}
          </p>
        </div>

        <div className="viewer-toggles">
          <label className="toggle small">
            <input type="checkbox" checked={showGhost} onChange={(e) => setShowGhost(e.target.checked)} />
            <span>Ghost the rest of the model</span>
          </label>
          <label className="toggle small">
            <input
              type="checkbox"
              checked={followStep}
              onChange={(e) => setFollowStep(e.target.checked)}
            />
            <span>Follow the current layer</span>
          </label>
          <label className="toggle small">
            <input
              type="checkbox"
              checked={highlightSupports}
              onChange={(e) => setHighlightSupports(e.target.checked)}
            />
            <span>Show structural supports</span>
          </label>
        </div>
      </div>
    </div>
  );
}
