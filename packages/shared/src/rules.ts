// Measurement rules (spec 8, M5): thresholds, schedule, clock and GPS checks evaluated by the ingest
// worker on every frame. Pure functions: `measurementAlarms` says which conditions hold right now,
// `Debouncer` turns that into alarms that open / close only after the condition has held for a while.
// Device-health rules (offline, RS485, LOGO…) stay in health.ts and are not debounced.
import type { AlarmType, GeoPoint, Schedule, Thresholds } from './domain';
import { dhMeterLost, logoLost, phaseLoss, type HealthInput } from './health';
import { LOCALE, defineDict, type Lang } from './i18n';

export interface MeasureInput extends HealthInput {
  manualMode: boolean | null;
  /** cosφ total as a ratio (MCOS / 100). */
  pfTotal: number | null;
  /** Position the cabinet is registered at (map). */
  declaredLocation: GeoPoint | null;
}

/** One telemetry frame, kept for the swing rules (5-minute window). */
export interface MeasureSample {
  at: number;
  v: (number | null)[];
  i: (number | null)[];
  b1: boolean | null;
  b2: boolean | null;
}

export type ScheduleWindow = Pick<Schedule, 'mode' | 'on1' | 'off1' | 'on2' | 'off2' | 'branch1Enabled' | 'branch2Enabled'>;

export const SWING_WINDOW_MS = 5 * 60_000;
export const CLOCK_DRIFT_MS = 5 * 60_000;
export const GPS_DRIFT_M = 200;
export const UNBALANCE_RATIO = 0.3;
export const LOW_PF = 0.85;
/** Below this a phase counts as lost (phase_loss), not as under-voltage. */
const PHASE_PRESENT_V = 50;

/** Alarm types produced here; the ingest worker only debounces / closes these. */
export const MEASUREMENT_TYPES: readonly AlarmType[] = [
  'over_voltage', 'under_voltage', 'voltage_swing', 'over_current', 'current_swing', 'phase_unbalance', 'low_pf',
  'leak_current', 'over_temp', 'battery_low', 'clock_drift', 'schedule_mismatch', 'gps_drift',
];

/** How long a condition must hold before the alarm opens / closes (anti-flapping). */
export const HOLD_MS: Record<string, { open: number; close: number }> = {
  default: { open: 30_000, close: 30_000 },
  // 20 min: a manual-on pulse (PI2O or the I2 button on the cabinet) keeps lights on for 15 min
  schedule_mismatch: { open: 20 * 60_000, close: 60_000 },
  clock_drift: { open: 2 * 60_000, close: 60_000 },
  gps_drift: { open: 5 * 60_000, close: 60_000 },
};
export const holdFor = (t: AlarmType) => HOLD_MS[t] ?? HOLD_MS.default!;

const PH = ['L1', 'L2', 'L3'];

/** Messages of measurementAlarms (the ingest worker stores the Vietnamese ones in alarms.message). */
export const MEASUREMENT_TEXT = defineDict(
  {
    voltageSwing: (bad: string, limit: number) => `Biên độ 5 phút ${bad} > ${limit} V`,
    currentSwing: (bad: string, limit: number) => `Biên độ 5 phút ${bad} > ${limit} A`,
    unbalance: (l1: string, l2: string, l3: string, pct: number) => `Dòng L1 ${l1} · L2 ${l2} · L3 ${l3} A, lệch ${pct} %`,
    leak: (ma: number, limit: number) => `Rò ${ma} mA > ${limit} mA`,
    temp: (c: number, limit: number) => `Nhiệt độ tủ ${c} °C > ${limit} °C`,
    battery: (mv: number, limit: number) => `Pin ${mv} mV < ${limit} mV`,
    clock: (ahead: boolean, min: number) => `Giờ LOGO ${ahead ? 'nhanh' : 'chậm'} ${min} phút so với máy chủ`,
    branch: (b: number, on: boolean) => `nhánh ${b} ${on ? 'sáng ngoài lịch' : 'tắt trong lịch'}`,
    schedule: (diff: string, mode: number) => `${diff} (lịch Chế độ ${mode})`,
    gps: (m: number) => `GPS cách vị trí khai báo ${m} m`,
  },
  {
    voltageSwing: (bad: string, limit: number) => `5-min range ${bad} > ${limit} V`,
    currentSwing: (bad: string, limit: number) => `5-min range ${bad} > ${limit} A`,
    unbalance: (l1: string, l2: string, l3: string, pct: number) => `Current L1 ${l1} · L2 ${l2} · L3 ${l3} A, imbalance ${pct} %`,
    leak: (ma: number, limit: number) => `Leakage ${ma} mA > ${limit} mA`,
    temp: (c: number, limit: number) => `Cabinet temperature ${c} °C > ${limit} °C`,
    battery: (mv: number, limit: number) => `Battery ${mv} mV < ${limit} mV`,
    clock: (ahead: boolean, min: number) => `LOGO clock ${min} min ${ahead ? 'ahead of' : 'behind'} the server`,
    branch: (b: number, on: boolean) => `branch ${b} ${on ? 'on outside the schedule' : 'off within the schedule'}`,
    schedule: (diff: string, mode: number) => `${diff} (Mode ${mode} schedule)`,
    gps: (m: number) => `GPS ${m} m from the registered position`,
  },
);

