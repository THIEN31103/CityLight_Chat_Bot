// Guard policy (spec 6.1, 6.3, 6.7, 6.8): pure functions, decided in code. The model never chooses a tier, never
// skips the allowlist and never sees whether a kill switch is on.
import type { RoleKey } from '@citylight/shared';
import { hasPermission } from '@citylight/shared';

/** The single-cabinet commands Jarvis can propose (batch control and alarm ack come later). */
export type ActionType = 'MANUAL_ALL' | 'MANUAL_BRANCH' | 'AUTO' | 'PULSE_ON' | 'DIAG';

export interface ActionCommand {
  type: ActionType;
  params: { on?: boolean; branch?: 1 | 2 };
}

/**
 * T1: confirm by voice, typed words or the button. T2: the button only. T3 (batch + OTP) is not offered yet.
 * Switching off is always T2 (lights going dark in a street is the costly mistake); so is anything proposed while the
 * user has not touched the console for 10 minutes.
 */
export type Tier = 'T1' | 'T2';
export const IDLE_FOR_T2_MS = 10 * 60_000;

export function tierFor(cmd: ActionCommand, idleMs = 0): Tier {
  if ((cmd.type === 'MANUAL_ALL' || cmd.type === 'MANUAL_BRANCH') && cmd.params.on === false) return 'T2';
  if (idleMs >= IDLE_FOR_T2_MS) return 'T2';
  return 'T1';
}

/** at most this many commands Jarvis sends per user and minute (spec 6.7) */
export const MAX_COMMANDS_PER_MIN = 6;
/** a pending action lives this long (spec 6.2) */
export const PENDING_TTL_MS = 60_000;

export interface GuardState {
  /** JARVIS_ACTIONS_ENABLED in .env */
  envEnabled: boolean;
  /** the console setting (kill switch) */
  settingsEnabled: boolean;
  /** JARVIS_CABINET_ALLOWLIST, upper case; empty = nothing may be controlled */
  allowlist: string[];
}

/** Why nothing can be controlled at all; null = control is available in principle. */
export function controlUnavailable(g: GuardState, role: RoleKey): string | null {
  if (!g.envEnabled) return 'Chức năng điều khiển của Jarvis đang tắt trong cấu hình máy chủ.';
  if (!g.settingsEnabled) return 'Chức năng điều khiển của Jarvis đang tắt (quản trị viên tắt trên trang quản trị).';
  if (!g.allowlist.length) return 'Chưa có tủ nào được phép điều khiển qua Jarvis.';
  if (!hasPermission(role, 'cabinet.control')) return 'Tài khoản của bạn không có quyền điều khiển tủ.';
  return null;
}

/** Why this cabinet cannot be controlled through Jarvis; null = allowed. */
export function cabinetRefused(g: GuardState, code: string): string | null {
  if (g.allowlist.includes(code.toUpperCase())) return null;
  // the user asked next "tủ nào mới được điều khiển" and "tại sao" (2026-11-20): say both at once
  const list = g.allowlist.length > 5 ? `${g.allowlist.slice(0, 5).join(', ')}…` : g.allowlist.join(', ');
  return `Tủ ${code} không nằm trong danh sách được phép điều khiển qua Jarvis (${list}). Danh sách này do quản trị viên đặt; tủ khác bạn điều khiển trên web CityLight.`;
}

/** Sliding one-minute window of commands sent per user. */
export class CommandRate {
  private readonly sent = new Map<string, number[]>();

  allow(userId: string, now = Date.now()): boolean {
    const recent = (this.sent.get(userId) ?? []).filter((t) => now - t < 60_000);
    this.sent.set(userId, recent);
    return recent.length < MAX_COMMANDS_PER_MIN;
  }

  record(userId: string, now = Date.now()) {
    this.sent.set(userId, [...(this.sent.get(userId) ?? []), now]);
  }
}
