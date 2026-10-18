import { describe, expect, it } from 'vitest';
import { CONFIRMED_BY_TELEMETRY, type CommandType } from '@citylight/shared';
import {
  FrameError,
  RETRYABLE,
  ackError,
  ackMatches,
  buildCommandFrame,
  buildCommandFrames,
  buildFrame,
  confirmRule,
  expectedAckKeys,
  isoVn,
  parseAck,
  parseBoot,
  parseDemo,
  parseFrame,
  parseGps,
  parseIso,
  parseLegacy,
  parseTelemetry,
} from '../src';
import { ACK_NEW, ACK_OLD, BOOT, LDIA_REPORT, TELE_OK, TELE_OLD_FW, TELE_PLC_LOST, TIMESYNC } from './fixtures';

describe('parseFrame', () => {
  it('splits pairs on the first quote only (LGPS contains quotes)', () => {
    const f = parseFrame(TELE_OK);
    expect(f.fields.LGPS).toBe("10.7769000'106.7009000'9");
    expect(f.order[0]).toBe('LTID');
    expect(f.warnings).toEqual([]);
  });

  it('upper-cases keys (device keys are case-insensitive)', () => {
    expect(parseFrame("*#ltid'cty0001&t10'X$").fields).toEqual({ LTID: 'cty0001', T10: 'X' });
  });

  it('rejects a broken envelope', () => {
    expect(() => parseFrame("LTID'A$")).toThrow(FrameError);
    expect(() => parseFrame("*#LTID'A")).toThrow(FrameError);
    expect(() => parseFrame('*#$')).toThrow(FrameError);
  });

  it('warns on empty / value-less / duplicate pairs', () => {
    const f = parseFrame("*#LTID'A&&FOO&LTID'B$");
    expect(f.fields.LTID).toBe('B');
    expect(f.warnings).toHaveLength(3);
  });

  it('parses the legacy KEY=VAL form', () => {
    expect(parseLegacy('LTID=CTY0005&PMAN=1').fields).toEqual({ LTID: 'CTY0005', PMAN: '1' });
  });
});

describe('parseTelemetry', () => {
  it('decodes a normal frame', () => {
    const t = parseTelemetry(TELE_OK);
    expect(t.ltid).toBe('CTY0005');
    expect(t.gps).toEqual({ lat: 10.7769, lng: 106.7009, sats: 9 });
    expect(t.busStatus).toBe('0');
    expect(t.vL1).toBe(222.3);
    expect(t.iL3).toBe(19);
    expect(t.pfL1).toBeCloseTo(0.95);
    expect(t.pTotalKw).toBe(11.2);
    expect(t.branch1On).toBe(true);
    expect(t.branch2On).toBe(false);
    expect(t.manualMode).toBe(false);
    expect(t.deviceTime).toBe('2026-10-17T11:05:03.412Z');
    expect(t.lastServerTime).toBeNull();
    expect(t.acInput).toBeNull();
    expect(t.tempSensorFault).toBe(false);
    expect(t.unknownKeys).toEqual({});
  });

  it('maps X to null and CTTE=1000 to a sensor fault', () => {
    const t = parseTelemetry(TELE_PLC_LOST);
    expect(t.busStatus).toBe('1');
    expect(t.plcOnline).toBe(false);
    expect(t.branch1On).toBeNull();
    expect(t.manualMode).toBeNull();
    expect(t.deviceTime).toBeNull();
    expect(t.gps).toBeNull();
    expect(t.tempC).toBeNull();
    expect(t.tempSensorFault).toBe(true);
    expect(t.vL1).toBe(0);
  });

  it('handles old firmware without LQ2/LQ3/PMAN', () => {
    const t = parseTelemetry(TELE_OLD_FW);
    expect(t.branch1On).toBeNull();
    expect(t.manualMode).toBeNull();
    expect(t.gps?.sats).toBe(7);
  });

  it('keeps unknown keys for future firmware', () => {
    const t = parseTelemetry("*#LTID'A&MKWH'1234.5&LCSQ'21$");
    expect(t.unknownKeys).toEqual({ MKWH: '1234.5', LCSQ: '21' });
  });

  it('requires LTID', () => {
    expect(() => parseTelemetry("*#LCLI'0$")).toThrow();
  });
});

