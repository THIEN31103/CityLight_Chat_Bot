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
const MAX_ALARM_PAGES = 10;
export const SEVERITY_VI = { critical: 'nghiêm trọng', major: 'quan trọng', minor: 'nhẹ' } as const;
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
  // several readings of one spoken code ("TL1009": TL01.0009 or TL10.0009): look each up, ask back when both exist
  const codes = tried.filter((t) => /^[A-Z]{2,4}[0-9]{2}[.][0-9]{4}$/.test(t));
  if (codes.length > 1) {
    const hits = (await Promise.all(codes.map((c) => ctx.reads.search(c, { signal: ctx.signal })))).flat().filter((c) => codes.includes(c.code.toUpperCase()));
    const unique = [...new Map(hits.map((c) => [c.id, c])).values()];
    if (unique.length === 1) return { kind: 'one', cabinet: unique[0]! };
    if (unique.length > 1) return { kind: 'many', choices: unique.slice(0, 5) };
  }
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

/**
 * English words in CityLight's own texts (alarm names like "Mất kết nối telemetry"), put in Vietnamese before the
 * model sees them: it copied them into answers ("tình trạng offline", 2026-11-15).
 */
const VI_WORDS: [RegExp, string][] = [
  [/(dữ liệu |data )?\btelemetry\b/gi, 'dữ liệu đo'], [/\boffline\b/gi, 'mất kết nối'], [/\bonline\b/gi, 'trực tuyến'],
  [/\bframes?\b/gi, 'gói tin'], [/\bfirmware\b/gi, 'phần mềm thiết bị'], [/\bdimming\b/gi, 'tiết giảm'],
];
export const viText = (s: string | null | undefined): string => {
  let out = s ?? '';
  for (const [re, by] of VI_WORDS) out = out.replace(re, by);
  return out;
};

const alarmBrief = (a: Alarm) => ({
  code: a.code, severity: SEVERITY_VI[a.severity], cabinet: a.cabinetCode, cabinetName: a.cabinetName, district: a.districtName,
  message: viText(a.message), since: vnTime(a.startedAt), acked: !!a.ackedAt,
});

// ---------------------------------------------------------------- tools

