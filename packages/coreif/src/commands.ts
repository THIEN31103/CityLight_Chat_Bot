// Logical command -> CoreIF downlink frame(s) (spec 4.1), ack matching and telemetry confirmation (spec 12).
// Device rules honoured here:
//  - LTID first, it is the destination address; LTID'ALL only runs LTIM.
//  - T-keys use HH:MM as sent; always send local time with +07:00 (never Z).
//  - <= 16 keys per frame.
//  - PLC_KEY only forwards PI50/LINE*/PI2O when the value changes: PULSE_ON sends PI2O'0 then PI2O'1
//    as two frames (one frame cannot carry the same key twice).
import type { CommandType, Schedule } from '@citylight/shared';
import type { Ack } from './uplink';
import type { TelemetryPatch } from './telemetry';
import { buildFrame, FrameError } from './frame';

/** Local wall-clock time in Asia/Ho_Chi_Minh as "YYYY-MM-DDTHH:MM:SS+07:00". */
export function isoVn(date = new Date()): string {
  const t = new Date(date.getTime() + 7 * 3600_000);
  return `${t.toISOString().slice(0, 19)}+07:00`;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function tKey(hhmm: string): string {
  if (!HHMM.test(hhmm)) throw new FrameError(`Giờ không hợp lệ: ${hhmm}`);
  // Date part is ignored by firmware for T keys.
  return `2026-01-01T${hhmm}:00+07:00`;
}

const b = (v: unknown) => (v ? 1 : 0);

type Pairs = [string, string | number][];

/** Key/value pairs of each frame, in send order (one entry per frame). */
export function commandSteps(type: CommandType, params: Record<string, unknown>, now = new Date()): Pairs[] {
  switch (type) {
    case 'MANUAL_ALL':
      // PLC_KEY applies PLN1/PLN2 before PMAN.
      return [[['PLN1', b(params.on)], ['PLN2', b(params.on)], ['PMAN', 1]]];
    case 'MANUAL_BRANCH': {
      const br = Number(params.branch);
      if (br !== 1 && br !== 2) throw new FrameError('branch phải là 1 hoặc 2');
      return [[[`PLN${br}`, b(params.on)], ['PMAN', 1]]];
    }
    case 'AUTO':
      return [[['PMAN', 0]]];
    case 'SET_TIME':
      return [[['LTIM', isoVn(now)]]];
    case 'SET_SCHEDULE': {
      const s = params as unknown as Schedule;
      if (s.mode === 1) return [[['PI50', 0], ['T10', tKey(s.on1)], ['T20', tKey(s.off1)]]];
      if (s.mode !== 2) throw new FrameError('mode phải là 1 hoặc 2');
      return [[
        ['PI50', 1],
        ['LINE1', b(s.branch1Enabled)],
        ['LINE2', b(s.branch2Enabled)],
        ['T10', tKey(s.on1)],
        ['T20', tKey(s.off1)],
        ['T11', tKey(s.on2)],
        ['T21', tKey(s.off2)],
      ]];
    }
    case 'PULSE_ON':
      // 0 first so the 0->1 edge always reaches LOGO, even if PLC_KEY already holds 1.
      return [[['PI2O', 0]], [['PI2O', 1]]];
    case 'DIAG':
      return [[['LDIA', 1]]];
    default:
      throw new FrameError(`Thiết bị chưa hỗ trợ lệnh ${type}`);
  }
}

export function buildCommandFrames(ltid: string, type: CommandType, params: Record<string, unknown>, now = new Date()): string[] {
  const id = ltid.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,32}$/.test(id)) throw new FrameError(`LTID không hợp lệ: ${ltid}`);
  const steps = commandSteps(type, params, now);
  if (id === 'ALL' && steps.some((s) => s.some(([k]) => k !== 'LTIM'))) throw new FrameError("LTID'ALL chỉ dùng cho LTIM");
  return steps.map((pairs) => buildFrame([['LTID', id], ...pairs]));
}

/** Single-frame commands only (PULSE_ON needs buildCommandFrames). */
export function buildCommandFrame(ltid: string, type: CommandType, params: Record<string, unknown>, now = new Date()): string {
  const frames = buildCommandFrames(ltid, type, params, now);
  if (frames.length !== 1) throw new FrameError(`Lệnh ${type} gồm ${frames.length} frame, dùng buildCommandFrames`);
  return frames[0]!;
}

/** Keys a frame expects to see acked (everything except LTID). */
export function expectedAckKeys(frame: string): string[] {
  return frame
    .slice(2, -1)
    .split('&')
    .map((p) => p.slice(0, p.indexOf("'")).toUpperCase())
    .filter((k) => k !== 'LTID');
}

/**
 * The firmware ack has no command id, only the cabinet id and the keys it ran. With one command in
 * flight per cabinet, an ack belongs to it when the cabinet matches and the key set is the same.
 */
export function ackMatches(ltid: string, frame: string, ack: Ack): boolean {
  if (!ack.ltid || ack.ltid !== ltid.toUpperCase()) return false;
  const want = expectedAckKeys(frame).sort();
  const got = ack.acks.map((a) => a.key).sort();
  return want.length === got.length && want.every((k, i) => k === got[i]);
}

const RC_TEXT: Record<number, string> = {
  [-1]: 'giá trị sai hoặc ghi Modbus xuống PLC thất bại',
  [-2]: 'thiết bị không hỗ trợ key',
};

/** null when every key has rc 0, else a readable error such as "PLN1 rc=-1 (…)". */
export function ackError(ack: Ack): string | null {
  const bad = ack.acks.filter((a) => a.rc !== 0);
  if (!bad.length) return null;
  return bad.map((a) => `${a.key} rc=${a.rc}${RC_TEXT[a.rc] ? ` (${RC_TEXT[a.rc]})` : ''}`).join('; ');
}

/** Commands that may be re-sent once when no ack comes back (same effect when applied twice). */
export const RETRYABLE: ReadonlySet<CommandType> = new Set(['MANUAL_ALL', 'MANUAL_BRANCH', 'AUTO', 'SET_TIME']);

/** Telemetry must show the effect; rc 0 only means LTE wrote PLC_KEY. */
export const TIME_TOLERANCE_MS = 120_000;

/**
 * Confirmation rule for a command once acked: returns a predicate over telemetry, or null when the
 * device reports nothing that proves the effect (SET_SCHEDULE, PULSE_ON, DIAG end at "acked").
 */
export function confirmRule(type: CommandType, params: Record<string, unknown>): ((t: TelemetryPatch, now: Date) => boolean) | null {
  switch (type) {
    case 'MANUAL_ALL': {
      const on = !!params.on;
      return (t) => t.manualMode === true && t.branch1On === on && t.branch2On === on;
    }
    case 'MANUAL_BRANCH': {
      const on = !!params.on;
      const br = Number(params.branch);
      return (t) => t.manualMode === true && (br === 1 ? t.branch1On : t.branch2On) === on;
    }
    case 'AUTO':
      return (t) => t.manualMode === false;
    case 'SET_TIME':
      return (t, now) => !!t.deviceTime && Math.abs(Date.parse(t.deviceTime) - now.getTime()) <= TIME_TOLERANCE_MS;
    default:
      return null;
  }
}
