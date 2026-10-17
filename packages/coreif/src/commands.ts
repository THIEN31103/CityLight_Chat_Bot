// Logical command -> CoreIF downlink frame (spec 4.1). Device rules honoured here:
//  - LTID first, it is the destination address; LTID'ALL only runs LTIM.
//  - T-keys use HH:MM as sent; always send local time with +07:00 (never Z).
//  - <= 16 keys per frame.
import type { CommandType, Schedule } from '@citylight/shared';
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

export function commandPairs(type: CommandType, params: Record<string, unknown>, now = new Date()): [string, string | number][] {
  switch (type) {
    case 'MANUAL_ALL':
      // PLC_KEY applies PLN1/PLN2 before PMAN.
      return [['PLN1', b(params.on)], ['PLN2', b(params.on)], ['PMAN', 1]];
    case 'MANUAL_BRANCH': {
      const br = Number(params.branch);
      if (br !== 1 && br !== 2) throw new FrameError('branch phải là 1 hoặc 2');
      return [[`PLN${br}`, b(params.on)], ['PMAN', 1]];
    }
    case 'AUTO':
      return [['PMAN', 0]];
    case 'SET_TIME':
      return [['LTIM', isoVn(now)]];
    case 'SET_SCHEDULE': {
      const s = params as unknown as Schedule;
      if (s.mode === 1) return [['PI50', 0], ['T10', tKey(s.on1)], ['T20', tKey(s.off1)]];
      return [
        ['PI50', 1],
        ['LINE1', b(s.branch1Enabled)],
        ['LINE2', b(s.branch2Enabled)],
        ['T10', tKey(s.on1)],
        ['T20', tKey(s.off1)],
        ['T11', tKey(s.on2)],
        ['T21', tKey(s.off2)],
      ];
    }
    case 'PULSE_ON':
      return [['PI2O', 1]];
    case 'DIAG':
      return [['LDIA', 1]];
    default:
      throw new FrameError(`Thiết bị chưa hỗ trợ lệnh ${type}`);
  }
}

export function buildCommandFrame(ltid: string, type: CommandType, params: Record<string, unknown>, now = new Date()): string {
  const id = ltid.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,32}$/.test(id)) throw new FrameError(`LTID không hợp lệ: ${ltid}`);
  const pairs = commandPairs(type, params, now);
  if (id === 'ALL' && pairs.some(([k]) => k !== 'LTIM')) throw new FrameError("LTID'ALL chỉ dùng cho LTIM");
  return buildFrame([['LTID', id], ...pairs]);
}

/** Keys a command expects to see acked (everything except LTID). */
export function expectedAckKeys(frame: string): string[] {
  return frame
    .slice(2, -1)
    .split('&')
    .map((p) => p.slice(0, p.indexOf("'")).toUpperCase())
    .filter((k) => k !== 'LTID');
}