const getSystemOverview: ToolDef<Record<string, never>> = {
  name: 'get_system_overview',
  kind: 'read',
  description: 'System overview: how many cabinets are online / offline / on / off / faulty, open alarms by severity, overdue incidents. Use for "hệ thống thế nào", "tình hình chung", "báo cáo tình hình".',
  schema: obj({}),
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>, z.ZodTypeDef, unknown>,
  async run(ctx) {
    const noRight = (e: unknown) => (e instanceof ApiProblem && e.status === 403 ? null : Promise.reject(e));
    // the counts by severity come from the API's totals: counting the items of one page said "100 nghiêm trọng" when
    // all 486 open alarms were critical (2026-11-15)
    const count = (severity: 'critical' | 'major' | 'minor') =>
      ctx.reads.alarms({ active: true, severity, size: 1 }, { signal: ctx.signal }).then((p) => p.total, noRight);
    const [stats, alarms, critical, major, minor] = await Promise.all([
      ctx.reads.mapStats({ signal: ctx.signal }),
      ctx.reads.alarms({ active: true, size: 100 }, { signal: ctx.signal }).catch(noRight),
      count('critical'),
      count('major'),
      count('minor'),
    ]);
    const c = stats.cabinets;
    const bySeverity = { critical: critical ?? 0, major: major ?? 0, minor: minor ?? 0 };
    const order = { critical: 0, major: 1, minor: 2 };
    const top = [...(alarms?.items ?? [])].sort((a, b) => order[a.severity] - order[b.severity] || b.startedAt.localeCompare(a.startedAt)).slice(0, 3);
    return {
      // Vietnamese keys: with "offline" the model copied the English word into its answer (2026-11-17)
      tu: { tong_so: c.total, truc_tuyen: c.total - c.offline, mat_ket_noi: c.offline, dang_sang: c.on, dang_tat: c.off, dang_loi: c.fault, tiet_giam: c.dimming, chua_ro: c.unknown },
      ty_le_truc_tuyen_phan_tram: Math.round(stats.onlinePct * 10) / 10,
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
      // never connected: "chưa từng" instead of null, which the model turned into "Không biết thời điểm" (2026-11-20)
      // Vietnamese words: with "online" the model wrote "đang sáng, online" (2026-11-20)
      ket_noi: st.online ? 'trực tuyến' : 'mất kết nối', lastSeen: vnTime(st.lastSeenAt as string | null) ?? 'chưa từng gửi dữ liệu lên hệ thống',
      // Vietnamese words: with branch1On the model wrote "Branch 1 và Branch 2 đều tắt" (2026-11-21)
      nhanh_1: st.branch1On === true ? 'đang sáng' : st.branch1On === false ? 'đang tắt' : null,
      nhanh_2: st.branch2On === true ? 'đang sáng' : st.branch2On === false ? 'đang tắt' : null,
      che_do: st.manualMode === true ? 'chạy tay' : st.manualMode === false ? 'theo lịch' : null,
      plc: st.plcOnline === false ? 'mất kết nối' : st.plcOnline ? 'trực tuyến' : null,
      dong_ho_dien: st.pmOnline === false ? 'mất kết nối' : st.pmOnline ? 'trực tuyến' : null,
      voltageV: [num('vL1'), num('vL2'), num('vL3')], currentA: [num('iL1'), num('iL2'), num('iL3')],
      powerKw: num('pTotalKw'), leakMa: num('leakMa'), tempC: num('tempC'), cua_tu: st.doorOpen === true ? 'đang mở' : st.doorOpen === false ? 'đóng' : null,
      openAlarms: (alarms as Alarm[]).filter((a) => a.active).slice(0, 5).map((a) => ({ code: a.code, severity: SEVERITY_VI[a.severity], message: viText(a.message), since: vnTime(a.startedAt) })),
      diagnostics: problems.slice(0, 6).map((d: DiagnosticItem) => ({ part: d.subsystem, status: d.status, code: d.code, evidence: d.evidence, detail: d.detail })),
      diagnosticsOk: diag ? diag.items.length - problems.length : null,
      schedule: sched ? { mode: sched.mode, on1: sched.on1, off1: sched.off1, on2: sched.on2, off2: sched.off2, source: sched.source, fromZone: sched.inheritedFromZone } : null,
      // capabilities ("manual_control"…) left out: the model read them as "Jarvis can switch this cabinet" (2026-11-20)
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
    hours: { type: 'integer', minimum: 1, description: 'Số giờ nhìn lại, mặc định 24, tối đa 168' },
    metrics: { type: 'array', items: { type: 'string', enum: [...TELEMETRY_METRICS] }, description: 'Đại lượng cần xem; bỏ trống = công suất, dòng, rò' },
  }, ['cabinet']),
  input: z.object({ cabinet: ref, hours: z.coerce.number().int().min(1).default(24).transform((n) => Math.min(n, 168)), metrics: z.array(z.enum(TELEMETRY_METRICS)).max(6).optional() }),
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
    limit: { type: 'integer', minimum: 1, description: 'tối đa 10' },
  }),
  input: z.object({
    severity: z.enum(['critical', 'major', 'minor']).optional(),
    district: z.string().trim().max(100).optional(),
    active: z.boolean().default(true),
    limit: z.coerce.number().int().min(1).default(10).transform((n) => Math.min(n, 10)),
  }),
  async run(ctx, { severity: asked, district, active, limit }) {
    // small models add a severity filter nobody asked for; keep it only when the question names a level
    const said = fold(ctx.userText ?? '');
    const severity = ctx.userText === undefined || /nghiem trong|quan trong|\bnhe\b|critical|major|minor|muc/.test(said) ? asked : undefined;
    // every page (up to MAX_ALARM_PAGES x 100), so "quận nào nhiều nhất" counts all open alarms, not the newest 100
    const first = await ctx.reads.alarms({ active, severity, district, size: 100, page: 1 }, { signal: ctx.signal });
    const items = [...first.items];
    for (let p = 2; items.length < first.total && p <= MAX_ALARM_PAGES; p++) {
      const next = await ctx.reads.alarms({ active, severity, district, size: 100, page: p }, { signal: ctx.signal });
      if (!next.items.length) break;
      items.push(...next.items);
    }
    const page = { total: first.total, items };
    const groups = new Map<string, { code: string; severity: string; district: string; count: number; cabinets: string[]; since: string; message: string }>();
    for (const a of page.items) {
      const k = `${a.code}|${a.districtName}`;
      const g = groups.get(k) ?? { code: a.code, severity: SEVERITY_VI[a.severity], district: a.districtName, count: 0, cabinets: [], since: a.startedAt, message: viText(a.message) };
      g.count++;
      if (g.cabinets.length < 5) g.cabinets.push(a.cabinetCode);
      if (a.startedAt < g.since) g.since = a.startedAt;
      groups.set(k, g);
    }
    const list = [...groups.values()].sort((x, y) => y.count - x.count).slice(0, limit).map((g) => ({ ...g, since: vnTime(g.since) }));
    if (list[0]) ctx.focus.alarmCode = list[0].code;
    // the model added up the group counts ("20 nghiêm trọng" when 486 were open, 2026-11-15): the total is named
    // plainly and the groups say they only cover the newest page
    return {
      tong_so_canh_bao: page.total,
      muc_do: severity ? SEVERITY_VI[severity] : 'mọi mức',
      ghi_chu: page.items.length >= page.total
        ? `Số lượng cảnh báo là tong_so_canh_bao = ${page.total}. Các nhóm dưới đây đếm đủ mọi cảnh báo (chỉ liệt kê ${list.length} nhóm lớn nhất).`
        : `Số lượng cảnh báo là tong_so_canh_bao = ${page.total}. Các nhóm dưới đây chỉ tính trên ${page.items.length} cảnh báo mới nhất, đừng cộng chúng lại.`,
      nhom_lon_nhat: list,
    };
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
    return { code: hit.code, title: viText(hit.title), severity: SEVERITY_VI[hit.severity], condition: viText(hit.condition), raisedByServer: hit.enabled };
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
    // Vietnamese keys: with "districts" the cloud model (gpt-oss) answered "Tôi không biết" to "những khu vực nào"
    return {
      so_khu_vuc: districts.length,
      khu_vuc: districts.map((d) => ({ ten: d.name, so_tu: d.cabinetCount, so_phuong: areas.filter((w) => w.parentId === d.id).length })).sort((a, b) => b.so_tu - a.so_tu),
    };
  },
};

