import type { BackTreatment, BuildOptions, SolidMode } from '../types';

interface Props {
  options: BuildOptions;
  threshold: number;
  /** True once the shape is carved from silhouettes rather than guessed. */
  multiView: boolean;
  onChange: (patch: Partial<BuildOptions>) => void;
  onThresholdChange: (value: number) => void;
  disabled: boolean;
}

const SOLID_MODES: Array<{ value: SolidMode; label: string; hint: string }> = [
  {
    value: 'symmetric',
    label: 'Rounded solid',
    hint: 'Bulges front and back from the outline. Best for most objects.',
  },
  {
    value: 'revolve',
    label: 'Turned',
    hint: 'Spins the outline around a vertical axis. For mugs, vases, bottles, lamps.',
  },
  {
    value: 'relief',
    label: 'Relief',
    hint: 'Flat back, raised front. For plaques, logos and wall pieces.',
  },
];

const BACK_TREATMENTS: Array<{ value: BackTreatment; label: string; hint: string }> = [
  {
    value: 'wrap',
    label: 'Wrap the edges round',
    hint: 'Carries the colours at the outline round the back. The safest guess.',
  },
  {
    value: 'flat',
    label: 'Plain back',
    hint: 'One solid colour behind. Cheapest, and honest about what is unknown.',
  },
  {
    value: 'mirror',
    label: 'Mirror the front',
    hint: 'Repeats the photo on the back — a second face on the back of a head.',
  },
];

export function SettingsPanel({
  options,
  threshold,
  multiView,
  onChange,
  onThresholdChange,
  disabled,
}: Props) {
  return (
    <div className="settings">
      <fieldset disabled={disabled}>
        <legend>Shape</legend>

        {multiView && (
          <p className="field-hint carved-note">
            The shape is carved from your silhouettes, so the depth guesses below no
            longer apply. Add more angles to sharpen it.
          </p>
        )}

        {!multiView &&
          SOLID_MODES.length > 0 && (
        <div className="mode-list">
          {SOLID_MODES.map((mode) => (
            <label key={mode.value} className={options.solidMode === mode.value ? 'mode active' : 'mode'}>
              <input
                type="radio"
                name="solidMode"
                value={mode.value}
                checked={options.solidMode === mode.value}
                onChange={() => onChange({ solidMode: mode.value })}
              />
              <span className="mode-label">{mode.label}</span>
              <span className="mode-hint">{mode.hint}</span>
            </label>
          ))}
        </div>
          )}

        <Slider
          label="Width"
          value={options.studsWide}
          min={12}
          max={64}
          step={2}
          suffix=" studs"
          hint="Bigger models capture more detail and need many more parts."
          onChange={(v) => onChange({ studsWide: v })}
        />

        {!multiView && options.solidMode !== 'revolve' && (
          <Slider
            label="Thickness"
            value={Math.round(options.depthScale * 100)}
            min={10}
            max={100}
            step={5}
            suffix="%"
            hint="Depth at the thickest point, as a share of the model's width."
            onChange={(v) => onChange({ depthScale: v / 100 })}
          />
        )}

        {!multiView && (
        <Slider
          label="Surface relief"
          value={Math.round(options.shadingInfluence * 100)}
          min={0}
          max={80}
          step={5}
          suffix="%"
          hint="How much the photo's shading shapes the surface. Raise it for faces and folds, drop it for flat lighting."
          onChange={(v) => onChange({ shadingInfluence: v / 100 })}
        />
        )}

        {!multiView && (
        <div className="mode-list">
          <p className="field-hint back-note">
            The photo shows one side only. The back is a guess, and this is the guess.
          </p>
          {BACK_TREATMENTS.map((mode) => (
            <label
              key={mode.value}
              className={options.backTreatment === mode.value ? 'mode active' : 'mode'}
            >
              <input
                type="radio"
                name="backTreatment"
                value={mode.value}
                checked={options.backTreatment === mode.value}
                onChange={() => onChange({ backTreatment: mode.value })}
              />
              <span className="mode-label">{mode.label}</span>
              <span className="mode-hint">{mode.hint}</span>
            </label>
          ))}
        </div>
        )}

        {multiView && (
          <Slider
            label="Carve tolerance"
            value={options.hullTolerance}
            min={0}
            max={2}
            step={1}
            suffix=" views"
            hint="How many photos a piece of the model may be missing from and survive. Raise it if a good part of the object is being carved away by one bad cut-out."
            onChange={(v) => onChange({ hullTolerance: v })}
          />
        )}

        <Slider
          label="Cutout sensitivity"
          value={Math.round(threshold * 100)}
          min={20}
          max={80}
          step={2}
          suffix="%"
          hint="Raise it if background is creeping in, lower it if the object is being eaten."
          onChange={(v) => onThresholdChange(v / 100)}
        />
      </fieldset>

      <fieldset disabled={disabled}>
        <legend>Bricks</legend>

        <Slider
          label="Colours"
          value={options.maxColors}
          min={2}
          max={41}
          step={1}
          hint="Fewer colours are cheaper to buy and read more boldly; more colours track the photo."
          onChange={(v) => onChange({ maxColors: v })}
        />

        <div className="toggle-row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={options.resolution === 'bricks'}
              onChange={(e) => onChange({ resolution: e.target.checked ? 'bricks' : 'mixed' })}
            />
            <span>
              Bricks only
              <em>
                Builds in whole 3-plate courses: strong, half the parts, one connected piece. Turning
                it off doubles the vertical resolution, but on a curved object the extra plates
                overhang and the model tends to come apart into sections. Check the stability score.
              </em>
            </span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={options.hollow}
              onChange={(e) => onChange({ hollow: e.target.checked })}
            />
            <span>
              Hollow interior
              <em>Leaves a two-stud shell. Saves a lot of parts on thick models.</em>
            </span>
          </label>
        </div>

        <Slider
          label="Parts per step"
          value={options.partsPerStep}
          min={2}
          max={20}
          step={1}
          hint="Smaller steps make a longer, gentler manual."
          onChange={(v) => onChange({ partsPerStep: v })}
        />
      </fieldset>
    </div>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  hint?: string;
  onChange: (value: number) => void;
}

function Slider({ label, value, min, max, step, suffix = '', hint, onChange }: SliderProps) {
  return (
    <label className="field">
      <span className="field-head">
        <span>{label}</span>
        <b>
          {value}
          {suffix}
        </b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <em className="field-hint">{hint}</em>}
    </label>
  );
}
