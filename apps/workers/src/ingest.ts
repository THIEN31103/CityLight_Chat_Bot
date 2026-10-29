// MQTT ingest worker (spec 3, M1):
//  - shared subscription on the uplink topics (EMQX hash_clientid keeps one cabinet on one instance)
//  - parse with @citylight/coreif, keep per-cabinet runtime state in memory
//  - batch-write telemetry / raw frames / cabinet_state every FLUSH_MS
//  - device-health alarms (shared/health.ts) opened / closed as state changes; offline sweep every 10 s,
//    paused while ingest has lost the broker and for offline_after once it is back (no mass E101 on an outage)
//  - measurement alarms (shared/rules.ts, M5): thresholds (cabinet > zone > default), schedule applied by
//    the server, clock, GPS; debounced per cabinet; config reloaded on Redis "cl:config" + every 60 s
//  - publish state + alarm events on Redis for the API's Socket.IO gateway
//  - anonymous-broker guards (S42): per-LTID frame budget, implausible values dropped, frames whose IMEI does
//    not match the cabinet's are not applied (E805 spoof_suspect, shared/identity.ts)
//  - command signing (D7-lite, S59): the telemetry identity block LUID/LSEQ/LSIG is checked with DEVICE_MASTER_KEY;
//    a valid one locks the board UID, turns signing on and moves cabinets.sig_boot (read by the command worker);
//    another board's UID = E805 (frame not applied), a wrong signature = E806 sig_invalid (frame applied)
//  - frames_raw (S57): every non-telemetry frame, every telemetry frame with a note or from an unregistered LTID,
//    otherwise 1 telemetry frame per cabinet per RAW_SAMPLE_MIN minutes (0 = all)
import mqtt from 'mqtt';
import { Redis } from 'ioredis';
import { TOPICS, parseBoot, parseDemo, parseTelemetry, sanitizeTelemetry, type TelemetryPatch } from '@citylight/coreif';
import { parseMasterKey, verifyIdent } from '@citylight/coreif/sign';
import { createSql } from '@citylight/db';
import {
  Debouncer, FrameBudget, LOGO_LINK, healthChecksPaused, MEASUREMENT_TYPES, OFFLINE_AFTER_MS, RAW_SAMPLE_MIN_DEFAULT, RawSampler, SPOOF_HOLD_MS, SWING_WINDOW_MS, activeHealthAlarms, checkImei, defaultThresholds,
  deriveCabinetStatus, errorOf, judgeIdent, measurementAlarms, normImei,
  type AlarmType, type FwProfile, type GeoPoint, type HealthInput, type MeasureSample, type ScheduleWindow, type Thresholds,
} from '@citylight/shared';
import { EVENTS_CHANNEL, type AlarmEvent, type CabinetStateEvent, type WorkerEvent } from './events';

const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const FLUSH_MS = Number(process.env.INGEST_FLUSH_MS ?? 500);
const MAX_BATCH = Number(process.env.INGEST_MAX_BATCH ?? 2000);
const RAW_SAMPLE_MIN = Number(process.env.RAW_SAMPLE_MIN ?? RAW_SAMPLE_MIN_DEFAULT);
const SWEEP_MS = 10_000;

const sql = createSql();
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 2 });
/** API / command-worker announce threshold and schedule changes here. */
const CONFIG_CHANNEL = 'cl:config';
const CONFIG_RELOAD_MS = 60_000;
/** D7-lite master key of this environment; null = identity blocks are not checked (no cabinet gets signed). */
const MASTER = parseMasterKey(process.env.DEVICE_MASTER_KEY);
/** Alarms opened by the frame guards and closed by sweep SPOOF_HOLD_MS after the last bad frame. */
const GUARD_TYPES = ['spoof_suspect', 'sig_invalid'] as const;
type GuardType = (typeof GUARD_TYPES)[number];
const isGuard = (t: AlarmType): t is GuardType => (GUARD_TYPES as readonly AlarmType[]).includes(t);

// ---------------- registry + runtime ----------------

interface Runtime extends HealthInput {
  id: string;
  ltid: string;
  code: string;
  name: string;
  status: string;
  activeAlarms: Map<AlarmType, { id: string; severity: string }>;
  bootTimes: number[];
  extra: Record<string, string>;
  sats: number | null;
  pf: { l1: number | null; l2: number | null; l3: number | null; total: number | null };
  pTotalKw: number | null;
  manualMode: boolean | null;
  doorOpen: boolean | null;
  contactorFault: boolean | null;
  zoneId: string | null;
  declaredLocation: GeoPoint | null;
  thresholds: Thresholds;
  schedule: ScheduleWindow | null;
  samples: MeasureSample[];
  debouncer: Debouncer;
  /** registered IMEI (cabinets.imei); null = learn it from the next frame that carries one */
  imei: string | null;
  /** last frame with a foreign IMEI / board UID (E805) or a bad identity signature (E806): keeps it open SPOOF_HOLD_MS */
  guards: Partial<Record<GuardType, { lastAt: number; frames: number }>>;
  /** signing (S59): locked board UID, UID waiting for the provider, signing on, boot the commands are signed for */
  uid: string | null;
  uidPending: string | null;
  signed: boolean;
  sigBoot: number | null;
  /** a lower boot seen in a row (judgeIdent) */
  lowerBoot: { boot: number; n: number } | null;
}

const byLtid = new Map<string, Runtime>();
const byId = new Map<string, Runtime>();

