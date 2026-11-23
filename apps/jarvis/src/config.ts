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

  // groq (2026-11-17): free cloud tier, takes the model off this PC; ollama: local, nothing leaves the machine
  LLM_PROVIDER: z.enum(['ollama', 'groq', 'fake']).default('ollama'),
  // ollama default: qwen3:4b is the thinking-only 2507 build (~60 s per answer); instruct answers at once.
  // groq default: openai/gpt-oss-20b (tool use, fast); unset = the provider's default
  LLM_MODEL: z.string().min(1).optional(),
  // groq: models tried in order when the main one is out of free quota (each has its own 8,000 tokens / minute);
  // empty = openai/gpt-oss-120b
  LLM_FALLBACK_MODELS: z.string().optional(),
  // reasoning models on groq (gpt-oss): low answers sooner
  LLM_REASONING_EFFORT: z.enum(['low', 'medium', 'high', '']).optional().transform((v) => v || undefined),
  // the key of a Groq account (console.groq.com): only in this .env, never logged
  GROQ_API_KEY: z.string().optional(),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1').transform((s) => s.replace(/\/+$/, '')),
  // context window: 4096 leaves room for tool results; ~1/3 of a 4B model runs on CPU with a 4 GB GPU either way
  LLM_NUM_CTX: int(4096, 1024, 262_144),
  // earlier chat messages sent to the model each turn (the context keeps 20); a 4B model copies old answers with more
  JARVIS_CONTEXT_MESSAGES: int(6, 0, 20),
  OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434').transform((s) => s.replace(/\/+$/, '')),
  LLM_MAX_TOKENS: int(1024, 64, 32_768),
  // thinking models (qwen3...): false answers at once; unset = leave the model's default
  LLM_THINK: z
    .enum(['true', 'false', ''])
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),

  // groq: whisper on Groq's free tier (no GPU here); faster-whisper: the local sidecar
  STT_PROVIDER: z.enum(['faster-whisper', 'groq', 'none']).default('faster-whisper'),
  // faster-whisper default small; groq default whisper-large-v3-turbo
  STT_MODEL: z.string().min(1).optional(),
  TTS_PROVIDER: z.enum(['edge-tts', 'none']).default('edge-tts'),
  TTS_VOICE: z.string().min(1).default('vi-VN-NamMinhNeural'),
  // the Python voice sidecar (voice/sidecar.py); loopback only
  VOICE_URL: z.string().url().default('http://127.0.0.1:8791').transform((s) => s.replace(/\/+$/, '')),

  JARVIS_CABINET_ALLOWLIST: z.string().optional(),
  JARVIS_ACTIONS_ENABLED: bool(true),
  JARVIS_DAILY_TOKEN_CAP_MAX: int(0, 0, 1_000_000_000),
  JARVIS_DAILY_TOKEN_CAP: int(0, 0, 1_000_000_000),
  JARVIS_PER_USER_PER_MIN: int(10, 1, 60),
  // the whole system shares one free Groq key: 1,000 requests / day and 8,000 tokens / minute per model, one question
  // about 4,800 tokens and 2-3 requests (measured 2026-11-23). These stop a few accounts from using it up for everyone.
  // Defaults apply with LLM_PROVIDER=groq only; 0 = no limit.
  JARVIS_GLOBAL_PER_MIN: z.coerce.number().int().min(0).max(600).optional(),
  JARVIS_PER_USER_PER_DAY: z.coerce.number().int().min(0).max(100_000).optional(),
  JARVIS_STT_PER_MIN: z.coerce.number().int().min(0).max(600).optional(),
  JARVIS_HISTORY_DAYS: int(90, 7, 365),

  JARVIS_CONSOLE_HOST: z.string().min(1).default('127.0.0.1'),
  JARVIS_CONSOLE_PORT: int(8790, 1, 65_535),
  JARVIS_CONSOLE_TOKEN: z.string().optional(),
  // pages that may send requests besides the console's own address: the HTTPS address a proxy in front of the
  // loopback console shows (GitHub Codespaces port forwarding, 2026-11-21); comma separated, https:// only
  JARVIS_EXTRA_ORIGINS: z.string().optional(),
  JARVIS_DATA_DIR: z.string().optional(),
  // keep each spoken sentence as data/voice-debug/*.wav + what was heard, to tune speech recognition; off by default,
  // the folder is gitignored and should be emptied after the test (it holds the user's voice)
  JARVIS_DEBUG_AUDIO: bool(false),
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
  const groqKey = e.GROQ_API_KEY?.trim() || null;
  if ((e.LLM_PROVIDER === 'groq' || e.STT_PROVIDER === 'groq') && !groqKey)
    throw new Error('LLM_PROVIDER / STT_PROVIDER = groq: set GROQ_API_KEY in apps/jarvis/.env (a key from console.groq.com)');
  const tokenCapMax = e.JARVIS_DAILY_TOKEN_CAP_MAX;
  if (tokenCapMax > 0 && e.JARVIS_DAILY_TOKEN_CAP > tokenCapMax)
    throw new Error(`JARVIS_DAILY_TOKEN_CAP (${e.JARVIS_DAILY_TOKEN_CAP}) is above JARVIS_DAILY_TOKEN_CAP_MAX (${tokenCapMax})`);
  return {
    apiBase: e.CITYLIGHT_API_BASE,
    apiTimeoutMs: e.JARVIS_API_TIMEOUT_MS,
    llm: {
      provider: e.LLM_PROVIDER,
      model: e.LLM_MODEL ?? (e.LLM_PROVIDER === 'groq' ? 'openai/gpt-oss-20b' : 'qwen3:4b-instruct'),
      ollamaUrl: e.OLLAMA_URL, maxTokens: e.LLM_MAX_TOKENS, numCtx: e.LLM_NUM_CTX, think: e.LLM_THINK, reasoningEffort: e.LLM_REASONING_EFFORT,
      // qwen/qwen3.8-27b is not a default: on 2026-11-17 Groq rejected its tool calls (it put the arguments as the name)
      fallbackModels: (e.LLM_FALLBACK_MODELS ?? (e.LLM_PROVIDER === 'groq' ? 'openai/gpt-oss-120b' : '')).split(',').map((m) => m.trim()).filter(Boolean),
    },
    groq: { baseUrl: e.GROQ_BASE_URL, apiKey: groqKey },
    contextMessages: e.JARVIS_CONTEXT_MESSAGES,
    stt: { provider: e.STT_PROVIDER, model: e.STT_MODEL ?? (e.STT_PROVIDER === 'groq' ? 'whisper-large-v3-turbo' : 'small') },
    tts: { provider: e.TTS_PROVIDER, voice: e.TTS_VOICE },
    voice: { url: e.VOICE_URL, enabled: e.STT_PROVIDER !== 'none' && e.TTS_PROVIDER !== 'none' },
    cabinetAllowlist: parseAllowlist(e.JARVIS_CABINET_ALLOWLIST),
    actionsEnabled: e.JARVIS_ACTIONS_ENABLED,
    dailyTokenCapMax: tokenCapMax,
    dailyTokenCap: e.JARVIS_DAILY_TOKEN_CAP,
    perUserPerMin: e.JARVIS_PER_USER_PER_MIN,
    globalPerMin: e.JARVIS_GLOBAL_PER_MIN ?? (e.LLM_PROVIDER === 'groq' ? 4 : 0),
    perUserPerDay: e.JARVIS_PER_USER_PER_DAY ?? (e.LLM_PROVIDER === 'groq' ? 150 : 0),
    sttPerMin: e.JARVIS_STT_PER_MIN ?? (e.STT_PROVIDER === 'groq' ? 15 : 0),
    historyDays: e.JARVIS_HISTORY_DAYS,
    console: {
      host: e.JARVIS_CONSOLE_HOST, port: e.JARVIS_CONSOLE_PORT, token: consoleToken,
      extraOrigins: (e.JARVIS_EXTRA_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter((o) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)),
    },
    dataDir: path.resolve(APP_DIR, e.JARVIS_DATA_DIR ?? 'data'),
    debugAudio: e.JARVIS_DEBUG_AUDIO,
  };
}