/** letters to change to turn a into b (Levenshtein) */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** state filters, in the words the model sees: "bình thường" = connected and without fault */
export const STATE_FILTER = ['binh_thuong', 'dang_sang', 'dang_tat', 'co_loi', 'mat_ket_noi'] as const;
export type StateFilter = (typeof STATE_FILTER)[number];
export const MATCHES: Record<StateFilter, (c: CabinetSummary) => boolean> = {
  binh_thuong: (c) => c.status === 'on' || c.status === 'off' || c.status === 'dimming',
  dang_sang: (c) => c.status === 'on' || c.status === 'dimming',
  dang_tat: (c) => c.status === 'off',
  co_loi: (c) => c.status === 'fault',
  mat_ket_noi: (c) => c.status === 'offline',
};

export const STATE_WORDS_VI: Record<StateFilter, string> = {
  binh_thuong: 'hoạt động bình thường', dang_sang: 'đang sáng', dang_tat: 'đang tắt', co_loi: 'có lỗi', mat_ket_noi: 'mất kết nối',
};

type AreaCabinetsInput = { area?: string; state?: StateFilter; limit?: number };
// No "maximum" in the tool schemas: Groq checks them and refused the whole answer when the model asked for 39
// cabinets ("limit: maximum 30, got 39", 2026-11-21). The limits are applied in code instead.
/** "toàn hệ thống", "tất cả": no area */
const wholeSystem = (area?: string) => !area || /^(toan bo|tat ca|he thong|toan he thong|bat ky|bat ki)/.test(fold(area));

/**
 * The one ward or district a user named ("quận 1" is the district, not Phường 1 nor Quận 10; "khu đức" misheard is
 * Thủ Đức). Sets it as the area in focus. Else an answer for the model: not found (with the real districts) or which one.
 */
