// Dimming profiles (spec S11, M9): validation and savings estimate, shared by the API and the web
// editor. Profiles are stored and edited now; sending them waits for firmware / hardware ("dimming").
import type { DimmingSegment, LampGroup } from './domain';
import { defineDict, type Lang } from './i18n';

export const MAX_SEGMENTS = 5;
/** minutes from 00:00 of the switch-on day; the night runs past midnight, up to 48 h */
export const MAX_MINUTE = 2880;

export function defaultDimmingSegments(): DimmingSegment[] {
  return [
    { enabled: true, startMin: 1080, endMin: 1320, levelPct: 100 },
    { enabled: true, startMin: 1320, endMin: 1440, levelPct: 75 },
    { enabled: true, startMin: 1440, endMin: 1560, levelPct: 50 },
    { enabled: true, startMin: 1560, endMin: 1680, levelPct: 75 },
    { enabled: true, startMin: 1680, endMin: 1785, levelPct: 100 },
  ];
}

/** Messages of validateDimming. */
export const DIMMING_ERROR_TEXT = defineDict(
  {
    count: (max: number) => `Cần từ 1 đến ${max} thời đoạn`,
    segment: (k: number) => `Thời đoạn ${k}`,
    integer: 'giá trị phải là số nguyên',
    range: 'ngoài khoảng 00:00 hôm nay – 24:00 hôm sau',
    order: 'giờ kết thúc phải sau giờ bắt đầu',
    level: 'mức phải từ 0 đến 100 %',
    gap: (prev: number) => `phải bắt đầu đúng lúc thời đoạn ${prev} kết thúc`,
  },
  {
    count: (max: number) => `A profile needs 1 to ${max} periods`,
    segment: (k: number) => `Period ${k}`,
    integer: 'values must be whole numbers',
    range: 'outside 00:00 today – 24:00 the next day',
    order: 'end time must be after the start time',
    level: 'level must be between 0 and 100 %',
    gap: (prev: number) => `must start exactly when period ${prev} ends`,
  },
);

/** Problems of a profile, one message per segment (empty = valid). */
export function validateDimming(segments: DimmingSegment[], lang: Lang = 'vi'): string[] {
  const T = DIMMING_ERROR_TEXT[lang];
  const out: string[] = [];
  if (!segments.length || segments.length > MAX_SEGMENTS) out.push(T.count(MAX_SEGMENTS));
  segments.forEach((s, i) => {
    const n = T.segment(i + 1);
    if (![s.startMin, s.endMin, s.levelPct].every((v) => Number.isInteger(v))) out.push(`${n}: ${T.integer}`);
    if (s.startMin < 0 || s.endMin > MAX_MINUTE) out.push(`${n}: ${T.range}`);
    if (s.endMin <= s.startMin) out.push(`${n}: ${T.order}`);
    if (s.levelPct < 0 || s.levelPct > 100) out.push(`${n}: ${T.level}`);
    const prev = segments[i - 1];
    if (prev && prev.endMin !== s.startMin) out.push(`${n}: ${T.gap(i)}`);
  });
  return out;
}

/** Share of energy saved over the profile's span (disabled segments run at 100 %), as the editor shows. */
export function dimmingSavedPct(segments: DimmingSegment[]): number {
  let full = 0;
  let used = 0;
  for (const s of segments) {
    const h = Math.max(0, s.endMin - s.startMin) / 60;
    full += h;
    used += (h * (s.enabled ? s.levelPct : 100)) / 100;
  }
  return full ? (1 - used / full) * 100 : 0;
}

export interface DimmingEstimate {
  lamps: number;
  ratedKw: number;
  hours: number;
  savedPct: number;
  kwhPerNight: number;
  kwhPerYear: number;
  /** null when no electricity price is set */
  vndPerYear: number | null;
}

/** Savings for lamps with this total rated power (from the GIS data, not a guess). */
export function estimateDimming(segments: DimmingSegment[], lamps: number, ratedW: number, pricePerKwh: number | null): DimmingEstimate {
  const hours = segments.reduce((h, s) => h + Math.max(0, s.endMin - s.startMin) / 60, 0);
  const savedPct = dimmingSavedPct(segments);
  const ratedKw = ratedW / 1000;
  const kwhPerNight = (ratedKw * hours * savedPct) / 100;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    lamps, ratedKw: r1(ratedKw), hours: r1(hours), savedPct: r1(savedPct), kwhPerNight: r1(kwhPerNight), kwhPerYear: Math.round(kwhPerNight * 365),
    vndPerYear: pricePerKwh ? Math.round(kwhPerNight * 365 * pricePerKwh) : null,
  };
}

export const LAMP_GROUPS: readonly LampGroup[] = [0, 1, 2, 3];
