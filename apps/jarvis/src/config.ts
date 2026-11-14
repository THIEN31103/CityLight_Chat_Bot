// Environment of apps/jarvis, validated once at start (zod). Secrets come from apps/jarvis/.env (gitignored).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_ALLOWLIST = 10_000;

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));
const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

/**
 * "DM0001..DM0010, TM01.0005" -> every code, upper case. A range keeps the prefix and the digit width of its ends.
 * Empty = no cabinet may be controlled (fail closed, spec 6.1).
 */
export function parseAllowlist(raw: string | undefined): string[] {
  const out = new Set<string>();
  for (const part of (raw ?? '').split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)) {
    const range = /^(.*?)(\d+)\.\.\1(\d+)$/.exec(part) ?? /^(.*?)(\d+)\.\.(\d+)$/.exec(part);
    if (!range) {
      out.add(part);
      continue;
    }
    const [, prefix, a, b] = range as unknown as [string, string, string, string];
    const from = Number(a);
    const to = Number(b);
    if (to < from) throw new Error(`JARVIS_CABINET_ALLOWLIST: range ${part} goes backwards`);
    if (to - from + 1 + out.size > MAX_ALLOWLIST) throw new Error(`JARVIS_CABINET_ALLOWLIST: more than ${MAX_ALLOWLIST} cabinets`);
    for (let n = from; n <= to; n++) out.add(`${prefix}${String(n).padStart(a.length, '0')}`);
  }
  return [...out];
}

const Env = z.object({
  CITYLIGHT_API_BASE: z.string().url().default('http://localhost:3000/api/v1').transform((s) => s.replace(/\/+$/, '')),
  JARVIS_API_TIMEOUT_MS: int(5000, 500, 60_000),

  LLM_PROVIDER: z.enum(['ollama', 'fake']).default('ollama'),
  // qwen3:4b is the thinking-only 2507 build (think=false does not stop it, ~60 s per answer); instruct answers at once
  LLM_MODEL: z.string().min(1).default('qwen3:4b-instruct'),
  // context window: 4096 leaves room for tool results; ~1/3 of a 4B model runs on CPU with a 4 GB GPU either way
  LLM_NUM_CTX: int(4096, 1024, 262_144),
  OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434').transform((s) => s.replace(/\/+$/, '')),
  LLM_MAX_TOKENS: int(1024, 64, 32_768),
  // thinking models (qwen3...): false answers at once; unset = leave the model's default
  LLM_THINK: z
    .enum(['true', 'false', ''])
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),

  STT_PROVIDER: z.enum(['faster-whisper', 'none']).default('faster-whisper'),
  STT_MODEL: z.string().min(1).default('small'),
  TTS_PROVIDER: z.enum(['edge-tts', 'none']).default('edge-tts'),
  TTS_VOICE: z.string().min(1).default('vi-VN-NamMinhNeural'),

  JARVIS_CABINET_ALLOWLIST: z.string().optional(),
  JARVIS_ACTIONS_ENABLED: bool(true),
  JARVIS_DAILY_TOKEN_CAP_MAX: int(0, 0, 1_000_000_000),
  JARVIS_DAILY_TOKEN_CAP: int(0, 0, 1_000_000_000),
  JARVIS_PER_USER_PER_MIN: int(10, 1, 60),
  JARVIS_HISTORY_DAYS: int(90, 7, 365),

  JARVIS_CONSOLE_HOST: z.string().min(1).default('127.0.0.1'),
  JARVIS_CONSOLE_PORT: int(8790, 1, 65_535),
  JARVIS_CONSOLE_TOKEN: z.string().optional(),
  JARVIS_DATA_DIR: z.string().optional(),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`apps/jarvis/.env: ${why}`);
  }
  const e = parsed.data;
  const consoleToken = e.JARVIS_CONSOLE_TOKEN?.trim() || null;
  // spec 10: LAN only with a token, never an open port
  if (!LOOPBACK.has(e.JARVIS_CONSOLE_HOST) && (!consoleToken || consoleToken.length < 24))
    throw new Error('JARVIS_CONSOLE_HOST is not loopback: set JARVIS_CONSOLE_TOKEN (at least 24 characters)');
  const tokenCapMax = e.JARVIS_DAILY_TOKEN_CAP_MAX;
  if (tokenCapMax > 0 && e.JARVIS_DAILY_TOKEN_CAP > tokenCapMax)
    throw new Error(`JARVIS_DAILY_TOKEN_CAP (${e.JARVIS_DAILY_TOKEN_CAP}) is above JARVIS_DAILY_TOKEN_CAP_MAX (${tokenCapMax})`);
  return {
    apiBase: e.CITYLIGHT_API_BASE,
    apiTimeoutMs: e.JARVIS_API_TIMEOUT_MS,
    llm: { provider: e.LLM_PROVIDER, model: e.LLM_MODEL, ollamaUrl: e.OLLAMA_URL, maxTokens: e.LLM_MAX_TOKENS, numCtx: e.LLM_NUM_CTX, think: e.LLM_THINK },
    stt: { provider: e.STT_PROVIDER, model: e.STT_MODEL },
    tts: { provider: e.TTS_PROVIDER, voice: e.TTS_VOICE },
    cabinetAllowlist: parseAllowlist(e.JARVIS_CABINET_ALLOWLIST),
    actionsEnabled: e.JARVIS_ACTIONS_ENABLED,
    dailyTokenCapMax: tokenCapMax,
    dailyTokenCap: e.JARVIS_DAILY_TOKEN_CAP,
    perUserPerMin: e.JARVIS_PER_USER_PER_MIN,
    historyDays: e.JARVIS_HISTORY_DAYS,
    console: { host: e.JARVIS_CONSOLE_HOST, port: e.JARVIS_CONSOLE_PORT, token: consoleToken },
    dataDir: path.resolve(APP_DIR, e.JARVIS_DATA_DIR ?? 'data'),
  };
}
