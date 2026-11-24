// Pending actions (spec 6.2, 6.5, 6.6). The ONLY place that sends a command to CityLight (static test in
// test/rules.test.ts). A pending action is created from a parsed order after the policy checks, shown with a fixed
// summary, and sent only when the user confirms in time with the tier's way. The Idempotency-Key is the pending id,
// so a double click or a repeated "xác nhận" can never send the command twice.
import { randomBytes } from 'node:crypto';
import type { Command, CommandStatus } from '@citylight/shared';
import { ApiProblem, type ApiClient } from '../api/client';
import { PENDING_TTL_MS, type ActionCommand, type Tier } from './policy';

export interface PendingAction {
  /** also the Idempotency-Key of the command */
  id: string;
  command: ActionCommand;
  cabinet: { id: string; code: string; name: string };
  /** "Bật tay cả hai nhánh đèn tủ TL01.0009 (Lý Thường Kiệt 9)" */
  summary: string;
  tier: Tier;
  createdAt: number;
  expiresAt: number;
  /** what will happen afterwards, said with the result ("đèn sẽ tự bật lại theo lịch lúc 18:00") */
  note?: string;
  /** open alarms / field incidents of the cabinet when the card was made ("Lưu ý trước khi gửi: …"); never blocks */
  warning?: string;
  /** a batch (T3): the allowed cabinets of one area, sent as POST /command-batches with the OTP from the console */
  batch?: { area: string; codes: string[]; total: number; offline: number; skipped: number };
}

export type Via = 'voice' | 'text' | 'button';

/** One pending action per console session; a new one replaces the old (spec 6.2). */
export class PendingSlot {
  private current: PendingAction | null = null;
  private readonly used = new Set<string>();

  create(p: Omit<PendingAction, 'id' | 'createdAt' | 'expiresAt'>, now = Date.now()): { pending: PendingAction; replaced: PendingAction | null } {
    const replaced = this.active(now);
    const pending: PendingAction = { ...p, id: `jv-${randomBytes(12).toString('base64url')}`, createdAt: now, expiresAt: now + PENDING_TTL_MS };
    this.current = pending;
    return { pending, replaced };
  }

  /** the waiting action, or null when there is none or it ran out */
  active(now = Date.now()): PendingAction | null {
    if (this.current && now >= this.current.expiresAt) this.current = null;
    return this.current;
  }

  /** the expired one, if it ran out unconfirmed (to tell the user "lệnh đã hết hạn") */
  expired(now = Date.now()): PendingAction | null {
    return this.current && now >= this.current.expiresAt ? this.current : null;
  }

  /**
   * Takes the action for sending: only the waiting one, only once, only in time, only the tier's way.
   * Returns a refusal in words otherwise; the action stays waiting when only the way was wrong.
   */
  /** explicit: the user said "xác nhận" / "đồng ý" (isExplicitConfirm), which may confirm T2 too */
  take(id: string, via: Via, now = Date.now(), explicit = false): { ok: true; pending: PendingAction } | { ok: false; reason: string } {
    if (this.used.has(id)) return { ok: false, reason: 'Lệnh này đã được xử lý rồi.' };
    const p = this.current;
    if (!p || p.id !== id) return { ok: false, reason: 'Không có lệnh nào đang chờ xác nhận.' };
    if (now >= p.expiresAt) {
      this.current = null;
      return { ok: false, reason: 'Lệnh đã hết hạn 60 giây, bạn ra lệnh lại nếu vẫn cần.' };
    }
    if (p.tier === 'T3' && via !== 'button')
      return { ok: false, reason: 'Lệnh nhiều tủ chỉ gửi bằng nút "Xác nhận" trên thẻ, nhập mã OTP 6 số nếu tài khoản bật xác thực 2 lớp. Nói hay gõ "xác nhận" không gửi được.' };
    if (p.tier === 'T2' && via !== 'button' && !explicit) return { ok: false, reason: 'Lệnh tắt cần nói hoặc gõ đúng chữ "xác nhận", hoặc bấm nút "Xác nhận" trên màn hình.' };
    this.used.add(id);
    this.current = null;
    return { ok: true, pending: p };
  }

  cancel(id?: string): PendingAction | null {
    const p = this.current;
    if (!p || (id && p.id !== id)) return null;
    this.current = null;
    this.used.add(p.id);
    return p;
  }

  clear() {
    this.current = null;
  }
}

const DONE: CommandStatus[] = ['confirmed', 'acked_unconfirmed', 'failed', 'timeout', 'cancelled'];
const ACK_IS_LAST: string[] = ['PULSE_ON', 'DIAG'];
/** the command has its last status (PULSE_ON and DIAG end at "acked") */
export const isDone = (type: string, s: CommandStatus) => DONE.includes(s) || (ACK_IS_LAST.includes(type) && s === 'acked');
export const FOLLOW_MS = 60_000;
export const POLL_MS = 2_000;

export interface FollowOpts {
  signal?: AbortSignal;
  onStatus?: (s: CommandStatus) => void;
  followMs?: number;
  pollMs?: number;
  otp?: string;
  /** the live feed (api/live.ts): ends the wait between two reads early when the server tells about this id */
  wait?: (id: string, ms: number) => Promise<void>;
}

const pause = (opts: FollowOpts, id: string) => (opts.wait ? opts.wait(id, opts.pollMs ?? POLL_MS) : new Promise<void>((r) => setTimeout(r, opts.pollMs ?? POLL_MS)));

