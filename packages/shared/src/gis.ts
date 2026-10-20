// GIS assets (spec S4/S5, M8): codes, distances along a route, pole generation, import rows.
// Shared by the API (authoritative) and the web editor (draft preview), so both place poles alike.
import type { GeoPoint } from './domain';
import { defineDict, type Lang } from './i18n';
import { distanceM } from './rules';

export type LngLat = [number, number];

export const routeCode = (cabinetCode: string, branch: 1 | 2) => `${cabinetCode}_N${branch}`;
export const poleCode = (cabinetCode: string, branch: 1 | 2, seq: number) => `${cabinetCode}_N${branch}_${seq}`;

const pt = ([lng, lat]: LngLat): GeoPoint => ({ lat, lng });

export function lineLengthM(line: LngLat[]): number {
  let m = 0;
  for (let i = 1; i < line.length; i++) m += distanceM(pt(line[i - 1]!), pt(line[i]!));
  return m;
}

/** Point at `t` (0..1) between a and b; fine for the short segments of a street-light route. */
const lerp = (a: LngLat, b: LngLat, t: number): LngLat => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * Points every `spacingM` metres along the line, starting at its first vertex; the last vertex is
 * added when the remainder is more than a third of the spacing (a pole is needed at the end).
 */
export function pointsAlong(line: LngLat[], spacingM: number): LngLat[] {
  if (line.length < 2 || !(spacingM > 0)) return line.slice(0, 1);
  const out: LngLat[] = [line[0]!];
  let carried = 0; // metres walked since the last point
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const seg = distanceM(pt(a), pt(b));
    let pos = spacingM - carried; // where the next point falls on this segment
    while (pos <= seg + 1e-9) {
      out.push(lerp(a, b, seg ? pos / seg : 0));
      pos += spacingM;
    }
    carried = seg - (pos - spacingM);
  }
  const end = line[line.length - 1]!;
  const lastGap = distanceM(pt(out[out.length - 1]!), pt(end));
  if (lastGap > spacingM / 3) out.push(end);
  return out;
}

// ---------------- import (Excel / CSV template) ----------------

export interface ImportPole {
  row: number;
  cabinetCode: string;
  branch: 1 | 2;
  seq: number;
  lat: number;
  lng: number;
  lampCount: number;
  ratedPowerW: number | null;
  lampGroup: 0 | 1 | 2 | 3;
  legacyCode: string | null;
}

/** Template columns (first row of the sheet). Headers are matched without accents / case. */
export const IMPORT_COLUMNS = ['Mã tủ', 'Nhánh', 'Thứ tự trụ', 'Vĩ độ', 'Kinh độ', 'Số đèn', 'Công suất (W)', 'Nhóm đèn', 'Mã trụ cũ'] as const;

/** Template columns per language; both header sets are accepted on import, whatever the user's language. */
export const IMPORT_COLUMNS_I18N: Record<Lang, readonly string[]> = {
  vi: IMPORT_COLUMNS,
  en: ['Cabinet code', 'Branch', 'Pole no.', 'Latitude', 'Longitude', 'Lamps', 'Power (W)', 'Lamp group', 'Old pole code'],
};

/** Row errors of parseImportRows. */
export const IMPORT_ERROR_TEXT = defineDict(
  {
    noCabinet: 'Thiếu mã tủ',
    branch: (v: string) => `Nhánh phải là 1/2 hoặc N1/N2 (đang là "${v}")`,
    seq: 'Thứ tự trụ phải là số nguyên ≥ 1',
    coords: 'Thiếu hoặc sai tọa độ',
    outside: (lat: number, lng: number) => `Tọa độ ${lat}, ${lng} nằm ngoài Việt Nam (đảo vĩ độ / kinh độ?)`,
    lamps: 'Số đèn phải từ 0 đến 20',
    power: 'Công suất phải từ 0 đến 2000 W',
    group: 'Nhóm đèn phải là 0, 1, 2 hoặc 3',
    duplicate: (cabinet: string, branch: string, seq: number) => `Trùng trụ ${cabinet} N${branch} số ${seq} trong file`,
  },
  {
    noCabinet: 'Cabinet code missing',
    branch: (v: string) => `Branch must be 1/2, N1/N2 or B1/B2 (found "${v}")`,
    seq: 'Pole no. must be an integer ≥ 1',
    coords: 'Coordinates missing or invalid',
    outside: (lat: number, lng: number) => `Coordinates ${lat}, ${lng} are outside Vietnam (latitude / longitude swapped?)`,
    lamps: 'Lamps must be between 0 and 20',
    power: 'Power must be between 0 and 2000 W',
    group: 'Lamp group must be 0, 1, 2 or 3',
    duplicate: (cabinet: string, branch: string, seq: number) => `Duplicate pole ${cabinet} B${branch} no. ${seq} in the file`,
  },
);

