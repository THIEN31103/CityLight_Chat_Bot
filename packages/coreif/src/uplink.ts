// Non-telemetry uplinks: command acks (stm32/ec25/echo), boot (stm32/ec25/boot),
// demo topic (stm32/ec25/demo: LDIA report text, time-sync log frame, boot provision frame).
import { decodeRs485SelfTest } from '@citylight/shared';
import { parseFrame } from './frame';
import { num, parseIso } from './telemetry';

export const TOPICS = {
  telemetry: 'electrical_cabinets_default',
  command: 'stm32/ec25/cmd',
  echo: 'stm32/ec25/echo',
  demo: 'stm32/ec25/demo',
  boot: 'stm32/ec25/boot',
} as const;

/** Prefix of the per-cabinet command topics (firmware CMD_TOPIC_PER_CABINET, telemetry LFWV'3). */
export const CABINET_COMMAND_PREFIX = 'citylight/cmd/';

/** citylight/cmd/<LTID>; the firmware upper-cases the LTID in its subscription. */
export function cabinetCommandTopic(ltid: string): string {
  return `${CABINET_COMMAND_PREFIX}${ltid.toUpperCase()}`;
}

/** Where a command frame for this cabinet goes: exactly one topic, never both (the device would run it twice). */
export function commandTopic(ltid: string, perCabinetTopic: boolean): string {
  return perCabinetTopic ? cabinetCommandTopic(ltid) : TOPICS.command;
}

export interface Ack {
  /** Cabinet id; missing on old firmware 1307ebc. */
  ltid: string | null;
  acks: { key: string; rc: number }[];
  deviceTick: number | null;
}

/** {"id":"CTY0005","ack":[{"k":"PI2O","rc":0}],"ts":123} (core_if.c). */
export function parseAck(raw: string): Ack {
  const j = JSON.parse(raw) as { id?: string; ack?: { k?: string; rc?: number }[]; ts?: number };
  if (!Array.isArray(j.ack)) throw new Error('Ack thiếu mảng "ack"');
  return {
    ltid: typeof j.id === 'string' ? j.id.toUpperCase() : null,
    acks: j.ack.filter((a) => typeof a.k === 'string').map((a) => ({ key: a.k!.toUpperCase(), rc: typeof a.rc === 'number' ? a.rc : -99 })),
    deviceTick: typeof j.ts === 'number' ? j.ts : null,
  };
}

export interface Boot {
  imei: string | null;
  deviceTick: number | null;
}

/** {"boot":"ok","imei":"...","tick":123} */
export function parseBoot(raw: string): Boot {
  const j = JSON.parse(raw) as { imei?: string; tick?: number };
  return { imei: typeof j.imei === 'string' ? j.imei : null, deviceTick: typeof j.tick === 'number' ? j.tick : null };
}

export type DemoMessage =
  | { kind: 'selftest'; ltid: string | null; summary: string; fail: boolean; rx: string; de: string; tx: string; resultLine: string | null }
  | { kind: 'timesync'; ltid: string; ref: string; deltaSec: number | null; synced: boolean; deviceTime: string | null }
  | { kind: 'provision'; ltid: string; fields: Record<string, string> }
  | { kind: 'unknown'; raw: string };

/**
 * Demo topic carries three shapes:
 *  - LDIA report: "[RS485] id=CTY0005\r\n[RS485] A DE=0 DI=1 RO=1 | D ... RO=1 | B ... RO=1 | C ... RO=1\r\n..."
 *  - time-sync log: *#LTID'..&LIME'..&TREF'SVR&TDEL'-3&TSYN'0&PTIM'..$
 *  - boot provision: *#LTID'..&LDOM'..&LPOR'..&LIME'..&LGPS'..$
 */
export function parseDemo(raw: string): DemoMessage {
  const text = raw.trim();
  if (text.startsWith('[RS485]')) {
    const id = /\[RS485\] id=(\S+)/.exec(text)?.[1] ?? null;
    const m = /A DE=0 DI=1 RO=(.) \| D DE=0 DI=0 RO=(.) \| B DE=1 DI=1 RO=(.) \| C DE=1 DI=0 RO=(.)/.exec(text);
    const summary = m ? `A${m[1]}D${m[2]}B${m[3]}C${m[4]}` : '';
    const d = decodeRs485SelfTest(summary);
    const resultLine = /\[RS485\] RESULT: (.+)/.exec(text)?.[1]?.trim() ?? null;
    return { kind: 'selftest', ltid: id ? id.toUpperCase() : null, summary, resultLine, ...d };
  }
  if (text.startsWith('*#')) {
    const { fields } = parseFrame(text);
    const ltid = (fields.LTID ?? '').toUpperCase();
    if ('TREF' in fields) {
      return { kind: 'timesync', ltid, ref: fields.TREF ?? 'X', deltaSec: num(fields.TDEL), synced: fields.TSYN === '1', deviceTime: parseIso(fields.PTIM) };
    }
    return { kind: 'provision', ltid, fields };
  }
  return { kind: 'unknown', raw: text };
}
