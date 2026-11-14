"""Jarvis voice sidecar: speech-to-text (faster-whisper) and text-to-speech (Piper, or edge-tts) over HTTP on 127.0.0.1.

  POST /stt   body: raw PCM 16-bit LE, 16 kHz, mono (Content-Type: audio/l16) or any audio file (wav, mp3, ...)
              -> {"text": "...", "ms": 812, "audioMs": 2400}
  POST /tts   body: {"text": "..."} -> audio/wav (Piper) or audio/mpeg (edge-tts)
  GET  /health -> {"status": "ok", "stt": {...}, "tts": {...}}

Settings (environment): VOICE_HOST (127.0.0.1), VOICE_PORT (8791), STT_MODEL (small), STT_DEVICE (cpu | cuda),
STT_COMPUTE (int8), STT_THREADS (half the CPU threads), TTS_ENGINE (piper | edge), PIPER_VOICE (path to the .onnx),
TTS_VOICE (edge-tts voice, vi-VN-NamMinhNeural), HF_HOME (model cache).
Default engines are local: audio and text stay on this machine. TTS_ENGINE=edge sends the spoken text to Microsoft's
edge-tts service, which failed 2 of 3 Vietnamese sentences when measured on 2026-11-14 (README).
"""

import asyncio
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import wave

import numpy as np

if os.environ.get("STT_DEVICE", "cpu") == "cuda" and os.name == "nt":
    # CUDA 12 cuBLAS / cuDNN 9 come as pip wheels (nvidia-cublas-cu12, nvidia-cudnn-cu12): put their DLLs on the path
    import glob
    import site

    for base in site.getsitepackages():
        for d in glob.glob(os.path.join(base, "Lib", "site-packages", "nvidia", "*", "bin")) + glob.glob(os.path.join(base, "nvidia", "*", "bin")):
            os.add_dll_directory(d)
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")

from faster_whisper import WhisperModel

