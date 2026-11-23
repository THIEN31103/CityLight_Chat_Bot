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
export const FOLLOW_MS = 60_000;
export const POLL_MS = 2_000;

export interface Outcome {
  status: CommandStatus | 'not_sent';
  commandId?: string;
  /** the API's reason when it refused or the command failed */
  error?: string;
  code?: string;
}

/**
 * Sends the command as the signed-in user and follows it until the cabinet confirms, fails or 60 s pass
 * (GET /commands/:id every 2 s; the socket event can replace the polling later). Never throws for an API refusal.
 */
export async function sendAndFollow(
  api: ApiClient, p: PendingAction, opts: { signal?: AbortSignal; onStatus?: (s: CommandStatus) => void; followMs?: number; pollMs?: number } = {},
): Promise<Outcome> {
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
  const done = (s: CommandStatus) => DONE.includes(s) || (ACK_IS_LAST.includes(p.command.type) && s === 'acked');
  while (!done(last) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? POLL_MS));
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
  return { status: done(last) ? last : 'timeout', commandId: cmd.id, error: cmd.error ?? undefined };
}
