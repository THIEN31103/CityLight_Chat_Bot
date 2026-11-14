// Read tools (spec 5.2): they run at once, only GET the API as the signed-in user, and return short, model-friendly
// shapes (Vietnamese labels, Vietnam time). This file must never call a command endpoint (spec 6.10, test/static.test.ts).
import type { Alarm, CabinetStatus, CabinetSummary, Command, DiagnosticItem } from '@citylight/shared';
import { z } from 'zod';
import { ApiProblem } from '../api/client';
import { TELEMETRY_METRICS, type AreaNode } from '../api/read';
import { cabinetSearchTerms, fold } from './names';
import type { Focus, ToolContext, ToolDef } from './registry';

const STATUS_VI: Record<CabinetStatus, string> = {
  on: 'đang sáng', off: 'đang tắt', fault: 'có lỗi', offline: 'mất kết nối', dimming: 'tiết giảm', unknown: 'chưa rõ',
};
const SEVERITY_VI = { critical: 'nghiêm trọng', major: 'quan trọng', minor: 'nhẹ' } as const;
const COMMAND_STATUS_VI: Record<string, string> = {
  queued: 'đang chờ gửi', sent: 'đã gửi', acked: 'tủ đã nhận, chờ xác nhận đèn', confirmed: 'đã xác nhận (đèn đã đổi)',
  acked_unconfirmed: 'tủ nhận lệnh nhưng chưa thấy đèn đổi', failed: 'thất bại', timeout: 'quá giờ không phản hồi', cancelled: 'đã hủy',
};

const vnFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false });
/** "17:05 10/11" in Vietnam time; null stays null */
export const vnTime = (iso: string | null | undefined) => (iso ? vnFmt.format(new Date(iso)) : null);

const ref = z.string().trim().max(120).default('');
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const CABINET_PROP = { type: 'string', description: 'Cabinet code (e.g. DM0010), name, or the words the user said ("tủ demo số mười"). "tủ đó" or empty = the cabinet in focus' };

type Resolved =
  | { kind: 'one'; cabinet: CabinetSummary }
  | { kind: 'many'; choices: CabinetSummary[] }
  | { kind: 'none'; tried: string[] };

const REFERS_BACK = /^(|tu (do|nay|kia|vua roi|vua noi)|(do|nay|no)|cai do)$/;

/** "tủ đó" -> the cabinet in focus; otherwise every search term until one gives results. Never picks among several. */
export async function resolveCabinet(ctx: ToolContext, raw: string): Promise<Resolved> {
  const f = fold(raw);
  if (REFERS_BACK.test(f) && ctx.focus.cabinet) {
    const c = ctx.focus.cabinet;
    return { kind: 'one', cabinet: { id: c.id, code: c.code, name: c.name } as CabinetSummary };
  }
  const tried = cabinetSearchTerms(raw);
  for (const term of tried) {
    const found = await ctx.reads.search(term, { signal: ctx.signal });
    if (!found.length) continue;
    const exact = found.filter((c) => c.code.toUpperCase() === term.toUpperCase() || fold(c.name) === fold(term));
    if (exact.length === 1) return { kind: 'one', cabinet: exact[0]! };
    if (found.length === 1) return { kind: 'one', cabinet: found[0]! };
    return { kind: 'many', choices: found.slice(0, 5) };
  }
  return { kind: 'none', tried };
}

function notResolved(r: Exclude<Resolved, { kind: 'one' }>) {
  return r.kind === 'many'
    ? { error: 'ambiguous', message: 'Có nhiều tủ khớp, hãy hỏi lại người dùng muốn tủ nào', choices: r.choices.map(brief) }
    : { error: 'not_found', message: 'Không thấy tủ nào khớp trong phạm vi của bạn', tried: r.tried };
}

function setFocus(focus: Focus, c: { id: string; code: string; name: string }) {
  focus.cabinet = { id: c.id, code: c.code, name: c.name };
}

const brief = (c: CabinetSummary) => ({ code: c.code, name: c.name, status: STATUS_VI[c.status] ?? c.status });

const alarmBrief = (a: Alarm) => ({
  code: a.code, severity: SEVERITY_VI[a.severity], cabinet: a.cabinetCode, cabinetName: a.cabinetName, district: a.districtName,
  message: a.message, since: vnTime(a.startedAt), acked: !!a.ackedAt,
});

