// Plausibility check on a parsed telemetry frame (2026-10-20, S42). The broker is still anonymous and the
// parser only rejects non-numbers: a value no cabinet can produce (5000 V, GPS in the ocean, LOGO clock in 1990)
// is dropped to null (= unknown) instead of reaching cabinet_state, charts and alarm rules. The rest of the
// frame is kept. Limits are wide on purpose: they catch garbage and forgery, not a faulty-but-real reading.
import type { TelemetryPatch } from './telemetry';

type NumKey = 'vL1' | 'vL2' | 'vL3' | 'iL1' | 'iL2' | 'iL3' | 'pfL1' | 'pfL2' | 'pfL3' | 'pfTotal' | 'pTotalKw' | 'leakMa' | 'tempC' | 'batteryMv';

export const PLAUSIBLE: Record<NumKey, [number, number]> = {
  vL1: [0, 450], vL2: [0, 450], vL3: [0, 450], // phase-neutral V; 400 V line-line wired wrong still fits
  iL1: [0, 1000], iL2: [0, 1000], iL3: [0, 1000], // A
  pfL1: [-1, 1], pfL2: [-1, 1], pfL3: [-1, 1], pfTotal: [-1, 1],
  pTotalKw: [0, 2000],
  leakMa: [0, 10_000],
  tempC: [-40, 125], // DS18B20 range
  batteryMv: [0, 6000],
};
/** Cabinets are in Vietnam: a fix outside this box is bogus (or a forged frame). */
export const GPS_BOX = { latMin: 8, latMax: 24, lngMin: 102, lngMax: 110 };
/** LOGO clock (PTIM): earlier than this or later than now + 1 day = garbage. */
const PTIM_MIN = Date.parse('2020-01-01T00:00:00Z');

/** Returns a copy with implausible fields set to null, and the list of what was dropped (for logs). */
export function sanitizeTelemetry(t: TelemetryPatch, now = Date.now()): { patch: TelemetryPatch; dropped: string[] } {
  const patch = { ...t };
  const dropped: string[] = [];
  for (const [k, [lo, hi]] of Object.entries(PLAUSIBLE) as [NumKey, [number, number]][]) {
    const v = patch[k];
    if (v !== null && (v < lo || v > hi)) {
      dropped.push(`${k}=${v}`);
      patch[k] = null;
    }
  }
  const g = patch.gps;
  if (g && (g.lat < GPS_BOX.latMin || g.lat > GPS_BOX.latMax || g.lng < GPS_BOX.lngMin || g.lng > GPS_BOX.lngMax)) {
    dropped.push(`gps=${g.lat},${g.lng}`);
    patch.gps = null;
  }
  if (patch.deviceTime) {
    const ms = Date.parse(patch.deviceTime);
    if (!Number.isFinite(ms) || ms < PTIM_MIN || ms > now + 86_400_000) {
      dropped.push(`deviceTime=${patch.deviceTime}`);
      patch.deviceTime = null;
    }
  }
  return { patch, dropped };
}
