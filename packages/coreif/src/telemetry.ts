// Telemetry frame (topic electrical_cabinets_default) -> typed patch.
// Field formats follow BOARD_LTE_KEY/Core/Src/main.c publish_frame_all():
//   MPU*/MPI*/MPOW: append_kv_fixed1_from_milli -> "222.3"   (V, A, kW)
//   MCO*/MCOS:      u32 scaled x100            -> "95"      (cos phi = 0.95; sign is lost)
//   LGPS:           "%.7f'%.7f'%d" lat'lon'sats (sats already +3 in firmware) or "X"
//   PTIM/LTIM:      ISO 8601 with ms and offset, or "X"
//   CTTE:           1000 = DS18B20 read error
//   LQ2/LQ3/PMAN:   "X" while PCON=0
//   PLGO:           0..5 LOGO link diagnosis from PLC_KEY [46] (firmware LOGO_DIAG), "X" while PCON=0
//   LFWV:           firmware level: 3 = own command topic citylight/cmd/<LTID> subscribed, 2 = shared topic only;
//                   not sent by older firmware; 4 = signing firmware (D7-lite, S59), same topic meaning as 3
//   LUID/LSEQ/LSIG: signing firmware identity block: chip UID 24 hex, boot counter 8 hex, 32 hex signature
//                   (checked by the ingest worker with sign.ts verifyIdent)
//   LCOD:           cabinet code written at the factory (printed in the QR label); not sent by older firmware
import type { GeoPoint } from '@citylight/shared';
import { parseFrame, type ParsedFrame } from './frame';

export interface TelemetryPatch {
  ltid: string;
  imei: string | null;
  domain: string | null;
  port: number | null;
  gps: (GeoPoint & { sats: number | null }) | null;
  lastServerTime: string | null;
  busStatus: '0' | '1' | '2' | '3' | '4' | 'X' | null;
  batteryMv: number | null;
  acInput: string | null;
  lteError: number | null;
  leakMa: number | null;
  tempC: number | null;
  tempSensorFault: boolean;
  pmOnline: boolean | null;
  vL1: number | null;
  vL2: number | null;
  vL3: number | null;
  iL1: number | null;
  iL2: number | null;
  iL3: number | null;
  pfL1: number | null;
  pfL2: number | null;
  pfL3: number | null;
  pfTotal: number | null;
  pTotalKw: number | null;
  plcOnline: boolean | null;
  echoMode2: boolean | null;
  echoLine1: boolean | null;
  echoLine2: boolean | null;
  branch1On: boolean | null;
  branch2On: boolean | null;
  manualMode: boolean | null;
  deviceTime: string | null;
  doorOpen: boolean | null;
  contactorFault: boolean | null;
  /** PLGO: 0 LOGO OK, 1 lost, 2 ETH silent, 3 TCP down, 4 no Modbus, 5 ETH settings; null = X / not sent. */
  logoLink: number | null;
  /** LFWV: 3 = the cabinet listens on its own command topic, 2 = shared topic only; null = not sent (older firmware). */
  fwLevel: number | null;
  /** LUID/LSEQ/LSIG when all three are present and well formed (not verified here); null otherwise. */
  ident: { uid: string; seq: string; sig: string } | null;
  /** LCOD: cabinet code stored in the board, matched against the scanned QR; null = not sent or malformed. */
  cabinetCode: string | null;
  /** All keys present in the frame (e.g. old firmware 1307ebc has no LQ2/LQ3/PMAN). */
  keys: string[];
  /** Keys present in the frame that this parser does not know (future firmware). */
  unknownKeys: Record<string, string>;
  warnings: string[];
}

const KNOWN = new Set([
  'LTID', 'LDOM', 'LPOR', 'LIME', 'LGPS', 'LTIM', 'LCLI', 'LBAT', 'LACI', 'LERR', 'CTVL', 'CTTE', 'MCON',
  'MPU1', 'MPU2', 'MPU3', 'MPI1', 'MPI2', 'MPI3', 'MCO1', 'MCO2', 'MCO3', 'MCOS', 'MPOW', 'PCON',
  'PIN5', 'LINE1', 'LINE2', 'LQ2', 'LQ3', 'PMAN', 'PTIM', 'PDOR', 'PFLT', 'PLGO', 'LFWV',
  'LUID', 'LSEQ', 'LSIG', 'LCOD',
]);

const isX = (v: string | undefined) => v === undefined || v === '' || v.toUpperCase() === 'X';