/** Minutes since local midnight in Asia/Ho_Chi_Minh (UTC+7, no DST). */
export function localMinutes(now: number): number {
  const d = new Date(now + 7 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/** true inside [on, off), windows may cross midnight; on == off = never on. */
export function inWindow(minutes: number, on: string, off: string): boolean {
  const a = toMin(on);
  const b = toMin(off);
  if (a === b) return false;
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

/**
 * Expected branch states from the schedule the server applied (LOGO program, CLAUDE.md):
 * Chế độ 1: both branches follow T010. Chế độ 2: each branch follows its own window when enabled,
 * off when disabled; both disabled = LOGO falls back to Chế độ 1.
 */
export function expectedBranches(s: ScheduleWindow, now: number): [boolean, boolean] {
  const m = localMinutes(now);
  const w1 = inWindow(m, s.on1, s.off1);
  if (s.mode === 1 || (!s.branch1Enabled && !s.branch2Enabled)) return [w1, w1];
  return [s.branch1Enabled && w1, s.branch2Enabled && inWindow(m, s.on2, s.off2)];
}

export function distanceM(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function swing(values: (number | null)[]): number {
  const v = values.filter((x): x is number => x !== null);
  return v.length < 2 ? 0 : Math.max(...v) - Math.min(...v);
}

/**
 * Conditions that hold right now (not debounced). `samples` = this cabinet's frames, oldest first;
 * `schedule` = the schedule the server applied (null = unknown, the rule is skipped: the firmware
 * cannot read the LOGO schedule back).
 */
export function measurementAlarms(
  h: MeasureInput,
  t: Thresholds,
  opts: { samples: MeasureSample[]; schedule: ScheduleWindow | null; now: number },
  lang: Lang = 'vi',
): Map<AlarmType, string> {
  const T = MEASUREMENT_TEXT[lang];
  const f1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString(LOCALE[lang]);
  const out = new Map<AlarmType, string>();
  if (!h.online) return out; // stale data: no measurement alarms while offline
  const now = opts.now;
  const lit = h.branch1On === true || h.branch2On === true;

  // ----- power meter values: only when PM_KEY answers and the DH meter reports real numbers -----
  const meterOk = h.pmOnline === true && !dhMeterLost(h);
  if (meterOk) {
    const v = [h.vL1, h.vL2, h.vL3];
    const i = [h.iL1, h.iL2, h.iL3];
    if (t.voltageHigh.enabled) {
      const hi = v.map((x, k) => (x !== null && x > t.voltageHigh.value ? `${PH[k]} ${f1(x)} V` : null)).filter(Boolean);
      if (hi.length) out.set('over_voltage', `${hi.join(', ')} > ${t.voltageHigh.value} V`);
    }
    if (t.voltageLow.enabled && !phaseLoss(h)) {
      const lo = v.map((x, k) => (x !== null && x >= PHASE_PRESENT_V && x < t.voltageLow.value ? `${PH[k]} ${f1(x)} V` : null)).filter(Boolean);
      if (lo.length) out.set('under_voltage', `${lo.join(', ')} < ${t.voltageLow.value} V`);
    }
    if (t.currentHigh.enabled) {
      const hi = i.map((x, k) => (x !== null && x > t.currentHigh.value ? `${PH[k]} ${f1(x)} A` : null)).filter(Boolean);
      if (hi.length) out.set('over_current', `${hi.join(', ')} > ${t.currentHigh.value} A`);
    }
    const win = opts.samples.filter((s) => now - s.at <= SWING_WINDOW_MS);
    // a swing needs about a full window of data, otherwise the first frames after boot would decide
    const fullWindow = win.length >= 2 && win[win.length - 1]!.at - win[0]!.at >= SWING_WINDOW_MS * 0.8;
    if (fullWindow && t.voltageSwing.enabled) {
      const sw = [0, 1, 2].map((k) => swing(win.map((s) => s.v[k] ?? null)));
      const bad = sw.map((x, k) => (x > t.voltageSwing.value ? `${PH[k]} ${f1(x)} V` : null)).filter(Boolean);
      if (bad.length) out.set('voltage_swing', T.voltageSwing(bad.join(', '), t.voltageSwing.value));
    }
    // switching a branch moves the current by design: only judge a window with constant branch states
    const steady = win.every((s) => s.b1 === win[0]?.b1 && s.b2 === win[0]?.b2);
    if (fullWindow && steady && t.currentSwing.enabled) {
      const sw = [0, 1, 2].map((k) => swing(win.map((s) => s.i[k] ?? null)));
      const bad = sw.map((x, k) => (x > t.currentSwing.value ? `${PH[k]} ${f1(x)} A` : null)).filter(Boolean);
      if (bad.length) out.set('current_swing', T.currentSwing(bad.join(', '), t.currentSwing.value));
    }
    if (lit) {
      const cur = i.filter((x): x is number => x !== null);
      const max = Math.max(0, ...cur);
      if (cur.length === 3 && max > 1) {
        const ratio = (max - Math.min(...cur)) / max;
        if (ratio > UNBALANCE_RATIO) out.set('phase_unbalance', T.unbalance(f1(cur[0]!), f1(cur[1]!), f1(cur[2]!), Math.round(ratio * 100)));
      }
      // the firmware sends cosφ as an unsigned value: anything outside 0..1 is not trusted
      if (h.pfTotal !== null && h.pfTotal > 0 && h.pfTotal <= 1 && h.pfTotal < LOW_PF) out.set('low_pf', `cosφ ${h.pfTotal.toFixed(2)} < ${LOW_PF}`);
    }
  }

  // ----- CT_KEY sensors -----
  if (t.leakMa.enabled && h.leakMa !== null && h.leakMa > t.leakMa.value) out.set('leak_current', T.leak(h.leakMa, t.leakMa.value));
  if (t.tempC.enabled && h.tempSensorInstalled && !h.tempSensorFault && h.tempC !== null && h.tempC > t.tempC.value) out.set('over_temp', T.temp(h.tempC, t.tempC.value));
  if (t.batteryLowMv.enabled && h.batteryMv !== null && h.batteryMv > 0 && h.batteryMv < t.batteryLowMv.value)
    out.set('battery_low', T.battery(h.batteryMv, t.batteryLowMv.value));

  // ----- LOGO clock: only while PTIM is live (a frozen PTIM is logo_lost) -----
  if (h.plcOnline === true && h.deviceTime && !logoLost(h, now)) {
    const drift = Date.parse(h.deviceTime) - now;
    if (Math.abs(drift) > CLOCK_DRIFT_MS) out.set('clock_drift', T.clock(drift > 0, Math.round(Math.abs(drift) / 60_000)));
  }

  // ----- schedule: branch state vs the schedule the server applied -----
  if (opts.schedule && h.manualMode === false && h.plcOnline === true && !logoLost(h, now) && h.branch1On !== null && h.branch2On !== null) {
    const [e1, e2] = expectedBranches(opts.schedule, now);
    const diff: string[] = [];
    if (h.branch1On !== e1) diff.push(T.branch(1, h.branch1On));
    if (h.branch2On !== e2) diff.push(T.branch(2, h.branch2On));
    if (diff.length) out.set('schedule_mismatch', T.schedule(diff.join(', '), opts.schedule.mode));
  }

  // ----- GPS vs registered position -----
  if (h.gpsDevice && h.declaredLocation) {
    const d = distanceM(h.gpsDevice, h.declaredLocation);
    if (d > GPS_DRIFT_M) out.set('gps_drift', T.gps(Math.round(d)));
  }
  return out;
}

/**
 * Per-cabinet hysteresis: an alarm opens after its condition held for `open` ms and closes after it
 * was gone for `close` ms. Feed it the raw conditions of every frame (and of the periodic sweep).
 */
export class Debouncer {
  /** alarms currently open, with their latest message */
  readonly active = new Map<AlarmType, string>();
  private pending = new Map<AlarmType, number>();

  update(raw: Map<AlarmType, string>, now: number): Map<AlarmType, string> {
    for (const type of new Set([...raw.keys(), ...this.active.keys(), ...this.pending.keys()])) {
      const cond = raw.has(type);
      const open = this.active.has(type);
      if (cond && open) this.active.set(type, raw.get(type)!);
      if (cond === open) {
        this.pending.delete(type);
        continue;
      }
      const since = this.pending.get(type) ?? now;
      this.pending.set(type, since);
      const hold = holdFor(type);
      if (now - since >= (cond ? hold.open : hold.close)) {
        this.pending.delete(type);
        if (cond) this.active.set(type, raw.get(type)!);
        else this.active.delete(type);
      }
    }
    return this.active;
  }

  /** Offline / reset: forget everything (the alarms get closed by the caller). */
  clear() {
    this.active.clear();
    this.pending.clear();
  }

  /** Seed with alarms already open in the DB (restart), so they are not re-opened. */
  seed(open: Iterable<[AlarmType, string]>) {
    for (const [t, m] of open) this.active.set(t, m);
  }
}

/** Alarm types the server actually raises (the rest wait for firmware or configuration). */
export const RAISED_ALARM_TYPES: readonly AlarmType[] = [
  // health.ts
  'offline', 'flapping', 'plc_lost', 'pm_lost', 'ct_lost', 'bus_down', 'multi_slave_lost', 'logo_lost', 'dh_meter_lost',
  'phase_loss', 'temp_sensor_fault', 'gps_nofix', 'fw_unsafe',
  // events: boot, LDIA report, command outcomes
  'reboot', 'rs485_selftest_fail', 'cmd_rejected', 'cmd_unconfirmed', 'cmd_timeout',
  // identity guard (identity.ts)
  'spoof_suspect', 'sig_invalid',
  ...MEASUREMENT_TYPES,
];
