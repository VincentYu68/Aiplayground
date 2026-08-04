/**
 * Speech recognition wrapper over the Web Speech API.
 *
 * iOS Safari exposes this as webkitSpeechRecognition and routes audio through
 * Apple's speech service, so it needs a network connection. Two behaviours
 * there drive the design of this class:
 *
 *  - `continuous` is unreliable. The engine fires `onend` on its own after
 *    pauses, so staying "on" means restarting it until the caller says stop.
 *  - Recognition must be suspended while the app speaks, or the phone's own
 *    text-to-speech output is picked up by the mic and re-translated in a loop.
 *    `pause()` / `resume()` exist for exactly that.
 */

export function speechRecognitionSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export class SpeechRecognizer {
  /**
   * @param {object} opts
   * @param {string} opts.lang            BCP-47 tag, e.g. 'en-US' or 'zh-CN'
   * @param {(text: string) => void} [opts.onInterim]  partial, still changing
   * @param {(text: string) => void} [opts.onFinal]    settled utterance
   * @param {(msg: string, fatal: boolean) => void} [opts.onError]
   * @param {(state: string) => void} [opts.onState]   'idle'|'listening'|'paused'
   */
  constructor({ lang = 'en-US', onInterim, onFinal, onError, onState } = {}) {
    this.lang = lang;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onError = onError;
    this.onState = onState;

    this.active = false;     // caller wants us listening
    this.paused = false;     // temporarily suspended (we are speaking)
    this.running = false;    // engine actually running
    this.rec = null;
    this._restartTimer = null;
  }

  _make() {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) {
          const trimmed = text.trim();
          if (trimmed) this.onFinal?.(trimmed);
        } else {
          interim += text;
        }
      }
      if (interim.trim()) this.onInterim?.(interim.trim());
    };

    rec.onerror = (event) => {
      // 'no-speech' and 'aborted' are routine; everything else is worth surfacing.
      const err = event.error;
      if (err === 'no-speech' || err === 'aborted') return;
      const fatal = err === 'not-allowed' || err === 'service-not-allowed';
      this.onError?.(describeError(err), fatal);
      if (fatal) this.stop();
    };

    rec.onend = () => {
      this.running = false;
      // The engine stops by itself after pauses; restart while still wanted.
      if (this.active && !this.paused) {
        this._restartTimer = setTimeout(() => this._start(), 250);
      } else {
        this.onState?.(this.paused ? 'paused' : 'idle');
      }
    };

    rec.onstart = () => {
      this.running = true;
      this.onState?.('listening');
    };

    return rec;
  }

  _start() {
    if (this.running || !this.active || this.paused) return;
    try {
      this.rec = this._make();
      this.rec.start();
    } catch (err) {
      // start() throws if called while already starting; ignore and let onend retry.
      if (err?.name !== 'InvalidStateError') {
        this.onError?.(err?.message ?? String(err), false);
      }
    }
  }

  setLang(lang) {
    if (this.lang === lang) return;
    this.lang = lang;
    // Language only takes effect on a fresh recogniser.
    if (this.active) {
      this.stop();
      this.start();
    }
  }

  start() {
    if (!speechRecognitionSupported()) {
      this.onError?.('Speech recognition is not available in this browser.', true);
      return;
    }
    this.active = true;
    this.paused = false;
    this._start();
  }

  stop() {
    this.active = false;
    this.paused = false;
    clearTimeout(this._restartTimer);
    try { this.rec?.stop(); } catch { /* already stopped */ }
    this.running = false;
    this.onState?.('idle');
  }

  /** Suspend while the app speaks, so TTS output is not fed back in. */
  pause() {
    if (!this.active || this.paused) return;
    this.paused = true;
    clearTimeout(this._restartTimer);
    try { this.rec?.stop(); } catch { /* fine */ }
    this.onState?.('paused');
  }

  resume() {
    if (!this.active || !this.paused) return;
    this.paused = false;
    this._start();
  }
}

function describeError(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission was denied. Enable it in Settings › Safari › Microphone.';
    case 'network':
      return 'Speech recognition needs a network connection and could not reach the service.';
    case 'audio-capture':
      return 'No microphone was found.';
    default:
      return `Speech recognition error: ${code}`;
  }
}