describe('field helpers', () => {
  it('parseGps rejects junk and 0,0', () => {
    expect(parseGps('X')).toBeNull();
    expect(parseGps("0.0000000'0.0000000'7")).toBeNull();
    expect(parseGps("95'200'3")).toBeNull();
  });
  it('parseIso: offset, Z, missing offset = +07:00, garbage', () => {
    expect(parseIso('2026-10-17T18:00:00+07:00')).toBe('2026-10-17T11:00:00.000Z');
    expect(parseIso('2026-10-17T11:00:00Z')).toBe('2026-10-17T11:00:00.000Z');
    expect(parseIso('2026-10-17T18:00:00')).toBe('2026-10-17T11:00:00.000Z');
    expect(parseIso('18:00')).toBeNull();
  });
});

describe('uplinks', () => {
  it('parses new and old acks', () => {
    expect(parseAck(ACK_NEW)).toEqual({ ltid: 'CTY0005', acks: [{ key: 'PLN1', rc: 0 }, { key: 'PMAN', rc: 0 }], deviceTick: 123456 });
    expect(parseAck(ACK_OLD).ltid).toBeNull();
  });
  it('parses boot', () => {
    expect(parseBoot(BOOT)).toEqual({ imei: '861234567890123', deviceTick: 5123 });
  });
  it('decodes the LDIA report like Master_modbus.c', () => {
    const d = parseDemo(LDIA_REPORT);
    expect(d.kind).toBe('selftest');
    if (d.kind !== 'selftest') return;
    expect(d.ltid).toBe('CTY0005');
    expect(d.summary).toBe('A1D1B1C1');
    expect(d.fail).toBe(true);
    expect(d.rx).toMatch(/^OK/);
    expect(d.tx).toMatch(/^Chưa kết luận/);
    expect(d.resultLine).toBe('FAIL');
  });
  it('parses the time-sync log frame', () => {
    const d = parseDemo(TIMESYNC);
    expect(d).toMatchObject({ kind: 'timesync', ltid: 'CTY0005', ref: 'SVR', deltaSec: -3, synced: false });
  });
});

describe('commands', () => {
  const now = new Date('2026-10-17T11:30:00Z');

  it('builds manual control with LTID first and PMAN last', () => {
    expect(buildCommandFrame('cty0005', 'MANUAL_ALL', { on: true })).toBe("*#LTID'CTY0005&PLN1'1&PLN2'1&PMAN'1$");
    expect(buildCommandFrame('CTY0005', 'MANUAL_BRANCH', { branch: 2, on: false })).toBe("*#LTID'CTY0005&PLN2'0&PMAN'1$");
    expect(buildCommandFrame('CTY0005', 'AUTO', {})).toBe("*#LTID'CTY0005&PMAN'0$");
  });

  it('sends LTIM as local time +07:00, never Z', () => {
    expect(isoVn(now)).toBe('2026-10-17T18:30:00+07:00');
    expect(buildCommandFrame('CTY0005', 'SET_TIME', {}, now)).toBe("*#LTID'CTY0005&LTIM'2026-10-17T18:30:00+07:00$");
  });

  it('builds schedule mode 1 and mode 2', () => {
    const base = { on1: '18:00', off1: '05:45', on2: '18:15', off2: '23:00', branch1Enabled: true, branch2Enabled: false };
    expect(buildCommandFrame('CTY0005', 'SET_SCHEDULE', { ...base, mode: 1 })).toBe(
      "*#LTID'CTY0005&PI50'0&T10'2026-01-01T18:00:00+07:00&T20'2026-01-01T05:45:00+07:00$",
    );
    const f2 = buildCommandFrame('CTY0005', 'SET_SCHEDULE', { ...base, mode: 2 });
    expect(expectedAckKeys(f2)).toEqual(['PI50', 'LINE1', 'LINE2', 'T10', 'T20', 'T11', 'T21']);
    expect(f2).toContain("LINE2'0");
  });

  it('rejects bad input and unsupported commands', () => {
    expect(() => buildCommandFrame('CTY0005', 'SET_SCHEDULE', { mode: 1, on1: '25:00', off1: '05:00' })).toThrow(FrameError);
    expect(() => buildCommandFrame('ALL', 'AUTO', {})).toThrow(FrameError);
    expect(() => buildCommandFrame('CTY0005', 'SET_DIMMING', {})).toThrow(FrameError);
    expect(() => buildCommandFrame('bad id!', 'AUTO', {})).toThrow(FrameError);
  });

  it('allows LTID ALL for time only', () => {
    expect(buildCommandFrame('ALL', 'SET_TIME', {}, now)).toBe("*#LTID'ALL&LTIM'2026-10-17T18:30:00+07:00$");
  });

  it('sends PULSE_ON as two frames so the 0->1 edge always reaches LOGO', () => {
    expect(buildCommandFrames('CTY0005', 'PULSE_ON', {})).toEqual(["*#LTID'CTY0005&PI2O'0$", "*#LTID'CTY0005&PI2O'1$"]);
    expect(() => buildCommandFrame('CTY0005', 'PULSE_ON', {})).toThrow(FrameError);
  });

  it('enforces the 16-key limit', () => {
    const pairs = Array.from({ length: 17 }, (_, i) => [`K${i}`, 1] as [string, number]);
    expect(() => buildFrame(pairs)).toThrow(FrameError);
  });
});

