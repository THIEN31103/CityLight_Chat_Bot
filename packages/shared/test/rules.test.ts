import { describe, expect, it } from 'vitest';
import {
  Debouncer, defaultSchedule, defaultThresholds, expectedBranches, inWindow, localMinutes, measurementAlarms,
  type MeasureInput, type MeasureSample, type Thresholds,
} from '../src';

const NOW = Date.parse('2026-10-17T12:00:00Z'); // 19:00 in Hồ Chí Minh
const base: MeasureInput = {
  online: true, lastSeenAt: '2026-10-17T11:59:55Z', busStatus: '0', plcOnline: true, pmOnline: true,
  branch1On: true, branch2On: true, manualMode: false, vL1: 222, vL2: 223, vL3: 221, iL1: 18, iL2: 17, iL3: 19,
  pfTotal: 0.95, leakMa: 12, tempC: 35, tempSensorFault: false, tempSensorInstalled: true, gpsDevice: { lat: 10.77, lng: 106.7 },
  declaredLocation: { lat: 10.77, lng: 106.7 }, batteryMv: 4000, deviceTime: '2026-10-17T12:00:00Z',
  deviceTimeChangedAt: '2026-10-17T11:59:30Z', deviceTimeMissingSince: null, logoLink: null, lastBootAt: '2026-10-17T08:00:00Z', bootsLastHour: 0, bootsLast24h: 1,
  fwProfile: 'v2-current',
};
const T = defaultThresholds();
const run = (h: Partial<MeasureInput>, opts: { t?: Thresholds; samples?: MeasureSample[]; schedule?: ReturnType<typeof defaultSchedule> | null } = {}) =>
  measurementAlarms({ ...base, ...h }, opts.t ?? T, { samples: opts.samples ?? [], schedule: opts.schedule ?? null, now: NOW });
const types = (...a: Parameters<typeof run>) => [...run(...a).keys()].sort();

describe('measurementAlarms', () => {
  it('normal cabinet: nothing', () => {
    expect(types({}, { schedule: defaultSchedule() })).toEqual([]);
  });

  it('voltage and current thresholds per phase', () => {
    expect(types({ vL2: 245 })).toEqual(['over_voltage']);
    expect(run({ vL2: 245 }).get('over_voltage')).toContain('L2 245 V');
    expect(types({ vL3: 190 })).toEqual(['under_voltage']);
    expect(types({ iL1: 50, iL2: 50, iL3: 50 })).toEqual(['over_current']);
    // a disabled threshold never fires
    expect(types({ vL2: 245 }, { t: { ...T, voltageHigh: { enabled: false, value: 240 } } })).toEqual([]);
  });

  it('no voltage alarms when the meter cannot be trusted', () => {
    expect(types({ vL2: 245, pmOnline: false })).toEqual([]);
    // DH meter lost = every value 0: not 3 × under-voltage
    expect(types({ vL1: 0, vL2: 0, vL3: 0, iL1: 0, iL2: 0, iL3: 0 })).toEqual([]);
    // a lost phase is phase_loss (health rules), not under-voltage
    expect(types({ vL3: 0 })).not.toContain('under_voltage');
  });

  it('nothing at all while offline', () => {
    expect(types({ online: false, vL1: 300, leakMa: 999 })).toEqual([]);
  });

  it('sensors: leak, temperature (not when the sensor is broken), battery', () => {
    expect(types({ leakMa: 45 })).toEqual(['leak_current']);
    expect(types({ tempC: 60 })).toEqual(['over_temp']);
    expect(types({ tempC: null, tempSensorFault: true })).toEqual([]);
    expect(types({ tempC: 60, tempSensorInstalled: false })).toEqual([]); // S54: no sensor fitted
    expect(types({ batteryMv: 3500 })).toEqual(['battery_low']);
  });

  it('phase unbalance and low cosφ only while lit', () => {
    expect(types({ iL1: 20, iL2: 10, iL3: 20 })).toEqual(['phase_unbalance']);
    expect(types({ iL1: 20, iL2: 10, iL3: 20, branch1On: false, branch2On: false })).toEqual([]);
    expect(types({ pfTotal: 0.7 })).toEqual(['low_pf']);
    expect(types({ pfTotal: 42.9 })).toEqual([]); // unsigned garbage from firmware
  });

  it('swing needs a full 5-minute window, current swing only with steady branches', () => {
    // swing thresholds are off by default: turn them on for this test
    const t: Thresholds = { ...T, voltageSwing: { enabled: true, value: 15 }, currentSwing: { enabled: true, value: 10 } };
    const mk = (offsetS: number, v: number, i: number, b2 = true): MeasureSample => ({ at: NOW - offsetS * 1000, v: [v, 222, 222], i: [i, 17, 17], b1: true, b2 });
    const wide = [mk(300, 210, 18), mk(200, 230, 18), mk(0, 222, 18)];
    expect(types({}, { t, samples: wide })).toEqual(['voltage_swing']);
    expect(types({}, { t, samples: wide.slice(1) })).toEqual([]); // < 4 min of data
    const amp = [mk(300, 222, 5), mk(150, 222, 20), mk(0, 222, 18)];
    expect(types({}, { t, samples: amp })).toEqual(['current_swing']);
    expect(types({}, { t, samples: [mk(300, 222, 5, false), mk(150, 222, 20), mk(0, 222, 18)] })).toEqual([]);
  });

  it('clock drift only while PTIM is live', () => {
    expect(types({ deviceTime: '2026-10-17T12:08:00Z' })).toEqual(['clock_drift']);
    expect(run({ deviceTime: '2026-10-17T11:50:00Z' }).get('clock_drift')).toContain('chậm 10 phút');
    expect(types({ deviceTime: '2026-10-17T12:08:00Z', deviceTimeChangedAt: '2026-10-17T11:40:00Z' })).toEqual([]);
  });

  it('no clock drift or schedule mismatch while PLGO says the LOGO is lost', () => {
    expect(types({ deviceTime: '2026-10-17T12:08:00Z', logoLink: 3 })).toEqual([]);
  });

  it('GPS drift over 200 m', () => {
    expect(types({ gpsDevice: { lat: 10.773, lng: 106.7 } })).toEqual(['gps_drift']);
    expect(types({ gpsDevice: { lat: 10.7701, lng: 106.7 } })).toEqual([]);
  });
});