export interface Outcome {
  status: CommandStatus | 'not_sent';
  commandId?: string;
  /** a batch: how its cabinets ended (2026-11-23) */
  batch?: { id: string; total: number; succeeded: number; failed: number; offline: number; pending: number };
  /** the API's reason when it refused or the command failed */
  error?: string;
  /** Jarvis stopped following before the command or batch ended (60 s): its result is told later (late.ts) */
  unfinished?: true;
  code?: string;
}

/**
 * Sends the command as the signed-in user and follows it until the cabinet confirms, fails or 60 s pass
 * (GET /commands/:id every 2 s; the socket event can replace the polling later). Never throws for an API refusal.
 */
export async function sendAndFollow(
  api: ApiClient, p: PendingAction, opts: FollowOpts = {},
): Promise<Outcome> {
  if (p.batch) return sendBatch(api, p, opts);
  // marking an alarm as seen is one call with an answer at once, nothing to follow (2026-11-23)
  if (p.command.type === 'ACK_ALARM') {
    try {
      await api.post(`alarms/${encodeURIComponent(p.command.params.alarmId ?? '')}/ack`, {}, { idempotencyKey: p.id, signal: opts.signal });
      return { status: 'confirmed' };
    } catch (e) {
      if (e instanceof ApiProblem) return { status: 'not_sent', error: e.detail, code: e.code };
      throw e;
    }
  }
  let cmd: Command;
  try {
    cmd = await api.post<Command>(`cabinets/${encodeURIComponent(p.cabinet.id)}/commands`, { type: p.command.type, params: p.command.params }, { idempotencyKey: p.id, signal: opts.signal });
  } catch (e) {
    if (e instanceof ApiProblem) return { status: 'not_sent', error: e.detail, code: e.code };
    throw e;
  }
  opts.onStatus?.(cmd.status);
  const until = Date.now() + (opts.followMs ?? FOLLOW_MS);
  let last = cmd.status;
  // PULSE_ON and DIAG end at "acked": the cabinet reports nothing that proves them (coreif confirmRule)
  const done = (s: CommandStatus) => isDone(p.command.type, s);
  while (!done(last) && Date.now() < until) {
    await pause(opts, cmd.id);
    if (opts.signal?.aborted) break;
    try {
      cmd = await api.get<Command>(`commands/${encodeURIComponent(cmd.id)}`, undefined, { signal: opts.signal });
    } catch (e) {
      if (opts.signal?.aborted) break;
      if (!(e instanceof ApiProblem)) throw e;
      continue;
    }
    if (cmd.status !== last) opts.onStatus?.(cmd.status);
    last = cmd.status;
  }
  return done(last) ? { status: last, commandId: cmd.id, error: cmd.error ?? undefined } : { status: 'timeout', commandId: cmd.id, error: cmd.error ?? undefined, unfinished: true };
}

/**
 * A batch (T3, spec 5.3 / 6.3): POST /command-batches with the cabinets' codes and the OTP typed on the console. The
 * OTP goes straight to the API: it is not logged, not audited, never seen by the model. Followed by
 * GET /command-batches/:id until it finishes or the time is up.
 */
async function sendBatch(
  api: ApiClient, p: PendingAction, opts: FollowOpts,
): Promise<Outcome> {
  type Batch = { id: string; total: number; succeeded: number; failed: number; offline: number; pending: number; finishedAt: string | null };
  const pick = (b: Batch) => ({ id: b.id, total: b.total, succeeded: b.succeeded, failed: b.failed, offline: b.offline, pending: b.pending });
  let b: Batch;
  try {
    b = await api.post<Batch>('command-batches', {
      kind: 'control', command: { type: p.command.type, params: p.command.params }, codes: p.batch!.codes.join(','), ...(opts.otp ? { otp: opts.otp } : {}),
    }, { idempotencyKey: p.id, signal: opts.signal });
  } catch (e) {
    if (e instanceof ApiProblem) return { status: 'not_sent', error: e.detail, code: e.code };
    throw e;
  }
  opts.onStatus?.('sent');
  const until = Date.now() + (opts.followMs ?? FOLLOW_MS);
  while (!b.finishedAt && b.pending > 0 && Date.now() < until) {
    await pause(opts, b.id);
    if (opts.signal?.aborted) break;
    try {
      // GET /command-batches/:id answers { batch, items } (apps/api/src/schedules.ts detail); POST answers the batch itself
      b = unwrapBatch(await api.get<Batch | { batch: Batch }>(`command-batches/${encodeURIComponent(b.id)}`, undefined, { signal: opts.signal }));
    } catch (e) {
      if (opts.signal?.aborted) break;
      if (!(e instanceof ApiProblem)) throw e;
    }
  }
  return b.finishedAt || b.pending === 0 ? { status: 'confirmed', batch: pick(b) } : { status: 'timeout', batch: pick(b), unfinished: true };
}

/** the batch out of GET /command-batches/:id ({ batch, items }), or the batch itself */
export const unwrapBatch = <B>(r: B | { batch: B }): B => (r && typeof r === 'object' && 'batch' in r ? r.batch : r);

export interface BatchPreview { total: number; offline: number; blocked: number; unsupported: number; max: number | null }
export type PreviewBatch = (body: { kind: 'control'; command: { type: string; params: Record<string, unknown> }; codes: string }) => Promise<BatchPreview | null>;

/** POST /command-batches/preview: what a batch would reach (sends nothing); null when the API refuses */
export function batchPreviewer(api: ApiClient, signal?: AbortSignal): PreviewBatch {
  return (body) => api.post<BatchPreview>('command-batches/preview', body, { signal }).catch(() => null);
}
