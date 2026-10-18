// Map, hierarchy and cabinet read endpoints (spec 11). Shapes match apps/web/src/lib/api.ts.
import { Controller, Get, Inject, Injectable, Module, Param, Query, Req } from '@nestjs/common';
import type { PendingQuery, Row } from 'postgres';
import { z } from 'zod';
import type { CabinetState, CabinetStatus, CabinetSummary, FwProfile, MapStats, Schedule, TelemetryPoint } from '@citylight/shared';
import { buildDiagnostics, capabilitiesFor, decodeRs485SelfTest, defaultSchedule, defaultThresholds, type HealthInput } from '@citylight/shared';
import type { AuthedRequest } from './auth';
import { ApiError } from './errors';
import { SQL, type Sql } from './infra';
import { inScope, scopeWhere, type Scope } from './scope';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const uuid = z.string().uuid();

interface StateRow {
  id: string; ltid: string; code: string; name: string; district_id: string | null; ward_id: string | null; lat: number; lng: number;
  status: CabinetStatus | null; online: boolean | null; branch1_on: boolean | null; branch2_on: boolean | null;
}

function summary(r: StateRow): CabinetSummary {
  return {
    id: r.id, ltid: r.ltid, code: r.code, name: r.name, location: { lat: r.lat, lng: r.lng }, status: r.status ?? 'offline',
    districtId: r.district_id, wardId: r.ward_id, branch1On: r.branch1_on, branch2On: r.branch2_on, connectedType: 'central',
  };
}

/** Telemetry metric name (web) -> column. */
const METRIC: Record<string, string> = {
  vL1: 'v_l1', vL2: 'v_l2', vL3: 'v_l3', iL1: 'i_l1', iL2: 'i_l2', iL3: 'i_l3',
  pTotalKw: 'p_total_kw', pfTotal: 'pf_total', leakMa: 'leak_ma', tempC: 'temp_c',
};

@Injectable()
export class CabinetsService {
  private mapCache: { at: number; data: CabinetSummary[] } | null = null;
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  async mapCabinets(scope: Scope): Promise<CabinetSummary[]> {
    const all = await this.allCabinets();
    return scope.all ? all : all.filter((c) => inScope(scope, c.districtId, c.wardId));
  }

  private async allCabinets(): Promise<CabinetSummary[]> {
    // 10k rows: cache 2 s so a room full of operators does not hammer the DB; scope is filtered per user
    if (this.mapCache && Date.now() - this.mapCache.at < 2000) return this.mapCache.data;
    const rows = await this.sql<StateRow[]>`
      SELECT c.id, c.ltid, c.code, c.name, c.district_id, c.ward_id, ST_Y(c.location) AS lat, ST_X(c.location) AS lng,
             s.status, s.online, s.branch1_on, s.branch2_on
      FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id`;
    const data = rows.map(summary);
    this.mapCache = { at: Date.now(), data };
    return data;
  }

