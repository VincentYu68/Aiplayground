/**
 * Ties recognition → translation → speech into one loop.
 *
 * Utterance-level rather than truly simultaneous: interim words appear as you
 * speak, but a phrase is only translated and spoken once the recogniser marks
 * it final. Translating partial text would mean constantly retracting audio
 * that had already been played.
 *
 * Utterances are processed strictly in order — if you keep talking while a
 * translation is still being spoken, the next one queues rather than overlaps.
 */

import { SpeechRecognizer, speechRecognitionSupported } from './speech.js';
import { Speaker, speechSynthesisSupported } from './tts.js';
import { makeTranslator, DIRECTIONS } from './translate.js';

export class Interpreter {
  /**
   * @param {object} handlers
   * @param {(text: string, final: boolean) => void} handlers.onSource
   * @param {(text: string) => void} handlers.onTranslation
   * @param {(state: string) => void} handlers.onState
   * @param {(msg: string, fatal: boolean) => void} handlers.onError
   * @param {(busy: boolean) => void} [handlers.onBusy] true while translating/speaking
   * @param {(stage: string, fraction: number) => void} [handlers.onProgress]
   */
  constructor(handlers = {}) {
    this.h = handlers;
    this.directionId = 'en-zh';
    this.engine = 'local';
    this.cloudOpts = { provider: 'google', apiKey: '' };
    this.translator = null;
    this.speaker = new Speaker();
    this.running = false;
    this.queue = [];
    this.draining = false;

    this.recognizer = new SpeechRecognizer({
      lang: DIRECTIONS[this.directionId].listenLang,
      onInterim: (t) => this.h.onSource?.(t, false),
      onFinal: (t) => this._enqueue(t),
      onError: (m, fatal) => this.h.onError?.(m, fatal),
      onState: (s) => this.h.onState?.(s),
    });
  }

  static get supported() {
    return speechRecognitionSupported() && speechSynthesisSupported();
  }

  get direction() { return DIRECTIONS[this.directionId]; }

  /** Call from a user gesture so iOS will allow speech playback later. */
  unlock() { this.speaker.unlock(); }

  setDirection(id) {
    if (id === this.directionId) return;
    this.directionId = id;
    this.translator?.dispose?.();
    this.translator = null;               // reload lazily for the new direction
    this.recognizer.setLang(this.direction.listenLang);
  }

  setEngine(engine, cloudOpts) {
    if (cloudOpts) this.cloudOpts = { ...this.cloudOpts, ...cloudOpts };
    if (engine === this.engine && this.translator) {
      if (this.engine === 'cloud') {
        // Key or provider may have changed; rebuild cheaply.
        this.translator = makeTranslator('cloud', this.directionId, this.cloudOpts);
      }
      return;
    }
    this.engine = engine;
    this.translator?.dispose?.();
    this.translator = null;
  }

  async _ensureTranslator() {
    if (this.translator?.ready) return this.translator;
    this.translator = makeTranslator(this.engine, this.directionId, this.cloudOpts);
    await this.translator.load(this.h.onProgress);
    return this.translator;
  }

  async start() {
    if (this.running) return;
    if (!Interpreter.supported) {
      this.h.onError?.(
        'This browser does not support speech recognition. On iPhone, use Safari.',
        true,
      );
      return;
    }

    try {
      await this._ensureTranslator();
    } catch (err) {
      this.h.onError?.(err?.message ?? String(err), true);
      return;
    }

    await this.speaker.ready();
    this.running = true;
    this.recognizer.start();
  }

  stop() {
    this.running = false;
    this.recognizer.stop();
    this.speaker.cancel();
    this.queue.length = 0;
    this.draining = false;
    this.h.onBusy?.(false);
    this.h.onState?.('idle');
  }

  _enqueue(text) {
    this.h.onSource?.(text, true);
    this.queue.push(text);
    this._drain();
  }

  async _drain() {
    if (this.draining) return;
    this.draining = true;
    this.h.onBusy?.(true);

    while (this.queue.length && this.running) {
      const text = this.queue.shift();
      try {
        const translated = await this.translator.translate(text);
        if (!this.running) break;
        if (translated) {
          this.h.onTranslation?.(translated);
          // Deafen ourselves while speaking, or the phone's own output is
          // picked up by the mic and translated again.
          this.recognizer.pause();
          await this.speaker.speak(translated, this.direction.speakLang);
          this.recognizer.resume();
        }
      } catch (err) {
        this.h.onError?.(err?.message ?? String(err), false);
        this.recognizer.resume();
      }
    }

    this.draining = false;
    this.h.onBusy?.(false);
  }
}
