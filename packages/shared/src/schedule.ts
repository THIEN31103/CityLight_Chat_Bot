// Lighting schedules (spec 9, M6): which schedule a cabinet should run, astronomical windows and
// the comparison with what the cabinet acked. Shared by the scheduler worker, the API and the web
// preview so all three compute the same minutes.
import SunCalc from 'suncalc';
import type { GeoPoint, Schedule } from './domain';
import { defaultSchedule } from './defaults';
import type { ScheduleWindow } from './rules';

const VN_OFFSET_MS = 7 * 3600_000;

/** Calendar date in Asia/Ho_Chi_Minh, as "YYYY-MM-DD". */
export function vnDate(now = Date.now()): string {
  return new Date(now + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** "HH:MM" local (UTC+7) of an instant, rounded to the nearest minute. */
export function vnHhmm(ms: number): string {
  const d = new Date(Math.round((ms + VN_OFFSET_MS) / 60_000) * 60_000);
  return d.toISOString().slice(11, 16);
}

/** Noon local time of a VN date: SunCalc picks the solar day around the instant it is given. */
const vnNoon = (date: string) => Date.parse(`${date}T12:00:00+07:00`);

/**
 * Astronomical window for the night that starts on `date`: on = sunset + offsetOn,
 * off = next sunrise + offsetOff (minutes, may be negative).
 */
export function astroWindow(center: GeoPoint, date: string, offsetOnMin: number, offsetOffMin: number): { on: string; off: string; sunset: string; sunrise: string } {
  const noon = vnNoon(date);
  const today = SunCalc.getTimes(new Date(noon), center.lat, center.lng);
  const tomorrow = SunCalc.getTimes(new Date(noon + 86_400_000), center.lat, center.lng);
  return {
    on: vnHhmm(today.sunset.getTime() + offsetOnMin * 60_000),
    off: vnHhmm(tomorrow.sunrise.getTime() + offsetOffMin * 60_000),
    sunset: vnHhmm(today.sunset.getTime()),
    sunrise: vnHhmm(tomorrow.sunrise.getTime()),
  };
}

/** Next `days` nights from `date` (web chart, API preview). */
export function astroPreview(center: GeoPoint, date: string, days: number, offsetOnMin: number, offsetOffMin: number) {
  const start = vnNoon(date);
  return Array.from({ length: days }, (_, i) => {
    const d = vnDate(start + i * 86_400_000);
    return { date: d, ...astroWindow(center, d, offsetOnMin, offsetOffMin) };
  });
}

export type ScheduleSource = 'cabinet' | 'zone' | 'default';

/**
 * The schedule a cabinet should run tonight: its own schedule, else its zone's, else the default.
 * An astronomical schedule replaces branch 1's window (and both branches in Chế độ 1); branch 2's
 * hand-set window stays (decision M6-B).
 */
export function desiredSchedule(
  own: Schedule | null,
  zone: Schedule | null,
  center: GeoPoint | null,
  now = Date.now(),
): { window: ScheduleWindow; source: ScheduleSource } {
  const base = own ?? zone ?? defaultSchedule();
  const source: ScheduleSource = own ? 'cabinet' : zone ? 'zone' : 'default';
  let { on1, off1 } = base;
  if (base.source === 'astronomical' && center) {
    const w = astroWindow(center, vnDate(now), base.offsetOnMin, base.offsetOffMin);
    on1 = w.on;
    off1 = w.off;
  }
  return {
    window: { mode: base.mode, on1, off1, on2: base.on2, off2: base.off2, branch1Enabled: base.branch1Enabled, branch2Enabled: base.branch2Enabled },
    source,
  };
}

/**
 * Same schedule as far as the device is concerned (what SET_SCHEDULE writes): Chế độ 1 sends
 * PI50/T10/T20 only, so branch 2 settings do not matter there.
 */
export function sameSchedule(a: ScheduleWindow | null, b: ScheduleWindow | null): boolean {
  if (!a || !b) return false;
  if (a.mode !== b.mode || a.on1 !== b.on1 || a.off1 !== b.off1) return false;
  if (a.mode === 1) return true;
  return a.on2 === b.on2 && a.off2 === b.off2 && a.branch1Enabled === b.branch1Enabled && a.branch2Enabled === b.branch2Enabled;
}
