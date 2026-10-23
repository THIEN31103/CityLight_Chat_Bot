// Telemetry exports (S55, after the 2026-10-21 demo). One cabinet = one workbook with a sheet per tab of the
// cabinet drawer (monitoring snapshot, voltage, current, power, leak / temperature, branch state, energy per day,
// alarms, commands). Several cabinets (zones and / or cabinet codes) = one long table, Excel or CSV for data work,
// plus a per-cabinet summary. Steps: every frame (raw, 90 days kept), 5 min, 1 h, 1 day; 1 h / 1 day read the
// telemetry_1h aggregate (kept for good) and the raw rows of the last hours it has not materialized yet.
// Temperature only for cabinets with a DS18B20 (S54). Times in Asia/Ho_Chi_Minh, texts in the user's language.
import { Controller, Get, Inject, Module, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { LABELS, alarmTypeLabels, defineDict, describeCommand, fill, type CommandType, type Lang } from '@citylight/shared';
import { z } from 'zod';
import { AuthModule, RequirePerm, type AuthedRequest, type SessionUser } from './auth';
import { CabinetsModule, CabinetsService } from './cabinets';
import { ApiError } from './errors';
import { SQL, type Sql } from './infra';
import { scopeWhere } from './scope';
import { DATE_TIME, addSheet, attachment, newWorkbook, sendWorkbook, vnTime, type XlsxColumn } from './xlsx';

export type Step = 'raw' | '5m' | '1h' | '1d';
const STEP_SEC: Record<Step, number> = { raw: 10, '5m': 300, '1h': 3600, '1d': 86_400 };
/** "auto" picks the finest step that stays under this many rows. */
const AUTO_ROWS = 50_000;
/** Hard limit per file (exceljs keeps the workbook in memory; the VPS has 3.8 GB). */
export const REPORT_MAX_ROWS = 100_000;
const MAX_RANGE_DAYS = 400;
const MAX_CABINETS = 2_000;

/** Rows a range would give (raw = one frame every 10 s). */
export function estimateRows(cabinets: number, from: Date, to: Date, step: Step) {
  return cabinets * Math.ceil((to.getTime() - from.getTime()) / 1000 / STEP_SEC[step]);
}

export function pickStep(cabinets: number, from: Date, to: Date, wanted: Step | 'auto'): Step {
  if (wanted !== 'auto') return wanted;
  return (['raw', '5m', '1h', '1d'] as const).find((s) => estimateRows(cabinets, from, to, s) <= AUTO_ROWS) ?? '1d';
}

const Range = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  step: z.enum(['auto', 'raw', '5m', '1h', '1d']).default('auto'),
});
const ReportQuery = Range.extend({
  zoneIds: z.string().max(4000).optional(),
  /** cabinet codes, comma / space / newline separated; "TM01.*" = every code starting with TM01. */
  codes: z.string().max(20_000).optional(),
});

interface SeriesRow {
  cabinet_id: string;
  t: Date;
  v1: number | null; v2: number | null; v3: number | null;
  i1: number | null; i2: number | null; i3: number | null;
  p: number | null; pf: number | null; leak: number | null; temp: number | null;
  b1: boolean | null; b2: boolean | null; man: boolean | null;
  /** kWh in the bucket (estimate = average kW x bucket length) */
  kwh: number | null;
  samples: number;
}