// ---------------------------------------------------------------- tools

const getSystemOverview: ToolDef<Record<string, never>> = {
  name: 'get_system_overview',
  kind: 'read',
  description: 'System overview: how many cabinets are online / offline / on / off / faulty, open alarms by severity, overdue incidents. Use for "hệ thống thế nào", "tình hình chung", "báo cáo tình hình".',
  schema: obj({}),
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>, z.ZodTypeDef, unknown>,
  async run(ctx) {
    const [stats, alarms] = await Promise.all([
      ctx.reads.mapStats({ signal: ctx.signal }),
      ctx.reads.alarms({ active: true, size: 100 }, { signal: ctx.signal }).catch((e) => (e instanceof ApiProblem && e.status === 403 ? null : Promise.reject(e))),
    ]);
    const c = stats.cabinets;
    const bySeverity = { critical: 0, major: 0, minor: 0 };
    for (const a of alarms?.items ?? []) bySeverity[a.severity]++;
    const order = { critical: 0, major: 1, minor: 2 };
    const top = [...(alarms?.items ?? [])].sort((a, b) => order[a.severity] - order[b.severity] || b.startedAt.localeCompare(a.startedAt)).slice(0, 3);
    return {
      cabinets: { total: c.total, online: c.total - c.offline, offline: c.offline, on: c.on, off: c.off, fault: c.fault, dimming: c.dimming, unknown: c.unknown },
      onlinePct: Math.round(stats.onlinePct * 10) / 10,
      openAlarms: alarms ? { total: alarms.total, bySeverity: { nghiem_trong: bySeverity.critical, quan_trong: bySeverity.major, nhe: bySeverity.minor }, top: top.map(alarmBrief) } : 'không có quyền xem cảnh báo',
      overdueIncidents: stats.overdueIncidents,
    };
  },
};

const findCabinets: ToolDef<{ query: string }> = {
  name: 'find_cabinets',
  kind: 'read',
  description: 'Find cabinets by code, name or address (at most 5). Use when the user names a cabinet loosely and you need to know which one.',
  schema: obj({ query: { type: 'string', description: 'Mã, tên hoặc địa chỉ (ít nhất 2 ký tự)' } }, ['query']),
  input: z.object({ query: z.string().trim().min(1).max(120) }),
  async run(ctx, { query }) {
    const r = await resolveCabinet(ctx, query);
    if (r.kind === 'one') {
      setFocus(ctx.focus, r.cabinet);
      return { cabinets: [brief(r.cabinet)] };
    }
    return r.kind === 'many' ? { cabinets: r.choices.map(brief), note: 'Nhiều tủ khớp: hỏi lại người dùng' } : notResolved(r);
  },
};