async function pickArea(ctx: ToolContext, area: string): Promise<{ pick: AreaNode; areas: AreaNode[]; heardAs?: string } | { error: Record<string, unknown> }> {
  const areas = await areaTree(ctx);
  const q = fold(area).replace(/^(phuong|quan|huyen|xa|thi tran) /, '');
  let hits = areas.filter((a) => a.kind !== 'unit' && fold(a.name).includes(q));
  // a name misheard by speech recognition ("khu đức" for Thủ Đức, 2026-11-21): the one area within two letters
  let heardAs: string | undefined;
  if (!hits.length) {
    const near = areas.filter((a) => a.kind !== 'unit' && q.length >= 4 && editDistance(fold(a.name).replace(/^(phuong|quan|huyen|xa|thi tran|tp) /, ''), q) <= 2);
    if (near.length === 1) {
      hits = near;
      heardAs = near[0]!.name;
    }
  }
  if (!hits.length)
    return { error: { error: 'not_found', message: `Không thấy khu vực "${area}". Hãy nói tên đúng và kể vài khu vực có thật.`, cac_quan: areas.filter((a) => a.kind === 'district').map((a) => a.name) } };
  // "quận 1" is the district, not "Phường 1" nor "Quận 10" (2026-11-20): the word the user said picks the kind
  const said = /^(quan|huyen)\b/.test(fold(area)) ? 'district' : /^(phuong|xa|thi tran)\b/.test(fold(area)) ? 'ward' : null;
  const same = hits.filter((a) => fold(a.name).replace(/^(phuong|quan|huyen|xa|thi tran) /, '') === q);
  const exact = said && same.some((a) => a.kind === said) ? same.filter((a) => a.kind === said) : same;
  const pick = exact.length === 1 ? exact[0]! : hits.length === 1 ? hits[0]! : null;
  if (!pick) return { error: { error: 'ambiguous', message: 'Nhiều khu vực khớp, hỏi lại người dùng', choices: hits.slice(0, 6).map((a) => a.name) } };
  ctx.focus.area = { id: pick.id, name: pick.name };
  return { pick, areas, ...(heardAs ? { heardAs } : {}) };
}

const getAreaCabinets: ToolDef<AreaCabinetsInput> = {
  name: 'get_area_cabinets',
  kind: 'read',
  description:
    'Cabinets with their state: of one ward or district, or of the whole system when area is left empty. Counts by state and a list (faulty / offline first), optionally only one state. Use for "liệt kê các tủ…", "10 tủ đang bình thường", "tủ nào mất kết nối", "phường X có tủ nào lỗi". Never ask the user for an area: leave it empty.',
  schema: obj({
    area: { type: 'string', description: 'Tên phường hoặc quận; bỏ trống = toàn hệ thống' },
    state: { type: 'string', enum: [...STATE_FILTER], description: 'chỉ tủ ở trạng thái này; binh_thuong = có kết nối, không lỗi' },
    limit: { type: 'integer', minimum: 1, description: 'số tủ trong danh sách, mặc định 15, tối đa 50' },
  }),
  input: z.object({
    area: z.string().trim().max(100).optional(),
    state: z.enum(STATE_FILTER).optional(),
    limit: z.number().int().min(1).transform((n) => Math.min(n, 50)).optional(),
  }),
  async run(ctx, { area, state, limit }) {
    let all: CabinetSummary[];
    let where: Record<string, unknown>;
    if (wholeSystem(area)) {
      all = await ctx.reads.mapCabinets({ signal: ctx.signal });
      where = { khu_vuc: 'toàn hệ thống' };
    } else {
      const found = await pickArea(ctx, area!);
      if ('error' in found) return found.error;
      const { pick, areas, heardAs } = found;
      const wards = pick.kind === 'ward' ? [pick] : areas.filter((a) => a.parentId === pick.id && a.kind === 'ward').slice(0, 15);
      all = (await Promise.all(wards.map((w) => ctx.reads.areaCabinets(w.id, { signal: ctx.signal })))).flat();
      where = { khu_vuc: pick.name, wardsCounted: pick.kind === 'district' ? wards.length : undefined, ...(heardAs ? { ghi_chu_ten: `Không có khu vực "${area}", hiểu là ${heardAs}. Nói rõ điều này.` } : {}) };
    }
    const counts: Record<string, number> = {};
    for (const c of all) counts[STATUS_VI[c.status] ?? c.status] = (counts[STATUS_VI[c.status] ?? c.status] ?? 0) + 1;
    const rank = (s: CabinetStatus) => ({ fault: 0, offline: 1, unknown: 2, on: 3, dimming: 3, off: 4 })[s] ?? 5;
    const chosen = state ? all.filter(MATCHES[state]) : [...all].sort((a, b) => rank(a.status) - rank(b.status));
    const shown = chosen.slice(0, limit ?? 15);
    // kept out of the result: the console makes the one the answer names "tủ đó"
    ctx.focus.listed = shown.map((c) => ({ id: c.id, code: c.code, name: c.name }));
    return {
      ...where,
      tong_so_tu: all.length,
      theo_trang_thai: counts,
      ...(state ? { loc: state, so_tu_khop: chosen.length } : {}),
      // "10 tủ đang bị lỗi" with no faulty cabinet ended in "Không biết." (2026-11-20): say none, and what there is
      ...(state && !chosen.length
        ? { ghi_chu: `Không có tủ nào ${STATE_WORDS_VI[state]}. Hiện có: ${Object.entries(counts).map(([k, n]) => `${n} tủ ${k}`).join(', ')}. Nói cả hai ý này.` }
        : {}),
      danh_sach: shown.map(brief),
    };
  },
};