/** Build runtimes for these cabinets (null = every active cabinet) that are not loaded yet. */
async function loadCabinets(ids: string[] | null) {
  const rows = await sql<
    {
      id: string; ltid: string; code: string; name: string; fw_profile: FwProfile; has_temp_sensor: boolean;
      status: string | null; online: boolean | null; last_seen_at: Date | null; last_boot_at: Date | null; bus_status: string | null;
      branch1_on: boolean | null; branch2_on: boolean | null; manual_mode: boolean | null; plc_online: boolean | null; pm_online: boolean | null;
      v_l1: number | null; v_l2: number | null; v_l3: number | null; i_l1: number | null; i_l2: number | null; i_l3: number | null;
      leak_ma: number | null; temp_c: number | null; temp_sensor_fault: boolean | null; battery_mv: number | null;
      lat: number | null; lng: number | null; device_time: Date | null; device_time_changed_at: Date | null;
      device_time_missing_since: Date | null; logo_link: number | null;
      zone1_id: string | null; decl_lat: number; decl_lng: number; imei: string | null;
      uid: string | null; uid_pending: string | null; signed: boolean; sig_boot: number | null;
    }[]
  >`
    SELECT c.id, c.ltid, c.code, c.name, c.fw_profile, c.has_temp_sensor, c.zone1_id, ST_Y(c.location) AS decl_lat, ST_X(c.location) AS decl_lng, c.imei,
           c.uid, c.uid_pending, c.signed, c.sig_boot,
           s.status, s.online, s.last_seen_at, s.last_boot_at, s.bus_status, s.branch1_on, s.branch2_on, s.manual_mode,
           s.plc_online, s.pm_online, s.v_l1, s.v_l2, s.v_l3, s.i_l1, s.i_l2, s.i_l3, s.leak_ma, s.temp_c, s.temp_sensor_fault,
           s.battery_mv, ST_Y(s.gps_device) AS lat, ST_X(s.gps_device) AS lng, s.device_time, s.device_time_changed_at,
           s.device_time_missing_since, s.logo_link
    FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id
    WHERE c.active ${ids ? sql`AND c.id = ANY(${ids}::uuid[])` : sql``}`;
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  for (const r of rows) {
    if (byId.has(r.id)) continue;
    const rt: Runtime = {
      id: r.id, ltid: r.ltid.toUpperCase(), code: r.code, name: r.name, fwProfile: r.fw_profile,
      status: r.status ?? 'offline', online: !!r.online, lastSeenAt: iso(r.last_seen_at), lastBootAt: iso(r.last_boot_at),
      busStatus: r.bus_status, plcOnline: r.plc_online, pmOnline: r.pm_online, branch1On: r.branch1_on, branch2On: r.branch2_on,
      manualMode: r.manual_mode, vL1: r.v_l1, vL2: r.v_l2, vL3: r.v_l3, iL1: r.i_l1, iL2: r.i_l2, iL3: r.i_l3,
      leakMa: r.leak_ma, tempC: r.temp_c, tempSensorFault: !!r.temp_sensor_fault, tempSensorInstalled: r.has_temp_sensor, batteryMv: r.battery_mv,
      gpsDevice: r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null, sats: null,
      deviceTime: iso(r.device_time), deviceTimeChangedAt: iso(r.device_time_changed_at),
      deviceTimeMissingSince: iso(r.device_time_missing_since), logoLink: r.logo_link,
      bootsLastHour: 0, bootsLast24h: 0, bootTimes: [], activeAlarms: new Map(), extra: {},
      pf: { l1: null, l2: null, l3: null, total: null }, pTotalKw: null, doorOpen: null, contactorFault: null,
      zoneId: r.zone1_id, declaredLocation: { lat: Number(r.decl_lat), lng: Number(r.decl_lng) },
      thresholds: defaultThresholds(), schedule: null, samples: [], debouncer: new Debouncer(),
      imei: normImei(r.imei), guards: {},
      uid: r.uid, uidPending: r.uid_pending, signed: r.signed, sigBoot: r.sig_boot === null ? null : Number(r.sig_boot), lowerBoot: null,
    };
    byLtid.set(rt.ltid, rt);
    byId.set(rt.id, rt);
  }
  return rows.length;
}

async function loadRegistry() {
  await loadCabinets(null);
  await loadSettings();
  const active = await sql<{ id: string; cabinet_id: string; type: AlarmType; severity: string; message: string }[]>`
    SELECT id, cabinet_id, type, severity, message FROM alarms WHERE active`;
  for (const a of active) {
    const rt = byId.get(a.cabinet_id);
    if (!rt) continue;
    rt.activeAlarms.set(a.type, { id: a.id, severity: a.severity });
    // measurement alarms open in the DB stay open until their condition is gone for the close hold
    if (MEASUREMENT_TYPES.includes(a.type)) rt.debouncer.seed([[a.type, a.message]]);
    // an open E805 / E806 survives a restart for one more hold period
    if (isGuard(a.type)) rt.guards[a.type] = { lastAt: Date.now(), frames: 0 };
  }
  const boots = await sql<{ cabinet_id: string; ts: Date }[]>`
    SELECT cabinet_id, ts FROM device_events WHERE kind = 'boot' AND ts > now() - interval '24 hours'`;
  for (const b of boots) byId.get(b.cabinet_id)?.bootTimes.push(b.ts.getTime());
  console.log(`[ingest] registry: ${byId.size} cabinets, ${active.length} active alarms`);
  await dropRegisteredUnknowns();
  await loadConfig();
}

/**
 * A frame buffered in unknownSeen before the registration reached this worker would re-insert the
 * row the API just deleted: forget registered LTIDs here and delete what slipped through.
 */
async function dropRegisteredUnknowns() {
  for (const ltid of [...unknownSeen.keys()]) if (byLtid.has(ltid)) unknownSeen.delete(ltid);
  await sql`DELETE FROM unknown_devices u USING cabinets c WHERE c.active AND upper(c.ltid) = upper(u.ltid)`;
}

/**
 * Admin changes (M8, Redis cl:config "registry"): new cabinets, edited LTID / code / name / zone /
 * position, decommissioned ones dropped. Runtime state of unchanged cabinets is kept.
 */
async function refreshRegistry() {
  const rows = await sql<{
    id: string; ltid: string; code: string; name: string; zone1_id: string | null; fw_profile: FwProfile; has_temp_sensor: boolean; lat: number; lng: number;
    imei: string | null; uid: string | null; uid_pending: string | null; signed: boolean; sig_boot: number | null;
  }[]>`
    SELECT id, ltid, code, name, zone1_id, fw_profile, has_temp_sensor, ST_Y(location) AS lat, ST_X(location) AS lng, imei,
           uid, uid_pending, signed, sig_boot FROM cabinets WHERE active`;
  const seen = new Set<string>();
  const fresh: string[] = [];
  for (const r of rows) {
    seen.add(r.id);
    const rt = byId.get(r.id);
    if (!rt) {
      fresh.push(r.id);
      continue;
    }
    const ltid = r.ltid.toUpperCase();
    if (ltid !== rt.ltid) {
      byLtid.delete(rt.ltid);
      rt.ltid = ltid;
      byLtid.set(ltid, rt);
    }
    Object.assign(rt, {
      code: r.code, name: r.name, zoneId: r.zone1_id, fwProfile: r.fw_profile, tempSensorInstalled: r.has_temp_sensor,
      declaredLocation: { lat: Number(r.lat), lng: Number(r.lng) },
    });
    // admin accepted a new IMEI or asked to re-learn it: E805 closes on the next sweep
    if (normImei(r.imei) !== rt.imei) {
      rt.imei = normImei(r.imei);
      delete rt.guards.spoof_suspect;
    }
    // provider accepted a new board UID (sig_boot restarts from its next identity) or turned signing off
    if (r.uid !== rt.uid) {
      rt.uid = r.uid;
      rt.sigBoot = r.sig_boot === null ? null : Number(r.sig_boot);
      rt.lowerBoot = null;
      delete rt.guards.spoof_suspect;
    }
    rt.uidPending = r.uid_pending;
    rt.signed = r.signed;
  }
  let dropped = 0;
  for (const [id, rt] of byId) {
    if (seen.has(id)) continue;
    byId.delete(id);
    if (byLtid.get(rt.ltid) === rt) byLtid.delete(rt.ltid);
    for (const [imei, x] of imeiIndex) if (x === rt) imeiIndex.delete(imei);
    dirty.delete(id);
    stateEvents.delete(id);
    dropped++;
  }
  const added = fresh.length ? await loadCabinets(fresh) : 0;
  await dropRegisteredUnknowns();
  await loadConfig();
  console.log(`[ingest] registry reloaded: ${byId.size} cabinets (+${added}, -${dropped})`);
}

