// LLM_PROVIDER=fake (spec 5.6): deterministic answers for tests, never a default.
// A user message starting with [[fake:{json}]] scripts the turn: { tools?: [{ name, input }], text?, chunks?, usage? }.
// The tools are asked for first (all at once); once their results are in the conversation, `text` comes back in
// `chunks` pieces (default 3), then `usage`. Without the prefix the answer is "ok".
// Every request is kept in `requests` so a test can check what would have reached a real model.
import { z } from 'zod';
import type { LlmEvent, LlmProvider, LlmRequest } from '../llm';

const PREFIX = '[[fake:';
const Script = z.object({
  tools: z.array(z.object({ name: z.string().min(1), input: z.record(z.unknown()).default({}) })).default([]),
  text: z.string().default('ok'),
  chunks: z.number().int().min(1).max(50).default(3),
  usage: z.object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) }).optional(),
});
type Script = z.infer<typeof Script>;

/** The script in a user message, or null when it has none (or it is not valid JSON). */
export function parseFakeScript(content: string): Script | null {
  if (!content.startsWith(PREFIX)) return null;
  const end = content.indexOf(']]', PREFIX.length);
  if (end < 0) return null;
  try {
    return Script.parse(JSON.parse(content.slice(PREFIX.length, end)));
  } catch {
    return null;
  }
}

function split(text: string, n: number): string[] {
  if (!text) return [];
  const size = Math.ceil(text.length / Math.min(n, text.length));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export class FakeLlm implements LlmProvider {
  readonly name = 'fake';
  readonly model = 'fake';
  readonly requests: LlmRequest[] = [];
  private calls = 0;

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const lastUser = req.messages.map((m, i) => ({ m, i })).filter((x) => x.m.role === 'user').at(-1);
    const script = lastUser ? parseFakeScript(lastUser.m.content) : null;
    const answered = lastUser ? req.messages.slice(lastUser.i + 1).filter((m) => m.role === 'tool').length : 0;
    const promptChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
    const usage = script?.usage ?? { inputTokens: Math.ceil(promptChars / 4), outputTokens: 0 };

    if (script && answered < script.tools.length) {
      for (const t of script.tools.slice(answered)) {
        if (req.signal?.aborted) return yield { type: 'done', stopReason: 'aborted' };
        yield { type: 'tool_use', call: { id: `fake_${++this.calls}`, name: t.name, input: t.input } };
      }
      yield { type: 'usage', ...usage };
      yield { type: 'done', stopReason: 'tool_use' };
      return;
    }
    const text = script ? script.text : 'ok';
    for (const piece of split(text, script?.chunks ?? 1)) {
      if (req.signal?.aborted) return yield { type: 'done', stopReason: 'aborted' };
      yield { type: 'text', text: piece };
    }
    yield { type: 'usage', inputTokens: usage.inputTokens, outputTokens: script?.usage?.outputTokens ?? Math.ceil(text.length / 4) };
    yield { type: 'done', stopReason: 'end_turn' };
  }
}
