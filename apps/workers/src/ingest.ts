// MQTT ingest worker (spec 3, M1):
//  - shared subscription on the uplink topics (EMQX hash_clientid keeps one cabinet on one instance)
//  - parse with @citylight/coreif, keep per-cabinet runtime state in memory
//  - batch-write telemetry / raw frames / cabinet_state every FLUSH_MS
//  - device-health alarms (shared/health.ts) opened / closed as state changes; offline sweep every 10 s
//  - publish state + alarm events on Redis for the API's Socket.IO gateway
import mqtt from 'mqtt';
import { Redis } from 'ioredis';
import { TOPICS, parseBoot, parseDemo, parseTelemetry, type TelemetryPatch } from '@citylight/coreif';
import { createSql } from '@citylight/db';
import { OFFLINE_AFTER_MS, activeHealthAlarms, deriveCabinetStatus, errorOf, type AlarmType, type FwProfile, type HealthInput } from '@citylight/shared';
import { EVENTS_CHANNEL, type AlarmEvent, type CabinetStateEvent, type WorkerEvent } from './events';

const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const FLUSH_MS = Number(process.env.INGEST_FLUSH_MS ?? 500);
const MAX_BATCH = Number(process.env.INGEST_MAX_BATCH ?? 2000);
const SWEEP_MS = 10_000;

const sql = createSql();
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 2 });

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
}

const byLtid = new Map<string, Runtime>();
const byId = new Map<string, Runtime>();

async function loadRegistry() {
  const rows = await sql<
    {
      id: string; ltid: string; code: string; name: string; fw_profile: FwProfile;
      status: string | null; online: boolean | null; last_seen_at: Date | null; last_boot_at: Date | null; bus_status: string | null;
      branch1_on: boolean | null; branch2_on: boolean | null; manual_mode: boolean | null; plc_online: boolean | null; pm_online: boolean | null;
      v_l1: number | null; v_l2: number | null; v_l3: number | null; i_l1: number | null; i_l2: number | null; i_l3: number | null;
      leak_ma: number | null; temp_c: number | null; temp_sensor_fault: boolean | null; battery_mv: number | null;
      lat: number | null; lng: number | null; device_time: Date | null; device_time_changed_at: Date | null;
    }[]
  >`
    SELECT c.id, c.ltid, c.code, c.name, c.fw_profile,
           s.status, s.online, s.last_seen_at, s.last_boot_at, s.bus_status, s.branch1_on, s.branch2_on, s.manual_mode,
           s.plc_online, s.pm_online, s.v_l1, s.v_l2, s.v_l3, s.i_l1, s.i_l2, s.i_l3, s.leak_ma, s.temp_c, s.temp_sensor_fault,
           s.battery_mv, ST_Y(s.gps_device) AS lat, ST_X(s.gps_device) AS lng, s.device_time, s.device_time_changed_at
    FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id`;
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  for (const r of rows) {
    if (byId.has(r.id)) continue;
    const rt: Runtime = {
      id: r.id, ltid: r.ltid.toUpperCase(), code: r.code, name: r.name, fwProfile: r.fw_profile,
      status: r.status ?? 'offline', online: !!r.online, lastSeenAt: iso(r.last_seen_at), lastBootAt: iso(r.last_boot_at),
      busStatus: r.bus_status, plcOnline: r.plc_online, pmOnline: r.pm_online, branch1On: r.branch1_on, branch2On: r.branch2_on,
      manualMode: r.manual_mode, vL1: r.v_l1, vL2: r.v_l2, vL3: r.v_l3, iL1: r.i_l1, iL2: r.i_l2, iL3: r.i_l3,
      leakMa: r.leak_ma, tempC: r.temp_c, tempSensorFault: !!r.temp_sensor_fault, batteryMv: r.battery_mv,
      gpsDevice: r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null, sats: null,
      deviceTime: iso(r.device_time), deviceTimeChangedAt: iso(r.device_time_changed_at),
      bootsLastHour: 0, bootsLast24h: 0, bootTimes: [], activeAlarms: new Map(), extra: {},
      pf: { l1: null, l2: null, l3: null, total: null }, pTotalKw: null, doorOpen: null, contactorFault: null,
    };
    byLtid.set(rt.ltid, rt);
    byId.set(rt.id, rt);
  }
  const active = await sql<{ id: string; cabinet_id: string; type: AlarmType; severity: string }[]>`
    SELECT id, cabinet_id, type, severity FROM alarms WHERE active`;
  for (const a of active) byId.get(a.cabinet_id)?.activeAlarms.set(a.type, { id: a.id, severity: a.severity });
  const boots = await sql<{ cabinet_id: string; ts: Date }[]>`
    SELECT cabinet_id, ts FROM device_events WHERE kind = 'boot' AND ts > now() - interval '24 hours'`;
  for (const b of boots) byId.get(b.cabinet_id)?.bootTimes.push(b.ts.getTime());
  console.log(`[ingest] registry: ${byId.size} cabinets, ${active.length} active alarms`);
}