const getCabinet: ToolDef<{ cabinet: string }> = {
  name: 'get_cabinet',
  kind: 'read',
  description: 'Current state of ONE cabinet: connection, branch 1 / 2 lit, manual mode, voltage, current, power, leakage, temperature, diagnostics (PLGO, PLC, LOGO), open alarms. Use for "tủ X bị gì", "tủ X thế nào", "tủ X có sáng không".',
  schema: obj({ cabinet: CABINET_PROP }, ['cabinet']),
  input: z.object({ cabinet: ref }),
  async run(ctx, { cabinet }) {
    const r = await resolveCabinet(ctx, cabinet);
    if (r.kind !== 'one') return notResolved(r);
    const id = r.cabinet.id;
    const [detail, diag, alarms] = await Promise.all([
      ctx.reads.cabinet(id, { signal: ctx.signal }),
      ctx.reads.diagnostics(id, { signal: ctx.signal }).catch(() => null),
      ctx.reads.cabinetAlarms(id, 20, { signal: ctx.signal }).catch(() => []),
    ]);
    const cab = detail.cabinet as Record<string, unknown>;
    const st = detail.state as Record<string, unknown>;
    const sched = detail.schedule as Record<string, unknown> | undefined;
    setFocus(ctx.focus, { id, code: String(cab.code), name: String(cab.name) });
    const num = (k: string) => (st[k] === null || st[k] === undefined ? null : Number(st[k]));
    const problems = (diag?.items ?? []).filter((d: DiagnosticItem) => d.status !== 'ok' && d.status !== 'unsupported');
    return {
      code: cab.code, name: cab.name, district: cab.districtName, ward: cab.wardName,
      status: STATUS_VI[st.status as CabinetStatus] ?? st.status,
      online: st.online, lastSeen: vnTime(st.lastSeenAt as string | null),
      branch1On: st.branch1On, branch2On: st.branch2On, manualMode: st.manualMode,
      plcOnline: st.plcOnline, powerMeterOnline: st.pmOnline,
      voltageV: [num('vL1'), num('vL2'), num('vL3')], currentA: [num('iL1'), num('iL2'), num('iL3')],
      powerKw: num('pTotalKw'), leakMa: num('leakMa'), tempC: num('tempC'), doorOpen: st.doorOpen,
      openAlarms: (alarms as Alarm[]).filter((a) => a.active).slice(0, 5).map((a) => ({ code: a.code, severity: SEVERITY_VI[a.severity], message: a.message, since: vnTime(a.startedAt) })),
      diagnostics: problems.slice(0, 6).map((d: DiagnosticItem) => ({ part: d.subsystem, status: d.status, code: d.code, evidence: d.evidence, detail: d.detail })),
      diagnosticsOk: diag ? diag.items.length - problems.length : null,
      schedule: sched ? { mode: sched.mode, on1: sched.on1, off1: sched.off1, on2: sched.on2, off2: sched.off2, source: sched.source, fromZone: sched.inheritedFromZone } : null,
      capabilities: detail.capabilities,
    };
  },
};

const HISTORY_METRICS = ['pTotalKw', 'iL1', 'iL2', 'iL3', 'vL1', 'vL2', 'vL3', 'leakMa', 'tempC'] as const;

const getCabinetHistory: ToolDef<{ cabinet: string; hours: number; metrics?: (typeof TELEMETRY_METRICS)[number][] }> = {
  name: 'get_cabinet_history',
  kind: 'read',
  description:
    'PAST of one cabinet over the last N hours (max 168): min / max / average values, likely on / off times (guessed from power), commands sent. Use for "tối qua / hôm qua bật lúc mấy giờ", "dòng rò 24 giờ qua", "có bất thường không".',
  schema: obj({
    cabinet: CABINET_PROP,
    hours: { type: 'integer', minimum: 1, maximum: 168, description: 'Số giờ nhìn lại, mặc định 24' },
    metrics: { type: 'array', items: { type: 'string', enum: [...TELEMETRY_METRICS] }, description: 'Đại lượng cần xem; bỏ trống = công suất, dòng, rò' },
  }, ['cabinet']),
  input: z.object({ cabinet: ref, hours: z.coerce.number().int().min(1).max(168).default(24), metrics: z.array(z.enum(TELEMETRY_METRICS)).max(6).optional() }),
  async run(ctx, { cabinet, hours, metrics }) {
    const r = await resolveCabinet(ctx, cabinet);
    if (r.kind !== 'one') return notResolved(r);
    const id = r.cabinet.id;
    setFocus(ctx.focus, r.cabinet);
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3_600_000);
    const want = [...new Set([...(metrics ?? ['iL1', 'leakMa']), 'pTotalKw'])].filter((m): m is (typeof HISTORY_METRICS)[number] => (HISTORY_METRICS as readonly string[]).includes(m));
    const [points, commands] = await Promise.all([
      ctx.reads.telemetry(id, want, from, to, { signal: ctx.signal }),
      ctx.reads.cabinetCommands(id, 30, { signal: ctx.signal }).catch(() => [] as Command[]),
    ]);
    const stats: Record<string, { min: number; max: number; avg: number } | null> = {};
    for (const m of want) {
      const xs = points.map((p) => p[m]).filter((x): x is number => typeof x === 'number');
      stats[m] = xs.length ? { min: Math.min(...xs), max: Math.max(...xs), avg: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 } : null;
    }
    // lights on ≈ power clearly above the idle draw; a guess, said as "khả năng"
    const kw = points.map((p) => ({ ts: p.ts, v: typeof p.pTotalKw === 'number' ? p.pTotalKw : null })).filter((p) => p.v !== null) as { ts: string; v: number }[];
    const peak = Math.max(0, ...kw.map((p) => p.v));
    const threshold = Math.max(0.05, peak * 0.3);
    const switches: { at: string | null; to: 'bật' | 'tắt' }[] = [];
    for (let i = 1; i < kw.length; i++) {
      const was = kw[i - 1]!.v > threshold;
      const is = kw[i]!.v > threshold;
      if (was !== is) switches.push({ at: vnTime(kw[i]!.ts), to: is ? 'bật' : 'tắt' });
    }
    const sent = commands.filter((c) => new Date(c.queuedAt) >= from).slice(0, 10)
      .map((c) => ({ type: c.type, params: c.params, status: COMMAND_STATUS_VI[c.status] ?? c.status, at: vnTime(c.queuedAt) }));
    return {
      cabinet: r.cabinet.code, from: vnTime(from.toISOString()), to: vnTime(to.toISOString()), samples: points.length, stats,
      likelySwitches: peak > 0.05 ? switches.slice(-12) : 'công suất gần 0 suốt khoảng thời gian, không suy ra được giờ bật / tắt',
      note: 'Giờ bật / tắt suy ra từ công suất, chỉ là khả năng',
      commands: sent,
    };
  },
};

