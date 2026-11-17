// LLM_PROVIDER=groq (2026-11-17): a cloud model behind an OpenAI-compatible /chat/completions API, streamed as
// server-sent events. Chosen to take the heaviest load (Ollama, ~3.5 GB) off this PC; Groq's free tier needs no card.
// What leaves the machine: the system prompt, the conversation and the tool results, all already sanitised (G6: no
// LTID / IMEI / signing keys / e-mail / phone). Real customer data needs the customer's consent (spec 10).
// The API key is sent only in the Authorization header and never logged or shown.
import type { LlmEvent, LlmMessage, LlmProvider, LlmRequest, LlmTool } from '../llm';

export interface OpenAiCompatOptions {
  /** shown on the console ("groq/openai/gpt-oss-20b") */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** reasoning models (gpt-oss): "low" answers sooner; undefined = provider default */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** tried in order when the model is out of free quota (429) */
  fallbackModels?: string[];
  fetch?: typeof fetch;
}

/** longest wait for a free-tier quota to come back before giving up on a turn */
export const MAX_WAIT_S = 15;

interface Chunk {
  choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  x_groq?: { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  error?: { message?: string };
}

function toMessages(system: string, messages: LlmMessage[]) {
  const out: Record<string, unknown>[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    else if (m.role === 'assistant' && m.toolCalls?.length)
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })),
      });
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

const toTools = (tools: LlmTool[]) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class OpenAiCompatLlm implements LlmProvider {
  readonly name: string;
  readonly model: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: OpenAiCompatOptions) {
    this.name = opts.name;
    this.model = opts.model;
    this.doFetch = opts.fetch ?? fetch;
  }

  private body(model: string, req: LlmRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: toMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens,
      temperature: 0.3,
    };
    if (req.tools.length) {
      body.tools = toTools(req.tools);
      body.tool_choice = 'auto';
    }
    // reasoning settings differ per family: gpt-oss takes an effort, qwen3 must not print its thinking
    if (this.opts.reasoningEffort && model.startsWith('openai/gpt-oss')) body.reasoning_effort = this.opts.reasoningEffort;
    if (model.includes('qwen')) body.reasoning_format = 'hidden';
    return body;
  }

  /**
   * The free tier allows 8,000 tokens a minute PER MODEL and a Jarvis question costs ~2,000 (measured 2026-11-17):
   * when one model is used up (429) the next one in the list answers; when all are, wait the few seconds Groq asks
   * for (at most MAX_WAIT_S) and go round once more. Only before any text has been streamed, so nothing repeats.
   */
  private async post(req: LlmRequest): Promise<Response> {
    const models = [this.model, ...(this.opts.fallbackModels ?? []).filter((m) => m !== this.model)];
    let last: Response | null = null;
    for (let round = 0; round < 2; round++) {
      let wait = Infinity;
      for (const model of models) {
        const res = await this.doFetch(`${this.opts.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify(this.body(model, req)),
          signal: req.signal,
        });
        if (res.status !== 429) return res;
        const after = Number(res.headers.get('retry-after'));
        wait = Math.min(wait, Number.isFinite(after) && after >= 0 ? after : 5);
        if (last) await last.text().catch(() => undefined);
        last = res;
      }
      if (round === 1 || wait > MAX_WAIT_S) break;
      await new Promise((r, j) => {
        const t = setTimeout(r, wait * 1000);
        req.signal?.addEventListener('abort', () => (clearTimeout(t), j(new DOMException('aborted', 'AbortError'))), { once: true });
      });
    }
    return last!;
  }

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    let res: Response;
    try {
      res = await this.post(req);
    } catch (e) {
      if (req.signal?.aborted) return yield { type: 'done', stopReason: 'aborted' };
      return yield { type: 'error', message: `Không kết nối được ${this.name} (${(e as Error).message})` };
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      let msg = detail.slice(0, 300);
      try {
        msg = (JSON.parse(detail) as Chunk).error?.message ?? msg;
      } catch {
        /* not JSON */
      }
      if (res.status === 429) return yield { type: 'error', message: `${this.name} báo đã dùng hết giới hạn miễn phí lúc này, thử lại sau ${res.headers.get('retry-after') ?? 'ít'} giây` };
      if (res.status === 401) return yield { type: 'error', message: `${this.name} từ chối khóa API (kiểm tra GROQ_API_KEY trong .env)` };
      return yield { type: 'error', message: `${this.name} trả lỗi ${res.status}: ${msg}` };
    }

    // tool calls arrive in pieces: index -> id, name, argument text
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    let buf = '';
    const decoder = new TextDecoder();
    const onData = function* (data: string): Iterable<LlmEvent> {
      if (data === '[DONE]') return;
      let c: Chunk;
      try {
        c = JSON.parse(data) as Chunk;
      } catch {
        return;
      }
      if (c.error?.message) {
        yield { type: 'error', message: c.error.message };
        return;
      }
      const u = c.usage ?? c.x_groq?.usage;
      if (u) usage = { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 };
      for (const ch of c.choices ?? []) {
        if (ch.delta?.content) yield { type: 'text', text: ch.delta.content };
        for (const tc of ch.delta?.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const cur = calls.get(i) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(i, cur);
        }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    };
    try {
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(part, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          for (const ev of onData(line.slice(5).trim())) {
            yield ev;
            if (ev.type === 'error') return;
          }
        }
      }
      if (buf.trim().startsWith('data:')) for (const ev of onData(buf.trim().slice(5).trim())) yield ev;
    } catch (e) {
      if (req.signal?.aborted) return yield { type: 'done', stopReason: 'aborted' };
      return yield { type: 'error', message: `Lỗi đọc luồng ${this.name}: ${(e as Error).message}` };
    }
    if (!finish) return yield { type: 'error', message: `${this.name} ngắt luồng trả lời giữa chừng` };
    let n = 0;
    for (const c of [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
      if (!c.name) continue;
      yield { type: 'tool_use', call: { id: c.id || `call_${++n}`, name: c.name, input: parseArgs(c.args) } };
    }
    const u = usage as { inputTokens: number; outputTokens: number } | null;
    if (u) yield { type: 'usage', ...u };
    yield { type: 'done', stopReason: calls.size ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn' };
  }
}
