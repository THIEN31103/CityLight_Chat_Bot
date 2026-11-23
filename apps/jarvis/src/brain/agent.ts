// One user turn: model -> tools -> model ... until it answers in text (spec 5). Streams text to the caller, can be
// cancelled (stop button, barge-in later, console closed). Read tools only in milestone 2; action tools will only
// create a PendingAction (milestone 4), never call a command endpoint from here.
import type { LlmMessage, LlmProvider, LlmToolCall } from './llm';
import { ACCOUNT_ANSWER } from '../guard/account';
import { CONTROL_CAPABILITY_ANSWER, isControlCapabilityQuestion, isListHowQuestion, isSwitchOrder, isWhoAmI, LIST_HOW_ANSWER, route, SWITCH_ANSWER } from './router';
import { ROLE_LABELS } from '@citylight/shared';
import { fold } from '../tools/names';
import { asLlmTools, runTool, type ToolContext, type ToolDef } from '../tools/registry';

export const MAX_TOOL_ROUNDS = 5;
/** characters of an answer held back once data is in: longer than any bare "không biết" */
export const SHOW_AFTER = 40;

// Words that make a question about the lighting system (folded, no diacritics). A question without any of them —
// greetings, "giới thiệu về bạn", "bạn làm được gì" — is answered by the model without data and never nudged.
const SYSTEM_WORDS =
  /\b(tu|tucab|he thong|tinh hinh|tong quan|bao cao|canh bao|loi|su co|qua han|lich|bat|tat|sang|den|nhanh|ma|quan|phuong|khu vuc|vung|online|offline|ket noi|mat ket noi|dien ap|dong|ro|cong suat|nhiet do|plc|logo|plgo|telemetry|tram|tuyen|cabinet|alarm|incident|schedule|demo)\b|\b[a-z]{2,4}\d{2}\.\d{1,4}\b|\b[a-z]{2}\d{4}\b|\be\s?\d{3}\b/;

