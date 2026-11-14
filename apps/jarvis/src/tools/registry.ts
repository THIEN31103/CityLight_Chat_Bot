// One wrapper for every tool (spec 5.2): validate input (zod) -> call the API as the signed-in user (the API checks
// permission and area) -> sanitizeForLlm -> shorten to ~2 KB -> JSON string for the model.
// 403 / 404 / 409 / timeouts come back as { error, message } so Jarvis says them in words instead of failing.
import type { User } from '@citylight/shared';
import { z } from 'zod';
import { ApiProblem } from '../api/client';
import type { CityLightReads } from '../api/read';
import type { LlmTool } from '../brain/llm';
import { sanitizeForLlm } from '../sanitize/llm';

export const TOOL_TIMEOUT_MS = 5000;
export const MAX_RESULT_CHARS = 2000;

/** What the conversation is about, so "tủ đó" / "lỗi kia" can be resolved (spec 5.4). */
export interface Focus {
  cabinet?: { id: string; code: string; name: string };
  area?: { id: string; name: string };
  alarmCode?: string;
}

export interface ToolContext {
  reads: CityLightReads;
  user: User;
  focus: Focus;
  /** what the user just asked: lets a tool drop a filter the model added on its own */
  userText?: string;
  signal?: AbortSignal;
}

export interface ToolDef<I = Record<string, unknown>> {
  name: string;
  description: string;
  /** JSON Schema the model sees */
  schema: Record<string, unknown>;
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  /** an action tool only creates a PendingAction (milestone 4); a read tool runs at once */
  kind: 'read' | 'action';
  run(ctx: ToolContext, input: I): Promise<unknown>;
}

export const asLlmTools = (defs: ToolDef[]): LlmTool[] => defs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.schema }));

/** Keeps the result under `max` characters by cutting the longest arrays first; marks what was cut. */
export function shrink(value: unknown, max = MAX_RESULT_CHARS): unknown {
  let v = structuredClone(value);
  const size = () => JSON.stringify(v)?.length ?? 0;
  for (let guard = 0; guard < 40 && size() > max; guard++) {
    const arr = longestArray(v);
    if (!arr || arr.list.length <= 1) break;
    const keep = Math.max(1, Math.floor(arr.list.length / 2));
    const total = arr.list.length;
    arr.list.splice(keep);
    if (arr.owner && !Array.isArray(arr.owner)) {
      arr.owner[`${arr.key}Total`] ??= total;
      arr.owner.truncated = true;
    }
  }
  if (size() > max) v = { truncated: true, note: 'Kết quả quá dài, hãy hỏi cụ thể hơn', preview: JSON.stringify(v).slice(0, max - 120) };
  return v;
}

function longestArray(root: unknown) {
  let best: { list: unknown[]; owner: Record<string, unknown> | unknown[] | null; key: string } | null = null;
  const visit = (node: unknown, owner: Record<string, unknown> | unknown[] | null, key: string) => {
    if (Array.isArray(node)) {
      if (!best || JSON.stringify(node).length > JSON.stringify(best.list).length) best = { list: node, owner, key };
      node.forEach((x, i) => visit(x, node, String(i)));
    } else if (node && typeof node === 'object') {
      for (const [k, x] of Object.entries(node)) visit(x, node as Record<string, unknown>, k);
    }
  };
  visit(root, null, '');
  return best as { list: unknown[]; owner: Record<string, unknown> | unknown[] | null; key: string } | null;
}

const ERROR_TEXT: Record<string, string> = {
  not_found: 'Không tìm thấy',
  forbidden_scope: 'Nằm ngoài khu vực bạn được phân quyền',
  forbidden: 'Tài khoản của bạn không có quyền xem mục này',
  unauthenticated: 'Phiên đăng nhập CityLight đã hết, cần đăng nhập lại',
  totp_setup_required: 'Tài khoản cần bật xác thực 2 lớp trên web trước',
  timeout: 'Máy chủ CityLight không trả lời kịp',
  unreachable: 'Không kết nối được máy chủ CityLight',
  rate_limited: 'Máy chủ đang giới hạn số yêu cầu, thử lại sau ít phút',
};

export interface ToolOutcome {
  /** JSON text for the model (already sanitized and shortened) */
  content: string;
  ok: boolean;
  ms: number;
}

export async function runTool(def: ToolDef, ctx: ToolContext, rawInput: unknown): Promise<ToolOutcome> {
  const t0 = performance.now();
  const done = (value: unknown, ok: boolean): ToolOutcome => ({
    content: JSON.stringify(shrink(sanitizeForLlm(value))),
    ok,
    ms: Math.round(performance.now() - t0),
  });
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return done({ error: 'invalid_input', message: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') }, false);
  }
  const timeout = AbortSignal.timeout(TOOL_TIMEOUT_MS);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  try {
    return done(await def.run({ ...ctx, signal }, parsed.data), true);
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    if (e instanceof ApiProblem) return done({ error: e.code, message: ERROR_TEXT[e.code] ?? e.detail }, false);
    if (timeout.aborted) return done({ error: 'timeout', message: ERROR_TEXT.timeout }, false);
    return done({ error: 'tool_failed', message: (e as Error).message }, false);
  }
}
