// LLM_PROVIDER=ollama: a free model running on this machine through Ollama's /api/chat (streaming NDJSON).
// Ollama gives tool calls no id, so ids are made here; token counts come from prompt_eval_count / eval_count
// on the final line. Nothing leaves the machine.
import type { LlmEvent, LlmMessage, LlmProvider, LlmRequest, LlmTool } from '../llm';

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  /** context window in tokens (options.num_ctx); undefined = Ollama default */
  numCtx?: number;
  /** thinking models (qwen3...): false = answer straight away (much faster); undefined = model default */
  think?: boolean;
  fetch?: typeof fetch;
}

interface OllamaChunk {
  message?: { role?: string; content?: string; thinking?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

function toOllamaMessages(system: string, messages: LlmMessage[]) {
  const out: Record<string, unknown>[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') out.push({ role: 'tool', content: m.content, tool_name: m.name });
    else if (m.role === 'assistant' && m.toolCalls?.length)
      out.push({ role: 'assistant', content: m.content, tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.input } })) });
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

const toOllamaTools = (tools: LlmTool[]) =>
  tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* fall through: the model wrote something that is not JSON */
    }
  }
  return {};
}

export class OllamaLlm implements LlmProvider {
  readonly name = 'ollama';
  readonly model: string;
  private readonly doFetch: typeof fetch;
  private calls = 0;

  constructor(private readonly opts: OllamaOptions) {
    this.model = opts.model;
    this.doFetch = opts.fetch ?? fetch;
  }

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOllamaMessages(req.system, req.messages),
      stream: true,
      options: { num_predict: req.maxTokens, ...(this.opts.numCtx ? { num_ctx: this.opts.numCtx } : {}) },
      // keep the model in VRAM between turns: a cold load costs seconds
      keep_alive: '30m',
    };
    if (req.tools.length) body.tools = toOllamaTools(req.tools);
    if (this.opts.think !== undefined) body.think = this.opts.think;

    let res: Response;
    try {
      res = await this.doFetch(`${this.opts.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal?.aborted) return yield { type: 'done', stopReason: 'aborted' };
      return yield { type: 'error', message: `Không kết nối được Ollama tại ${this.opts.baseUrl} (${(e as Error).message})` };
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      return yield { type: 'error', message: `Ollama trả lỗi ${res.status}: ${detail.slice(0, 300)}` };
    }

    let sawTool = false;
    let buf = '';
    const decoder = new TextDecoder();
    try {
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(part, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          for (const ev of this.onLine(line)) {
            if (ev.type === 'tool_use') sawTool = true;
            if (ev.type === 'done') return yield sawTool ? { type: 'done', stopReason: 'tool_use' } : ev;
            yield ev;
          }
        }
      }
      if (buf.trim()) {
        for (const ev of this.onLine(buf.trim())) {
          if (ev.type === 'tool_use') sawTool = true;
          if (ev.type === 'done') return yield sawTool ? { type: 'done', stopReason: 'tool_use' } : ev;
          yield ev;
        }
      }
      yield { type: 'error', message: 'Ollama ngắt luồng trả lời giữa chừng' };
    } catch (e) {
      if (req.signal?.aborted) return yield { type: 'done', stopReason: 'aborted' };
      yield { type: 'error', message: `Lỗi đọc luồng Ollama: ${(e as Error).message}` };
    }
  }

  private *onLine(line: string): Iterable<LlmEvent> {
    let c: OllamaChunk;
    try {
      c = JSON.parse(line) as OllamaChunk;
    } catch {
      return;
    }
    if (c.error) return yield { type: 'error', message: `Ollama: ${c.error}` };
    if (c.message?.content) yield { type: 'text', text: c.message.content };
    for (const tc of c.message?.tool_calls ?? []) {
      if (!tc.function?.name) continue;
      yield { type: 'tool_use', call: { id: `call_${++this.calls}`, name: tc.function.name, input: parseArgs(tc.function.arguments) } };
    }
    if (c.done) {
      yield { type: 'usage', inputTokens: c.prompt_eval_count ?? 0, outputTokens: c.eval_count ?? 0 };
      yield { type: 'done', stopReason: c.done_reason === 'length' ? 'max_tokens' : 'end_turn' };
    }
  }
}