const listAlarms: ToolDef<{ severity?: 'critical' | 'major' | 'minor'; district?: string; active: boolean; limit: number }> = {
  name: 'list_alarms',
  kind: 'read',
  description: 'Open alarms grouped by alarm code + district (count, a few cabinet codes). Use for "phường / quận nào có lỗi", "đang có cảnh báo gì". Leave every filter empty unless the user asked for one.',
  schema: obj({
    severity: { type: 'string', enum: ['critical', 'major', 'minor'], description: 'only if the user asked for a severity' },
    district: { type: 'string', description: 'Tên quận / huyện đúng như hệ thống ghi' },
    active: { type: 'boolean', description: 'true = chỉ cảnh báo đang mở (mặc định)' },
    limit: { type: 'integer', minimum: 1, maximum: 10 },
  }),
  input: z.object({
    severity: z.enum(['critical', 'major', 'minor']).optional(),
    district: z.string().trim().max(100).optional(),
    active: z.boolean().default(true),
    limit: z.coerce.number().int().min(1).max(10).default(10),
  }),
  async run(ctx, { severity: asked, district, active, limit }) {
    // small models add a severity filter nobody asked for; keep it only when the question names a level
    const said = fold(ctx.userText ?? '');
    const severity = ctx.userText === undefined || /nghiem trong|quan trong|\bnhe\b|critical|major|minor|muc/.test(said) ? asked : undefined;
    const page = await ctx.reads.alarms({ active, severity, district, size: 200 }, { signal: ctx.signal });
    const groups = new Map<string, { code: string; type: string; severity: string; district: string; count: number; cabinets: string[]; since: string; message: string }>();
    for (const a of page.items) {
      const k = `${a.code}|${a.districtName}`;
      const g = groups.get(k) ?? { code: a.code, type: a.type, severity: SEVERITY_VI[a.severity], district: a.districtName, count: 0, cabinets: [], since: a.startedAt, message: a.message };
      g.count++;
      if (g.cabinets.length < 5) g.cabinets.push(a.cabinetCode);
      if (a.startedAt < g.since) g.since = a.startedAt;
      groups.set(k, g);
    }
    const list = [...groups.values()].sort((x, y) => y.count - x.count).slice(0, limit).map((g) => ({ ...g, since: vnTime(g.since) }));
    if (list[0]) ctx.focus.alarmCode = list[0].code;
    return { total: page.total, shown: page.items.length, groups: list };
  },
};

