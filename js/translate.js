/**
 * Translation with two interchangeable back ends behind one interface:
 *
 *   LocalTranslator  — Marian/opus-mt running in-browser via transformers.js.
 *                      No key, nothing leaves the device, but one model per
 *                      direction (~40-80 MB) fetched on first use.
 *   CloudTranslator  — a REST call to Google or OpenAI using a key the user
 *                      types into the app. Better quality and no download, but
 *                      the transcript text leaves the device.
 *
 * Both expose `load(onProgress)` and `translate(text)`.
 *
 * Only providers that send CORS headers are usable from a static page, which
 * is why DeepL is absent — its API rejects browser-origin requests, so it
 * would need a server component to proxy it.
 */

/**
 * transformers.js is loaded from a CDN rather than vendored. Its browser build
 * bare-imports `onnxruntime-web/webgpu`, which a plain <script type="module">
 * cannot resolve, and onnxruntime-web itself is ~31 MB — far more than this
 * repo should carry. The on-device engine therefore depends on the network for
 * its runtime and its weights; the camera and emotion pipeline stay fully local
 * and keep working with no connection at all.
 */
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm';

const HF_MODELS = {
  // Marian models are single-direction, so each way is a separate download.
  // These IDs could not be verified from the build environment (huggingface.co
  // is blocked by its network policy) — if one 404s, correct it here.
  'en-zh': 'Xenova/opus-mt-en-zh',
  'zh-en': 'Xenova/opus-mt-zh-en',
};

/** Everything the app needs to know about a translation direction. */
export const DIRECTIONS = {
  'en-zh': {
    id: 'en-zh',
    label: 'English → Chinese',
    short: 'EN → 中文',
    listenLang: 'en-US',
    speakLang: 'zh-CN',
    sourceCode: 'en',
    targetCode: 'zh',
    sourceName: 'English',
    targetName: 'Chinese',
  },
  'zh-en': {
    id: 'zh-en',
    label: 'Chinese → English',
    short: '中文 → EN',
    listenLang: 'zh-CN',
    speakLang: 'en-US',
    sourceCode: 'zh',
    targetCode: 'en',
    sourceName: 'Chinese',
    targetName: 'English',
  },
};

export const opposite = (id) => (id === 'en-zh' ? 'zh-en' : 'en-zh');

/* ------------------------------------------------------------------ */
/* On-device                                                           */
/* ------------------------------------------------------------------ */

export class LocalTranslator {
  static get engineName() { return 'on-device'; }

  constructor(directionId) {
    this.direction = DIRECTIONS[directionId];
    this.modelId = HF_MODELS[directionId];
    this.pipe = null;
  }

  get ready() { return Boolean(this.pipe); }

  /** @param {(stage: string, fraction: number) => void} [onProgress] */
  async load(onProgress) {
    if (this.pipe) return this;
    onProgress?.('Loading translator', 0);

    let pipeline;
    let env;
    try {
      ({ pipeline, env } = await import(/* @vite-ignore */ TRANSFORMERS_URL));
    } catch (err) {
      // The raw failure here is "Failed to fetch dynamically imported module",
      // which tells the user nothing actionable.
      throw new Error(
        'Could not load the on-device translation runtime. It is fetched from a ' +
        'CDN the first time you use it, so this needs a working connection. ' +
        'Switch to the cloud engine below, or retry once you are online.',
      );
    }
    // Weights come from the Hugging Face CDN; there is no local copy to check.
    env.allowLocalModels = false;

    const seen = new Map();
    const report = (p) => {
      // transformers.js reports per-file progress; average across files so the
      // bar moves monotonically rather than resetting on each new file.
      if (p.status === 'progress' && p.file) {
        seen.set(p.file, (p.loaded ?? 0) / Math.max(1, p.total ?? 1));
      } else if (p.status === 'done' && p.file) {
        seen.set(p.file, 1);
      }
      const vals = [...seen.values()];
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      onProgress?.('Downloading translation model', avg);
    };

    try {
      this.pipe = await pipeline('translation', this.modelId, {
        dtype: 'q8',
        progress_callback: report,
      });
    } catch (err) {
      // Older/newer builds disagree about the dtype option name; retry plain
      // before giving up so a option mismatch does not look like a 404.
      try {
        this.pipe = await pipeline('translation', this.modelId, { progress_callback: report });
      } catch {
        throw new Error(
          `Could not load the on-device model "${this.modelId}". ` +
          `${err?.message ?? err}. Check the ID in js/translate.js, or switch to the cloud engine.`,
        );
      }
    }

    onProgress?.('Translator ready', 1);
    return this;
  }

  async translate(text) {
    if (!this.pipe) throw new Error('Translator not loaded');
    const out = await this.pipe(text);
    const first = Array.isArray(out) ? out[0] : out;
    return (first?.translation_text ?? '').trim();
  }

  dispose() {
    this.pipe = null;
  }
}

/* ------------------------------------------------------------------ */
/* Cloud                                                               */
/* ------------------------------------------------------------------ */

export const CLOUD_PROVIDERS = {
  google: { id: 'google', label: 'Google Translate', keyHint: 'Google Cloud API key' },
  openai: { id: 'openai', label: 'OpenAI', keyHint: 'OpenAI API key (sk-...)' },
};

export class CloudTranslator {
  static get engineName() { return 'cloud'; }

  constructor(directionId, { provider = 'google', apiKey = '', model = 'gpt-4o-mini' } = {}) {
    this.direction = DIRECTIONS[directionId];
    this.provider = provider;
    this.apiKey = apiKey;
    this.model = model;
  }

  get ready() { return Boolean(this.apiKey); }

  async load(onProgress) {
    if (!this.apiKey) throw new Error('Add an API key in settings to use the cloud engine.');
    onProgress?.('Translator ready', 1);
    return this;
  }

  async translate(text) {
    return this.provider === 'openai'
      ? this._openai(text)
      : this._google(text);
  }

  async _google(text) {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: text,
        source: this.direction.sourceCode,
        target: this.direction.targetCode,
        format: 'text',
      }),
    });
    if (!res.ok) throw new Error(await describeHttp(res, 'Google Translate'));
    const data = await res.json();
    const out = data?.data?.translations?.[0]?.translatedText ?? '';
    return decodeEntities(out).trim();
  }

  async _openai(text) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              `Translate the user's message from ${this.direction.sourceName} into ` +
              `${this.direction.targetName}. Reply with the translation only — no ` +
              `quotes, no notes, no romanisation.`,
          },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) throw new Error(await describeHttp(res, 'OpenAI'));
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content ?? '').trim();
  }

  dispose() {}
}

async function describeHttp(res, who) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message ?? '';
  } catch { /* body was not JSON */ }
  if (res.status === 401 || res.status === 403) {
    return `${who} rejected the API key (HTTP ${res.status}). ${detail}`;
  }
  if (res.status === 429) return `${who} rate limit reached. ${detail}`;
  return `${who} request failed (HTTP ${res.status}). ${detail}`;
}

/** Google returns HTML entities in translated text. */
function decodeEntities(s) {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

/* ------------------------------------------------------------------ */

/**
 * @param {'local'|'cloud'} engine
 * @param {string} directionId
 * @param {object} [cloudOpts]
 */
export function makeTranslator(engine, directionId, cloudOpts) {
  return engine === 'cloud'
    ? new CloudTranslator(directionId, cloudOpts)
    : new LocalTranslator(directionId);
}
