import { useEffect, useRef, useState } from 'react';
import { useDict } from '@/i18n';
import { ENROLL } from '@/i18n/dict/enroll';

/** Longest side of the frame given to the decoder: enough for a label and cheap on a phone. */
const DECODE_SIZE = 640;
const DECODE_EVERY_MS = 150;

type CameraProblem = 'cameraDenied' | 'cameraMissing' | 'cameraBusy' | 'cameraInsecure' | 'cameraFailed';

/** Why getUserMedia failed, so the person knows what to fix. */
function cameraProblem(e: unknown): CameraProblem {
  if (!navigator.mediaDevices) return 'cameraInsecure';
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'cameraDenied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'cameraMissing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'cameraBusy';
  return 'cameraFailed';
}

/** Live camera view that reports the first QR code it reads, then stops. */
export function QrScanner({ onRead, onCameraError }: { onRead: (text: string) => void; onCameraError: (message: string) => void }) {
  const t = useDict(ENROLL);
  const video = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState(false);
  const handlers = useRef({ onRead, onCameraError });
  handlers.current = { onRead, onCameraError };
  const textRef = useRef(t);
  textRef.current = t;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stream: MediaStream | undefined;

    const start = async () => {
      try {
        const { default: jsQR } = await import('jsqr');
        if (stopped) return;
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
        const v = video.current;
        // closed while the browser was asking: this stream would otherwise keep the camera on
        if (stopped || !v) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        v.srcObject = stream;
        await v.play();
        setLive(true);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        const tick = () => {
          if (stopped) return;
          if (v.videoWidth) {
            const scale = Math.min(1, DECODE_SIZE / Math.max(v.videoWidth, v.videoHeight));
            canvas.width = Math.round(v.videoWidth * scale);
            canvas.height = Math.round(v.videoHeight * scale);
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const hit = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
            if (hit?.data) {
              handlers.current.onRead(hit.data);
              return;
            }
          }
          timer = setTimeout(tick, DECODE_EVERY_MS);
        };
        tick();
      } catch (e) {
        console.error('[QrScanner]', e);
        if (!stopped) handlers.current.onCameraError(textRef.current[cameraProblem(e)]);
      }
    };
    void start();

    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <div className="relative overflow-hidden rounded-lg bg-black">
      {/* playsInline + muted: iPhone Safari refuses to start the preview otherwise */}
      <video ref={video} playsInline muted className="aspect-square w-full object-cover" />
      {live && <div className="absolute inset-x-0 bottom-0 bg-black/60 px-3 py-2 text-center text-sm text-white">{t.aimHint}</div>}
    </div>
  );
}