const explainAlarmCode: ToolDef<{ code: string }> = {
  name: 'explain_alarm_code',
  kind: 'read',
  description: 'Meaning of an alarm code such as E201 or E301: name, severity, condition, from the system catalogue. ALWAYS use this for "mã E… là gì"; never explain a code from memory.',
  schema: obj({ code: { type: 'string', description: 'Mã cảnh báo, ví dụ E201; hoặc loại như plc_lost' } }, ['code']),
  input: z.object({ code: z.string().trim().min(1).max(40) }),
  async run(ctx, { code }) {
    const rules = await ctx.reads.alarmRules({ signal: ctx.signal });
    const q = code.toUpperCase().replace(/\s+/g, '');
    const hit = rules.find((r) => r.code.toUpperCase() === q) ?? rules.find((r) => r.type.toUpperCase() === q);
    if (!hit) return { error: 'not_found', message: `Không có mã ${code} trong danh mục`, known: rules.slice(0, 12).map((r) => r.code) };
    ctx.focus.alarmCode = hit.code;
    return { code: hit.code, title: hit.title, severity: SEVERITY_VI[hit.severity], condition: hit.condition, raisedByServer: hit.enabled };
  },
};

let treeCache: { at: number; userId: string; areas: AreaNode[] } | null = null;
async function areaTree(ctx: ToolContext) {
  if (treeCache && treeCache.userId === ctx.user.id && Date.now() - treeCache.at < 60_000) return treeCache.areas;
  const t = await ctx.reads.areaTree({ signal: ctx.signal });
  treeCache = { at: Date.now(), userId: ctx.user.id, areas: t.areas };
  return t.areas;
}

const listAreas: ToolDef<Record<string, never>> = {
  name: 'list_areas',
  kind: 'read',
  description: 'Districts in the user\'s scope with their number of cabinets and wards.',
  schema: obj({}),
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>, z.ZodTypeDef, unknown>,
  async run(ctx) {
    const areas = await areaTree(ctx);
    const districts = areas.filter((a) => a.kind === 'district');
    return {
      districts: districts.map((d) => ({ name: d.name, cabinets: d.cabinetCount, wards: areas.filter((w) => w.parentId === d.id).length })).sort((a, b) => b.cabinets - a.cabinets),
    };
  },
};

const getAreaCabinets: ToolDef<{ area: string }> = {
  name: 'get_area_cabinets',
  kind: 'read',
  description: 'Cabinets of one ward or district by name: counts by state and a few cabinets, faulty / offline first.',
  schema: obj({ area: { type: 'string', description: 'Tên phường hoặc quận' } }, ['area']),
  input: z.object({ area: z.string().trim().min(1).max(100) }),
  async run(ctx, { area }) {
    const areas = await areaTree(ctx);
    const q = fold(area).replace(/^(phuong|quan|huyen|xa|thi tran) /, '');
    const hits = areas.filter((a) => a.kind !== 'unit' && fold(a.name).includes(q));
    if (!hits.length) return { error: 'not_found', message: `Không thấy khu vực "${area}"` };
    const exact = hits.filter((a) => fold(a.name).replace(/^(phuong|quan|huyen|xa|thi tran) /, '') === q);
    const pick = exact.length === 1 ? exact[0]! : hits.length === 1 ? hits[0]! : null;
    if (!pick) return { error: 'ambiguous', message: 'Nhiều khu vực khớp, hỏi lại người dùng', choices: hits.slice(0, 6).map((a) => a.name) };
    ctx.focus.area = { id: pick.id, name: pick.name };
    const wards = pick.kind === 'ward' ? [pick] : areas.filter((a) => a.parentId === pick.id && a.kind === 'ward').slice(0, 15);
    const lists = await Promise.all(wards.map((w) => ctx.reads.areaCabinets(w.id, { signal: ctx.signal })));
    const all = lists.flat();
    const counts: Record<string, number> = {};
    for (const c of all) counts[STATUS_VI[c.status] ?? c.status] = (counts[STATUS_VI[c.status] ?? c.status] ?? 0) + 1;
    const rank = (s: CabinetStatus) => ({ fault: 0, offline: 1, unknown: 2, on: 3, dimming: 3, off: 4 })[s] ?? 5;
    return {
      area: pick.name, kind: pick.kind, total: all.length, byStatus: counts,
      cabinets: [...all].sort((a, b) => rank(a.status) - rank(b.status)).slice(0, 15).map(brief),
      wardsCounted: pick.kind === 'district' ? wards.length : undefined,
    };
  },
};