export function num(v: string | undefined): number | null {
  if (isX(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function bool01(v: string | undefined): boolean | null {
  if (isX(v)) return null;
  if (v === '1') return true;
  if (v === '0') return false;
  return null;
}

/** "10.7769000'106.7009000'9" -> point; null for X or out-of-range. */
export function parseGps(v: string | undefined): (GeoPoint & { sats: number | null }) | null {
  if (isX(v)) return null;
  const [a, b, c] = v!.split("'");
  const lat = Number(a);
  const lng = Number(b);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  const sats = c === undefined ? null : Number(c);
  return { lat, lng, sats: Number.isFinite(sats) ? sats : null };
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/;

/** Device ISO time -> canonical ISO string (UTC). No offset = +07:00 (core_if.c convention). */
export function parseIso(v: string | undefined): string | null {
  if (isX(v)) return null;
  const m = ISO.exec(v!.trim());
  if (!m) return null;
  const offset = m[8] ?? '+07:00';
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ''}${offset}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** PLGO 0..5; anything else (X, garbage) = null. */
function logoLink(v: string | undefined): number | null {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 5 ? n : null;
}

/** LUID/LSEQ/LSIG, lower-cased; any part missing or malformed = null. */
function ident(f: Record<string, string>): TelemetryPatch['ident'] {
  const uid = f.LUID?.toLowerCase();
  const seq = f.LSEQ?.toLowerCase();
  const sig = f.LSIG?.toLowerCase();
  if (!uid || !seq || !sig || !/^[0-9a-f]{24}$/.test(uid) || !/^[0-9a-f]{8}$/.test(seq) || !/^[0-9a-f]{32}$/.test(sig)) return null;
  return { uid, seq, sig };
}

/** LCOD: same characters as a cabinet code in the API; X, empty or anything else = null. */
function cabinetCode(v: string | undefined): string | null {
  if (isX(v)) return null;
  const s = v!.trim();
  return /^[\w.-]{2,24}$/.test(s) ? s : null;
}

/** LFWV: small positive integer; anything else = null. */
function fwLevel(v: string | undefined): number | null {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n > 0 && n < 100 ? n : null;
}

export function telemetryFromFields(p: ParsedFrame): TelemetryPatch {
  const f = p.fields;
  const warnings = [...p.warnings];
  if (!f.LTID || isX(f.LTID)) throw new Error('Telemetry thiếu LTID');
  const pf = (v: string | undefined) => {
    const n = num(v);
    return n === null ? null : n / 100;
  };
  const lcli = f.LCLI?.toUpperCase();
  const busStatus = lcli && ['0', '1', '2', '3', '4', 'X'].includes(lcli) ? (lcli as TelemetryPatch['busStatus']) : null;
  if (lcli && !busStatus) warnings.push(`LCLI lạ: ${f.LCLI}`);
  const ctte = num(f.CTTE);
  const unknownKeys: Record<string, string> = {};
  for (const k of p.order) if (!KNOWN.has(k)) unknownKeys[k] = f[k]!;
  return {
    ltid: f.LTID.toUpperCase(),
    imei: isX(f.LIME) ? null : f.LIME!,
    domain: isX(f.LDOM) ? null : f.LDOM!,
    port: num(f.LPOR),
    gps: parseGps(f.LGPS),
    lastServerTime: parseIso(f.LTIM),
    busStatus,
    batteryMv: num(f.LBAT),
    acInput: isX(f.LACI) ? null : f.LACI!,
    lteError: num(f.LERR),
    leakMa: num(f.CTVL),
    tempC: ctte === 1000 ? null : ctte,
    tempSensorFault: ctte === 1000,
    pmOnline: bool01(f.MCON),
    vL1: num(f.MPU1),
    vL2: num(f.MPU2),
    vL3: num(f.MPU3),
    iL1: num(f.MPI1),
    iL2: num(f.MPI2),
    iL3: num(f.MPI3),
    pfL1: pf(f.MCO1),
    pfL2: pf(f.MCO2),
    pfL3: pf(f.MCO3),
    pfTotal: pf(f.MCOS),
    pTotalKw: num(f.MPOW),
    plcOnline: bool01(f.PCON),
    echoMode2: bool01(f.PIN5),
    echoLine1: bool01(f.LINE1),
    echoLine2: bool01(f.LINE2),
    branch1On: bool01(f.LQ2),
    branch2On: bool01(f.LQ3),
    manualMode: bool01(f.PMAN),
    deviceTime: parseIso(f.PTIM),
    doorOpen: bool01(f.PDOR),
    contactorFault: bool01(f.PFLT),
    logoLink: logoLink(f.PLGO),
    fwLevel: fwLevel(f.LFWV),
    ident: ident(f),
    cabinetCode: cabinetCode(f.LCOD),
    keys: [...p.order],
    unknownKeys,
    warnings,
  };
}

export function parseTelemetry(raw: string): TelemetryPatch {
  return telemetryFromFields(parseFrame(raw));
}