/** Editable settings (M8): offline detection delay. */
let offlineAfterMs = OFFLINE_AFTER_MS;
async function loadSettings() {
  const r = (await sql<{ value: number }[]>`SELECT value FROM system_settings WHERE key = 'offline_after_s'`)[0];
  const ms = r ? Number(r.value) * 1000 : OFFLINE_AFTER_MS;
  if (Number.isFinite(ms) && ms >= 30_000 && ms !== offlineAfterMs) {
    offlineAfterMs = ms;
    console.log(`[ingest] offline after ${ms / 1000} s`);
  }
}

/** Thresholds (cabinet override > zone > default) and the schedule each cabinet last acked. */
async function loadConfig() {
  const thr = await sql<{ zone_id: string | null; cabinet_id: string | null; values: Partial<Thresholds> }[]>`SELECT zone_id, cabinet_id, values FROM thresholds`;
  const byZone = new Map<string, Partial<Thresholds>>();
  const byCab = new Map<string, Partial<Thresholds>>();
  for (const t of thr) {
    if (t.cabinet_id) byCab.set(t.cabinet_id, t.values);
    else if (t.zone_id) byZone.set(t.zone_id, t.values);
  }
  const sched = await sql<{ cabinet_id: string; values: ScheduleWindow }[]>`SELECT cabinet_id, values FROM schedule_applied`;
  const schedBy = new Map(sched.map((r) => [r.cabinet_id, r.values]));
  const def = defaultThresholds();
  for (const rt of byId.values()) {
    rt.thresholds = { ...def, ...(rt.zoneId ? byZone.get(rt.zoneId) : undefined), ...byCab.get(rt.id) };
    const s = schedBy.get(rt.id);
    rt.schedule = s && (s.mode === 1 || s.mode === 2) && s.on1 && s.off1 ? s : null;
  }
}

// ---------------- batching ----------------

const telemetryRows: Record<string, unknown>[] = [];
const rawRows: { ts: Date; topic: string; ltid: string | null; payload: string; parse_error: string | null }[] = [];
const dirty = new Set<string>();
const stateEvents = new Map<string, CabinetStateEvent>();
const stats = { frames: 0, telemetry: 0, unknown: 0, parseErrors: 0, throttled: 0, sanitized: 0, spoofed: 0, badSig: 0, flushes: 0, lastFlushMs: 0, lagMs: 0 };
/** ingest <-> broker link: offline checks pause while it is down (shared/health.ts healthChecksPaused) */
const brokerLink = { connected: false, upSinceMs: null as number | null, downSinceMs: Date.now() as number | null };
/** Read by the API (system page) and infra/scripts/watchdog.sh: {connected, since, at} */
const BROKER_KEY = 'cl:ingest:mqtt';
function publishBrokerLink() {
  const since = brokerLink.connected ? brokerLink.upSinceMs : brokerLink.downSinceMs;
  void redis
    .set(BROKER_KEY, JSON.stringify({ connected: brokerLink.connected, since: since ? new Date(since).toISOString() : null, at: new Date().toISOString() }))
    .catch(() => undefined);
}
/** per-LTID budget: firmware sends <= 1 frame/s; a flood under one LTID is dropped before it costs a DB write */
const budget = new FrameBudget(5, 1);
const lastWarn = new Map<string, number>();
function warnOnce(key: string, msg: string) {
  const now = Date.now();
  if (now - (lastWarn.get(key) ?? 0) < 60_000) return;
  lastWarn.set(key, now);
  if (lastWarn.size > 10_000) lastWarn.clear();
  console.warn(msg);
}

/** parseError also carries guard notes (dropped values, foreign IMEI): frames_raw is the debugging record. */
function raw(topic: string, ltid: string | null, payload: string, parseError: string | null = null) {
  rawRows.push({ ts: new Date(), topic, ltid, payload, parse_error: parseError });
}
const rawSampler = new RawSampler(RAW_SAMPLE_MIN);

const unknownSeen = new Map<string, { imei: string | null; otherImei: string | null; frames: number; gps: { lat: number; lng: number } | null }>();

// ---------------- alarms ----------------

function alarmEvent(rt: Runtime, id: string, type: AlarmType, message: string, startedAt: Date, endedAt: Date | null): AlarmEvent {
  const def = errorOf(type);
  return {
    id, code: def?.code ?? 'E000', type, severity: def?.severity ?? 'minor', cabinetId: rt.id, cabinetCode: rt.code, cabinetName: rt.name,
    message, startedAt: startedAt.toISOString(), endedAt: endedAt ? endedAt.toISOString() : null,
  };
}

async function publish(ev: WorkerEvent) {
  await redis.publish(EVENTS_CHANNEL, JSON.stringify(ev)).catch(() => undefined);
}

/** Open / close device-health alarms so the active set matches the rules. */
async function syncAlarms(rt: Runtime, now = Date.now()) {
  const want = activeHealthAlarms(rt, now);
  const raw = measurementAlarms(
    { ...rt, pfTotal: rt.pf.total },
    rt.thresholds,
    { samples: rt.samples, schedule: rt.schedule, now },
  );
  for (const [type, message] of rt.debouncer.update(raw, now)) want.set(type, message);
  for (const [type, message] of want) {
    if (rt.activeAlarms.has(type)) continue;
    const def = errorOf(type);
    if (!def) continue;
    const started = new Date(now);
    const rows = await sql<{ id: string }[]>`
      INSERT INTO alarms (cabinet_id, code, type, severity, message, started_at, active)
      VALUES (${rt.id}, ${def.code}, ${type}, ${def.severity}, ${message}, ${started}, true)
      ON CONFLICT (cabinet_id, type) WHERE active DO NOTHING
      RETURNING id`;
    if (rows[0]) {
      rt.activeAlarms.set(type, { id: rows[0].id, severity: def.severity });
      void publish({ type: 'alarm.raised', alarm: alarmEvent(rt, rows[0].id, type, message, started, null) });
    }
  }
  for (const [type, a] of [...rt.activeAlarms]) {
    // E805 / E806 are managed by the frame guards (openGuard / sweep), not by the health / measurement rules
    if (want.has(type) || !errorOf(type) || isGuard(type)) continue;
    const ended = new Date(now);
    await sql`UPDATE alarms SET active = false, ended_at = ${ended} WHERE id = ${a.id}`;
    rt.activeAlarms.delete(type);
    void publish({ type: 'alarm.cleared', alarm: alarmEvent(rt, a.id, type, '', ended, ended) });
  }
  const critical = [...rt.activeAlarms.values()].some((a) => a.severity === 'critical');
  const status = deriveCabinetStatus(rt, critical);
  if (status !== rt.status) rt.status = status;
}

