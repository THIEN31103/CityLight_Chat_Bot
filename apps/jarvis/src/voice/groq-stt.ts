// STT_PROVIDER=groq (2026-11-17): Whisper large-v3-turbo on Groq's free tier instead of faster-whisper on this PC's
// GPU. The audio of one sentence leaves the machine (16 kHz WAV); nothing is stored here. Same hint and the same
// "made-up words" filters as the local sidecar (voice/sidecar.py), so behaviour does not change with the engine.
import type { SttProvider, SttResult, TtsAudio, TtsProvider } from './client';
import { VoiceError } from './client';

/** what the operators say, written the way it should come out (same text as voice/sidecar.py PROMPT) */
export const STT_HINT =
  'Jarvis ơi, tổng quan hệ thống hôm nay thế nào? Tình hình hệ thống, báo cáo tình hình đầu ca. ' +
  'Tủ demo số mười bị gì vậy? Tủ TL01.0009 có đang sáng không? Lịch bật tắt của tủ đó. ' +
  'Phường nào, quận nào đang có lỗi, nhiều cảnh báo nhất? Có sự cố nào quá hạn không? ' +
  'Mã E201 nghĩa là gì? Mất kết nối PLC, LOGO, nhánh một, nhánh hai, dòng rò, điện áp, công suất. ' +
  'Bật tay, tắt tay, trả về chạy theo lịch, xác nhận, hủy lệnh, đồng ý, cảm ơn Jarvis.';

// Whisper fills very short or silent audio with phrases from its training data (YouTube outros)
const HALLUCINATIONS = ['subscribe', 'đăng ký kênh', 'kênh', 'video', 'cảm ơn các bạn đã theo dõi', 'hẹn gặp lại', 'like và', 'ghiền mì gõ'];
export const MIN_AVG_LOGPROB = -1.0;

export interface Segment {
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
}

/** a segment that is noise turned into words, a loop, or a YouTube outro */
export function looksMadeUp(s: Segment): boolean {
  const t = s.text.trim().toLowerCase();
  if (!t) return true;
  const lp = s.avg_logprob ?? 0;
  if ((s.no_speech_prob ?? 0) > 0.6 && lp < -0.8) return true;
  if (lp < MIN_AVG_LOGPROB) return true;
  if ((s.compression_ratio ?? 0) > 2.4) return true;
  return HALLUCINATIONS.some((h) => t.includes(h));
}

/** PCM 16-bit LE mono 16 kHz -> a WAV file */
export function pcmToWav(pcm: Uint8Array, rate = 16_000): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** the request did not reach Groq or no answer came back in time: worth one retry */
class NetworkError extends VoiceError {}

export class GroqStt implements SttProvider {
  constructor(private readonly opts: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number; fetch?: typeof fetch }) {}

  /**
   * One network retry: on 2026-11-17 two of eight sentences failed on the way to Groq ("fetch failed", a 20 s
   * timeout) and the same audio went through at once afterwards. A refusal from Groq (429, 401...) is not retried.
   */
  async transcribe(pcm: Uint8Array, signal?: AbortSignal): Promise<SttResult> {
    try {
      return await this.once(pcm, signal);
    } catch (e) {
      if (signal?.aborted || !(e instanceof NetworkError)) throw e;
      return this.once(pcm, signal);
    }
  }

  private async once(pcm: Uint8Array, signal?: AbortSignal): Promise<SttResult> {
    const form = new FormData();
    form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'cau-noi.wav');
    form.append('model', this.opts.model);
    form.append('language', 'vi');
    form.append('prompt', STT_HINT);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    const t0 = performance.now();
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
        body: form,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new NetworkError(`Không kết nối được Groq để nghe giọng (${(e as Error).message})`);
    }
    if (!res.ok) {
      if (res.status === 429) throw new VoiceError('Groq báo đã dùng hết giới hạn nghe giọng miễn phí lúc này, thử lại sau');
      if (res.status === 401) throw new VoiceError('Groq từ chối khóa API (kiểm tra GROQ_API_KEY trong .env)');
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new VoiceError(`Groq nghe giọng lỗi ${res.status}: ${body.error?.message ?? res.statusText}`);
    }
    const data = (await res.json()) as { text?: string; segments?: Segment[]; duration?: number };
    const segments = data.segments ?? [{ text: data.text ?? '' }];
    const kept = segments.filter((s) => !looksMadeUp(s));
    return {
      text: kept.map((s) => s.text.trim()).join(' ').trim(),
      ms: Math.round(performance.now() - t0),
      audioMs: Math.round(pcm.length / 32),
    };
  }
}

/** Speech recognition from one engine, speech from another (Groq hears, the local Piper sidecar speaks). */
export class MixedVoice implements SttProvider, TtsProvider {
  constructor(
    private readonly stt: SttProvider & { label?: string },
    private readonly tts: TtsProvider & { health?: () => Promise<{ status: string; stt: Record<string, unknown>; tts: Record<string, unknown> } | null> },
    private readonly sttInfo: Record<string, unknown>,
  ) {}

  transcribe(pcm: Uint8Array, signal?: AbortSignal) {
    return this.stt.transcribe(pcm, signal);
  }

  synth(text: string, signal?: AbortSignal): Promise<TtsAudio> {
    return this.tts.synth(text, signal);
  }

  /** ready when the speaking side answers; the cloud side is reached on the first sentence */
  async health() {
    const h = this.tts.health ? await this.tts.health() : { status: 'ok', stt: {}, tts: {} };
    return h ? { ...h, stt: this.sttInfo } : null;
  }
}