  async stats(scope: Scope): Promise<MapStats> {
    const rows = await this.sql<{ status: CabinetStatus; n: number }[]>`
      SELECT coalesce(s.status, 'offline') AS status, count(*)::int AS n FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id
      WHERE ${scopeWhere(this.sql, scope)} GROUP BY 1`;
    const counts = { offline: 0, fault: 0, dimming: 0, on: 0, off: 0, unknown: 0, total: 0 };
    for (const r of rows) {
      counts[r.status] += r.n;
      counts.total += r.n;
    }
    const online = counts.total - counts.offline;
    const overdue = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM incidents i JOIN cabinets c ON c.id = i.cabinet_id
      WHERE i.status = 'assigned' AND i.deadline < now() AND ${scopeWhere(this.sql, scope)}`;
    return { cabinets: counts, onlinePct: counts.total ? (online / counts.total) * 100 : 0, energyTodayKwh: null, energyYesterdayKwh: null, overdueIncidents: overdue[0]?.n ?? 0 };
  }

  async search(scope: Scope, q: string) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const rows = await this.sql<StateRow[]>`
      SELECT c.id, c.ltid, c.code, c.name, c.district_id, c.ward_id, ST_Y(c.location) AS lat, ST_X(c.location) AS lng,
             s.status, s.online, s.branch1_on, s.branch2_on
      FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id
      WHERE (c.name ILIKE ${like} OR c.code ILIKE ${like} OR c.ltid ILIKE ${like} OR c.address ILIKE ${like}) AND ${scopeWhere(this.sql, scope)}
      ORDER BY c.code LIMIT 10`;
    return rows.map(summary);
  }

  async nearby(scope: Scope, lat: number, lng: number, radius: number) {
    const rows = await this.sql<(StateRow & { distance_m: number })[]>`
      SELECT c.id, c.ltid, c.code, c.name, c.district_id, c.ward_id, ST_Y(c.location) AS lat, ST_X(c.location) AS lng,
             s.status, s.online, s.branch1_on, s.branch2_on,
             ST_Distance(c.location::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) AS distance_m
      FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id
      WHERE ST_DWithin(c.location::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radius}) AND ${scopeWhere(this.sql, scope)}
      ORDER BY distance_m LIMIT 100`;
    return rows.map((r) => ({ ...summary(r), distanceM: Math.round(r.distance_m) }));
  }

  /** Areas in scope plus their ancestors (so the tree keeps its parents); counts only cabinets in scope. */
  async areaTree(scope: Scope) {
    const visible = scope.all
      ? this.sql`TRUE`
      : scope.areaIds.length
        ? this.sql`a.id IN (
            WITH RECURSIVE up AS (
              SELECT id, parent_id FROM areas WHERE id = ANY(${this.sql.array(scope.areaIds)}::uuid[])
              UNION SELECT p.id, p.parent_id FROM areas p JOIN up ON p.id = up.parent_id
            ) SELECT id FROM up)`
        : this.sql`FALSE`;
    const areas = await this.sql<{ id: string; name: string; parent_id: string | null; kind: 'unit' | 'district' | 'ward'; n: number }[]>`
      SELECT a.id, a.name, a.parent_id, a.kind,
        (SELECT count(*)::int FROM cabinets c
          WHERE (c.ward_id = a.id OR c.district_id = a.id OR (a.kind = 'unit' AND c.organization_id = a.organization_id))
            AND ${scopeWhere(this.sql, scope)}) AS n
      FROM areas a WHERE ${visible} ORDER BY a.kind, a.name`;
    const unassigned = scope.all ? await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cabinets WHERE district_id IS NULL` : [{ n: 0 }];
    return {
      areas: areas.map((a) => ({ id: a.id, name: a.name, parentId: a.parent_id, kind: a.kind, cabinetCount: a.n })),
      unassigned: unassigned[0]?.n ?? 0,
    };
  }

  async areaCabinets(scope: Scope, id: string) {
    if (id === 'unassigned' && !scope.all) return [];
    const rows =
      id === 'unassigned'
        ? await this.sql<StateRow[]>`
            SELECT c.id, c.ltid, c.code, c.name, c.district_id, c.ward_id, ST_Y(c.location) AS lat, ST_X(c.location) AS lng, s.status, s.online, s.branch1_on, s.branch2_on
            FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id WHERE c.district_id IS NULL ORDER BY c.code`
        : await this.sql<StateRow[]>`
            SELECT c.id, c.ltid, c.code, c.name, c.district_id, c.ward_id, ST_Y(c.location) AS lat, ST_X(c.location) AS lng, s.status, s.online, s.branch1_on, s.branch2_on
            FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id WHERE c.ward_id = ${uuid.parse(id)} AND ${scopeWhere(this.sql, scope)} ORDER BY c.code`;
    return rows.map(summary);
  }

  async list(scope: Scope, page: number, size: number, status?: string, q?: string) {
    const like = q ? `%${q.replace(/[%_]/g, '')}%` : null;
    const where = this.sql`WHERE (${status ?? null}::text IS NULL OR coalesce(s.status::text, 'offline') = ${status ?? null})
      AND (${like}::text IS NULL OR c.name ILIKE ${like} OR c.ltid ILIKE ${like} OR c.code ILIKE ${like})
      AND ${scopeWhere(this.sql, scope)}`;
    const rows = await this.sql<(StateRow & { district_name: string | null; fw_profile: string; last_seen_at: Date | null })[]>`
      SELECT c.id, c.ltid, c.code, c.name, c.district_id, c.ward_id, ST_Y(c.location) AS lat, ST_X(c.location) AS lng,
             s.status, s.online, s.branch1_on, s.branch2_on, d.name AS district_name, c.fw_profile, s.last_seen_at
      FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id LEFT JOIN areas d ON d.id = c.district_id
      ${where} ORDER BY c.code LIMIT ${size} OFFSET ${(page - 1) * size}`;
    const total = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id ${where}`;
    return {
      items: rows.map((r) => ({ ...summary(r), districtName: r.district_name ?? 'Chưa phân khu vực', fwProfile: r.fw_profile, lastSeenAt: iso(r.last_seen_at) })),
      total: total[0]?.n ?? 0, page, size,
    };
  }

  /** 404 when the cabinet does not exist, 403 forbidden_scope when it is outside the user's areas. */
  async assertCabinet(scope: Scope, id: string): Promise<string> {
    const cid = uuid.parse(id);
    const rows = await this.sql<{ district_id: string | null; ward_id: string | null }[]>`SELECT district_id, ward_id FROM cabinets WHERE id = ${cid}`;
    if (!rows[0]) throw new ApiError(404, 'not_found', 'Không tìm thấy tủ');
    if (!inScope(scope, rows[0].district_id, rows[0].ward_id)) throw new ApiError(403, 'forbidden_scope', 'Tủ này nằm ngoài khu vực bạn được phân quyền');
    return cid;
  }

  private async health(id: string): Promise<{ input: HealthInput; row: Record<string, unknown> }> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT c.*, ST_Y(c.location) AS lat, ST_X(c.location) AS lng, d.name AS district_name, w.name AS ward_name,
             s.status, s.online, s.last_seen_at, s.last_boot_at, s.bus_status, s.branch1_on, s.branch2_on, s.manual_mode, s.plc_online, s.pm_online,
             s.v_l1, s.v_l2, s.v_l3, s.i_l1, s.i_l2, s.i_l3, s.pf_total, s.p_total_kw, s.leak_ma, s.temp_c, s.temp_sensor_fault, s.battery_mv,
             ST_Y(s.gps_device) AS gps_lat, ST_X(s.gps_device) AS gps_lng, s.device_time, s.device_time_changed_at, s.door_open, s.contactor_fault,
             s.active_alarm_count,
             (SELECT count(*)::int FROM device_events e WHERE e.cabinet_id = c.id AND e.kind = 'boot' AND e.ts > now() - interval '1 hour') AS boots_1h,
             (SELECT count(*)::int FROM device_events e WHERE e.cabinet_id = c.id AND e.kind = 'boot' AND e.ts > now() - interval '24 hours') AS boots_24h
      FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id
      LEFT JOIN areas d ON d.id = c.district_id LEFT JOIN areas w ON w.id = c.ward_id
      WHERE c.id = ${id}`;
    const r = rows[0];
    if (!r) throw new ApiError(404, 'not_found', 'Không tìm thấy tủ');
    const num = (k: string) => (r[k] === null || r[k] === undefined ? null : Number(r[k]));
    const input: HealthInput = {
      online: !!r.online, lastSeenAt: iso(r.last_seen_at as Date), busStatus: (r.bus_status as string) ?? null,
      plcOnline: (r.plc_online as boolean) ?? null, pmOnline: (r.pm_online as boolean) ?? null,
      branch1On: (r.branch1_on as boolean) ?? null, branch2On: (r.branch2_on as boolean) ?? null,
      vL1: num('v_l1'), vL2: num('v_l2'), vL3: num('v_l3'), iL1: num('i_l1'), iL2: num('i_l2'), iL3: num('i_l3'),
      leakMa: num('leak_ma'), tempC: num('temp_c'), tempSensorFault: !!r.temp_sensor_fault,
      gpsDevice: r.gps_lat !== null && r.gps_lat !== undefined ? { lat: Number(r.gps_lat), lng: Number(r.gps_lng) } : null,
      batteryMv: num('battery_mv'), deviceTime: iso(r.device_time as Date), deviceTimeChangedAt: iso(r.device_time_changed_at as Date),
      lastBootAt: iso(r.last_boot_at as Date), bootsLastHour: Number(r.boots_1h ?? 0), bootsLast24h: Number(r.boots_24h ?? 0),
      fwProfile: r.fw_profile as FwProfile,
    };
    return { input, row: r };
  }

  async detail(scope: Scope, id: string) {
    id = await this.assertCabinet(scope, id);
    const { input: h, row: r } = await this.health(id);
    const state: CabinetState = {
      cabinetId: id, status: (r.status as CabinetStatus) ?? 'offline', online: h.online, lastSeenAt: h.lastSeenAt,
      branch1On: h.branch1On, branch2On: h.branch2On, manualMode: (r.manual_mode as boolean) ?? null, plcOnline: h.plcOnline, pmOnline: h.pmOnline,
      busStatus: h.busStatus, vL1: h.vL1, vL2: h.vL2, vL3: h.vL3, iL1: h.iL1, iL2: h.iL2, iL3: h.iL3, pfL1: null, pfL2: null, pfL3: null,
      pfTotal: r.pf_total === null ? null : Number(r.pf_total), pTotalKw: r.p_total_kw === null ? null : Number(r.p_total_kw),
      leakMa: h.leakMa, tempC: h.tempC, batteryMv: h.batteryMv, gpsDevice: h.gpsDevice, deviceTime: h.deviceTime,
      doorOpen: (r.door_open as boolean) ?? null, contactorFault: (r.contactor_fault as boolean) ?? null,
      energyKwh: null, sTotalKva: null, qTotalKvar: null, freqHz: null, simSignal: null, simOperator: null,
      activeAlarmCount: Number(r.active_alarm_count ?? 0),
    };
    const sched = await this.sql<Record<string, unknown>[]>`
      SELECT s.*, (s.cabinet_id IS NULL) AS inherited FROM schedules s
      WHERE s.cabinet_id = ${id} OR s.zone_id = ${(r.zone1_id as string) ?? null}
      ORDER BY (s.cabinet_id IS NULL) LIMIT 1`;
    const applied = await this.sql<{ applied_at: Date }[]>`SELECT applied_at FROM schedule_applied WHERE cabinet_id = ${id}`;
    const s = sched[0];
    const schedule: Schedule = s
      ? {
          mode: Number(s.mode) as 1 | 2, source: s.source as Schedule['source'], on1: s.on1 as string, off1: s.off1 as string,
          on2: (s.on2 as string) ?? '18:15', off2: (s.off2 as string) ?? '23:00', branch1Enabled: !!s.branch1_enabled, branch2Enabled: !!s.branch2_enabled,
          offsetOnMin: Number(s.offset_on_min), offsetOffMin: Number(s.offset_off_min), appliedAt: iso(applied[0]?.applied_at), inheritedFromZone: !!s.inherited,
        }
      : { ...defaultSchedule(), appliedAt: iso(applied[0]?.applied_at) };
    const thr = await this.sql<{ values: unknown }[]>`SELECT values FROM thresholds WHERE cabinet_id = ${id} OR zone_id = ${(r.zone1_id as string) ?? null} ORDER BY (cabinet_id IS NULL) LIMIT 1`;
    const counts = await this.sql<{ routes: number; poles: number; lamps: number }[]>`
      SELECT (SELECT count(*)::int FROM routes WHERE cabinet_id = ${id}) AS routes,
             (SELECT count(*)::int FROM poles p JOIN routes rt ON rt.id = p.route_id WHERE rt.cabinet_id = ${id}) AS poles,
             (SELECT count(*)::int FROM lamps l JOIN poles p ON p.id = l.pole_id JOIN routes rt ON rt.id = p.route_id WHERE rt.cabinet_id = ${id}) AS lamps`;
    return {
      cabinet: {
        id, ltid: r.ltid, code: r.code, name: r.name, address: r.address ?? '', street: r.street ?? '', wardId: r.ward_id, districtId: r.district_id,
        managementUnitId: r.management_unit_id, zone1Id: r.zone1_id, zone2Id: r.zone2_id, location: { lat: Number(r.lat), lng: Number(r.lng) },
        fwProfile: r.fw_profile, imei: r.imei ?? '', simIccid: r.sim_iccid, photoUrl: r.photo_url, installedAt: iso(r.installed_at as Date),
        routeCount: counts[0]?.routes ?? 0, poleCount: counts[0]?.poles ?? 0, lampCount: counts[0]?.lamps ?? 0,
        districtName: (r.district_name as string) ?? 'Chưa phân khu vực', wardName: (r.ward_name as string) ?? '—',
      },
      state,
      capabilities: capabilitiesFor(h.fwProfile),
      schedule,
      thresholds: (thr[0]?.values as ReturnType<typeof defaultThresholds>) ?? defaultThresholds(),
    };
  }

  async diagnostics(scope: Scope, id: string) {
    id = await this.assertCabinet(scope, id);
    const { input } = await this.health(id);
    const st = await this.sql<{ ts: Date; data: { summary?: string } }[]>`
      SELECT ts, data FROM device_events WHERE cabinet_id = ${id} AND kind = 'selftest' ORDER BY ts DESC LIMIT 1`;
    const selfTest = st[0]?.data.summary ? { at: st[0].ts.toISOString(), summary: st[0].data.summary, ...decodeRs485SelfTest(st[0].data.summary) } : null;
    return { items: buildDiagnostics(input), lastBootAt: input.lastBootAt, bootsLast24h: input.bootsLast24h, selfTest };
  }

  /** Raw hypertable with time_bucket up to 7 days (~300 points), hourly aggregate beyond. */
  async telemetry(scope: Scope, id: string, metrics: string[], from: Date, to: Date): Promise<TelemetryPoint[]> {
    id = await this.assertCabinet(scope, id);
    const cols = metrics.filter((m) => METRIC[m]);
    if (!cols.length) return [];
    const rangeMs = to.getTime() - from.getTime();
    if (rangeMs <= 0) return [];
    const bucketSec = Math.max(60, Math.ceil(rangeMs / 1000 / 300));
    const useHourly = rangeMs > 7 * 86_400_000;
    const select = cols.map((m) => `avg(${METRIC[m]})::real AS "${m}"`).join(', ');
    const table = useHourly ? 'telemetry_1h' : 'telemetry';
    const tsCol = useHourly ? 'bucket' : 'ts';
    const rows = await this.sql.unsafe<Record<string, unknown>[]>(
      `SELECT time_bucket(make_interval(secs => $1), ${tsCol}) AS b, ${select}
       FROM ${table} WHERE cabinet_id = $2 AND ${tsCol} >= $3 AND ${tsCol} <= $4 GROUP BY b ORDER BY b`,
      [bucketSec, id, from, to],
    );
    return rows.map((r) => {
      const p: TelemetryPoint = { ts: (r.b as Date).toISOString() };
      for (const m of cols) p[m] = r[m] === null ? null : Math.round(Number(r[m]) * 100) / 100;
      return p;
    });
  }

  /** kWh estimate = average kW x hours, per hour (today) or per day (30 days), Asia/Ho_Chi_Minh. */
  async energy(scope: Scope, id: string, range: 'day' | '30d') {
    id = await this.assertCabinet(scope, id);
    const rows =
      range === 'day'
        ? await this.sql<{ b: Date; kwh: number | null }[]>`
            SELECT time_bucket('1 hour', ts, 'Asia/Ho_Chi_Minh') AS b, avg(p_total_kw)::real AS kwh
            FROM telemetry WHERE cabinet_id = ${id} AND ts >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'
            GROUP BY b ORDER BY b`
        : await this.sql<{ b: Date; kwh: number | null }[]>`
            SELECT time_bucket('1 day', ts, 'Asia/Ho_Chi_Minh') AS b, (avg(p_total_kw) * 24)::real AS kwh
            FROM telemetry WHERE cabinet_id = ${id} AND ts >= now() - interval '30 days' GROUP BY b ORDER BY b`;
    const fmt = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', ...(range === 'day' ? { hour: '2-digit', hour12: false } : { day: 'numeric', month: 'numeric' }) });
    return { estimated: true, points: rows.map((r) => ({ label: range === 'day' ? `${fmt.format(r.b)}h` : fmt.format(r.b), kwh: Math.round(Number(r.kwh ?? 0) * 10) / 10 })) };
  }

  async cabinetAlarms(scope: Scope, id: string, limit: number) {
    id = await this.assertCabinet(scope, id);
    return this.alarmRows(this.sql`WHERE a.cabinet_id = ${id}`, limit, 0);
  }

  alarmRows(where: PendingQuery<Row[]>, limit: number, offset: number) {
    return this.sql`
      SELECT a.id, a.code, a.cabinet_id AS "cabinetId", c.name AS "cabinetName", c.code AS "cabinetCode",
             coalesce(d.name, 'Chưa phân khu vực') AS "districtName", a.type, a.severity, a.message, a.value,
             a.started_at AS "startedAt", a.ended_at AS "endedAt", a.active, u.full_name AS "ackedBy", a.acked_at AS "ackedAt"
      FROM alarms a JOIN cabinets c ON c.id = a.cabinet_id LEFT JOIN areas d ON d.id = c.district_id LEFT JOIN users u ON u.id = a.acked_by
      ${where} ORDER BY a.started_at DESC LIMIT ${limit} OFFSET ${offset}`;
  }
}