export const normHeader = (h: string) =>
  h.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const KEYS: Record<string, keyof Omit<ImportPole, 'row'>> = {
  ma_tu: 'cabinetCode', nhanh: 'branch', thu_tu_tru: 'seq', thu_tu: 'seq', vi_do: 'lat', lat: 'lat', kinh_do: 'lng', lng: 'lng', lon: 'lng',
  so_den: 'lampCount', cong_suat_w: 'ratedPowerW', cong_suat: 'ratedPowerW', nhom_den: 'lampGroup', ma_tru_cu: 'legacyCode',
  // English template (IMPORT_COLUMNS_I18N.en)
  cabinet_code: 'cabinetCode', branch: 'branch', pole_no: 'seq', pole_number: 'seq', latitude: 'lat', longitude: 'lng',
  lamps: 'lampCount', lamp_count: 'lampCount', power_w: 'ratedPowerW', power: 'ratedPowerW', lamp_group: 'lampGroup', old_pole_code: 'legacyCode',
};

/** Vietnam with a margin: catches swapped lat/lng and decimal-comma mistakes. */
const inVietnam = (lat: number, lng: number) => lat >= 8 && lat <= 24 && lng >= 102 && lng <= 110;
const num = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

/** Rows as objects keyed by the sheet headers; row numbers are the sheet's (header = row 1). */
export function parseImportRows(rows: Record<string, unknown>[], lang: Lang = 'vi'): { poles: ImportPole[]; errors: { row: number; message: string }[] } {
  const poles: ImportPole[] = [];
  const errors: { row: number; message: string }[] = [];
  const seen = new Set<string>();
  const T = IMPORT_ERROR_TEXT[lang];
  rows.forEach((raw, i) => {
    const row = i + 2;
    const r: Record<string, unknown> = {};
    for (const [h, v] of Object.entries(raw)) {
      const k = KEYS[normHeader(h)];
      if (k) r[k] = v;
    }
    if (Object.values(r).every((v) => v === null || v === undefined || String(v).trim() === '')) return; // blank line
    const fail = (m: string) => errors.push({ row, message: m });
    const cabinetCode = String(r.cabinetCode ?? '').trim();
    const b = String(r.branch ?? '').trim().toUpperCase().replace(/^[NB]/, '');
    const seq = num(r.seq);
    const lat = num(r.lat);
    const lng = num(r.lng);
    const lampCount = num(r.lampCount) ?? 1;
    const power = num(r.ratedPowerW);
    const group = num(r.lampGroup) ?? 0;
    if (!cabinetCode) return void fail(T.noCabinet);
    if (b !== '1' && b !== '2') return void fail(T.branch(String(r.branch ?? '')));
    if (seq === null || Number.isNaN(seq) || !Number.isInteger(seq) || seq < 1) return void fail(T.seq);
    if (lat === null || lng === null || Number.isNaN(lat) || Number.isNaN(lng)) return void fail(T.coords);
    if (!inVietnam(lat, lng)) return void fail(T.outside(lat, lng));
    if (Number.isNaN(lampCount) || !Number.isInteger(lampCount) || lampCount < 0 || lampCount > 20) return void fail(T.lamps);
    if (power !== null && (Number.isNaN(power) || power < 0 || power > 2000)) return void fail(T.power);
    if (Number.isNaN(group) || ![0, 1, 2, 3].includes(group)) return void fail(T.group);
    const key = `${cabinetCode}|${b}|${seq}`;
    if (seen.has(key)) return void fail(T.duplicate(cabinetCode, b, seq));
    seen.add(key);
    poles.push({
      row, cabinetCode, branch: Number(b) as 1 | 2, seq, lat, lng, lampCount, ratedPowerW: power, lampGroup: group as 0 | 1 | 2 | 3,
      legacyCode: r.legacyCode ? String(r.legacyCode).trim() : null,
    });
  });
  return { poles, errors };
}

/**
 * Google Maps directions to a point (opens the app on phones). Coordinates only, no cabinet name or id.
 * null when the point is unset (0,0 placeholder) or out of range.
 */
export function directionsUrl(p: GeoPoint | null | undefined): string | null {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
  if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 || (p.lat === 0 && p.lng === 0)) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}