HOST = os.environ.get("VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOICE_PORT", "8791"))
STT_MODEL = os.environ.get("STT_MODEL", "small")
STT_DEVICE = os.environ.get("STT_DEVICE", "cpu")
STT_COMPUTE = os.environ.get("STT_COMPUTE", "int8")
STT_THREADS = int(os.environ.get("STT_THREADS", str(max(1, (os.cpu_count() or 2) // 2))))
TTS_ENGINE = os.environ.get("TTS_ENGINE", "piper")
PIPER_VOICE = os.environ.get("PIPER_VOICE", "")
TTS_VOICE = os.environ.get("TTS_VOICE", "vi-VN-NamMinhNeural")
MAX_BODY = 4 * 1024 * 1024  # ~2 min of 16 kHz PCM
# words the operators say: helps the model spell them right
PROMPT = "Jarvis, CityLight, tủ điện chiếu sáng, tủ demo, nhánh, cảnh báo, sự cố, mất kết nối, PLC, LOGO, mã lỗi, phường, quận, bật, tắt, lịch."

print(f"[voice] loading faster-whisper {STT_MODEL} on {STT_DEVICE}/{STT_COMPUTE}, {STT_THREADS} threads ...", flush=True)
t0 = time.time()
model = WhisperModel(STT_MODEL, device=STT_DEVICE, compute_type=STT_COMPUTE, cpu_threads=STT_THREADS)
print(f"[voice] STT ready in {time.time() - t0:.1f} s", flush=True)
stt_lock = threading.Lock()  # one transcription at a time: CPU / VRAM are shared with the LLM

piper_voice = None
if TTS_ENGINE == "piper":
    from piper import PiperVoice

    if not PIPER_VOICE or not os.path.exists(PIPER_VOICE):
        sys.exit(f"[voice] PIPER_VOICE must point to a Piper .onnx voice (got {PIPER_VOICE!r}); see README")
    piper_voice = PiperVoice.load(PIPER_VOICE)
    tts_lock = threading.Lock()
    # first synthesis is slow (graph warm-up): do it now, not on the first answer
    with wave.open(io.BytesIO(), "wb") as _w:
        piper_voice.synthesize_wav("Xin chào.", _w)
    print(f"[voice] TTS piper ready ({os.path.basename(PIPER_VOICE)})", flush=True)
else:
    import edge_tts


def transcribe(body: bytes, content_type: str) -> dict:
    if content_type.startswith("audio/l16") or content_type == "application/octet-stream":
        audio = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768.0
        audio_ms = int(len(audio) / 16)
        source = audio
    else:
        source = io.BytesIO(body)
        audio_ms = None
    start = time.time()
    with stt_lock:
        segments, info = model.transcribe(
            source,
            language="vi",
            beam_size=1,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            initial_prompt=PROMPT,
            condition_on_previous_text=False,
            without_timestamps=True,
        )
        kept = [s for s in segments if not looks_hallucinated(s)]
        text = " ".join(s.text.strip() for s in kept).strip()
    return {"text": text, "ms": int((time.time() - start) * 1000), "audioMs": audio_ms if audio_ms is not None else int(info.duration * 1000)}


# Whisper fills very short or silent audio with phrases from its training data (YouTube outros): drop those segments.
HALLUCINATIONS = ("subscribe", "đăng ký kênh", "kênh", "video", "cảm ơn các bạn đã theo dõi", "hẹn gặp lại", "like và", "ghiền mì gõ")


def looks_hallucinated(seg) -> bool:
    t = seg.text.strip().lower()
    if not t:
        return True
    if seg.no_speech_prob > 0.6 and seg.avg_logprob < -0.8:
        return True
    return any(h in t for h in HALLUCINATIONS)


async def _speak(text: str, voice: str) -> bytes:
    out = bytearray()
    async for chunk in edge_tts.Communicate(text, voice).stream():
        if chunk["type"] == "audio":
            out += chunk["data"]
    return bytes(out)


def speak_piper(text: str) -> bytes:
    buf = io.BytesIO()
    with tts_lock, wave.open(buf, "wb") as w:
        piper_voice.synthesize_wav(text, w)
    return buf.getvalue()


def speak(text: str, voice: str) -> tuple[bytes, str]:
    if piper_voice is not None:
        return speak_piper(text), "audio/wav"
    return speak_edge(text, voice), "audio/mpeg"


def speak_edge(text: str, voice: str) -> bytes:
    # the edge-tts service often answers a Vietnamese request with no audio (2 of 3 on 2026-11-14); retry a little
    last: Exception | None = None
    for attempt in range(3):
        try:
            audio = asyncio.run(_speak(text, voice))
            if audio:
                return audio
            last = RuntimeError("empty audio")
        except Exception as e:
            last = e
        time.sleep(0.15 * (attempt + 1))
    raise last if last else RuntimeError("tts failed")


class Handler(BaseHTTPRequestHandler):
    server_version = "jarvis-voice/1"

    def log_message(self, fmt, *args):  # quiet: no request bodies in logs
        pass

    def _send(self, status: int, body: bytes, ctype: str):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, data: dict):
        self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self):
        if self.path == "/health":
            tts = {"engine": "piper", "voice": os.path.basename(PIPER_VOICE)} if piper_voice is not None else {"engine": "edge-tts", "voice": TTS_VOICE}
            return self._json(200, {"status": "ok", "stt": {"model": STT_MODEL, "device": STT_DEVICE, "compute": STT_COMPUTE, "threads": STT_THREADS}, "tts": tts})
        self._json(404, {"error": "not_found"})

    def do_POST(self):
        size = int(self.headers.get("content-length") or 0)
        if size <= 0 or size > MAX_BODY:
            return self._json(413 if size > MAX_BODY else 400, {"error": "bad_size"})
        body = self.rfile.read(size)
        try:
            if self.path == "/stt":
                return self._json(200, transcribe(body, self.headers.get("content-type", "")))
            if self.path == "/tts":
                req = json.loads(body.decode("utf-8"))
                text = str(req.get("text", "")).strip()[:1000]
                if not text:
                    return self._json(400, {"error": "empty"})
                start = time.time()
                audio, mime = speak(text, str(req.get("voice") or TTS_VOICE))
                self.send_response(200)
                self.send_header("content-type", mime)
                self.send_header("content-length", str(len(audio)))
                self.send_header("x-tts-ms", str(int((time.time() - start) * 1000)))
                self.end_headers()
                self.wfile.write(audio)
                return
            self._json(404, {"error": "not_found"})
        except Exception as e:  # report, never crash the server
            print(f"[voice] {self.path} failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            self._json(502, {"error": "failed", "message": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[voice] listening on http://{HOST}:{PORT}", flush=True)
    srv.serve_forever()