const TEXT = defineDict(
  {
    file: 'du-lieu-tu', reportFile: 'bao-cao-tu',
    sheet: {
      monitor: 'Giám sát', voltage: 'Điện áp', current: 'Dòng điện', power: 'Công suất', leakTemp: 'Rò điện - nhiệt độ', state: 'Trạng thái nhánh',
      energy: 'Điện năng theo ngày', alarms: 'Cảnh báo', commands: 'Lệnh', data: 'Dữ liệu', summary: 'Tổng hợp', info: 'Thông tin',
    },
    col: {
      time: 'Thời gian', day: 'Ngày', item: 'Mục', value: 'Giá trị', unit: 'Đơn vị', cabinetCode: 'Mã tủ', cabinetName: 'Tên tủ', zone: 'Vùng',
      p: 'Công suất (kW)', pf: 'cosφ', kwh: 'Điện năng ước lượng (kWh)', leak: 'Dòng rò (mA)', temp: 'Nhiệt độ (°C)', b1: 'Nhánh 1 sáng', b2: 'Nhánh 2 sáng',
      man: 'Thủ công', samples: 'Số mẫu', vMin: 'U thấp nhất (V)', vAvg: 'U trung bình (V)', vMax: 'U cao nhất (V)', iMax: 'I cao nhất (A)',
      pAvg: 'P trung bình (kW)', leakMax: 'Dòng rò cao nhất (mA)', tempMax: 'Nhiệt độ cao nhất (°C)', alarms: 'Số cảnh báo trong kỳ',
      code: 'Mã lỗi', type: 'Loại', severity: 'Mức độ', message: 'Nội dung', start: 'Bắt đầu', end: 'Kết thúc',
      command: 'Lệnh', status: 'Trạng thái', by: 'Người gửi', queued: 'Lúc gửi', acked: 'Tủ ack', confirmed: 'Xác nhận', error: 'Lỗi',
    },
    info: {
      range: 'Khoảng thời gian', step: 'Bước', steps: { raw: 'Từng frame (~10 s)', '5m': '5 phút', '1h': '1 giờ', '1d': '1 ngày' } as Record<Step, string>,
      exportedAt: 'Lúc xuất', by: 'Người xuất', cabinets: 'Số tủ', estimated: 'Điện năng là ước lượng (công suất trung bình × thời gian), chưa phải chỉ số công tơ.',
      noTemp: 'Không lắp cảm biến nhiệt (S54)', system: 'Hệ thống',
    },
    snapshot: {
      status: 'Trạng thái', online: 'Kết nối', lastSeen: 'Frame cuối', yes: 'Có', no: 'Không', on: 'Sáng', off: 'Tắt', branch1: 'Nhánh 1', branch2: 'Nhánh 2',
      manual: 'Chế độ thủ công', plc: 'PLC_KEY trả lời', pm: 'PM_KEY trả lời', voltage: 'Điện áp', current: 'Dòng điện', pTotal: 'Công suất tổng', pf: 'cosφ tổng',
      leak: 'Dòng rò', temp: 'Nhiệt độ tủ', battery: 'Pin', gps: 'GPS thiết bị', deviceTime: 'Giờ LOGO (PTIM)', alarms: 'Cảnh báo đang mở',
    },
    tooMany: 'Quá nhiều dòng ({rows} > {max}): chọn bước lớn hơn hoặc khoảng ngắn hơn',
    noCabinet: 'Không có tủ nào khớp vùng / mã đã chọn trong khu vực của bạn',
    tooManyCabinets: 'Quá {max} tủ: chọn ít vùng / mã hơn',
    badRange: 'Khoảng thời gian không hợp lệ (tối đa {days} ngày)',
  },
  {
    file: 'cabinet-data', reportFile: 'cabinet-report',
    sheet: {
      monitor: 'Monitoring', voltage: 'Voltage', current: 'Current', power: 'Power', leakTemp: 'Leak - temperature', state: 'Branch state',
      energy: 'Energy per day', alarms: 'Alarms', commands: 'Commands', data: 'Data', summary: 'Summary', info: 'Info',
    },
    col: {
      time: 'Time', day: 'Day', item: 'Item', value: 'Value', unit: 'Unit', cabinetCode: 'Cabinet code', cabinetName: 'Cabinet name', zone: 'Zone',
      p: 'Power (kW)', pf: 'cosφ', kwh: 'Estimated energy (kWh)', leak: 'Leakage (mA)', temp: 'Temperature (°C)', b1: 'Branch 1 lit', b2: 'Branch 2 lit',
      man: 'Manual', samples: 'Samples', vMin: 'Lowest U (V)', vAvg: 'Average U (V)', vMax: 'Highest U (V)', iMax: 'Highest I (A)',
      pAvg: 'Average P (kW)', leakMax: 'Highest leakage (mA)', tempMax: 'Highest temperature (°C)', alarms: 'Alarms in the period',
      code: 'Error code', type: 'Type', severity: 'Severity', message: 'Message', start: 'Started', end: 'Ended',
      command: 'Command', status: 'Status', by: 'Sent by', queued: 'Sent at', acked: 'Cabinet ack', confirmed: 'Confirmed', error: 'Error',
    },
    info: {
      range: 'Period', step: 'Step', steps: { raw: 'Every frame (~10 s)', '5m': '5 minutes', '1h': '1 hour', '1d': '1 day' } as Record<Step, string>,
      exportedAt: 'Exported at', by: 'Exported by', cabinets: 'Cabinets', estimated: 'Energy is an estimate (average power × time), not a meter reading.',
      noTemp: 'No temperature sensor fitted (S54)', system: 'System',
    },
    snapshot: {
      status: 'Status', online: 'Connection', lastSeen: 'Last frame', yes: 'Yes', no: 'No', on: 'On', off: 'Off', branch1: 'Branch 1', branch2: 'Branch 2',
      manual: 'Manual mode', plc: 'PLC_KEY answers', pm: 'PM_KEY answers', voltage: 'Voltage', current: 'Current', pTotal: 'Total power', pf: 'Total cosφ',
      leak: 'Leakage', temp: 'Cabinet temperature', battery: 'Battery', gps: 'Device GPS', deviceTime: 'LOGO time (PTIM)', alarms: 'Open alarms',
    },
    tooMany: 'Too many rows ({rows} > {max}): pick a larger step or a shorter period',
    noCabinet: 'No cabinet in your areas matches the selected zones / codes',
    tooManyCabinets: 'More than {max} cabinets: pick fewer zones / codes',
    badRange: 'Invalid period (at most {days} days)',
  },
);