const getSchedule: ToolDef<{ cabinet: string }> = {
  name: 'get_schedule',
  kind: 'read',
  description: 'On / off SCHEDULE of one cabinet (its own or its zone\'s): mode, on / off times, astronomical or fixed, offsets. Use for "lịch bật tắt", "mấy giờ bật".',
  schema: obj({ cabinet: CABINET_PROP }, ['cabinet']),
  input: z.object({ cabinet: ref }),
  async run(ctx, { cabinet }) {
    const r = await resolveCabinet(ctx, cabinet);
    if (r.kind !== 'one') return notResolved(r);
    const detail = await ctx.reads.cabinet(r.cabinet.id, { signal: ctx.signal });
    setFocus(ctx.focus, r.cabinet);
    const s = detail.schedule as Record<string, unknown>;
    return {
      cabinet: r.cabinet.code, mode: s.mode === 2 ? '2 khung giờ' : '1 khung giờ', source: s.source === 'astronomical' ? 'thiên văn' : 'cố định',
      on1: s.on1, off1: s.off1, on2: s.mode === 2 ? s.on2 : undefined, off2: s.mode === 2 ? s.off2 : undefined,
      branch1Enabled: s.branch1Enabled, branch2Enabled: s.branch2Enabled, offsetOnMin: s.offsetOnMin, offsetOffMin: s.offsetOffMin,
      fromZone: s.inheritedFromZone, appliedAt: vnTime(s.appliedAt as string | null),
    };
  },
};

const INCIDENT_STATUS_VI: Record<string, string> = { new: 'mới', assigned: 'đã giao', deferred: 'hoãn', resolved: 'đã xử lý', closed: 'đã đóng' };

const listIncidents: ToolDef<{ filter: 'open' | 'overdue' | 'all'; limit: number }> = {
  name: 'list_incidents',
  kind: 'read',
  description: 'Field incidents (repair tickets): open, overdue or all; overdue first. Use for "sự cố", "quá hạn".',
  schema: obj({ filter: { type: 'string', enum: ['open', 'overdue', 'all'] }, limit: { type: 'integer', minimum: 1, maximum: 10 } }),
  input: z.object({ filter: z.enum(['open', 'overdue', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(10).default(10) }),
  async run(ctx, { filter, limit }) {
    const q = filter === 'open' ? 'new_assigned_deferred' : filter;
    const page = await ctx.reads.incidents({ q, size: 50 }, { signal: ctx.signal });
    const now = Date.now();
    const items = page.items.map((i) => ({ ...i, overdue: !!i.deadline && new Date(i.deadline).getTime() < now && !['resolved', 'closed'].includes(i.status) }));
    items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.reportedAt.localeCompare(a.reportedAt));
    return {
      total: page.total,
      incidents: items.slice(0, limit).map((i) => ({
        code: i.code, cabinet: i.cabinetName, district: i.districtName, category: i.category, status: INCIDENT_STATUS_VI[i.status] ?? i.status,
        overdue: i.overdue, deadline: vnTime(i.deadline), reported: vnTime(i.reportedAt), content: i.content.slice(0, 160),
      })),
    };
  },
};

const getCommandStatus: ToolDef<{ command_id: string }> = {
  name: 'get_command_status',
  kind: 'read',
  description: 'Status of one command already sent, by command id.',
  schema: obj({ command_id: { type: 'string', description: 'id lệnh (uuid)' } }, ['command_id']),
  input: z.object({ command_id: z.string().uuid() }),
  async run(ctx, { command_id }) {
    const c = await ctx.reads.command(command_id, { signal: ctx.signal });
    return { cabinet: c.cabinetName, type: c.type, params: c.params, status: COMMAND_STATUS_VI[c.status] ?? c.status, queued: vnTime(c.queuedAt), error: c.error ?? null };
  },
};

/**
 * Offered to the model. Kept to 8: every tool schema is in the prompt on each call, and a 4B model picks better from
 * fewer. get_cabinet already resolves loose names (and asks back when several match), so find_cabinets is not needed.
 */
export const READ_TOOLS = [
  getSystemOverview, getCabinet, getCabinetHistory, listAlarms, explainAlarmCode, getAreaCabinets, getSchedule, listIncidents,
] as unknown as ToolDef[];

/** Written and tested, not offered yet: list_areas, find_cabinets; get_command_status comes back with actions (milestone 4). */
export const SPARE_TOOLS = [findCabinets, listAreas, getCommandStatus] as unknown as ToolDef[];