const TelemetryQuery = z.object({
  metrics: z.string().default('vL1'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const PageQuery = z.object({ page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(200).default(20) });

@Controller()
export class CabinetsController {
  constructor(@Inject(CabinetsService) private readonly svc: CabinetsService) {}

  @Get('map/cabinets') mapCabinets(@Req() r: AuthedRequest) { return this.svc.mapCabinets(r.user!.scope); }
  @Get('map/stats') stats(@Req() r: AuthedRequest) { return this.svc.stats(r.user!.scope); }
  @Get('search') search(@Req() r: AuthedRequest, @Query('q') q = '') { return q.trim().length >= 2 ? this.svc.search(r.user!.scope, q.trim()) : []; }
  @Get('areas/tree') tree(@Req() r: AuthedRequest) { return this.svc.areaTree(r.user!.scope); }
  @Get('areas/:id/cabinets') areaCabinets(@Req() r: AuthedRequest, @Param('id') id: string) { return this.svc.areaCabinets(r.user!.scope, id); }

  @Get('cabinets/nearby')
  nearby(@Req() r: AuthedRequest, @Query() q: unknown) {
    const p = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), radius: z.coerce.number().min(10).max(20_000).default(2000) }).parse(q);
    return this.svc.nearby(r.user!.scope, p.lat, p.lng, p.radius);
  }

  @Get('cabinets')
  list(@Req() r: AuthedRequest, @Query() q: unknown) {
    const p = PageQuery.extend({ status: z.string().optional(), q: z.string().max(100).optional() }).parse(q);
    return this.svc.list(r.user!.scope, p.page, p.size, p.status || undefined, p.q || undefined);
  }

  @Get('cabinets/:id') detail(@Req() r: AuthedRequest, @Param('id') id: string) { return this.svc.detail(r.user!.scope, id); }
  @Get('cabinets/:id/diagnostics') diagnostics(@Req() r: AuthedRequest, @Param('id') id: string) { return this.svc.diagnostics(r.user!.scope, id); }

  @Get('cabinets/:id/telemetry')
  telemetry(@Req() r: AuthedRequest, @Param('id') id: string, @Query() q: unknown) {
    const p = TelemetryQuery.parse(q);
    const to = p.to ?? new Date();
    const from = p.from ?? new Date(to.getTime() - 6 * 3_600_000);
    return this.svc.telemetry(r.user!.scope, id, p.metrics.split(','), from, to);
  }

  @Get('cabinets/:id/energy')
  energy(@Req() r: AuthedRequest, @Param('id') id: string, @Query('range') range = 'day') {
    return this.svc.energy(r.user!.scope, id, range === '30d' ? '30d' : 'day');
  }

  @Get('cabinets/:id/alarms')
  alarms(@Req() r: AuthedRequest, @Param('id') id: string, @Query('limit') limit = '20') {
    return this.svc.cabinetAlarms(r.user!.scope, id, Math.min(100, Number(limit) || 20));
  }

  // Not built yet in M1: explicit answers so hybrid mode does not fall back to mock data for a real cabinet.
  @Get('cabinets/:id/lamps') async lamps(@Req() r: AuthedRequest, @Param('id') id: string) { await this.svc.assertCabinet(r.user!.scope, id); return []; }
}

@Module({ controllers: [CabinetsController], providers: [CabinetsService], exports: [CabinetsService] })
export class CabinetsModule {}