// ---------------- batching ----------------

const telemetryRows: Record<string, unknown>[] = [];
const rawRows: { ts: Date; topic: string; ltid: string | null; payload: string; parse_error: string | null }[] = [];
const dirty = new Set<string>();
const stateEvents = new Map<string, CabinetStateEvent>();
const stats = { frames: 0, telemetry: 0, unknown: 0, parseErrors: 0, flushes: 0, lastFlushMs: 0, lagMs: 0 };

function raw(topic: string, ltid: string | null, payload: string, parseError: string | null = null) {
  rawRows.push({ ts: new Date(), topic, ltid, payload, parse_error: parseError });
}

const unknownSeen = new Map<string, { imei: string | null; frames: number }>();

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
    if (want.has(type) || !errorOf(type)) continue;
    const ended = new Date(now);
    await sql`UPDATE alarms SET active = false, ended_at = ${ended} WHERE id = ${a.id}`;
    rt.activeAlarms.delete(type);
    void publish({ type: 'alarm.cleared', alarm: alarmEvent(rt, a.id, type, '', ended, ended) });
  }
  const critical = [...rt.activeAlarms.values()].some((a) => a.severity === 'critical');
  const status = deriveCabinetStatus(rt, critical);
  if (status !== rt.status) rt.status = status;
}

function markChanged(rt: Runtime) {
  dirty.add(rt.id);
  stateEvents.set(rt.id, {
    cabinetId: rt.id, ltid: rt.ltid, status: rt.status, online: rt.online, branch1On: rt.branch1On, branch2On: rt.branch2On,
    manualMode: rt.manualMode, activeAlarmCount: rt.activeAlarms.size, lastSeenAt: rt.lastSeenAt,
  });
}

// ---------------- handlers ----------------

