// "Update the cabinet location from GPS" (owner request 2026-10-19). GPS belongs to the LTE board, not to the
// cabinet: a drift can mean the cabinet moved (update) or the board was fitted to another cabinet (do not).
// So the server only proposes the median of the recent fixes and a person confirms; nothing moves on its own.
import type { GeoPoint } from './domain';

/** Fixes looked at: the median of this window is the proposed position. */
export const GPS_RELOCATE_WINDOW_MIN = 30;
/** Fewer fixes than this = not enough to trust (one frame every ~10 s gives ~180 in the window). */
export const GPS_RELOCATE_MIN_SAMPLES = 10;
/** 90 % of the fixes must lie within this distance of the median, else GPS is still jumping. */
export const GPS_RELOCATE_MAX_SPREAD_M = 50;
/** Closer than this the declared position already matches: nothing to update. */
export const GPS_RELOCATE_MIN_MOVE_M = 10;
/** The client sends the point it showed; if the server's median moved more than this since, it asks again. */
export const GPS_RELOCATE_STALE_M = 25;

export interface GpsSuggestion {
  declared: GeoPoint;
  /** median of the fixes in the window, null = no fix */
  gps: GeoPoint | null;
  samples: number;
  /** 90th percentile distance of the fixes to the median */
  spreadM: number | null;
  /** median to the declared position */
  distanceM: number | null;
  windowMin: number;
  ok: boolean;
  /** why it cannot be applied (Vietnamese, shown as is); null when ok */
  reason: string | null;
}

/** A cabinet with an open gps_drift alarm (E802): drawn on the map as declared -> GPS. */
export interface GpsDriftItem {
  cabinetId: string;
  code: string;
  name: string;
  declared: GeoPoint;
  gps: GeoPoint;
  distanceM: number;
}

export function judgeGpsSuggestion(s: { samples: number; spreadM: number | null; distanceM: number | null }): { ok: boolean; reason: string | null } {
  if (s.samples === 0) return { ok: false, reason: `Không có điểm GPS nào trong ${GPS_RELOCATE_WINDOW_MIN} phút gần nhất (LGPS=X hoặc tủ offline)` };
  if (s.samples < GPS_RELOCATE_MIN_SAMPLES)
    return { ok: false, reason: `Mới có ${s.samples} điểm GPS trong ${GPS_RELOCATE_WINDOW_MIN} phút, cần ít nhất ${GPS_RELOCATE_MIN_SAMPLES}` };
  if ((s.spreadM ?? Infinity) > GPS_RELOCATE_MAX_SPREAD_M)
    return { ok: false, reason: `GPS chưa ổn định: các điểm lệch nhau khoảng ${Math.round(s.spreadM ?? 0)} m (cho phép ≤ ${GPS_RELOCATE_MAX_SPREAD_M} m). Thử lại sau` };
  if ((s.distanceM ?? 0) < GPS_RELOCATE_MIN_MOVE_M) return { ok: false, reason: 'Vị trí khai báo đã khớp GPS, không cần cập nhật' };
  return { ok: true, reason: null };
}