describe('schedule', () => {
  it('local time and windows across midnight', () => {
    expect(localMinutes(NOW)).toBe(19 * 60);
    expect(inWindow(19 * 60, '18:00', '05:45')).toBe(true);
    expect(inWindow(3 * 60, '18:00', '05:45')).toBe(true);
    expect(inWindow(12 * 60, '18:00', '05:45')).toBe(false);
    expect(inWindow(12 * 60, '18:00', '18:00')).toBe(false);
  });

  it('expected branches in Chế độ 1 and 2', () => {
    const s = { ...defaultSchedule(), on2: '18:15', off2: '18:30' };
    expect(expectedBranches(s, NOW)).toEqual([true, true]);
    expect(expectedBranches({ ...s, mode: 2 }, NOW)).toEqual([true, false]);
    expect(expectedBranches({ ...s, mode: 2, branch1Enabled: false }, NOW)).toEqual([false, false]);
    // both disabled: LOGO falls back to Chế độ 1
    expect(expectedBranches({ ...s, mode: 2, branch1Enabled: false, branch2Enabled: false }, NOW)).toEqual([true, true]);
  });

  it('mismatch, skipped in manual mode or with an unknown schedule', () => {
    const s = defaultSchedule();
    expect(run({ branch2On: false }, { schedule: s }).get('schedule_mismatch')).toContain('nhánh 2 tắt trong lịch');
    expect(types({ branch2On: false, manualMode: true }, { schedule: s })).toEqual([]);
    expect(types({ branch2On: false }, { schedule: null })).toEqual([]);
    const day = { ...s, on1: '05:00', off1: '06:00' };
    expect(run({}, { schedule: day }).get('schedule_mismatch')).toContain('sáng ngoài lịch');
  });
});

describe('Debouncer', () => {
  it('opens after 30 s, closes after 30 s, a blip does nothing', () => {
    const d = new Debouncer();
    const on = new Map([['over_voltage', 'x'] as const]);
    const off = new Map();
    expect(d.update(on, 0).size).toBe(0);
    expect(d.update(off, 10_000).size).toBe(0); // blip
    expect(d.update(on, 20_000).size).toBe(0);
    expect(d.update(on, 49_000).size).toBe(0);
    expect([...d.update(on, 50_000).keys()]).toEqual(['over_voltage']);
    expect(d.update(off, 60_000).size).toBe(1);
    expect(d.update(on, 70_000).size).toBe(1); // back before the close hold: stays open, timer reset
    expect(d.update(off, 80_000).size).toBe(1);
    expect(d.update(off, 110_000).size).toBe(0);
  });

  it('schedule mismatch waits 20 minutes (manual-on pulse lasts 15)', () => {
    const d = new Debouncer();
    const m = new Map([['schedule_mismatch', 'x'] as const]);
    d.update(m, 0);
    expect(d.update(m, 15 * 60_000).size).toBe(0);
    expect(d.update(m, 20 * 60_000).size).toBe(1);
  });

  it('seeded alarms stay open until their condition is gone long enough', () => {
    const d = new Debouncer();
    d.seed([['leak_current', 'old']]);
    expect(d.update(new Map(), 0).size).toBe(1);
    expect(d.update(new Map(), 30_000).size).toBe(0);
  });
});