async function onTelemetry(payload: string) {
  let t: TelemetryPatch;
  try {
    t = parseTelemetry(payload);
  } catch (e) {
    stats.parseErrors++;
    raw(TOPICS.telemetry, null, payload, (e as Error).message);
    return;
  }
  raw(TOPICS.telemetry, t.ltid, payload);
  const rt = byLtid.get(t.ltid);
  if (!rt) {
    stats.unknown++;
    const u = unknownSeen.get(t.ltid) ?? { imei: t.imei, frames: 0 };
    u.frames++;
    u.imei = t.imei ?? u.imei;
    unknownSeen.set(t.ltid, u);
    return;
  }
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
  rt.branch1On = t.branch1On;
  rt.branch2On = t.branch2On;
  rt.manualMode = t.manualMode;
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
  if (t.deviceTime !== rt.deviceTime) {
    rt.deviceTime = t.deviceTime;
    if (t.deviceTime) rt.deviceTimeChangedAt = now.toISOString();
  }
  rt.doorOpen = t.doorOpen;
  rt.contactorFault = t.contactorFault;
  rt.extra = t.unknownKeys;
  // Old field firmware sends no LQ2/LQ3/PMAN: detect it and flag (E804, commands blocked).
  const oldFw = !t.keys.includes('LQ2') && !t.keys.includes('PMAN');
  const fw: FwProfile = oldFw ? 'v2-1307ebc' : rt.fwProfile === 'v2-1307ebc' ? 'v2-current' : rt.fwProfile;
  if (fw !== rt.fwProfile) {
    rt.fwProfile = fw;
    await sql`UPDATE cabinets SET fw_profile = ${fw} WHERE id = ${rt.id}`;
  }
  telemetryRows.push({
    ts: now, cabinet_id: rt.id, online: true, bus_status: t.busStatus, branch1_on: t.branch1On, branch2_on: t.branch2On, manual_mode: t.manualMode,
    v_l1: t.vL1, v_l2: t.vL2, v_l3: t.vL3, i_l1: t.iL1, i_l2: t.iL2, i_l3: t.iL3, pf_l1: t.pfL1, pf_l2: t.pfL2, pf_l3: t.pfL3, pf_total: t.pfTotal,
    p_total_kw: t.pTotalKw, leak_ma: t.leakMa, temp_c: t.tempC, battery_mv: t.batteryMv,
    extra: Object.keys(t.unknownKeys).length ? JSON.stringify(t.unknownKeys) : null,
  });
  await syncAlarms(rt);
  dirty.add(rt.id);
  const next = `${rt.status}|${rt.branch1On}|${rt.branch2On}|${rt.manualMode}|${rt.activeAlarms.size}`;
  if (!wasOnline || prev !== next) markChanged(rt);
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
      indexImei(d.fields.LIME ?? null, rt);
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

async function flush() {
  const started = Date.now();
  const tele = telemetryRows.splice(0, telemetryRows.length);
  const raws = rawRows.splice(0, rawRows.length);
  const ids = [...dirty];
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
          gps_sats: r.sats, device_time: r.deviceTime, device_time_changed_at: r.deviceTimeChangedAt, door_open: r.doorOpen,
          contactor_fault: r.contactorFault, extra: JSON.stringify(r.extra), active_alarm_count: r.activeAlarms.size, updated_at: new Date(),
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
            device_time_changed_at = excluded.device_time_changed_at, door_open = excluded.door_open, contactor_fault = excluded.contactor_fault,
            extra = excluded.extra, active_alarm_count = excluded.active_alarm_count, updated_at = excluded.updated_at`;
      }
    }
    if (unknownSeen.size) {
      const list = [...unknownSeen.entries()];
      unknownSeen.clear();
      for (const [ltid, u] of list) {
        await sql`INSERT INTO unknown_devices (ltid, imei, frames) VALUES (${ltid}, ${u.imei}, ${u.frames})
                  ON CONFLICT (ltid) DO UPDATE SET last_seen_at = now(), frames = unknown_devices.frames + excluded.frames,
                  imei = coalesce(excluded.imei, unknown_devices.imei)`;
      }
    }
    if (events.length) await publish({ type: 'cabinet.state', items: events });
    stats.flushes++;
    stats.lastFlushMs = Date.now() - started;
  } catch (e) {
    console.error('[ingest] flush failed:', (e as Error).message);
    // put the telemetry back once so a transient DB error does not lose a batch
    telemetryRows.unshift(...tele);
    ids.forEach((id) => dirty.add(id));
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
  const message = `Không nhận frame telemetry quá ${OFFLINE_AFTER_MS / 1000} s`;
  for (const rt of list) rt.online = false;
  const ids = list.map((r) => r.id);
  for (let i = 0; i < ids.length; i += MAX_BATCH) {
    const chunk = ids.slice(i, i + MAX_BATCH);
    const closed = await sql<{ id: string; cabinet_id: string; type: AlarmType }[]>`
      UPDATE alarms SET active = false, ended_at = ${started}
      WHERE active AND type <> 'offline' AND cabinet_id = ANY(${chunk}::uuid[])
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
  const wentSilent: Runtime[] = [];
  for (const rt of byId.values()) {
    updateBootCounters(rt, now);
    const silent = !rt.lastSeenAt || now - Date.parse(rt.lastSeenAt) > OFFLINE_AFTER_MS;
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
const mq = mqtt.connect(MQTT_URL, {
  clientId: `cl-ingest-${process.pid}`,
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  keepalive: 30,
  reconnectPeriod: 2000,
  clean: true,
});
mq.on('connect', () => {
  const subs = [TOPICS.telemetry, TOPICS.boot, TOPICS.demo, TOPICS.echo].map((t) => `$share/ingest/${t}`);
  mq.subscribe(subs, { qos: 0 }, (err, granted) => {
    if (err) console.error('[ingest] subscribe failed', err.message);
    const denied = granted?.filter((g) => g.qos === 128) ?? [];
    if (denied.length) console.error(`[ingest] broker denied ${denied.map((g) => g.topic).join(', ')} — check MQTT_USERNAME vs infra/emqx/acl.conf`);
    else console.log(`[ingest] subscribed ${subs.length} topics on ${MQTT_URL}`);
  });
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
  console.log(`[ingest] frames ${stats.frames} · telemetry ${stats.telemetry} · unknown ${stats.unknown} · parse errors ${stats.parseErrors} · last flush ${stats.lastFlushMs} ms · queue ${telemetryRows.length}`);
  void redis.set('cl:ingest:stats', JSON.stringify({ ...stats, at: Date.now(), queue: telemetryRows.length })).catch(() => undefined);
}, 30_000);

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