/** Greetings, thanks, questions about Jarvis itself: answered without data. */
export function looksLikeSmallTalk(text: string): boolean {
  const f = fold(text).replace(/[^a-z0-9. ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!f) return true;
  if (/^(xin chao|chao|hi|hello|alo|cam on|thank|thanks|ok|oke|vang|da|uh|u|tam biet|bye|chuc ngu ngon)\b/.test(f) && f.split(' ').length <= 6) return true;
  if (/(ban la ai|ban ten gi|ten ban|ban lam (duoc )?gi|ban giup (duoc )?gi|ban co the lam gi|gioi thieu|jarvis la ai|ban khoe khong)/.test(f)) return true;
  return !SYSTEM_WORDS.test(f);
}

/** Added once when a small model answered a data question from imagination instead of calling a tool. */
/** "Tôi không biết." / "Không biết." alone: given while the tool result held the answer (gpt-oss, 2026-11-17) */
export const BARE_DONT_KNOW = /^\s*(tôi\s+)?(không|chưa)\s+(biết|rõ)\.?\s*$/i;
export const DATA_NUDGE =
  '(System reminder, do not mention it) The tool result above holds the data. Answer my question from it now, in Vietnamese, 1-2 sentences. If it says nothing matched, say that.';

export const TOOL_NUDGE =
  '(System reminder, do not mention it) You did not call any tool and you know nothing about the system without one. Call the right tool now, then answer from its result in Vietnamese.';

/** Said instead of a second answer that still used no data: honest, and never a made-up number. */
/** the provider's refusal when the model calls a tool in a request that offered none */
export const TOOL_NOT_OFFERED = /tool choice is none|called a tool/i;
/** the provider's refusal of a tool call whose arguments do not fit the schema */
export const TOOL_ARGS_REFUSED = /tool call validation failed|did not match schema/i;

/** a bare "không biết" twice although a tool answered (2026-11-20: "10 tủ đang bị lỗi" -> "Không biết.") */
export const DATA_FAIL_ANSWER = 'Tôi đã tra dữ liệu nhưng chưa trả lời được câu này. Bạn hỏi lại cụ thể hơn giúp tôi, ví dụ trạng thái nào hay khu vực nào.';

export const NO_DATA_ANSWER = 'Tôi chưa tra được dữ liệu cho câu này. Bạn hỏi cụ thể hơn giúp tôi, ví dụ tủ nào, khu vực nào hay mã lỗi nào.';

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
  /** tools only the router runs, not offered to the model (a short tool list keeps the small model on track) */
  routerTools?: ToolDef[];
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
  const byName = new Map([...(t.routerTools ?? []), ...t.tools].map((d) => [d.name, d]));
  const llmTools = asLlmTools(t.tools);
  const messages = [...t.messages];
  const produced: LlmMessage[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: TurnResult['toolCalls'] = [];
  let finalText = '';
  let nudged = false;
  let redone = false;
  /** the model asked for a tool while none was offered: the round is asked again with the tools */
  let needTools = false;
  /** a tool call refused for its arguments was reported back to the model once */
  let argsRetried = false;
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

  // fixed answers, said plainly instead of whatever the model looks up: what Jarvis can do with the lights (nothing
  // yet, milestone 4), an order to switch, and who the user is
  const fixed = t.useRouter === false ? null
    : isControlCapabilityQuestion(lastUser) ? CONTROL_CAPABILITY_ANSWER
    : isSwitchOrder(lastUser) ? SWITCH_ANSWER
    : isListHowQuestion(lastUser) ? LIST_HOW_ANSWER
    // never an account detail, not even the user's own name or role (user rule 2026-11-23)
    : isWhoAmI(lastUser) ? ACCOUNT_ANSWER
    : null;
  if (fixed) {
    t.onEvent?.({ type: 'text', text: fixed });
    produced.push({ role: 'assistant', content: fixed });
    return out({ text: fixed, stopReason: 'end_turn' });
  }

  // plain intents: fetch first, so the model starts from real data
  const routed = t.useRouter === false || !needsData ? null : route(lastUser, t.ctx.focus);
  const prefetched = !!routed && byName.has(routed.name);
  if (prefetched) await runCalls([{ id: 'route_1', name: routed!.name, input: routed!.input }], '');

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (t.signal?.aborted) return out({ text: finalText, stopReason: 'aborted' });
    let text = '';
    const calls: LlmToolCall[] = [];
    let stop: string | null = null;
    // What the user sees is only what code keeps (user report 2026-11-17: an answer appeared, then a rule threw it
    // away and another sentence replaced it). A data question with no data yet is never shown: code always asks
    // again. Once data is in, the first SHOW_AFTER characters wait (a bare "không biết" is shorter), then the text
    // streams. Small talk streams at once.
    const live = !needsData || toolCalls.length > 0;
    let shown = '';
    let held = '';
    const show = (s: string) => {
      if (!s) return;
      shown += s;
      t.onEvent?.({ type: 'text', text: s });
    };
    // tools are offered until the last round, which must answer in words. When the router already fetched the data,
    // the first answer is written without the tool list: the 8 schemas are ~1,300 of the ~2,000 tokens of a question,
    // and Groq's free tier allows 8,000 tokens a minute (2026-11-20). A bare "không biết" still gets DATA_NUDGE with tools.
    const offer = round >= MAX_TOOL_ROUNDS || (prefetched && round === 0 && !needTools) ? [] : llmTools;
    let retry = false;
    for await (const ev of t.llm.stream({ system: t.system, messages, tools: offer, maxTokens: t.maxTokens, signal: t.signal })) {
      if (ev.type === 'text') {
        text += ev.text;
        if (!live) continue;
        if (shown) show(ev.text);
        else {
          held += ev.text;
          if (!needsData || held.length > SHOW_AFTER) {
            show(held);
            held = '';
          }
        }
      } else if (ev.type === 'tool_use') calls.push(ev.call);
      else if (ev.type === 'usage') {
        usage.inputTokens += ev.inputTokens;
        usage.outputTokens += ev.outputTokens;
        t.onEvent?.({ type: 'usage', inputTokens: ev.inputTokens, outputTokens: ev.outputTokens });
      } else if (ev.type === 'done') stop = ev.stopReason;
      else if (!offer.length && !needTools && round < MAX_TOOL_ROUNDS && TOOL_NOT_OFFERED.test(ev.message)) {
        // Groq refuses the whole answer when the model calls a tool that was not offered ("Tool choice is none, but
        // model called a tool", user report 2026-11-20: the router fetched the areas, the model wanted the cabinets)
        needTools = true;
        retry = true;
        break;
      } else if (!argsRetried && round < MAX_TOOL_ROUNDS && TOOL_ARGS_REFUSED.test(ev.message)) {
        // Groq checks the arguments against the schema and refuses the whole answer ("limit: maximum 30, got 39",
        // 2026-11-21): tell the model once and let it call again
        argsRetried = true;
        retry = true;
        messages.push({ role: 'user', content: `(System reminder, do not mention it) Your tool call was refused: ${ev.message.slice(0, 300)}. Call the tool again with arguments that fit.` });
        break;
      } else return out({ text: finalText + text, stopReason: 'error', error: ev.message });
    }
    if (retry) {
      if (shown) t.onEvent?.({ type: 'reset' });
      continue;
    }
    if (stop === 'aborted' || t.signal?.aborted) return out({ text: finalText + text, stopReason: 'aborted' });
    // text that reached the screen and is now dropped (rare: a long draft followed by a tool call) is taken back
    const drop = () => shown && t.onEvent?.({ type: 'reset' });

    // a data question answered without any tool: drop that draft and ask once more (code decides, not the model)
    if (!calls.length && needsData && !toolCalls.length && !nudged && round < MAX_TOOL_ROUNDS) {
      nudged = true;
      drop();
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: TOOL_NUDGE });
      continue;
    }
    // a bare "không biết" although a tool answered: ask once to answer from the data (code decides, not the model)
    if (!calls.length && toolCalls.length && !redone && BARE_DONT_KNOW.test(text) && round < MAX_TOOL_ROUNDS) {
      redone = true;
      drop();
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: DATA_NUDGE });
      continue;
    }
    // asked to answer from the data and still a bare "không biết": a fixed honest sentence, never "Không biết." alone
    if (!calls.length && redone && BARE_DONT_KNOW.test(text)) {
      drop();
      t.onEvent?.({ type: 'text', text: DATA_FAIL_ANSWER });
      produced.push({ role: 'assistant', content: DATA_FAIL_ANSWER });
      return out({ text: DATA_FAIL_ANSWER, stopReason: 'end_turn' });
    }
    // asked again and still no data: an honest fixed sentence instead of a guess (or the model talking about tools)
    if (!calls.length && nudged && !toolCalls.length) {
      drop();
      t.onEvent?.({ type: 'text', text: NO_DATA_ANSWER });
      produced.push({ role: 'assistant', content: NO_DATA_ANSWER });
      return out({ text: NO_DATA_ANSWER, stopReason: 'end_turn' });
    }
    if (!calls.length) {
      const answer: LlmMessage = { role: 'assistant', content: text };
      produced.push(answer);
      // kept: what was still waiting goes out now
      if (shown) show(held);
      else show(text.trim() ? text : finalText);
      // the answer is the last round's text; what came before a tool call is kept only when nothing follows
      // (a cloud model wrote the answer, called a tool again and wrote it twice: "…kết nối.491 tủ…", 2026-11-17)
      return out({ text: text.trim() ? text : finalText, stopReason: stop === 'max_tokens' ? 'max_tokens' : 'end_turn' });
    }
    drop();
    finalText = text.trim() ? text : finalText;

    await runCalls(calls, text);
  }
  return out({ text: finalText, stopReason: 'too_many_tools' });
}
