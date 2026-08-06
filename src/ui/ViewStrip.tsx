/**
 * The set of photographs the model is built from.
 *
 * One photo can only ever give a silhouette and a guess at the depth behind it.
 * Each additional angle carves the shape down further, so this is the control
 * that most changes how right the model looks once you orbit it — which is why
 * it sits at the top rather than buried in settings.
 */

import type { ViewState } from '../types';

const ANGLES: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Front' },
  { value: 45, label: 'Front-right' },
  { value: 90, label: 'Right' },
  { value: 135, label: 'Back-right' },
  { value: 180, label: 'Back' },
  { value: 225, label: 'Back-left' },
  { value: 270, label: 'Left' },
  { value: 315, label: 'Front-left' },
];

interface Props {
  views: ViewState[];
  activeId: number;
  onSelect: (id: number) => void;
  onAdd: (file: File) => void;
  onRemove: (id: number) => void;
  onAzimuth: (id: number, azimuth: number) => void;
}

export function ViewStrip({ views, activeId, onSelect, onAdd, onRemove, onAzimuth }: Props) {
  const used = new Set(views.map((v) => v.azimuth));

  return (
    <div className="view-strip">
      <div className="view-cards">
        {views.map((view) => (
          <div
            key={view.id}
            className={view.id === activeId ? 'view-card active' : 'view-card'}
          >
            <button
              type="button"
              className="view-thumb"
              onClick={() => onSelect(view.id)}
              title={`Edit the cut-out for this view`}
            >
              <img src={view.source.dataUrl} alt={`View at ${view.azimuth} degrees`} />
              {!view.mask && <span className="view-busy">…</span>}
            </button>
            <div className="view-meta">
              <select
                value={view.azimuth}
                onChange={(e) => onAzimuth(view.id, Number(e.target.value))}
                aria-label="Camera angle"
              >
                {ANGLES.map((a) => (
                  <option
                    key={a.value}
                    value={a.value}
                    disabled={a.value !== view.azimuth && used.has(a.value)}
                  >
                    {a.label}
                  </option>
                ))}
              </select>
              {views.length > 1 && (
                <button
                  type="button"
                  className="view-remove"
                  onClick={() => onRemove(view.id)}
                  aria-label="Remove this view"
                >
                  ×
                </button>
              )}
            </div>
          </div>
        ))}

        {views.length < 8 && (
          <label className="view-card add">
            <span className="view-add-plus">+</span>
            <span className="view-add-label">Add angle</span>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onAdd(file);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>

      <p className="view-note">
        {views.length === 1 ? (
          <>
            <b>One photo can't describe a solid.</b> The shape behind the outline is a
            guess, so the model only really reads from the front. Add a photo from the
            side and the shape is carved from both silhouettes instead of invented.
          </>
        ) : (
          <>
            Shape carved from {views.length} silhouettes. Shoot from roughly the same
            distance each time, keeping the object upright and centred.
          </>
        )}
      </p>
    </div>
  );
}
