/**
 * Text-to-speech over the Web Speech API's speechSynthesis.
 *
 * Two iOS quirks are handled here:
 *  - getVoices() is populated asynchronously; on a cold load it returns []
 *    until the 'voiceschanged' event fires.
 *  - Safari will not speak until speak() has been called once from inside a
 *    user gesture. `unlock()` burns a silent utterance to satisfy that.
 */

export function speechSynthesisSupported() {
  return typeof window.speechSynthesis !== 'undefined';
}

export class Speaker {
  constructor() {
    this.unlocked = false;
    this._voices = [];
    this._ready = null;
    if (speechSynthesisSupported()) {
      this._voices = window.speechSynthesis.getVoices();
      window.speechSynthesis.addEventListener?.('voiceschanged', () => {
        this._voices = window.speechSynthesis.getVoices();
      });
    }
  }

  /** Resolves once the voice list is populated (or a timeout elapses). */
  ready() {
    if (!speechSynthesisSupported()) return Promise.resolve([]);
    if (this._ready) return this._ready;

    this._ready = new Promise((resolve) => {
      const got = () => {
        this._voices = window.speechSynthesis.getVoices();
        return this._voices.length > 0;
      };
      if (got()) return resolve(this._voices);

      const onChange = () => {
        if (got()) {
          window.speechSynthesis.removeEventListener?.('voiceschanged', onChange);
          clearTimeout(timer);
          resolve(this._voices);
        }
      };
      window.speechSynthesis.addEventListener?.('voiceschanged', onChange);
      // Some browsers never fire the event; do not block forever on it.
      const timer = setTimeout(() => {
        window.speechSynthesis.removeEventListener?.('voiceschanged', onChange);
        resolve(this._voices);
      }, 2000);
    });
    return this._ready;
  }

  /** Must be called from inside a user gesture, once, before any speak(). */
  unlock() {
    if (this.unlocked || !speechSynthesisSupported()) return;
    try {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      window.speechSynthesis.speak(u);
      this.unlocked = true;
    } catch { /* non-fatal */ }
  }

  /**
   * Best voice for a language tag. Prefers an exact match, then the base
   * language, then a local (on-device) voice over a remote one.
   */
  voiceFor(lang) {
    if (!this._voices.length) this._voices = window.speechSynthesis?.getVoices() ?? [];
    const want = lang.toLowerCase();
    const base = want.split('-')[0];

    const score = (v) => {
      const vl = (v.lang || '').toLowerCase().replace('_', '-');
      if (vl === want) return v.localService ? 4 : 3;
      if (vl.split('-')[0] === base) return v.localService ? 2 : 1;
      return 0;
    };

    let best = null;
    let bestScore = 0;
    for (const v of this._voices) {
      const s = score(v);
      if (s > bestScore) { bestScore = s; best = v; }
    }
    return best;
  }

  get speaking() {
    return Boolean(window.speechSynthesis?.speaking);
  }

  cancel() {
    try { window.speechSynthesis?.cancel(); } catch { /* fine */ }
  }

  /**
   * Speak `text` in `lang`. Resolves when playback finishes (or errors).
   * @param {string} text
   * @param {string} lang BCP-47 tag
   * @param {{rate?: number, pitch?: number, interrupt?: boolean}} [opts]
   */
  speak(text, lang, { rate = 1, pitch = 1, interrupt = true } = {}) {
    if (!speechSynthesisSupported() || !text) return Promise.resolve();
    if (interrupt) this.cancel();

    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = rate;
      u.pitch = pitch;
      const voice = this.voiceFor(lang);
      if (voice) u.voice = voice;

      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      u.onend = finish;
      u.onerror = finish;
      // Safari occasionally drops onend; do not leave the caller hanging.
      const guard = setTimeout(finish, 1000 + text.length * 120);
      u.onend = () => { clearTimeout(guard); finish(); };

      try {
        window.speechSynthesis.speak(u);
      } catch {
        clearTimeout(guard);
        finish();
      }
    });
  }
}
