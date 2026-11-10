// The brain behind one interface (spec 4.1): ollama (free, local, default) or fake (tests only).
// A cloud provider (Claude) can be added later behind the same interface without touching the agent.
import type { Config } from '../config';
import { FakeLlm } from './providers/fake';
import { OllamaLlm } from './providers/ollama';

/** JSON Schema of one tool's input, as the model sees it. */
export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  maxTokens: number;
  signal?: AbortSignal;
}

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; call: LlmToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' }
  | { type: 'error'; message: string };

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  stream(req: LlmRequest): AsyncIterable<LlmEvent>;
}

export function createLlm(cfg: Config['llm']): LlmProvider {
  switch (cfg.provider) {
    case 'fake':
      return new FakeLlm();
    case 'ollama':
      return new OllamaLlm({ baseUrl: cfg.ollamaUrl, model: cfg.model, think: cfg.think });
  }
}

/** Drains a stream into one result: handy for tests, the smoke script and the benchmark. */
export async function collect(events: AsyncIterable<LlmEvent>) {
  let text = '';
  const toolCalls: LlmToolCall[] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: Extract<LlmEvent, { type: 'done' }>['stopReason'] | null = null;
  let error: string | null = null;
  for await (const ev of events) {
    if (ev.type === 'text') text += ev.text;
    else if (ev.type === 'tool_use') toolCalls.push(ev.call);
    else if (ev.type === 'usage') usage = { inputTokens: usage.inputTokens + ev.inputTokens, outputTokens: usage.outputTokens + ev.outputTokens };
    else if (ev.type === 'done') stopReason = ev.stopReason;
    else error = ev.message;
  }
  return { text, toolCalls, usage, stopReason, error };
}
