// Voice mode of the console (milestone 3): one button turns it on; while on, the microphone is open, a simple
// energy VAD finds where a sentence starts and ends (~650 ms of silence), and each sentence is sent as 16 kHz PCM.
// Chrome's echo cancellation, noise suppression and gain control are asked for; without echo cancellation Jarvis
// would hear itself, so while it speaks a louder voice is needed to interrupt it (barge-in).

const FRAME_MS = 40;
const END_SILENCE_MS = 650;
const MIN_SPEECH_MS = 400;
const MAX_UTTERANCE_MS = 15_000;
const PREROLL_MS = 320;

export class VoiceInput {
  /**
   * @param {{ onSpeechStart: () => void, onUtterance: (pcm: ArrayBuffer, ms: number) => void, onLevel?: (v: number) => void, isPlaying: () => boolean }} cb
   */
  constructor(cb) {
    this.cb = cb;
    this.ctx = null;
    this.stream = null;
    this.floor = 0.01;
    this.reset();
  }

  reset() {
    this.speaking = false;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.frames = [];
    this.preroll = [];
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule('/mic-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'jarvis-mic');
    this.node.port.onmessage = (e) => this.feed(e.data);
    src.connect(this.node);
    this.reset();
  }

  async stop() {
    this.node?.port.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.stream = null;
    this.reset();
  }

  get on() {
    return !!this.ctx;
  }

  feed(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    this.cb.onLevel?.(rms);
    const playing = this.cb.isPlaying();
    // the threshold follows the room's noise; higher while Jarvis talks so its own voice does not cut it off
    const threshold = playing ? Math.max(0.045, this.floor * 6) : Math.max(0.012, this.floor * 3.5);
    const loud = rms > threshold;

    if (!this.speaking) {
      if (!loud) this.floor = this.floor * 0.95 + rms * 0.05;
      this.preroll.push(frame);
      if (this.preroll.length * FRAME_MS > PREROLL_MS) this.preroll.shift();
      this.voicedMs = loud ? this.voicedMs + FRAME_MS : 0;
      // 120 ms of voice starts a sentence; 250 ms while Jarvis is speaking (barge-in, spec 4.2)
      if (this.voicedMs >= (playing ? 250 : 120)) {
        this.speaking = true;
        this.frames = [...this.preroll];
        this.preroll = [];
        this.silenceMs = 0;
        this.cb.onSpeechStart();
      }
      return;
    }
    this.frames.push(frame);
    this.silenceMs = loud ? 0 : this.silenceMs + FRAME_MS;
    const total = this.frames.length * FRAME_MS;
    if (this.silenceMs >= END_SILENCE_MS || total >= MAX_UTTERANCE_MS) {
      const speechMs = total - this.silenceMs;
      const frames = this.frames;
      this.reset();
      if (speechMs >= MIN_SPEECH_MS) this.cb.onUtterance(toPcm16(frames, this.ctx.sampleRate), speechMs);
    }
  }
}

/** float frames at the device rate -> 16 kHz signed 16-bit little-endian (box-filter downsampling) */
function toPcm16(frames, rate) {
  const n = frames.reduce((a, f) => a + f.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const f of frames) {
    all.set(f, o);
    o += f.length;
  }
  const ratio = rate / 16000;
  const out = new Int16Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.min(n, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = from; j < to; j++) s += all[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, to - from)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out.buffer;
}

/** Plays the answer's sentences in order as they arrive. */
export class Player {
  constructor(onIdle) {
    this.onIdle = onIdle;
    this.queue = [];
    this.current = null;
  }

  get playing() {
    return !!this.current || this.queue.length > 0;
  }

  enqueue(base64, mime = 'audio/mpeg') {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    this.queue.push(URL.createObjectURL(new Blob([bytes], { type: mime })));
    if (!this.current) this.next();
  }

  next() {
    const url = this.queue.shift();
    if (!url) {
      this.current = null;
      this.onIdle?.();
      return;
    }
    const a = new Audio(url);
    this.current = a;
    const done = () => {
      URL.revokeObjectURL(url);
      if (this.current === a) this.next();
    };
    a.onended = done;
    a.onerror = done;
    a.play().catch(done);
  }

  stop() {
    for (const u of this.queue) URL.revokeObjectURL(u);
    this.queue = [];
    if (this.current) {
      this.current.pause();
      this.current.src = '';
    }
    this.current = null;
  }
}
