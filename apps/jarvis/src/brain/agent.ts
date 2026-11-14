// One user turn: model -> tools -> model ... until it answers in text (spec 5). Streams text to the caller, can be
// cancelled (stop button, barge-in later, console closed). Read tools only in milestone 2; action tools will only
// create a PendingAction (milestone 4), never call a command endpoint from here.
import type { LlmMessage, LlmProvider, LlmToolCall } from './llm';
import { route } from './router';
import { fold } from '../tools/names';
import { asLlmTools, runTool, type ToolContext, type ToolDef } from '../tools/registry';

export const MAX_TOOL_ROUNDS = 5;

/** Greetings, thanks, "who are you": answered without data. Anything else is a question about the system. */
export function looksLikeSmallTalk(text: string): boolean {
  const f = fold(text).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!f) return true;
  if (/^(xin chao|chao|hi|hello|alo|cam on|thank|thanks|ok|oke|vang|da|uh|u|tam biet|bye|chuc ngu ngon)\b/.test(f) && f.split(' ').length <= 6) return true;
  return /^(ban la ai|ban ten gi|ban lam duoc gi|ban giup duoc gi|jarvis la ai)/.test(f);
}

/** Added once when a small model answered a data question from imagination instead of calling a tool. */
export const TOOL_NUDGE =
  '(System reminder, do not mention it) You did not call any tool and you know nothing about the system without one. Call the right tool now, then answer from its result in Vietnamese.';

export type AgentEvent =
  | { type: 'reset' }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; name: string; input: Record<string, unknown> }
  | { type: 'tool_end'; name: string; ok: boolean; ms: number }
  | { type: 'usage'; inputTokens: number; outputTokens: number };

export interface TurnInput {
  llm: LlmProvider;
  tools: ToolDef[];
  ctx: ToolContext;
  system: string;
  /** earlier turns (user / assistant text) followed by the new user message */
  messages: LlmMessage[];
  maxTokens: number;
  signal?: AbortSignal;
  onEvent?: (ev: AgentEvent) => void;
  /** run the keyword router before the model (default true) */
  useRouter?: boolean;
}

export interface TurnResult {
  text: string;
  /** every message produced in this turn (assistant tool calls, tool results, final answer), for the history */
  produced: LlmMessage[];
  usage: { inputTokens: number; outputTokens: number };
  toolCalls: { name: string; input: Record<string, unknown>; ok: boolean; ms: number }[];
  stopReason: 'end_turn' | 'max_tokens' | 'aborted' | 'too_many_tools' | 'error';
  /** the model first answered without a tool and was asked again */
  nudged: boolean;
  error?: string;
}

export async function runTurn(t: TurnInput): Promise<TurnResult> {
  const byName = new Map(t.tools.map((d) => [d.name, d]));
  const llmTools = asLlmTools(t.tools);
  const messages = [...t.messages];
  const produced: LlmMessage[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: TurnResult['toolCalls'] = [];
  let finalText = '';
  let nudged = false;
  const lastUser = [...t.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const needsData = !looksLikeSmallTalk(lastUser);
  const out = (r: Omit<TurnResult, 'produced' | 'usage' | 'toolCalls' | 'nudged'>): TurnResult => ({ ...r, produced, usage, toolCalls, nudged });

  /** runs tools as if the model had asked for them (router) or because it did */
  const runCalls = async (calls: LlmToolCall[], text: string) => {
    const assistant: LlmMessage = { role: 'assistant', content: text, toolCalls: calls };
    messages.push(assistant);
    produced.push(assistant);
    for (const call of calls) {
      const def = byName.get(call.name);
      t.onEvent?.({ type: 'tool_start', name: call.name, input: call.input });
      const res = def
        ? await runTool(def, { ...t.ctx, signal: t.signal }, call.input)
        : { content: JSON.stringify({ error: 'unknown_tool', message: `Không có công cụ ${call.name}` }), ok: false, ms: 0 };
      t.onEvent?.({ type: 'tool_end', name: call.name, ok: res.ok, ms: res.ms });
      toolCalls.push({ name: call.name, input: call.input, ok: res.ok, ms: res.ms });
      const result: LlmMessage = { role: 'tool', toolCallId: call.id, name: call.name, content: res.content };
      messages.push(result);
      produced.push(result);
    }
  };

  // plain intents: fetch first, so the model starts from real data
  const routed = t.useRouter === false || !needsData ? null : route(lastUser, t.ctx.focus);
  if (routed && byName.has(routed.name)) await runCalls([{ id: 'route_1', name: routed.name, input: routed.input }], '');

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (t.signal?.aborted) return out({ text: finalText, stopReason: 'aborted' });
    let text = '';
    const calls: LlmToolCall[] = [];
    let stop: string | null = null;
    // tools are offered until the last round, which must answer in words
    const offer = round < MAX_TOOL_ROUNDS ? llmTools : [];
    for await (const ev of t.llm.stream({ system: t.system, messages, tools: offer, maxTokens: t.maxTokens, signal: t.signal })) {
      if (ev.type === 'text') {
        text += ev.text;
        t.onEvent?.({ type: 'text', text: ev.text });
      } else if (ev.type === 'tool_use') calls.push(ev.call);
      else if (ev.type === 'usage') {
        usage.inputTokens += ev.inputTokens;
        usage.outputTokens += ev.outputTokens;
        t.onEvent?.({ type: 'usage', inputTokens: ev.inputTokens, outputTokens: ev.outputTokens });
      } else if (ev.type === 'done') stop = ev.stopReason;
      else return out({ text: finalText + text, stopReason: 'error', error: ev.message });
    }
    if (stop === 'aborted' || t.signal?.aborted) return out({ text: finalText + text, stopReason: 'aborted' });

    // a data question answered without any tool: drop that draft and ask once more (code decides, not the model)
    if (!calls.length && needsData && !toolCalls.length && !nudged && round < MAX_TOOL_ROUNDS) {
      nudged = true;
      t.onEvent?.({ type: 'reset' });
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: TOOL_NUDGE });
      continue;
    }
    finalText += text;

    if (!calls.length) {
      const answer: LlmMessage = { role: 'assistant', content: text };
      produced.push(answer);
      return out({ text: finalText, stopReason: stop === 'max_tokens' ? 'max_tokens' : 'end_turn' });
    }

    await runCalls(calls, text);
  }
  return out({ text: finalText, stopReason: 'too_many_tools' });
}
