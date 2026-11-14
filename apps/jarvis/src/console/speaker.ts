// Speaks an answer while it is being written (spec 4.2): text deltas -> sentences -> speech text -> TTS, one sentence
// at a time and in order. For a question that needs data, nothing is spoken before a tool has run: a draft the agent
// may still throw away (the nudge) must never be heard. While a tool runs, a short filler is said once.
import { SentenceSplitter, toSpeech } from '../voice/speech-text';
import type { TtsAudio, TtsProvider } from '../voice/client';

export const FILLER = 'Để tôi kiểm tra.';

export interface SpokenChunk {
  seq: number;
  text: string;
  audio: Uint8Array;
  mime: string;
  ms: number;
  /** the "Để tôi kiểm tra." said while a tool runs: heard, not part of the answer text */
  filler: boolean;
}

export class Speaker {
  private readonly splitter = new SentenceSplitter();
  private held: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private seq = 0;
  private spokeAnything = false;
  private toolSeen = false;
  private stopped = false;
  firstAudioMs: number | null = null;
  readonly started = performance.now();
  errors: string[] = [];

  constructor(
    private readonly tts: TtsProvider,
    private readonly needsData: boolean,
    private readonly emit: (c: SpokenChunk) => void,
    private readonly signal: AbortSignal,
    private readonly filler?: () => Promise<TtsAudio | null>,
  ) {}

  private get gated() {
    return this.needsData && !this.toolSeen;
  }

  text(delta: string) {
    for (const s of this.splitter.push(delta)) this.queue(s);
  }

  /** the agent dropped its draft (nudge): forget what was held, the next draft comes */
  reset() {
    this.held = [];
    this.splitter.flush();
  }

  /** a tool started: what was written before it may be said now, plus a filler if nothing was said yet */
  tool() {
    if (!this.toolSeen) {
      this.toolSeen = true;
      const held = this.held;
      this.held = [];
      if (held.length) held.forEach((s) => this.say(s));
      else if (!this.spokeAnything && this.filler) this.sayAudio(FILLER, this.filler, true);
    }
  }

  /** the answer is complete: say the rest and wait until every sentence was sent */
  async end(): Promise<void> {
    for (const s of this.splitter.flush()) this.queue(s);
    this.toolSeen = true;
    const held = this.held;
    this.held = [];
    held.forEach((s) => this.say(s));
    await this.chain;
  }

  stop() {
    this.stopped = true;
    this.held = [];
  }

  private queue(sentence: string) {
    if (this.gated) this.held.push(sentence);
    else this.say(sentence);
  }

  private say(sentence: string) {
    const spoken = toSpeech(sentence);
    if (!spoken) return;
    this.sayAudio(sentence, () => this.tts.synth(spoken, this.signal));
  }

  private sayAudio(text: string, make: () => Promise<TtsAudio | null>, filler = false) {
    this.spokeAnything = true;
    const seq = ++this.seq;
    // synthesis starts now (in parallel with the next sentences); delivery stays in order
    const audio = make().catch((e: Error) => {
      this.errors.push(e.message);
      return null;
    });
    this.chain = this.chain.then(async () => {
      const a = await audio;
      if (!a || this.stopped || this.signal.aborted) return;
      const ms = Math.round(performance.now() - this.started);
      this.firstAudioMs ??= ms;
      this.emit({ seq, text, audio: a.audio, mime: a.mime, ms, filler });
    });
  }
}