/**
 * A frame the guards reject or distrust: E805 (foreign IMEI / board UID, frame not applied) or E806 (bad identity
 * signature). Opened once; sweep closes it SPOOF_HOLD_MS after the last such frame.
 */
async function openGuard(rt: Runtime, type: GuardType, message: string, now = Date.now()) {
  rt.guards[type] = { lastAt: now, frames: (rt.guards[type]?.frames ?? 0) + 1 };
  warnOnce(`${type}:${rt.ltid}`, `[ingest] ${rt.ltid}: ${message}`);
  if (rt.activeAlarms.has(type)) return;
  const def = errorOf(type)!;
  const started = new Date(now);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO alarms (cabinet_id, code, type, severity, message, started_at, active)
    VALUES (${rt.id}, ${def.code}, ${type}, ${def.severity}, ${message}, ${started}, true)
    ON CONFLICT (cabinet_id, type) WHERE active DO NOTHING
    RETURNING id`;
  if (rows[0]) {
    rt.activeAlarms.set(type, { id: rows[0].id, severity: def.severity });
    void publish({ type: 'alarm.raised', alarm: alarmEvent(rt, rows[0].id, type, message, started, null) });
    markChanged(rt);
  }
}

/** A frame under this cabinet's LTID with another IMEI: not applied; E805 opened (closed by sweep after the hold). */
async function onSpoof(rt: Runtime, imei: string | null, now = Date.now()) {
  stats.spoofed++;
  await openGuard(rt, 'spoof_suspect', `Frame mang LTID ${rt.ltid} với IMEI ${imei ?? '(không có)'} khác IMEI đã ghi nhận ${rt.imei}: frame bị bỏ qua`, now);
}

/** Guard alarms close SPOOF_HOLD_MS after the last bad frame, or at once when the admin changed the IMEI / UID. */
async function closeGuardIfQuiet(rt: Runtime, type: GuardType, now: number) {
  const a = rt.activeAlarms.get(type);
  const g = rt.guards[type];
  if (!a || (g && now - g.lastAt < SPOOF_HOLD_MS)) return;
  const ended = new Date(now);
  await sql`UPDATE alarms SET active = false, ended_at = ${ended} WHERE id = ${a.id}`;
  rt.activeAlarms.delete(type);
  delete rt.guards[type];
  void publish({ type: 'alarm.cleared', alarm: alarmEvent(rt, a.id, type, '', ended, ended) });
  markChanged(rt);
}

type IdentCheck = ReturnType<typeof verifyIdent> | null;

/** Remember another validly signed board UID under this LTID for the provider's E805 decision. */
async function setUidPending(rt: Runtime, uid: string) {
  if (rt.uidPending === uid) return;
  rt.uidPending = uid;
  await sql`UPDATE cabinets SET uid_pending = ${uid} WHERE id = ${rt.id}`;
}

/**
 * Telemetry identity block (S59), after the IMEI check passed. Returns true when the frame must not be applied
 * (another board: E805). A wrong signature only raises E806: telemetry itself is not signed in D7-lite.
 */
async function onIdent(rt: Runtime, id: IdentCheck, now: number): Promise<boolean> {
  if (!id) return false;
  if (!id.ok) {
    stats.badSig++;
    await openGuard(rt, 'sig_invalid', `Bộ định danh (LUID/LSEQ/LSIG) mang LTID ${rt.ltid} ký sai: phần định danh bị bỏ qua`, now);
    return false;
  }
  const j = judgeIdent({ uid: rt.uid, boot: rt.sigBoot }, { uid: id.uid, boot: id.boot }, rt.lowerBoot);
  rt.lowerBoot = j.lower;
  const log = (action: string, value: string) => sql`
    INSERT INTO activity_logs (user_email, action, target_type, target_id, target_name, new_value)
    VALUES ('hệ thống', ${action}, 'cabinet', ${rt.id}, ${rt.code}, ${value})`;
  switch (j.verdict) {
    case 'foreign':
      stats.spoofed++;
      await setUidPending(rt, id.uid);
      await openGuard(rt, 'spoof_suspect', `Frame mang LTID ${rt.ltid} từ board UID ${id.uid} khác UID đã ghi nhận ${rt.uid}: frame bị bỏ qua`, now);
      return true;
    case 'learn': {
      const owner = await sql<{ code: string }[]>`SELECT code FROM cabinets WHERE uid = ${id.uid} AND id <> ${rt.id}`;
      if (owner[0]) {
        // the board moved from another registered cabinet: the provider decides (accepting frees it there)
        stats.spoofed++;
        await setUidPending(rt, id.uid);
        await openGuard(rt, 'spoof_suspect', `Board UID ${id.uid} đang ghi nhận cho tủ ${owner[0].code}: frame mang LTID ${rt.ltid} bị bỏ qua`, now);
        return true;
      }
      await sql`UPDATE cabinets SET uid = ${id.uid}, uid_pending = NULL, signed = true, sig_boot = ${id.boot}, key_fp = ${id.fingerprint}
                WHERE id = ${rt.id} AND uid IS NULL`;
      Object.assign(rt, { uid: id.uid, uidPending: null, signed: true, sigBoot: id.boot });
      await log('Ghi nhận UID board, bật ký lệnh', `UID ${id.uid}, LKFP ${id.fingerprint}, BOOT ${id.boot}`);
      return false;
    }
    case 'advance':
    case 'reset':
      await sql`UPDATE cabinets SET sig_boot = ${id.boot}, signed = true, key_fp = ${id.fingerprint} WHERE id = ${rt.id}`;
      if (j.verdict === 'reset') await log('BOOT tủ giảm (xóa chip / nạp lại)', `BOOT ${rt.sigBoot} -> ${id.boot}`);
      if (!rt.signed) await log('Bật lại ký lệnh (tủ gửi định danh ký đúng)', `BOOT ${id.boot}`);
      Object.assign(rt, { signed: true, sigBoot: id.boot });
      return false;
    case 'same':
      if (!rt.signed) {
        await sql`UPDATE cabinets SET signed = true WHERE id = ${rt.id}`;
        rt.signed = true;
        await log('Bật lại ký lệnh (tủ gửi định danh ký đúng)', `BOOT ${id.boot}`);
      }
      return false;
    case 'stale':
      warnOnce(`stale:${rt.ltid}`, `[ingest] ${rt.ltid}: identity with lower BOOT ${id.boot} (recorded ${rt.sigBoot}) ignored`);
      return false;
  }
}

function markChanged(rt: Runtime, cameOnline = false) {
  dirty.add(rt.id);
  stateEvents.set(rt.id, {
    cabinetId: rt.id, ltid: rt.ltid, status: rt.status, online: rt.online, branch1On: rt.branch1On, branch2On: rt.branch2On,
    manualMode: rt.manualMode, activeAlarmCount: rt.activeAlarms.size, lastSeenAt: rt.lastSeenAt,
    // keep the flag if another change of the same flush window comes after it
    cameOnline: cameOnline || stateEvents.get(rt.id)?.cameOnline || undefined,
  });
}

// ---------------- handlers ----------------

/** PTIM (canonical ISO) -> minute number; null for X. */
const ptimMinute = (iso: string | null) => (iso ? Math.floor(Date.parse(iso) / 60_000) : null);

async function onTelemetry(payload: string) {
  let t: TelemetryPatch;
  try {
    t = parseTelemetry(payload);
  } catch (e) {
    stats.parseErrors++;
    raw(TOPICS.telemetry, null, payload, (e as Error).message);
    return;
  }
  if (!budget.take(t.ltid)) {
    // > 1 frame/s sustained under one LTID: not the firmware; dropped without a DB write
    stats.throttled++;
    warnOnce(`thr:${t.ltid}`, `[ingest] ${t.ltid}: too many frames, dropping (budget 5 + 1/s)`);
    return;
  }
  const { patch, dropped } = sanitizeTelemetry(t);
  if (dropped.length) {
    stats.sanitized++;
    warnOnce(`san:${t.ltid}`, `[ingest] ${t.ltid}: implausible values dropped: ${dropped.join(', ')}`);
    t = patch;
  }
  const rt = byLtid.get(t.ltid);
  const verdict = rt ? checkImei(rt.imei, t.imei) : 'ok';
  const id: IdentCheck = rt && MASTER && t.ident ? verifyIdent(MASTER, t.ltid, t.ident) : null;
  const foreign = verdict === 'mismatch' ? `IMEI ${normImei(t.imei) ?? 'X'} khác IMEI đã ghi nhận` : null;
  const note = foreign ?? (id && !id.ok ? 'định danh ký sai' : null) ?? (dropped.length ? `bỏ giá trị: ${dropped.join(', ')}` : null);
  if (rawSampler.keep(t.ltid, Date.now(), note !== null || !rt)) raw(TOPICS.telemetry, t.ltid, payload, note);
  if (!rt) {
    stats.unknown++;
    const imei = normImei(t.imei);
    const u = unknownSeen.get(t.ltid) ?? { imei, otherImei: null, frames: 0, gps: null };
    u.frames++;
    // first IMEI wins; a different one under the same LTID is kept apart so the admin sees the conflict
    if (!u.imei) u.imei = imei;
    else if (imei && imei !== u.imei) u.otherImei = imei;
    if (t.gps) u.gps = { lat: t.gps.lat, lng: t.gps.lng };
    unknownSeen.set(t.ltid, u);
    return;
  }
  if (verdict === 'mismatch') {
    // modem and board replaced together: keep the new UID too, so the provider accepts both in one E805 decision
    if (id?.ok && rt.uid && id.uid !== rt.uid) await setUidPending(rt, id.uid);
    await onSpoof(rt, normImei(t.imei));
    return;
  }
  if (verdict === 'learn') {
    rt.imei = normImei(t.imei);
    await sql`UPDATE cabinets SET imei = ${rt.imei} WHERE id = ${rt.id} AND imei IS NULL`;
    await sql`INSERT INTO activity_logs (user_email, action, target_type, target_id, target_name, new_value)
              VALUES ('hệ thống', 'Ghi nhận IMEI tủ (frame đầu tiên)', 'cabinet', ${rt.id}, ${rt.code}, ${rt.imei})`;
  }
  if (await onIdent(rt, id, Date.now())) return;
  stats.telemetry++;
  indexImei(t.imei, rt);
  const now = new Date();
  const wasOnline = rt.online;
  const prev = `${rt.status}|${rt.branch1On}|${rt.branch2On}|${rt.manualMode}|${rt.activeAlarms.size}`;
  rt.online = true;
  rt.lastSeenAt = now.toISOString();
  rt.busStatus = t.busStatus;
  rt.plcOnline = t.plcOnline;
  rt.pmOnline = t.pmOnline;
  rt.logoLink = t.plcOnline ? t.logoLink : null;
  // PLGO >= 1: PLC_KEY says the LOGO is not answering, so its LQ2/LQ3/PMAN are the last values it read
  const logoSilent = rt.logoLink !== null && rt.logoLink >= LOGO_LINK.lost;
  rt.branch1On = logoSilent ? null : t.branch1On;
  rt.branch2On = logoSilent ? null : t.branch2On;
  rt.manualMode = logoSilent ? null : t.manualMode;
  rt.vL1 = t.vL1; rt.vL2 = t.vL2; rt.vL3 = t.vL3;
  rt.iL1 = t.iL1; rt.iL2 = t.iL2; rt.iL3 = t.iL3;
  rt.pf = { l1: t.pfL1, l2: t.pfL2, l3: t.pfL3, total: t.pfTotal };
  rt.pTotalKw = t.pTotalKw;
  rt.leakMa = t.leakMa;
  rt.tempC = t.tempC;
  rt.tempSensorFault = t.tempSensorFault;
  rt.batteryMv = t.batteryMv;
  if (t.gps) {
    rt.gpsDevice = { lat: t.gps.lat, lng: t.gps.lng };
    rt.sats = t.gps.sats;
  } else rt.gpsDevice = null;
  // LOGO RTC has minute resolution and LTE adds its own seconds/ms to PTIM: only a new minute is a sign of life
  if (t.deviceTime && ptimMinute(t.deviceTime) !== ptimMinute(rt.deviceTime)) rt.deviceTimeChangedAt = now.toISOString();
  rt.deviceTime = t.deviceTime;
  if (t.deviceTime || t.plcOnline !== true) rt.deviceTimeMissingSince = null;
  else rt.deviceTimeMissingSince ??= now.toISOString();
  rt.doorOpen = t.doorOpen;
  rt.contactorFault = t.contactorFault;
  rt.extra = t.unknownKeys;
  rt.samples.push({ at: now.getTime(), v: [t.vL1, t.vL2, t.vL3], i: [t.iL1, t.iL2, t.iL3], b1: t.branch1On, b2: t.branch2On });
  while (rt.samples.length && now.getTime() - rt.samples[0]!.at > SWING_WINDOW_MS + 30_000) rt.samples.shift();
  // Old field firmware sends no LQ2/LQ3/PMAN: detect it and flag (E804, commands blocked).
  // LFWV'3 = the cabinet is subscribed to its own command topic (v3); LFWV'2 or no LFWV = shared topic only (S53).
  const oldFw = !t.keys.includes('LQ2') && !t.keys.includes('PMAN');
  const fw: FwProfile = oldFw ? 'v2-1307ebc' : (t.fwLevel ?? 0) >= 3 ? 'v3' : 'v2-current';
  if (fw !== rt.fwProfile) {
    rt.fwProfile = fw;
    await sql`UPDATE cabinets SET fw_profile = ${fw} WHERE id = ${rt.id}`;
  }
  telemetryRows.push({
    ts: now, cabinet_id: rt.id, online: true, bus_status: t.busStatus, branch1_on: t.branch1On, branch2_on: t.branch2On, manual_mode: t.manualMode,
    v_l1: t.vL1, v_l2: t.vL2, v_l3: t.vL3, i_l1: t.iL1, i_l2: t.iL2, i_l3: t.iL3, pf_l1: t.pfL1, pf_l2: t.pfL2, pf_l3: t.pfL3, pf_total: t.pfTotal,
    p_total_kw: t.pTotalKw, leak_ma: t.leakMa, temp_c: t.tempC, battery_mv: t.batteryMv,
    gps_lat: t.gps?.lat ?? null, gps_lng: t.gps?.lng ?? null,
    // objects, not JSON.stringify: postgres.js serialises them, a string would be stored as a JSON string
    extra: Object.keys(t.unknownKeys).length ? t.unknownKeys : null,
  });
  await syncAlarms(rt);
  dirty.add(rt.id);
  const next = `${rt.status}|${rt.branch1On}|${rt.branch2On}|${rt.manualMode}|${rt.activeAlarms.size}`;
  if (!wasOnline || prev !== next) markChanged(rt, !wasOnline);
}

async function onBoot(payload: string) {
  try {
    const b = parseBoot(payload);
    raw(TOPICS.boot, null, payload);
    if (!b.imei) return;
    // The boot JSON carries no LTID and arrives BEFORE the provision frame that maps IMEI -> LTID,
    // so an unknown IMEI is parked for up to 60 s and applied once the mapping shows up.
    const rt = imeiIndex.get(b.imei);
    if (!rt) {
      pendingBoots.set(b.imei, { at: Date.now(), tick: b.deviceTick });
      return;
    }
    await applyBoot(rt, b.imei, b.deviceTick, Date.now());
  } catch (e) {
    raw(TOPICS.boot, null, payload, (e as Error).message);
  }
}

const pendingBoots = new Map<string, { at: number; tick: number | null }>();

function indexImei(imei: string | null, rt: Runtime) {
  if (!imei || imeiIndex.get(imei) === rt) return;
  imeiIndex.set(imei, rt);
  const p = pendingBoots.get(imei);
  if (p) {
    pendingBoots.delete(imei);
    if (Date.now() - p.at < 60_000) applyBoot(rt, imei, p.tick, p.at).catch((e) => console.error('[ingest] boot', (e as Error).message));
  }
}

async function applyBoot(rt: Runtime, imei: string, tick: number | null, now: number) {
  {
    rt.lastBootAt = new Date(now).toISOString();
    rt.bootTimes = [...rt.bootTimes.filter((t) => now - t < 86_400_000), now];
    await sql`INSERT INTO device_events (cabinet_id, kind, data) VALUES (${rt.id}, 'boot', ${JSON.stringify({ imei, tick })}::jsonb)`;
    const def = errorOf('reboot')!;
    await sql`INSERT INTO alarms (cabinet_id, code, type, severity, message, started_at, ended_at, active)
              VALUES (${rt.id}, ${def.code}, 'reboot', ${def.severity}, 'Nhận frame stm32/ec25/boot', now(), now(), false)`;
    updateBootCounters(rt, now);
    await syncAlarms(rt, now);
    markChanged(rt);
  }
}

const imeiIndex = new Map<string, Runtime>();

function updateBootCounters(rt: Runtime, now: number) {
  rt.bootsLastHour = rt.bootTimes.filter((t) => now - t < 3_600_000).length;
  rt.bootsLast24h = rt.bootTimes.length;
}

async function onDemo(payload: string) {
  try {
    const d = parseDemo(payload);
    const ltid = d.kind === 'unknown' ? null : d.ltid;
    raw(TOPICS.demo, ltid, payload);
    const rt = ltid ? byLtid.get(ltid) : undefined;
    if (!rt) return;
    if (d.kind === 'provision') {
      // a forged provision frame must not map its IMEI (and so its boot frames) onto this cabinet
      if (checkImei(rt.imei, d.fields.LIME ?? null) !== 'mismatch') indexImei(d.fields.LIME ?? null, rt);
    } else if (d.kind === 'selftest') {
      await sql`INSERT INTO device_events (cabinet_id, kind, data) VALUES (${rt.id}, 'selftest', ${JSON.stringify({ summary: d.summary, rx: d.rx, de: d.de, tx: d.tx, fail: d.fail, result: d.resultLine })}::jsonb)`;
      if (d.fail) {
        const def = errorOf('rs485_selftest_fail')!;
        await sql`INSERT INTO alarms (cabinet_id, code, type, severity, message, started_at, ended_at, active)
                  VALUES (${rt.id}, ${def.code}, 'rs485_selftest_fail', ${def.severity}, ${`LDIA: ${d.summary} — ${d.tx}`}, now(), now(), false)`;
      }
    } else if (d.kind === 'timesync') {
      await sql`INSERT INTO device_events (cabinet_id, kind, data) VALUES (${rt.id}, 'timesync', ${JSON.stringify({ ref: d.ref, deltaSec: d.deltaSec, synced: d.synced })}::jsonb)`;
    }
  } catch (e) {
    raw(TOPICS.demo, null, payload, (e as Error).message);
  }
}

// ---------------- flush + sweep ----------------

const geom = (p: { lat: number; lng: number } | null) => (p ? `SRID=4326;POINT(${p.lng} ${p.lat})` : null);

/** true after a failed flush whose batch was put back: the next failure drops it. */
let retriedBatch = false;

async function flush() {
  const started = Date.now();
  const tele = telemetryRows.splice(0, telemetryRows.length);
  const raws = rawRows.splice(0, rawRows.length);
  // a cabinet decommissioned / deleted since its frame arrived has left the registry: drop its pending state
  // (byId.get() would be undefined and fail every later flush)
  const ids = [...dirty].filter((id) => byId.has(id));
  dirty.clear();
  const events = [...stateEvents.values()];
  stateEvents.clear();
  try {
    for (let i = 0; i < tele.length; i += MAX_BATCH) {
      await sql`INSERT INTO telemetry ${sql(tele.slice(i, i + MAX_BATCH) as never[])} ON CONFLICT DO NOTHING`;
    }
    for (let i = 0; i < raws.length; i += MAX_BATCH) {
      await sql`INSERT INTO frames_raw ${sql(raws.slice(i, i + MAX_BATCH) as never[])}`;
    }
    if (ids.length) {
      const rows = ids.map((id) => {
        const r = byId.get(id)!;
        return {
          cabinet_id: r.id, status: r.status, online: r.online, last_seen_at: r.lastSeenAt, last_boot_at: r.lastBootAt, bus_status: r.busStatus,
          branch1_on: r.branch1On, branch2_on: r.branch2On, manual_mode: r.manualMode, plc_online: r.plcOnline, pm_online: r.pmOnline,
          v_l1: r.vL1, v_l2: r.vL2, v_l3: r.vL3, i_l1: r.iL1, i_l2: r.iL2, i_l3: r.iL3, pf_total: r.pf.total, p_total_kw: r.pTotalKw,
          leak_ma: r.leakMa, temp_c: r.tempC, temp_sensor_fault: r.tempSensorFault, battery_mv: r.batteryMv, gps_device: geom(r.gpsDevice),
          gps_sats: r.sats, device_time: r.deviceTime, device_time_changed_at: r.deviceTimeChangedAt,
          device_time_missing_since: r.deviceTimeMissingSince, logo_link: r.logoLink, door_open: r.doorOpen,
          contactor_fault: r.contactorFault, extra: r.extra, active_alarm_count: r.activeAlarms.size, updated_at: new Date(),
        };
      });
      for (let i = 0; i < rows.length; i += MAX_BATCH) {
        await sql`
          INSERT INTO cabinet_state ${sql(rows.slice(i, i + MAX_BATCH) as never[])}
          ON CONFLICT (cabinet_id) DO UPDATE SET
            status = excluded.status, online = excluded.online, last_seen_at = excluded.last_seen_at, last_boot_at = excluded.last_boot_at,
            bus_status = excluded.bus_status, branch1_on = excluded.branch1_on, branch2_on = excluded.branch2_on, manual_mode = excluded.manual_mode,
            plc_online = excluded.plc_online, pm_online = excluded.pm_online, v_l1 = excluded.v_l1, v_l2 = excluded.v_l2, v_l3 = excluded.v_l3,
            i_l1 = excluded.i_l1, i_l2 = excluded.i_l2, i_l3 = excluded.i_l3, pf_total = excluded.pf_total, p_total_kw = excluded.p_total_kw,
            leak_ma = excluded.leak_ma, temp_c = excluded.temp_c, temp_sensor_fault = excluded.temp_sensor_fault, battery_mv = excluded.battery_mv,
            gps_device = excluded.gps_device, gps_sats = excluded.gps_sats, device_time = excluded.device_time,
            device_time_changed_at = excluded.device_time_changed_at, device_time_missing_since = excluded.device_time_missing_since,
            logo_link = excluded.logo_link, door_open = excluded.door_open, contactor_fault = excluded.contactor_fault,
            extra = excluded.extra, active_alarm_count = excluded.active_alarm_count, updated_at = excluded.updated_at`;
      }
    }
    if (unknownSeen.size) {
      const list = [...unknownSeen.entries()];
      unknownSeen.clear();
      for (const [ltid, u] of list) {
        if (byLtid.has(ltid)) continue; // registered since the frame arrived
        // the first IMEI seen is kept; a different one goes to other_imei (registration then asks which is real)
        await sql`INSERT INTO unknown_devices (ltid, imei, other_imei, frames, gps) VALUES (${ltid}, ${u.imei}, ${u.otherImei}, ${u.frames}, ${geom(u.gps)})
                  ON CONFLICT (ltid) DO UPDATE SET last_seen_at = now(), frames = unknown_devices.frames + excluded.frames,
                  imei = coalesce(unknown_devices.imei, excluded.imei),
                  other_imei = coalesce(unknown_devices.other_imei,
                    CASE WHEN unknown_devices.imei IS NULL THEN excluded.other_imei
                         WHEN excluded.imei IS NOT NULL AND excluded.imei <> unknown_devices.imei THEN excluded.imei
                         ELSE excluded.other_imei END),
                  gps = coalesce(excluded.gps, unknown_devices.gps)`;
      }
    }
    if (events.length) await publish({ type: 'cabinet.state', items: events });
    stats.flushes++;
    stats.lastFlushMs = Date.now() - started;
    retriedBatch = false;
  } catch (e) {
    // put the batch back ONCE so a transient DB error does not lose it; a batch that fails again is dropped,
    // otherwise one bad row (e.g. a deleted cabinet) would block every later flush
    if (!retriedBatch) {
      console.error('[ingest] flush failed, retrying the batch once:', (e as Error).message);
      telemetryRows.unshift(...tele.filter((t) => byId.has(t.cabinet_id as string)));
      ids.forEach((id) => dirty.add(id));
      retriedBatch = true;
    } else {
      console.error(`[ingest] flush failed again, dropped ${tele.length} telemetry rows / ${ids.length} states:`, (e as Error).message);
      retriedBatch = false;
    }
  }
}

/**
 * Cabinets that just went silent, handled in two statements instead of one round trip each:
 * a broker / mobile-network outage takes thousands offline at once (10k one-by-one took ~55 s).
 * While offline only E101 stays active; device-side alarms close (their data is stale).
 */
async function markOffline(list: Runtime[], now: number) {
  if (!list.length) return;
  const def = errorOf('offline')!;
  const started = new Date(now);
  const message = `Không nhận frame telemetry quá ${offlineAfterMs / 1000} s`;
  for (const rt of list) {
    rt.online = false;
    rt.samples = [];
    rt.debouncer.clear(); // their alarms are closed below; start fresh when the cabinet comes back
  }
  const ids = list.map((r) => r.id);
  for (let i = 0; i < ids.length; i += MAX_BATCH) {
    const chunk = ids.slice(i, i + MAX_BATCH);
    const closed = await sql<{ id: string; cabinet_id: string; type: AlarmType }[]>`
      UPDATE alarms SET active = false, ended_at = ${started}
      WHERE active AND type NOT IN ('offline', 'spoof_suspect', 'sig_invalid') AND cabinet_id = ANY(${chunk}::uuid[])
      RETURNING id, cabinet_id, type`;
    for (const c of closed) {
      const rt = byId.get(c.cabinet_id)!;
      rt.activeAlarms.delete(c.type);
      void publish({ type: 'alarm.cleared', alarm: alarmEvent(rt, c.id, c.type, '', started, started) });
    }
    const rows = chunk.map((cabinet_id) => ({ cabinet_id, code: def.code, type: 'offline', severity: def.severity, message, started_at: started, active: true }));
    const opened = await sql<{ id: string; cabinet_id: string }[]>`
      INSERT INTO alarms ${sql(rows)} ON CONFLICT (cabinet_id, type) WHERE active DO NOTHING RETURNING id, cabinet_id`;
    for (const o of opened) {
      const rt = byId.get(o.cabinet_id)!;
      rt.activeAlarms.set('offline', { id: o.id, severity: def.severity });
      void publish({ type: 'alarm.raised', alarm: alarmEvent(rt, o.id, 'offline', message, started, null) });
    }
  }
  for (const rt of list) {
    rt.status = 'offline';
    markChanged(rt);
  }
}

async function sweep() {
  const now = Date.now();
  if (healthChecksPaused(brokerLink, now, offlineAfterMs)) {
    for (const rt of byId.values()) updateBootCounters(rt, now);
    warnOnce('sweep:paused', `[ingest] broker link ${brokerLink.connected ? 'just back' : 'down'}: offline / time-based checks paused`);
    return;
  }
  const wentSilent: Runtime[] = [];
  for (const rt of byId.values()) {
    updateBootCounters(rt, now);
    for (const g of GUARD_TYPES) if (rt.activeAlarms.has(g)) await closeGuardIfQuiet(rt, g, now);
    const silent = !rt.lastSeenAt || now - Date.parse(rt.lastSeenAt) > offlineAfterMs;
    if (rt.online && silent) {
      wentSilent.push(rt);
    } else if (rt.online) {
      // time-based rules (PTIM frozen, GPS grace, flapping window)
      const before = rt.activeAlarms.size;
      await syncAlarms(rt, now);
      if (rt.activeAlarms.size !== before) markChanged(rt);
    } else if (!rt.online && !rt.activeAlarms.has('offline') && rt.lastSeenAt) {
      wentSilent.push(rt);
    }
  }
  await markOffline(wentSilent, now);
}

// ---------------- main ----------------

await loadRegistry();
{
  const sub = redis.duplicate();
  await sub.subscribe(CONFIG_CHANNEL);
  // thresholds / schedules / cabinets / settings change rarely: reload inside the handler chain
  sub.on('message', (_ch, msg) => {
    const type = (() => {
      try {
        return (JSON.parse(msg) as { type?: string }).type;
      } catch {
        return undefined;
      }
    })();
    const job = type === 'registry' ? refreshRegistry : type === 'settings' ? loadSettings : loadConfig;
    chain = chain.then(job).catch((e) => console.error('[ingest] config', (e as Error).message));
  });
}
setInterval(() => void (chain = chain.then(loadConfig).catch(() => undefined)), CONFIG_RELOAD_MS);
const mq = mqtt.connect(MQTT_URL, {
  clientId: `cl-ingest-${process.pid}`,
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  // a lost link is noticed after ~1.5 x keepalive: 15 s -> ~22 s, well inside the shortest offline_after (30 s)
  keepalive: 15,
  reconnectPeriod: 2000,
  // mqtt.js stops for good after a refused CONNACK unless told otherwise; EMQX refuses transiently right after it
  // comes back ("Identifier rejected", seen 2026-10-28 in e2e:broker-outage) and ingest then never reconnected
  reconnectOnConnackError: true,
  clean: true,
});
mq.on('connect', () => {
  const subs = [TOPICS.telemetry, TOPICS.boot, TOPICS.demo, TOPICS.echo].map((t) => `$share/ingest/${t}`);
  mq.subscribe(subs, { qos: 0 }, (err, granted) => {
    if (err) console.error('[ingest] subscribe failed', err.message);
    const denied = granted?.filter((g) => g.qos === 128) ?? [];
    if (denied.length) console.error(`[ingest] broker denied ${denied.map((g) => g.topic).join(', ')} — check MQTT_USERNAME vs infra/emqx/acl.conf`);
    else console.log(`[ingest] subscribed ${subs.length} topics on ${MQTT_URL}`);
    // the link counts as up only once frames can flow (subscribed); the grace period starts here
    if (!err && !denied.length && !brokerLink.connected) {
      Object.assign(brokerLink, { connected: true, upSinceMs: Date.now(), downSinceMs: null });
      publishBrokerLink();
    }
  });
});
mq.on('close', () => {
  if (!brokerLink.connected) return;
  Object.assign(brokerLink, { connected: false, upSinceMs: null, downSinceMs: Date.now() });
  console.warn(`[ingest] lost the broker ${MQTT_URL}: offline checks paused until it is back`);
  publishBrokerLink();
});
mq.on('error', (e) => console.error('[ingest] mqtt', e.message));

// Messages are processed one at a time per process so per-cabinet state stays ordered.
let chain = Promise.resolve();
mq.on('message', (topic, buf) => {
  const payload = buf.toString();
  stats.frames++;
  chain = chain.then(async () => {
    if (topic === TOPICS.telemetry) await onTelemetry(payload);
    else if (topic === TOPICS.boot) await onBoot(payload);
    else if (topic === TOPICS.demo) await onDemo(payload);
    else if (topic === TOPICS.echo) raw(TOPICS.echo, null, payload); // command acks are handled by the command worker (M4)
  }).catch((e) => console.error('[ingest] handler', (e as Error).message));
});

setInterval(() => void flush(), FLUSH_MS);
setInterval(() => void (chain = chain.then(sweep)), SWEEP_MS);
setInterval(() => {
  console.log(`[ingest] frames ${stats.frames} · telemetry ${stats.telemetry} · unknown ${stats.unknown} · parse errors ${stats.parseErrors} · throttled ${stats.throttled} · sanitized ${stats.sanitized} · foreign IMEI/UID ${stats.spoofed} · bad identity ${stats.badSig} · last flush ${stats.lastFlushMs} ms · queue ${telemetryRows.length}`);
  void redis.set('cl:ingest:stats', JSON.stringify({ ...stats, at: Date.now(), queue: telemetryRows.length })).catch(() => undefined);
  publishBrokerLink(); // refreshes "at": a stale key means ingest itself is stuck
}, 30_000);
publishBrokerLink();

async function shutdown() {
  await flush();
  await mq.endAsync();
  await sql.end();
  redis.disconnect();
  process.exit(0);
}
process.on('unhandledRejection', (e) => console.error('[ingest] unhandled', (e as Error)?.message ?? e));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