const r2 = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
const day = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

@Controller()
export class ReportsController {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(CabinetsService) private readonly cabinets: CabinetsService,
  ) {}

  private range(q: unknown, lang: Lang) {
    const p = Range.parse(q);
    const days = (p.to.getTime() - p.from.getTime()) / 86_400_000;
    if (!(days > 0) || days > MAX_RANGE_DAYS) throw new ApiError(422, 'invalid_range', fill(TEXT[lang].badRange, { days: MAX_RANGE_DAYS }));
    return p;
  }

  private checkRows(rows: number, lang: Lang) {
    if (rows > REPORT_MAX_ROWS) throw new ApiError(422, 'too_many_rows', fill(TEXT[lang].tooMany, { rows, max: REPORT_MAX_ROWS }), { rows, max: REPORT_MAX_ROWS });
  }

  /** Time series of these cabinets, one row per cabinet and bucket, ordered by cabinet then time. */
  private async series(ids: string[], from: Date, to: Date, step: Step): Promise<SeriesRow[]> {
    const sql = this.sql;
    if (step === 'raw') {
      return sql<SeriesRow[]>`
        SELECT cabinet_id, ts AS t, v_l1 AS v1, v_l2 AS v2, v_l3 AS v3, i_l1 AS i1, i_l2 AS i2, i_l3 AS i3, p_total_kw AS p, pf_total AS pf,
               leak_ma AS leak, temp_c AS temp, branch1_on AS b1, branch2_on AS b2, manual_mode AS man, NULL::real AS kwh, 1 AS samples
        FROM telemetry WHERE cabinet_id = ANY(${ids}::uuid[]) AND ts >= ${from} AND ts < ${to}
        ORDER BY cabinet_id, ts LIMIT ${REPORT_MAX_ROWS + 1}`;
    }
    if (step === '5m') {
      return sql<SeriesRow[]>`
        SELECT cabinet_id, time_bucket('5 minutes', ts) AS t, avg(v_l1)::real AS v1, avg(v_l2)::real AS v2, avg(v_l3)::real AS v3,
               avg(i_l1)::real AS i1, avg(i_l2)::real AS i2, avg(i_l3)::real AS i3, avg(p_total_kw)::real AS p, avg(pf_total)::real AS pf,
               max(leak_ma)::real AS leak, avg(temp_c)::real AS temp, bool_or(branch1_on) AS b1, bool_or(branch2_on) AS b2, bool_or(manual_mode) AS man,
               (avg(p_total_kw) / 12)::real AS kwh, count(*)::int AS samples
        FROM telemetry WHERE cabinet_id = ANY(${ids}::uuid[]) AND ts >= ${from} AND ts < ${to}
        GROUP BY 1, 2 ORDER BY 1, 2`;
    }
    // telemetry_1h is materialized up to ~1 h ago (policy end_offset): older hours from it, the rest from raw rows
    const cut = new Date(Math.floor((Date.now() - 2 * 3_600_000) / 3_600_000) * 3_600_000);
    const hourly = sql`
      SELECT cabinet_id, bucket AS t, v_l1 AS v1, v_l2 AS v2, v_l3 AS v3, i_l1 AS i1, i_l2 AS i2, i_l3 AS i3, p_total_kw AS p, pf_total AS pf,
             leak_ma_max AS leak, temp_c AS temp, kwh_estimate AS kwh, samples
      FROM telemetry_1h WHERE cabinet_id = ANY(${ids}::uuid[]) AND bucket >= ${from} AND bucket < ${to} AND bucket < ${cut}
      UNION ALL
      SELECT cabinet_id, time_bucket('1 hour', ts), avg(v_l1), avg(v_l2), avg(v_l3), avg(i_l1), avg(i_l2), avg(i_l3), avg(p_total_kw), avg(pf_total),
             max(leak_ma), avg(temp_c), avg(p_total_kw), count(*)
      FROM telemetry WHERE cabinet_id = ANY(${ids}::uuid[]) AND ts >= ${from > cut ? from : cut} AND ts < ${to}
      GROUP BY 1, 2`;
    if (step === '1h') {
      return sql<SeriesRow[]>`
        SELECT cabinet_id, t, v1::real, v2::real, v3::real, i1::real, i2::real, i3::real, p::real, pf::real, leak::real, temp::real,
               NULL::boolean AS b1, NULL::boolean AS b2, NULL::boolean AS man, kwh::real, samples::int
        FROM (${hourly}) h ORDER BY 1, 2`;
    }
    return sql<SeriesRow[]>`
      SELECT cabinet_id, time_bucket('1 day', t, 'Asia/Ho_Chi_Minh') AS t, avg(v1)::real AS v1, avg(v2)::real AS v2, avg(v3)::real AS v3,
             avg(i1)::real AS i1, avg(i2)::real AS i2, avg(i3)::real AS i3, avg(p)::real AS p, avg(pf)::real AS pf, max(leak)::real AS leak,
             avg(temp)::real AS temp, NULL::boolean AS b1, NULL::boolean AS b2, NULL::boolean AS man, sum(kwh)::real AS kwh, sum(samples)::int AS samples
      FROM (${hourly}) h GROUP BY 1, 2 ORDER BY 1, 2`;
  }

  private async log(u: SessionUser, target: { type: string; id: string | null; name: string }, value: string, ip?: string) {
    await this.sql`INSERT INTO activity_logs (user_id, user_email, action, target_type, target_id, target_name, new_value, ip)
                   VALUES (${u.id}, ${u.email}, 'Xuất dữ liệu', ${target.type}, ${target.id}, ${target.name}, ${value}, ${ip ?? null})`;
  }

  /** One cabinet: a sheet per drawer tab. */
  @Get('cabinets/:id/export.xlsx')
  @RequirePerm('map.view')
  async cabinet(@Param('id') id: string, @Query() q: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const u = req.user!;
    const lang = u.lang;
    const T = TEXT[lang];
    const p = this.range(q, lang);
    const detail = await this.cabinets.detail(u.scope, id);
    const cid = detail.cabinet.id;
    const step = pickStep(1, p.from, p.to, p.step);
    this.checkRows(estimateRows(1, p.from, p.to, step), lang);
    const rows = await this.series([cid], p.from, p.to, step);
    this.checkRows(rows.length, lang);
    const fitted = !!detail.cabinet.hasTempSensor;
    const C = T.col;
    const S = T.snapshot;
    const s = detail.state;
    const yn = (v: boolean | null) => (v === null ? null : v ? S.yes : S.no);
    const lit = (v: boolean | null) => (v === null ? null : v ? S.on : S.off);
    const time: XlsxColumn<SeriesRow> = { header: C.time, value: (r) => vnTime(r.t), numFmt: step === '1d' ? 'dd/mm/yyyy' : DATE_TIME, width: 18 };
    const num = (header: string, f: (r: SeriesRow) => number | null, width = 14): XlsxColumn<SeriesRow> => ({ header, value: (r) => r2(f(r)), width });

    const wb = newWorkbook();
    type Kv = { item: string; value: string | number | null; unit: string };
    const snapshot: Kv[] = [
      { item: S.status, value: LABELS[lang].status[s.status] ?? s.status, unit: '' },
      { item: S.online, value: yn(s.online), unit: '' },
      { item: S.lastSeen, value: s.lastSeenAt ? vnTime(s.lastSeenAt)!.toISOString().replace('T', ' ').slice(0, 19) : null, unit: '' },
      { item: S.branch1, value: lit(s.branch1On), unit: '' },
      { item: S.branch2, value: lit(s.branch2On), unit: '' },
      { item: S.manual, value: yn(s.manualMode), unit: '' },
      { item: S.plc, value: yn(s.plcOnline), unit: '' },
      { item: S.pm, value: yn(s.pmOnline), unit: '' },
      { item: `${S.voltage} L1-N`, value: r2(s.vL1), unit: 'V' },
      { item: `${S.voltage} L2-N`, value: r2(s.vL2), unit: 'V' },
      { item: `${S.voltage} L3-N`, value: r2(s.vL3), unit: 'V' },
      { item: `${S.current} I1`, value: r2(s.iL1), unit: 'A' },
      { item: `${S.current} I2`, value: r2(s.iL2), unit: 'A' },
      { item: `${S.current} I3`, value: r2(s.iL3), unit: 'A' },
      { item: S.pTotal, value: r2(s.pTotalKw), unit: 'kW' },
      { item: S.pf, value: r2(s.pfTotal), unit: '' },
      { item: S.leak, value: r2(s.leakMa), unit: 'mA' },
      { item: S.temp, value: fitted ? r2(s.tempC) : T.info.noTemp, unit: fitted ? '°C' : '' },
      { item: S.battery, value: s.batteryMv, unit: 'mV' },
      { item: S.gps, value: s.gpsDevice ? `${s.gpsDevice.lat.toFixed(6)}, ${s.gpsDevice.lng.toFixed(6)}` : null, unit: '' },
      { item: S.deviceTime, value: s.deviceTime ? vnTime(s.deviceTime)!.toISOString().replace('T', ' ').slice(0, 16) : null, unit: '' },
      { item: S.alarms, value: s.activeAlarmCount, unit: '' },
      { item: T.info.range, value: `${day(p.from)} → ${day(p.to)}`, unit: '' },
      { item: T.info.step, value: T.info.steps[step], unit: '' },
      { item: T.info.exportedAt, value: vnTime(new Date())!.toISOString().replace('T', ' ').slice(0, 16), unit: '' },
      { item: T.info.by, value: u.email, unit: '' },
    ];
    addSheet<Kv>(wb, T.sheet.monitor, [
      { header: C.item, value: (r) => r.item, width: 26 },
      { header: C.value, value: (r) => r.value, width: 26 },
      { header: C.unit, value: (r) => r.unit, width: 8 },
    ], snapshot);
    addSheet(wb, T.sheet.voltage, [time, num('L1-N (V)', (r) => r.v1), num('L2-N (V)', (r) => r.v2), num('L3-N (V)', (r) => r.v3)], rows);
    addSheet(wb, T.sheet.current, [time, num('I1 (A)', (r) => r.i1), num('I2 (A)', (r) => r.i2), num('I3 (A)', (r) => r.i3)], rows);
    addSheet(wb, T.sheet.power, [time, num(C.p, (r) => r.p), num(C.pf, (r) => r.pf), ...(step === 'raw' ? [] : [num(C.kwh, (r) => r.kwh, 22)])], rows);
    addSheet(wb, T.sheet.leakTemp, [time, num(C.leak, (r) => r.leak), ...(fitted ? [num(C.temp, (r) => r.temp)] : [])], rows);
    if (step === 'raw' || step === '5m') {
      addSheet(wb, T.sheet.state, [
        time,
        { header: C.b1, value: (r) => lit(r.b1), width: 12 },
        { header: C.b2, value: (r) => lit(r.b2), width: 12 },
        { header: C.man, value: (r) => yn(r.man), width: 10 },
      ], rows);
    }
    // energy per Vietnamese day, from hourly buckets whatever the step
    const daily = new Map<string, number>();
    for (const r of step === '1h' || step === '1d' ? rows : await this.series([cid], p.from, p.to, '1h')) {
      const d = day(r.t);
      daily.set(d, (daily.get(d) ?? 0) + Number(r.kwh ?? 0));
    }
    const energy = addSheet<[string, number]>(wb, T.sheet.energy, [
      { header: C.day, value: (r) => r[0], width: 12 },
      { header: C.kwh, value: (r) => Math.round(r[1] * 10) / 10, width: 24 },
    ], [...daily.entries()]);
    energy.getCell('D1').value = T.info.estimated;

    const types = alarmTypeLabels(lang);
    const alarms = await this.sql<{ code: string; type: string; severity: string; message: string; started_at: Date; ended_at: Date | null }[]>`
      SELECT code, type, severity, message, started_at, ended_at FROM alarms
      WHERE cabinet_id = ${cid} AND started_at < ${p.to} AND (ended_at IS NULL OR ended_at >= ${p.from}) ORDER BY started_at LIMIT ${REPORT_MAX_ROWS}`;
    addSheet(wb, T.sheet.alarms, [
      { header: C.code, value: (a) => a.code, width: 8 },
      { header: C.type, value: (a) => types[a.type as keyof typeof types] ?? a.type, width: 26 },
      { header: C.severity, value: (a) => LABELS[lang].severity[a.severity as 'critical' | 'major' | 'minor'] ?? a.severity, width: 12 },
      { header: C.message, value: (a) => a.message, width: 50 },
      { header: C.start, value: (a) => vnTime(a.started_at), numFmt: DATE_TIME, width: 18 },
      { header: C.end, value: (a) => vnTime(a.ended_at), numFmt: DATE_TIME, width: 18 },
    ], alarms);

    const cmds = await this.sql<{ type: CommandType; params: Record<string, unknown>; status: string; by: string | null; queued_at: Date; acked_at: Date | null; confirmed_at: Date | null; error: string | null }[]>`
      SELECT m.type, m.params, m.status, u.full_name AS by, m.queued_at, m.acked_at, m.confirmed_at, m.error
      FROM commands m LEFT JOIN users u ON u.id = m.requested_by
      WHERE m.cabinet_id = ${cid} AND m.queued_at >= ${p.from} AND m.queued_at < ${p.to} ORDER BY m.queued_at LIMIT ${REPORT_MAX_ROWS}`;
    addSheet(wb, T.sheet.commands, [
      { header: C.command, value: (m) => describeCommand(m.type, m.params, lang), width: 36 },
      { header: C.status, value: (m) => LABELS[lang].commandStatus[m.status as keyof (typeof LABELS)['vi']['commandStatus']] ?? m.status, width: 18 },
      { header: C.by, value: (m) => m.by ?? T.info.system, width: 22 },
      { header: C.queued, value: (m) => vnTime(m.queued_at), numFmt: DATE_TIME, width: 18 },
      { header: C.acked, value: (m) => vnTime(m.acked_at), numFmt: DATE_TIME, width: 18 },
      { header: C.confirmed, value: (m) => vnTime(m.confirmed_at), numFmt: DATE_TIME, width: 18 },
      { header: C.error, value: (m) => m.error, width: 40 },
    ], cmds);

    await this.log(u, { type: 'cabinet', id: cid, name: `${detail.cabinet.code} - ${detail.cabinet.name}` }, `${day(p.from)} → ${day(p.to)}, ${step}, ${rows.length} dòng`, req.ip);
    return sendWorkbook(reply, `${T.file}-${detail.cabinet.code}-${day(p.from)}_${day(p.to)}.xlsx`, wb);
  }

  /** Cabinets in these zones and / or with these codes, inside the user's areas. */
  private async pick(u: SessionUser, zoneIds: string[], codes: string[]) {
    const exact = codes.filter((c) => !c.endsWith('*'));
    const prefixes = codes.filter((c) => c.endsWith('*')).map((c) => `${c.slice(0, -1).replace(/[\\%_]/g, '\\$&')}%`);
    if (!zoneIds.length && !codes.length) return [];
    return this.sql<{ id: string; code: string; name: string; zone: string | null; has_temp_sensor: boolean }[]>`
      SELECT c.id, c.code, c.name, z.name AS zone, c.has_temp_sensor FROM cabinets c LEFT JOIN zones z ON z.id = c.zone1_id
      WHERE ${scopeWhere(this.sql, u.scope)} AND (
        (c.zone1_id = ANY(${zoneIds}::uuid[]) OR c.zone2_id = ANY(${zoneIds}::uuid[]))
        OR upper(c.code) = ANY(${exact.map((c) => c.toUpperCase())}::text[])
        OR upper(c.code) LIKE ANY(${prefixes.map((c) => c.toUpperCase())}::text[]))
      ORDER BY c.code LIMIT ${MAX_CABINETS + 1}`;
  }

  /** Several cabinets: long table + per-cabinet summary (xlsx), or the long table alone (csv). */
  @Get('reports/telemetry.xlsx')
  @RequirePerm('map.view')
  reportXlsx(@Query() q: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.report('xlsx', q, req, reply);
  }

  @Get('reports/telemetry.csv')
  @RequirePerm('map.view')
  reportCsv(@Query() q: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.report('csv', q, req, reply);
  }

  private async report(fmt: 'xlsx' | 'csv', q: unknown, req: AuthedRequest, reply: FastifyReply) {
    const u = req.user!;
    const lang = u.lang;
    const T = TEXT[lang];
    const C = T.col;
    const p = ReportQuery.parse(q);
    this.range(p, lang);
    const uuidRe = /^[0-9a-f-]{36}$/i;
    const zoneIds = (p.zoneIds ?? '').split(',').map((s) => s.trim()).filter((s) => uuidRe.test(s));
    const codes = (p.codes ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_CABINETS);
    const cabs = await this.pick(u, zoneIds, codes);
    if (!cabs.length) throw new ApiError(422, 'no_cabinet', T.noCabinet);
    if (cabs.length > MAX_CABINETS) throw new ApiError(422, 'too_many_cabinets', fill(T.tooManyCabinets, { max: MAX_CABINETS }), { max: MAX_CABINETS });
    const step = pickStep(cabs.length, p.from, p.to, p.step);
    this.checkRows(estimateRows(cabs.length, p.from, p.to, step), lang);
    const rows = await this.series(cabs.map((c) => c.id), p.from, p.to, step);
    this.checkRows(rows.length, lang);
    const byId = new Map(cabs.map((c) => [c.id, c]));
    const anyTemp = cabs.some((c) => c.has_temp_sensor);
    const cab = (r: SeriesRow) => byId.get(r.cabinet_id)!;
    const lit = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
    const cols: XlsxColumn<SeriesRow>[] = [
      { header: C.cabinetCode, value: (r) => cab(r).code, width: 14 },
      { header: C.cabinetName, value: (r) => cab(r).name, width: 26 },
      { header: C.time, value: (r) => vnTime(r.t), numFmt: step === '1d' ? 'dd/mm/yyyy' : DATE_TIME, width: 18 },
      { header: 'L1-N (V)', value: (r) => r2(r.v1) }, { header: 'L2-N (V)', value: (r) => r2(r.v2) }, { header: 'L3-N (V)', value: (r) => r2(r.v3) },
      { header: 'I1 (A)', value: (r) => r2(r.i1) }, { header: 'I2 (A)', value: (r) => r2(r.i2) }, { header: 'I3 (A)', value: (r) => r2(r.i3) },
      { header: C.p, value: (r) => r2(r.p) }, { header: C.pf, value: (r) => r2(r.pf) },
      ...(step === 'raw' ? [] : [{ header: C.kwh, value: (r: SeriesRow) => r2(r.kwh), width: 22 }]),
      { header: C.leak, value: (r) => r2(r.leak) },
      ...(anyTemp ? [{ header: C.temp, value: (r: SeriesRow) => (cab(r).has_temp_sensor ? r2(r.temp) : null) }] : []),
      ...(step === 'raw' || step === '5m'
        ? [{ header: C.b1, value: (r: SeriesRow) => lit(r.b1) }, { header: C.b2, value: (r: SeriesRow) => lit(r.b2) }, { header: C.man, value: (r: SeriesRow) => lit(r.man) }]
        : []),
      { header: C.samples, value: (r) => r.samples, width: 10 },
    ];
    const what = `${cabs.length} tủ, ${day(p.from)} → ${day(p.to)}, ${step}, ${rows.length} dòng, ${fmt}`;
    await this.log(u, { type: 'report', id: null, name: zoneIds.length ? `${zoneIds.length} vùng` : `${codes.length} mã tủ` }, what, req.ip);
    const file = `${T.reportFile}-${day(p.from)}_${day(p.to)}`;

    if (fmt === 'csv') {
      // UTF-8 BOM so Excel opens the Vietnamese text correctly; ISO local time (+07:00) for data tools
      const esc = (v: unknown) => {
        if (v === null || v === undefined) return '';
        const s = v instanceof Date ? `${v.toISOString().slice(0, 19)}+07:00` : String(v);
        return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [cols.map((c) => esc(c.header)).join(',')];
      for (const r of rows) lines.push(cols.map((c) => esc(c.value(r))).join(','));
      attachment(reply, `${file}.csv`, 'text/csv; charset=utf-8');
      return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
    }

    const wb = newWorkbook();
    type Sum = { code: string; name: string; zone: string | null; n: number; vMin: number | null; vAvg: number | null; vMax: number | null; iMax: number | null; pAvg: number | null; kwh: number | null; leakMax: number | null; tempMax: number | null; alarms: number; temp: boolean };
    const sums = new Map<string, Sum & { vSum: number; vN: number; pSum: number; pN: number }>();
    for (const c of cabs) sums.set(c.id, { code: c.code, name: c.name, zone: c.zone, n: 0, vMin: null, vAvg: null, vMax: null, iMax: null, pAvg: null, kwh: step === 'raw' ? null : 0, leakMax: null, tempMax: null, alarms: 0, temp: c.has_temp_sensor, vSum: 0, vN: 0, pSum: 0, pN: 0 });
    const mx = (a: number | null, b: number | null) => (b === null ? a : a === null ? b : Math.max(a, b));
    const mn = (a: number | null, b: number | null) => (b === null ? a : a === null ? b : Math.min(a, b));
    for (const r of rows) {
      const s = sums.get(r.cabinet_id)!;
      s.n += r.samples;
      for (const v of [r.v1, r.v2, r.v3]) if (v !== null && v > 0) { s.vMin = mn(s.vMin, Number(v)); s.vMax = mx(s.vMax, Number(v)); s.vSum += Number(v); s.vN++; }
      for (const i of [r.i1, r.i2, r.i3]) s.iMax = mx(s.iMax, i === null ? null : Number(i));
      if (r.p !== null) { s.pSum += Number(r.p); s.pN++; }
      if (s.kwh !== null) s.kwh += Number(r.kwh ?? 0);
      s.leakMax = mx(s.leakMax, r.leak === null ? null : Number(r.leak));
      if (s.temp) s.tempMax = mx(s.tempMax, r.temp === null ? null : Number(r.temp));
    }
    const counts = await this.sql<{ cabinet_id: string; n: number }[]>`
      SELECT cabinet_id, count(*)::int AS n FROM alarms WHERE cabinet_id = ANY(${cabs.map((c) => c.id)}::uuid[])
        AND started_at < ${p.to} AND (ended_at IS NULL OR ended_at >= ${p.from}) GROUP BY 1`;
    for (const c of counts) sums.get(c.cabinet_id)!.alarms = c.n;
    const summary = [...sums.values()].map((s) => ({ ...s, vAvg: s.vN ? s.vSum / s.vN : null, pAvg: s.pN ? s.pSum / s.pN : null }));
    addSheet(wb, T.sheet.summary, [
      { header: C.cabinetCode, value: (s) => s.code, width: 14 },
      { header: C.cabinetName, value: (s) => s.name, width: 26 },
      { header: C.zone, value: (s) => s.zone, width: 18 },
      { header: C.samples, value: (s) => s.n, width: 10 },
      { header: C.vMin, value: (s) => r2(s.vMin) }, { header: C.vAvg, value: (s) => r2(s.vAvg) }, { header: C.vMax, value: (s) => r2(s.vMax) },
      { header: C.iMax, value: (s) => r2(s.iMax) }, { header: C.pAvg, value: (s) => r2(s.pAvg) },
      { header: C.kwh, value: (s) => (s.kwh === null ? null : Math.round(s.kwh * 10) / 10), width: 22 },
      { header: C.leakMax, value: (s) => r2(s.leakMax), width: 20 },
      ...(anyTemp ? [{ header: C.tempMax, value: (s: Sum) => (s.temp ? r2(s.tempMax) : null), width: 22 }] : []),
      { header: C.alarms, value: (s) => s.alarms, width: 20 },
    ], summary);
    addSheet(wb, T.sheet.data, cols, rows);
    type Kv = { item: string; value: string | number };
    addSheet<Kv>(wb, T.sheet.info, [{ header: C.item, value: (r) => r.item, width: 22 }, { header: C.value, value: (r) => r.value, width: 60 }], [
      { item: T.info.range, value: `${day(p.from)} → ${day(p.to)}` },
      { item: T.info.step, value: T.info.steps[step] },
      { item: T.info.cabinets, value: cabs.length },
      { item: T.info.exportedAt, value: vnTime(new Date())!.toISOString().replace('T', ' ').slice(0, 16) },
      { item: T.info.by, value: u.email },
      { item: C.kwh, value: T.info.estimated },
    ]);
    return sendWorkbook(reply, `${file}.xlsx`, wb);
  }
}

@Module({ imports: [CabinetsModule, AuthModule], controllers: [ReportsController] })
export class ReportsModule {}