const MISMATCH_KIND = ['tat_trong_gio', 'sang_ngoai_gio'] as const;
type MismatchInput = { area?: string; kind?: (typeof MISMATCH_KIND)[number]; limit?: number };

/**
 * Lights against their schedule (Gemini review 2026-11-23, "lệch lịch"). The server already checks every cabinet
 * (packages/shared/src/rules.ts): branch state vs the schedule it applied, only while the PLC and the LOGO answer and
 * the cabinet is not in manual mode, and raises E303 "Đèn lệch lịch" after 20 minutes. Its alarms are the answer;
 * reading 1,000 schedules here would be slower and less exact. Offline cabinets cannot be checked: their number is said.
 */
const findScheduleMismatch: ToolDef<MismatchInput> = {
  name: 'find_schedule_mismatch',
  kind: 'read',
  description:
    'Cabinets whose lights do not follow their schedule right now (alarm E303), of one ward or district or of the whole system when area is empty: off during scheduled hours ("lẽ ra phải sáng mà đang tắt") or on outside them ("sáng ngoài giờ"). Cabinets in manual mode are not counted; offline ones cannot be checked (their number is given). Use for "tủ nào lệch lịch", "tối nay tủ nào đáng lẽ sáng mà đang tắt", "đèn nào sáng ban ngày".',
  schema: obj({
    area: { type: 'string', description: 'Tên phường hoặc quận; bỏ trống = toàn hệ thống' },
    kind: { type: 'string', enum: [...MISMATCH_KIND], description: 'tat_trong_gio = lẽ ra sáng mà tắt; sang_ngoai_gio = lẽ ra tắt mà sáng; bỏ trống = cả hai' },
    limit: { type: 'integer', minimum: 1, description: 'số tủ trong danh sách, mặc định 10, tối đa 30' },
  }),
  input: z.object({
    area: z.string().trim().max(100).optional(),
    kind: z.enum(MISMATCH_KIND).optional(),
    limit: z.number().int().min(1).transform((n) => Math.min(n, 30)).optional(),
  }),
  async run(ctx, { area, kind, limit }) {
    const o = { signal: ctx.signal };
    const [page, cabinets] = await Promise.all([ctx.reads.alarms({ active: true, type: 'schedule_mismatch', size: 200 }, o), ctx.reads.mapCabinets(o)]);
    let inArea = (_c: CabinetSummary) => true;
    let where: Record<string, unknown> = { khu_vuc: 'toàn hệ thống' };
    if (!wholeSystem(area)) {
      const found = await pickArea(ctx, area!);
      if ('error' in found) return found.error;
      const id = found.pick.id;
      inArea = (c) => c.districtId === id || c.wardId === id;
      where = { khu_vuc: found.pick.name, ...(found.heardAs ? { ghi_chu_ten: `Không có khu vực "${area}", hiểu là ${found.heardAs}. Nói rõ điều này.` } : {}) };
    }
    const scope = cabinets.filter(inArea);
    const byId = new Map(scope.map((c) => [c.id, c]));
    // "nhánh 1 tắt trong lịch, nhánh 2 sáng ngoài lịch (lịch Chế độ 2)": per branch, from the server's own words
    const rows = (page.items as Alarm[])
      .filter((a) => a.active && a.type === 'schedule_mismatch' && byId.has(a.cabinetId))
      .map((a) => {
        const branches = [...a.message.matchAll(/nhánh (\d) (tắt trong lịch|sáng ngoài lịch)/g)].map((m) => ({ branch: Number(m[1]), off: m[2] === 'tắt trong lịch' }));
        return { a, off: branches.filter((b) => b.off).map((b) => b.branch), on: branches.filter((b) => !b.off).map((b) => b.branch) };
      })
      .sort((x, y) => x.a.startedAt.localeCompare(y.a.startedAt));
    const offIn = rows.filter((r) => r.off.length);
    const onOut = rows.filter((r) => r.on.length);
    const chosen = kind === 'tat_trong_gio' ? offIn : kind === 'sang_ngoai_gio' ? onOut : rows;
    const shown = chosen.slice(0, limit ?? 10);
    ctx.focus.listed = shown.map((r) => ({ id: r.a.cabinetId, code: r.a.cabinetCode, name: r.a.cabinetName }));
    const say = (r: (typeof rows)[number]) =>
      [r.off.length ? `${r.off.length === 2 ? 'cả hai nhánh' : `nhánh ${r.off[0]}`} tắt trong giờ lịch` : '', r.on.length ? `${r.on.length === 2 ? 'cả hai nhánh' : `nhánh ${r.on[0]}`} sáng ngoài giờ lịch` : '']
        .filter(Boolean).join(', ');
    const offline = scope.filter((c) => c.status === 'offline').length;
    return {
      ...where,
      so_tu_kiem_tra: scope.length - offline,
      lech_lich: rows.length,
      tat_trong_gio_lich: offIn.length,
      sang_ngoai_gio_lich: onOut.length,
      ...(kind ? { loc: kind, so_tu_khop: chosen.length } : {}),
      danh_sach: shown.map((r) => ({ code: r.a.cabinetCode, name: r.a.cabinetName, district: r.a.districtName, lech: say(r), tu_luc: vnTime(r.a.startedAt) })),
      mat_ket_noi_khong_kiem_tra_duoc: offline,
      ghi_chu:
        'Máy chủ chỉ báo lệch lịch khi đèn khác lịch quá 20 phút; tủ đang chạy tay không tính. Tủ mất kết nối thì không biết đèn đang thế nào: nói số tủ này, đừng gọi chúng là đúng lịch.' +
        (rows.length ? '' : ' Không có tủ nào lệch lịch: nói rõ điều này.'),
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

export const INCIDENT_STATUS_VI: Record<string, string> = { new: 'mới', assigned: 'đã giao', deferred: 'hoãn', resolved: 'đã xử lý', closed: 'đã đóng' };

const listIncidents: ToolDef<{ filter: 'open' | 'overdue' | 'all'; limit: number }> = {
  name: 'list_incidents',
  kind: 'read',
  description: 'Field incidents (repair tickets): open, overdue or all; overdue first. Use for "sự cố", "quá hạn".',
  schema: obj({ filter: { type: 'string', enum: ['open', 'overdue', 'all'] }, limit: { type: 'integer', minimum: 1, description: 'tối đa 10' } }),
  input: z.object({ filter: z.enum(['open', 'overdue', 'all']).default('open'), limit: z.coerce.number().int().min(1).default(10).transform((n) => Math.min(n, 10)) }),
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
  getSystemOverview, getCabinet, getCabinetHistory, listAlarms, explainAlarmCode, getAreaCabinets, findScheduleMismatch, getSchedule, listIncidents,
] as unknown as ToolDef[];

/** Not offered to the model: list_areas, find_cabinets run only through the keyword router; get_command_status comes back with actions (milestone 4). */
export const SPARE_TOOLS = [findCabinets, listAreas, getCommandStatus] as unknown as ToolDef[];