describe('ack matching and confirmation', () => {
  const frame = "*#LTID'CTY0005&PLN1'1&PLN2'1&PMAN'1$";
  const ack = (json: object) => parseAck(JSON.stringify(json));

  it('matches an ack by cabinet id and key set, in any order', () => {
    expect(ackMatches('CTY0005', frame, ack({ id: 'cty0005', ack: [{ k: 'PMAN', rc: 0 }, { k: 'PLN1', rc: 0 }, { k: 'PLN2', rc: 0 }] }))).toBe(true);
    expect(ackMatches('CTY0005', frame, ack({ id: 'CTY0006', ack: [{ k: 'PLN1', rc: 0 }, { k: 'PLN2', rc: 0 }, { k: 'PMAN', rc: 0 }] }))).toBe(false);
    expect(ackMatches('CTY0005', frame, ack({ id: 'CTY0005', ack: [{ k: 'PMAN', rc: 0 }] }))).toBe(false);
    // old firmware 1307ebc: no id, cannot be attributed
    expect(ackMatches('CTY0005', frame, ack({ ack: [{ k: 'PLN1', rc: 0 }, { k: 'PLN2', rc: 0 }, { k: 'PMAN', rc: 0 }] }))).toBe(false);
  });

  it('reports rc != 0 per key', () => {
    expect(ackError(ack({ id: 'CTY0005', ack: [{ k: 'PMAN', rc: 0 }] }))).toBeNull();
    expect(ackError(ack({ id: 'CTY0005', ack: [{ k: 'PLN1', rc: -1 }, { k: 'PMAN', rc: 0 }] }))).toMatch(/^PLN1 rc=-1/);
    expect(ackError(ack({ id: 'CTY0005', ack: [{ k: 'T12', rc: -2 }] }))).toContain('không hỗ trợ');
  });

  it('confirms manual control only when LQ2/LQ3/PMAN show it', () => {
    const now = new Date();
    const all = confirmRule('MANUAL_ALL', { on: true })!;
    expect(all({ manualMode: true, branch1On: true, branch2On: true } as never, now)).toBe(true);
    expect(all({ manualMode: true, branch1On: true, branch2On: null } as never, now)).toBe(false);
    expect(all({ manualMode: false, branch1On: true, branch2On: true } as never, now)).toBe(false);
    const br2 = confirmRule('MANUAL_BRANCH', { branch: 2, on: false })!;
    expect(br2({ manualMode: true, branch1On: true, branch2On: false } as never, now)).toBe(true);
    expect(confirmRule('AUTO', {})!({ manualMode: false } as never, now)).toBe(true);
  });

  it('confirms SET_TIME when PTIM is within 2 minutes', () => {
    const now = new Date('2026-10-18T03:00:00Z');
    const rule = confirmRule('SET_TIME', {})!;
    expect(rule({ deviceTime: '2026-10-18T03:01:30.000Z' } as never, now)).toBe(true);
    expect(rule({ deviceTime: '2026-10-18T02:50:00.000Z' } as never, now)).toBe(false);
    expect(rule({ deviceTime: null } as never, now)).toBe(false);
  });

  it('keeps the confirmable list in step with shared (web toasts use it)', () => {
    const all: CommandType[] = ['MANUAL_ALL', 'MANUAL_BRANCH', 'AUTO', 'SET_SCHEDULE', 'SET_TIME', 'PULSE_ON', 'DIAG'];
    expect(all.filter((t) => confirmRule(t, { on: true, branch: 1 }) !== null)).toEqual([...CONFIRMED_BY_TELEMETRY]);
    expect(RETRYABLE.has('PULSE_ON')).toBe(false);
    expect(RETRYABLE.has('SET_SCHEDULE')).toBe(false);
  });
});
