// Speech-to-text and text-to-speech behind interfaces (spec 4.1); the default implementation talks to the local
// Python sidecar (voice/sidecar.py: faster-whisper + edge-tts). A different engine only needs these two interfaces.

export interface SttResult {
  text: string;
  /** time the engine needed */
  ms: number;
  audioMs: number;
}

export interface SttProvider {
  /** PCM 16-bit LE, 16 kHz, mono */
  transcribe(pcm: Uint8Array, signal?: AbortSignal): Promise<SttResult>;
}

export interface TtsAudio {
  audio: Uint8Array;
  /** audio/wav (Piper) or audio/mpeg (edge-tts) */
  mime: string;
}

export interface TtsProvider {
  /** one sentence -> playable audio */
  synth(text: string, signal?: AbortSignal): Promise<TtsAudio>;
}

export class VoiceError extends Error {}

export class SidecarVoice implements SttProvider, TtsProvider {
  constructor(private readonly opts: { url: string; voice: string; timeoutMs?: number; fetch?: typeof fetch }) {}

  private async call(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.url}${path}`, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new VoiceError(`Bộ giọng nói lỗi ${res.status}: ${body.message ?? body.error ?? res.statusText}`);
      }
      return res;
    } catch (e) {
      if (signal?.aborted || e instanceof VoiceError) throw e;
      throw new VoiceError(`Không kết nối được bộ giọng nói tại ${this.opts.url} (${(e as Error).message})`);
    }
  }

  async health(): Promise<{ status: string; stt: Record<string, unknown>; tts: Record<string, unknown> } | null> {
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.url}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? ((await res.json()) as never) : null;
    } catch {
      return null;
    }
  }

  async transcribe(pcm: Uint8Array, signal?: AbortSignal): Promise<SttResult> {
    const res = await this.call('/stt', { method: 'POST', headers: { 'content-type': 'audio/l16; rate=16000; channels=1' }, body: pcm }, signal);
    return (await res.json()) as SttResult;
  }

  async synth(text: string, signal?: AbortSignal): Promise<TtsAudio> {
    const res = await this.call('/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice: this.opts.voice }) }, signal);
    return { audio: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'audio/mpeg' };
  }
}
