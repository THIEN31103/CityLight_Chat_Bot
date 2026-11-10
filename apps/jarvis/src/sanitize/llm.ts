// G6: nothing that identifies a board, a SIM or a person reaches the LLM, the console text or the chat history,
// for every role (the provider account gets LTID from the API, Jarvis drops it anyway).
// Runs on every tool result before the model sees it and on every text Jarvis stores or shows.
import { stripLtid } from '@citylight/shared';

/** Keys dropped wherever they appear (case-insensitive). */
const DROP_EXACT = new Set(['ltid', 'imei', 'uid', 'ip', 'otp', 'email', 'phone', 'cookie', 'cookies']);
const DROP_PATTERN = /imei|iccid|email|phone|password|passwd|secret|csrf|apikey|api_key|^signing|^telegram|token$/i;
const COORD_KEYS = new Set(['lat', 'lng', 'lon', 'latitude', 'longitude']);

// CoreIF frames carry identity as KEY'value pairs: *#LTID'CTY0005&LIME'861234567890123&LPAS'secret$
const FRAME_FIELD = /\b(LTID|LIME|LUSR|LPAS)'[^&$\s]*/g;
// an IMEI written out anywhere (15 digits on their own)
const IMEI_IN_TEXT = /(?<![\d.])\d{15}(?![\d.])/g;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Vietnamese mobile numbers: 0xxxxxxxxx or +84xxxxxxxxx, with optional spaces / dots
const PHONE_IN_TEXT = /(?<![\w.])(?:\+84|0)(?:[\s.]?\d){9}(?![\w.])/g;

export interface SanitizeOptions {
  /** keep full coordinates (a tool that needs the exact position); default: rounded to ~100 m */
  preciseCoords?: boolean;
}

export function sanitizeText(text: string): string {
  return stripLtid(text)
    .replace(FRAME_FIELD, "$1'***")
    .replace(EMAIL_IN_TEXT, '***@***')
    .replace(IMEI_IN_TEXT, '***')
    .replace(PHONE_IN_TEXT, '***');
}

function dropKey(key: string) {
  return DROP_EXACT.has(key.toLowerCase()) || DROP_PATTERN.test(key);
}

/** A copy without identity fields or values; never mutates (API rows may be cached by the caller). */
export function sanitizeForLlm<T>(value: T, opts: SanitizeOptions = {}): T {
  return walk(stripLtid(value), opts, null) as T;
}

function walk(v: unknown, opts: SanitizeOptions, key: string | null): unknown {
  if (typeof v === 'string') return sanitizeText(v);
  if (typeof v === 'number') return !opts.preciseCoords && key && COORD_KEYS.has(key.toLowerCase()) ? Math.round(v * 1000) / 1000 : v;
  if (Array.isArray(v)) return v.map((x) => walk(x, opts, null));
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return v.toISOString();
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return undefined; // Buffer, stream...: nothing for the model
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (dropKey(k)) continue;
    const w = walk(x, opts, k);
    if (w !== undefined) out[k] = w;
  }
  return out;
}
