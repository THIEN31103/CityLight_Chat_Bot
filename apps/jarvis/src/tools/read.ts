// Read tools (spec 5.2): they run at once, only GET the API as the signed-in user, and return short, model-friendly
// shapes (Vietnamese labels, Vietnam time). This file must never call a command endpoint (spec 6.10, test/static.test.ts).
import type { Alarm, CabinetStatus, CabinetSummary, Command, DiagnosticItem, TelemetryPoint } from '@citylight/shared';
import { z } from 'zod';
import { ApiProblem } from '../api/client';
import { TELEMETRY_METRICS, type AreaNode } from '../api/read';
import { cabinetSearchTerms, fold } from './names';
import type { Focus, ToolContext, ToolDef } from './registry';

const STATUS_VI: Record<CabinetStatus, string> = {
  on: 'đang sáng', off: 'đang tắt', fault: 'có lỗi', offline: 'mất kết nối', dimming: 'tiết giảm', unknown: 'chưa rõ',
};
const MAX_ALARM_PAGES = 10;
/** online cabinets read one by one for the manual-mode count of a shift report (8 at a time) */
const MANUAL_READS = 100;
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

/**
 * An alarm said to a person: its title from the alarm rules, then the server's detail without the raw device fields
 * ("E202 Mất kết nối PM_KEY (LTE không đọc được PM_KEY)" instead of "E202 LCLI=2, MCON=0: LTE …", test 2026-11-24).
 */
export function alarmLabel(a: { code: string; message: string }, titles?: Map<string, string>): string {
  const title = titles?.get(a.code);
  const detail = viText(a.message).replace(/^(?:[A-Z][A-Z0-9_]*=[^,:]*,s*)*[A-Z][A-Z0-9_]*=[^:]*:s*/, '').trim();
  if (!title) return `${a.code} ${detail || viText(a.message)}`;
  return detail && fold(detail) !== fold(title) ? `${a.code} ${title} (${detail})` : `${a.code} ${title}`;
}

/**
 * A schedule in Vietnamese words for the model ("Offset", "manual" were copied into answers, test 2026-11-24). The
 * offsets move the sunset / sunrise times, so they only mean something for an astronomical schedule.
 */
function scheduleVi(s: Record<string, unknown>) {
  const astro = s.source === 'astronomical';
  const two = s.mode === 2;
  const minutes = (n: unknown) => (typeof n === 'number' ? `${n > 0 ? '+' : ''}${n} phút` : null);
  return {
    loai_lich: astro ? 'lịch thiên văn (theo giờ mặt trời lặn / mọc)' : 'lịch giờ cố định',
    so_khung_gio: two ? 2 : 1,
    khung_1: { bat: s.on1, tat: s.off1 },
    ...(two ? { khung_2: { bat: s.on2, tat: s.off2 } } : {}),
    nhanh_1: s.branch1Enabled === false ? 'không chạy theo lịch' : 'chạy theo lịch',
    nhanh_2: s.branch2Enabled === false ? 'không chạy theo lịch' : 'chạy theo lịch',
    ...(astro ? { bat_lech_so_voi_mat_troi_lan: minutes(s.offsetOnMin), tat_lech_so_voi_mat_troi_moc: minutes(s.offsetOffMin) } : {}),
    lay_tu_lich_vung: s.inheritedFromZone === true ? 'có' : 'không',
  };
}

const alarmBrief = (a: Alarm, titles?: Map<string, string>) => ({
  code: a.code, severity: SEVERITY_VI[a.severity], cabinet: a.cabinetCode, cabinetName: a.cabinetName, district: a.districtName,
  // the alarm's name, not the raw device fields ("LCLI=4, …" was read out, test 2026-11-24)
  message: alarmLabel(a, titles).slice(a.code.length + 1), since: vnTime(a.startedAt), acked: !!a.ackedAt,
});
/** the alarm names, or none when the rules cannot be read (a test double without them, no right) */
const titlesOf = (ctx: ToolContext) => Promise.resolve().then(() => ctx.reads.alarmTitles({ signal: ctx.signal })).catch(() => undefined);

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
    const [stats, alarms, critical, major, minor, titles] = await Promise.all([
      ctx.reads.mapStats({ signal: ctx.signal }),
      ctx.reads.alarms({ active: true, size: 100 }, { signal: ctx.signal }).catch(noRight),
      count('critical'),
      count('major'),
      count('minor'),
      titlesOf(ctx),
    ]);
    const c = stats.cabinets;
    const bySeverity = { critical: critical ?? 0, major: major ?? 0, minor: minor ?? 0 };
    const order = { critical: 0, major: 1, minor: 2 };
    const top = [...(alarms?.items ?? [])].sort((a, b) => order[a.severity] - order[b.severity] || b.startedAt.localeCompare(a.startedAt)).slice(0, 3);
    return {
      // Vietnamese keys: with "offline" the model copied the English word into its answer (2026-11-17)
      tu: { tong_so: c.total, truc_tuyen: c.total - c.offline, mat_ket_noi: c.offline, dang_sang: c.on, dang_tat: c.off, dang_loi: c.fault, tiet_giam: c.dimming, chua_ro: c.unknown },
      ty_le_truc_tuyen_phan_tram: Math.round(stats.onlinePct * 10) / 10,
      openAlarms: alarms ? { total: alarms.total, bySeverity: { nghiem_trong: bySeverity.critical, quan_trong: bySeverity.major, nhe: bySeverity.minor }, top: top.map((a) => alarmBrief(a, titles)) } : 'không có quyền xem cảnh báo',
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
  description: 'Current state of ONE cabinet: connection, branch 1 / 2 lit, manual mode, voltage, current, power, leakage, temperature, diagnostics (PLGO, PLC, LOGO), open alarms. Use for "tủ X bị gì", "tủ X thế nào", "tủ X có sáng không", "chẩn đoán tủ X". Always say the chan_doan sentence in a few words.',
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
      // "12 mục OK" (test 2026-11-24): a Vietnamese key
      so_muc_chan_doan_binh_thuong: diag ? diag.items.length - problems.length : null,
      // asked right after a self-check, the answer left the diagnosis out (test 2026-11-24): a sentence to read
      chan_doan: !diag ? 'chưa đọc được kết quả chẩn đoán'
        : problems.length ? `${problems.length} mục chẩn đoán có vấn đề: ${problems.slice(0, 3).map((d: DiagnosticItem) => `${d.subsystem} (${d.detail ?? d.status})`).join('; ')}`
        : `chẩn đoán bình thường cả ${diag.items.length} mục`,
      // Vietnamese words: with source "manual" the model said "chế độ theo lịch (manual)" (test 2026-11-24)
      lich: sched ? scheduleVi(sched) : null,
      // capabilities ("manual_control"…) left out: the model read them as "Jarvis can switch this cabinet" (2026-11-20)
    };
  },
};

const HISTORY_METRICS = ['pTotalKw', 'iL1', 'iL2', 'iL3', 'vL1', 'vL2', 'vL3', 'leakMa', 'tempC'] as const;

const getCabinetHistory: ToolDef<{ cabinet: string; hours: number; metrics?: (typeof TELEMETRY_METRICS)[number][] }> = {
  name: 'get_cabinet_history',
  kind: 'read',
  description:
    'PAST of one cabinet over the last N hours (max 168): min / max / average values, likely on / off times (guessed from power), commands sent, and a leakage check against the cabinet own threshold (times over it, rising or not, on vs off, current while both branches are off). Use for "tối qua / hôm qua bật lúc mấy giờ", "dòng rò 24 giờ qua", "rò có tăng không", "có bất thường không".',
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
    // the cabinet's own leakage threshold and its state now, for the leakage check
    const detail = want.includes('leakMa')
      ? ctx.reads.cabinet(id, { signal: ctx.signal }).then((d) => d as unknown as Parameters<typeof leakReport>[1]).catch(() => null)
      : Promise.resolve(null);
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
    const leak = want.includes('leakMa') ? leakReport(points, await detail, threshold) : undefined;
    return {
      cabinet: r.cabinet.code, from: vnTime(from.toISOString()), to: vnTime(to.toISOString()), samples: points.length, stats,
      likelySwitches: peak > 0.05 ? switches.slice(-12) : 'công suất gần 0 suốt khoảng thời gian, không suy ra được giờ bật / tắt',
      note: 'Giờ bật / tắt suy ra từ công suất, chỉ là khả năng',
      ...(leak ? { chan_doan_ro: leak } : {}),
      commands: sent,
    };
  },
};

/**
 * Leakage against this cabinet's own threshold (Gemini review 2026-11-23, "chẩn đoán dòng rò"): how often and when it
 * went over, whether it is rising, on vs off, and a current while both branches are off now. Facts only: the cause is
 * for a field check, said as such.
 */
export function leakReport(
  points: TelemetryPoint[], detail: { state?: Record<string, unknown>; thresholds?: { leakMa?: { enabled: boolean; value: number } } } | null, onKw: number,
): Record<string, unknown> {
  const xs = points.filter((p) => typeof p.leakMa === 'number').map((p) => ({ ts: p.ts, v: p.leakMa as number, on: typeof p.pTotalKw === 'number' ? p.pTotalKw > onKw : null }));
  const limit = detail?.thresholds?.leakMa?.enabled ? detail.thresholds.leakMa.value : null;
  const out: Record<string, unknown> = { nguong_mA: limit ?? 'tủ chưa đặt ngưỡng rò' };
  if (xs.length) {
    const over = limit === null ? [] : xs.filter((p) => p.v > limit);
    out.cao_nhat_mA = Math.max(...xs.map((p) => p.v));
    if (limit !== null) {
      out.so_lan_vuot_nguong = over.length;
      if (over.length) Object.assign(out, { vuot_lan_dau: vnTime(over[0]!.ts), vuot_lan_cuoi: vnTime(over[over.length - 1]!.ts) });
    }
    // rising: the last third clearly above the first third (at least 1.5 times and 2 mA more)
    if (xs.length >= 6) {
      const third = Math.floor(xs.length / 3);
      const avg = (a: typeof xs) => a.reduce((s, p) => s + p.v, 0) / a.length;
      const first = avg(xs.slice(0, third));
      const last = avg(xs.slice(-third));
      out.xu_huong = last >= first * 1.5 && last - first >= 2 ? `tăng dần (từ khoảng ${first.toFixed(1)} lên ${last.toFixed(1)} mA)`
        : first >= last * 1.5 && first - last >= 2 ? `giảm dần (từ khoảng ${first.toFixed(1)} xuống ${last.toFixed(1)} mA)` : 'ổn định';
    }
    const lit = xs.filter((p) => p.on === true);
    const dark = xs.filter((p) => p.on === false);
    const mean = (a: typeof xs) => Math.round((a.reduce((s, p) => s + p.v, 0) / a.length) * 10) / 10;
    if (lit.length && dark.length) out.ro_trung_binh = { khi_den_sang_mA: mean(lit), khi_den_tat_mA: mean(dark) };
  } else out.du_lieu = 'không có số đo dòng rò trong khoảng thời gian này';
  // a current while both branches are off now: a contactor stuck closed, or a load before the contactor
  const st = detail?.state ?? {};
  const amps = ['iL1', 'iL2', 'iL3'].map((k) => st[k]).filter((x): x is number => typeof x === 'number');
  if (st.branch1On === false && st.branch2On === false && amps.some((a) => a > 0.5))
    out.dong_khi_tat = `Cả hai nhánh đang tắt nhưng vẫn có dòng ${Math.max(...amps).toFixed(1)} A: nên kiểm tra contactor và tải trước contactor.`;
  out.ghi_chu = 'Chỉ nói số liệu và điều bất thường; nguyên nhân thật cần kiểm tra hiện trường, nói rõ điều này nếu có bất thường.';
  return out;
}

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
    const titles = await titlesOf(ctx);
    const groups = new Map<string, { code: string; severity: string; district: string; count: number; cabinets: string[]; since: string; y_nghia: string }>();
    for (const a of page.items) {
      const k = `${a.code}|${a.districtName}`;
      const g = groups.get(k) ?? { code: a.code, severity: SEVERITY_VI[a.severity], district: a.districtName, count: 0, cabinets: [], since: a.startedAt, y_nghia: alarmLabel(a, titles).slice(a.code.length + 1) };
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
      // the meaning was left out ("E204, nghiêm trọng, Quận 1, tủ TL01.0039", test 2026-11-24)
      cach_noi: 'Mỗi nhóm nói: mã, ý nghĩa (y_nghia, ngắn gọn), quận, tủ.',
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
const AREA_PREFIX = /^(phuong|quan|huyen|xa|thi tran|tp|thanh pho) /;
const bareName = (a: AreaNode) => fold(a.name).replace(AREA_PREFIX, '');

/**
 * The areas of `pool` a name fits: a number only exactly ("2" is not "12" nor "24": "Quận 2", which does not exist,
 * listed Phường 2 … Phường 24 on 2026-11-23), else the same name, else a part of it, else one within two letters
 * ("khu đức" for Thủ Đức, misheard 2026-11-21).
 */
function fitAreas(pool: AreaNode[], name: string): { hits: AreaNode[]; heardAs?: string } {
  const q = fold(name).replace(AREA_PREFIX, '').trim();
  if (!q) return { hits: [] };
  if (/^\d+$/.test(q)) return { hits: pool.filter((a) => bareName(a) === q) };
  const same = pool.filter((a) => bareName(a) === q);
  if (same.length) return { hits: same };
  const part = pool.filter((a) => fold(a.name).includes(q));
  if (part.length) return { hits: part };
  const near = q.length >= 4 ? pool.filter((a) => editDistance(bareName(a), q) <= 2) : [];
  return near.length === 1 ? { hits: near, heardAs: near[0]!.name } : { hits: [] };
}

/** "Phường 2 (Quận 3)": a ward with its district, so wards of the same name can be told apart */
const withParent = (a: AreaNode, areas: AreaNode[]) => {
  const p = a.kind === 'ward' ? areas.find((x) => x.id === a.parentId) : undefined;
  return p ? `${a.name} (${p.name})` : a.name;
};

/**
 * The one ward or district a user named, set as the area in focus. "quận 1" is the district, not Phường 1 nor Quận 10;
 * "phường 2 quận 3", "Phường 2, Quận 3", "phường 2 của quận 3" is that ward of that district. Else an answer for the
 * model: not found (with the real names) or which one (wards with their district).
 */
async function pickArea(ctx: ToolContext, area: string): Promise<{ pick: AreaNode; areas: AreaNode[]; heardAs?: string } | { error: Record<string, unknown> }> {
  const areas = await areaTree(ctx);
  const named = areas.filter((a) => a.kind !== 'unit');
  const districts = named.filter((a) => a.kind === 'district');
  const districtNames = districts.map((a) => a.name);
  const f = fold(area).replace(/[(),;]/g, ' ').replace(/\s+/g, ' ').trim();
  const done = (pick: AreaNode, heardAs?: string) => {
    ctx.focus.area = { id: pick.id, name: pick.name };
    return { pick, areas, ...(heardAs ? { heardAs } : {}) };
  };
  const combo = /^((?:phuong|xa|thi tran) .+?) (?:cua |thuoc |o |tai )?((?:quan|huyen|tp|thanh pho) .+)$/.exec(f);
  if (combo) {
    const d = fitAreas(districts, combo[2]!);
    if (d.hits.length !== 1)
      return { error: { error: 'not_found', message: `Không có ${area.trim()}: không thấy quận "${combo[2]}". Nói rõ điều này và kể các quận có thật.`, cac_quan: districtNames } };
    const wards = named.filter((a) => a.kind === 'ward' && a.parentId === d.hits[0]!.id);
    const w = fitAreas(wards, combo[1]!);
    if (w.hits.length === 1) return done(w.hits[0]!, w.heardAs ?? d.heardAs);
    return { error: { error: 'not_found', message: `${d.hits[0]!.name} không có "${combo[1]}". Nói rõ điều này và kể vài phường có thật của quận đó.`, cac_phuong: wards.slice(0, 30).map((a) => a.name) } };
  }
  const said = /^(quan|huyen|tp|thanh pho)\b/.test(f) ? 'district' : /^(phuong|xa|thi tran)\b/.test(f) ? 'ward' : null;
  const { hits, heardAs } = fitAreas(said ? named.filter((a) => a.kind === said) : named, f);
  if (!hits.length)
    return {
      error: {
        error: 'not_found',
        message: said === 'district'
          ? `Không có "${area.trim()}" trong hệ thống. Nói rõ điều này và kể các quận có thật.`
          : `Không thấy khu vực "${area.trim()}". Hãy nói tên đúng và kể vài khu vực có thật.`,
        cac_quan: districtNames,
      },
    };
  if (hits.length === 1) return done(hits[0]!, heardAs);
  return {
    error: {
      error: 'ambiguous',
      message: 'Nhiều khu vực trùng tên. Hỏi lại người dùng muốn khu vực nào, đọc các lựa chọn đúng như ghi (kèm tên quận), để họ trả lời ví dụ "Phường 2 Quận 3".',
      choices: hits.slice(0, 8).map((a) => withParent(a, areas)),
    },
  };
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
      where = { khu_vuc: withParent(found.pick, found.areas), ...(found.heardAs ? { ghi_chu_ten: `Không có khu vực "${area}", hiểu là ${found.heardAs}. Nói rõ điều này.` } : {}) };
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

const SEV_RANK: Record<Alarm['severity'], number> = { critical: 0, major: 1, minor: 2 };

/**
 * The shift report of one area or the whole system (Gemini review 2026-11-23, "bản tin đầu ca"): what the operator
 * starting a shift needs in one answer instead of four questions: cabinets by state, open alarms (worst first), field
 * incidents (overdue first), lights against their schedule (E303). Each part says when it could not be read.
 */
const getShiftReport: ToolDef<{ area?: string }> = {
  name: 'get_shift_report',
  kind: 'read',
  description:
    'Shift report ("bản tin đầu ca", "giao ca", "tóm tắt ca") of one ward or district, or of the whole system when area is empty: cabinets by state, open alarms by severity with the worst ones, open and overdue field incidents, cabinets off schedule, commands and batches of the last 12 hours; for the whole system also the areas with the most alarms. Use when the user starts or hands over a shift.',
  schema: obj({ area: { type: 'string', description: 'Tên phường hoặc quận; bỏ trống = toàn hệ thống' } }),
  input: z.object({ area: z.string().trim().max(100).optional() }),
  async run(ctx, { area }) {
    const o = { signal: ctx.signal };
    const noRight = (e: unknown) => (e instanceof ApiProblem && e.status === 403 ? null : Promise.reject(e));
    const alarmsAll = async () => {
      const first = await ctx.reads.alarms({ active: true, size: 100, page: 1 }, o);
      const items = [...first.items];
      for (let p = 2; items.length < first.total && p <= MAX_ALARM_PAGES; p++) {
        const next = await ctx.reads.alarms({ active: true, size: 100, page: p }, o);
        if (!next.items.length) break;
        items.push(...next.items);
      }
      return { total: first.total, items };
    };
    const [cabinets, alarms, incidents] = await Promise.all([
      ctx.reads.mapCabinets(o),
      alarmsAll().catch(noRight),
      ctx.reads.incidents({ q: 'new_assigned_deferred', size: 100 }, o).then((p) => p.items).catch(noRight),
    ]);
    let inArea = (_c: CabinetSummary) => true;
    let where: Record<string, unknown> = { khu_vuc: 'toàn hệ thống' };
    if (!wholeSystem(area)) {
      const found = await pickArea(ctx, area!);
      if ('error' in found) return found.error;
      const id = found.pick.id;
      inArea = (c) => c.districtId === id || c.wardId === id;
      where = { khu_vuc: withParent(found.pick, found.areas), ...(found.heardAs ? { ghi_chu_ten: `Không có khu vực "${area}", hiểu là ${found.heardAs}. Nói rõ điều này.` } : {}) };
    }
    const scope = cabinets.filter(inArea);
    const ids = new Set(scope.map((c) => c.id));
    const n = (s: CabinetStatus) => scope.filter((c) => c.status === s).length;
    const now = Date.now();

    let canh_bao: unknown = 'không có quyền xem cảnh báo';
    let lech_lich: unknown = 'không có quyền xem cảnh báo';
    let khu_vuc_nhieu_canh_bao: unknown;
    if (alarms) {
      const titles = await titlesOf(ctx);
      const open = alarms.items.filter((a) => a.active && ids.has(a.cabinetId)).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.startedAt.localeCompare(a.startedAt));
      const sev = (s: Alarm['severity']) => open.filter((a) => a.severity === s).length;
      canh_bao = {
        tong_so: open.length,
        nghiem_trong: sev('critical'), quan_trong: sev('major'), nhe: sev('minor'),
        nang_nhat: open.slice(0, 3).map((a) => alarmBrief(a, titles)),
        // the model named one of the three, or none (tests 2026-11-24): the sentence is built here
        cau_mau: open.length
          ? `${open.length} cảnh báo đang mở (${[['nghiêm trọng', sev('critical')], ['quan trọng', sev('major')], ['nhẹ', sev('minor')]].filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}); nặng nhất: ${open.slice(0, 3).map((a) => `${alarmLabel(a, titles).replace(/ \(.*\)$/, '')} ở tủ ${a.cabinetCode}`).join('; ')}.`
          : 'Không có cảnh báo đang mở.',
        ...(alarms.items.length < alarms.total ? { ghi_chu: `Chỉ tính trên ${alarms.items.length} / ${alarms.total} cảnh báo mới nhất.` } : {}),
      };
      const mismatch = open.filter((a) => a.type === 'schedule_mismatch');
      lech_lich = { so_tu: mismatch.length, tu: mismatch.slice(0, 3).map((a) => a.cabinetCode) };
      if (wholeSystem(area)) {
        const by = new Map<string, number>();
        for (const a of open) by.set(a.districtName, (by.get(a.districtName) ?? 0) + 1);
        khu_vuc_nhieu_canh_bao = [...by].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([khu_vuc, so_canh_bao]) => ({ khu_vuc, so_canh_bao }));
      }
    }

    let su_co: unknown = 'không có quyền xem sự cố';
    if (incidents) {
      const mine = incidents.filter((i) => ids.has(i.cabinetId));
      const late = mine.filter((i) => i.deadline && new Date(i.deadline).getTime() < now).sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? ''));
      su_co = {
        dang_mo: mine.length,
        qua_han: late.length,
        qua_han_lau_nhat: late.slice(0, 3).map((i) => ({ code: i.code, cabinet: i.cabinetName, category: i.category, status: INCIDENT_STATUS_VI[i.status] ?? i.status, deadline: vnTime(i.deadline) })),
      };
    }

    // commands and batches of the last 12 hours (spec 7 briefing); the log needs log.view, without it the part says so
    const since = now - 12 * 3_600_000;
    let lenh_12_gio: unknown = 'không có quyền xem nhật ký lệnh';
    let lo_lenh_12_gio: unknown;
    try {
      const cmds: Command[] = [];
      for (let p = 1; p <= 3; p++) {
        const pg = await ctx.reads.commandLog(p, 100, o);
        const fresh = pg.items.filter((c) => Date.parse(c.queuedAt) >= since);
        cmds.push(...fresh);
        if (fresh.length < pg.items.length || pg.items.length < 100) break;
      }
      const mine = cmds.filter((c) => ids.has(c.cabinetId) && c.type !== 'SET_SCHEDULE' && c.type !== 'SET_TIME');
      const st = (...s: string[]) => mine.filter((c) => s.includes(c.status)).length;
      lenh_12_gio = {
        tong_so: mine.length,
        xong: st('confirmed', 'acked_unconfirmed'), loi: st('failed', 'timeout'), dang_cho: st('queued', 'sent', 'acked'),
        gan_nhat: mine.filter((c) => !c.batchId).slice(0, 3).map((c) => ({ tu: c.cabinetName, lenh: commandVi(c), ket_qua: COMMAND_STATUS_VI[c.status] ?? c.status, luc: vnTime(c.queuedAt) })),
        cau_mau: mine.length
          ? `12 giờ qua có ${mine.length} lệnh: ${st('confirmed', 'acked_unconfirmed')} xong, ${st('failed', 'timeout')} lỗi, ${st('queued', 'sent', 'acked')} đang chờ.`
          : '12 giờ qua không có lệnh nào.',
      };
      if (wholeSystem(area)) {
        const lots = (await ctx.reads.batches(o)).filter((b) => b.kind === 'control' && Date.parse(b.createdAt) >= since).sort((p, q) => q.createdAt.localeCompare(p.createdAt));
        lo_lenh_12_gio = {
          so_lo: lots.length,
          gan_nhat: lots.slice(0, 3).map((b) => ({
            lenh: b.command ? commandVi(b.command) : b.kind, so_tu: b.total, thanh_cong: b.succeeded, loi: b.failed, mat_ket_noi: b.offline, xong: b.finishedAt ? 'đã xong' : 'đang chạy', luc: vnTime(b.createdAt),
          })),
          // left out of the answer twice (tests 2026-11-24): the sentence is built here
          ...(lots[0] ? {
            cau_mau: `${lots.length} lô lệnh nhiều tủ; gần nhất lúc ${vnTime(lots[0].createdAt)}: ${lots[0].command ? commandVi(lots[0].command).toLowerCase() : lots[0].kind} ${lots[0].total} tủ, ${lots[0].succeeded} tủ đã nhận, ${lots[0].failed} lỗi, ${lots[0].offline} mất kết nối${lots[0].finishedAt ? '' : ', đang chạy'}.`,
          } : {}),
        };
      }
    } catch (e) {
      if (!(e instanceof ApiProblem && e.status === 403)) lenh_12_gio = 'không đọc được nhật ký lệnh lúc này';
    }

    // cabinets left in manual mode (spec 7 briefing, 2026-11-25): only a cabinet's own state has it, and only an
    // online cabinet's is current, so the online ones are read, 8 at a time, at most MANUAL_READS of them
    const online = scope.filter((c) => c.status !== 'offline');
    let chay_tay: unknown;
    if (online.length > MANUAL_READS) chay_tay = `không đếm: ${online.length} tủ trực tuyến, quá nhiều để đọc từng tủ`;
    else {
      const manual: CabinetSummary[] = [];
      let unread = 0;
      for (let k = 0; k < online.length; k += 8) {
        const part = online.slice(k, k + 8);
        const states = await Promise.all(part.map((c) => Promise.resolve().then(() => ctx.reads.cabinet(c.id, o)).then((d) => (d.state as Record<string, unknown> | undefined)?.manualMode, () => undefined)));
        states.forEach((m, j) => (m === true ? manual.push(part[j]!) : m === undefined ? unread++ : undefined));
      }
      chay_tay = {
        so_tu: manual.length,
        tu: manual.slice(0, 5).map((c) => c.code),
        cau_mau: manual.length
          ? `${manual.length} tủ đang chạy tay (sẽ tự về lịch ở mốc bật / tắt kế tiếp): ${manual.slice(0, 5).map((c) => c.code).join(', ')}${manual.length > 5 ? '…' : ''}.`
          : 'Không có tủ nào đang chạy tay.',
        ...(unread ? { ghi_chu: `${unread} tủ không đọc được trạng thái.` } : {}),
      };
    }

    return {
      ...where,
      tu: { tong_so: scope.length, truc_tuyen: scope.length - n('offline'), mat_ket_noi: n('offline'), dang_sang: n('on') + n('dimming'), dang_tat: n('off'), dang_loi: n('fault') },
      chay_tay,
      canh_bao,
      su_co,
      lech_lich,
      lenh_12_gio,
      ...(lo_lenh_12_gio ? { lo_lenh_12_gio } : {}),
      ...(khu_vuc_nhieu_canh_bao ? { khu_vuc_nhieu_canh_bao } : {}),
      ghi_chu:
        'Đây là bản tin đầu ca. Bắt đầu bằng tên khu vực (khu_vuc). Nói theo thứ tự: số tủ và số mất kết nối; chay_tay.cau_mau nếu có; cảnh báo: đọc canh_bao.cau_mau gần như nguyên văn; sự cố quá hạn; tủ lệch lịch; đọc lenh_12_gio.cau_mau, rồi lo_lenh_12_gio.cau_mau nếu có. Phần nào bằng 0 thì nói gọn "không có". Không nói ai gửi lệnh. Không đoán nguyên nhân.',
    };
  },
};

/** a command in the words of the confirmation card ("Tắt tay nhánh 1"); other device commands keep their name */
function commandVi(c: Pick<Command, 'type' | 'params'>): string {
  const on = c.params?.on === true;
  switch (c.type as string) {
    case 'MANUAL_ALL': return `${on ? 'Bật' : 'Tắt'} tay cả hai nhánh`;
    case 'MANUAL_BRANCH': return `${on ? 'Bật' : 'Tắt'} tay nhánh ${String(c.params?.branch ?? '?')}`;
    case 'AUTO': return 'Trả về chạy theo lịch';
    case 'PULSE_ON': return 'Bật tạm 15 phút';
    case 'DIAG': return 'Tự kiểm tra RS485';
    default: return String(c.type);
  }
}

/**
 * What was done to one cabinet over the last N days (Gemini review 2026-11-23, "lịch sử can thiệp theo tháng"):
 * commands by kind and result, alarms by code, field incidents. Never who sent or handled them (accounts, D60).
 */
const getCabinetInterventions: ToolDef<{ cabinet: string; days: number }> = {
  name: 'get_cabinet_interventions',
  kind: 'read',
  description:
    'What happened to one cabinet over the last N days (default 30, max 90): commands sent (how many of each kind, how many failed, the latest ones), alarms (how many of each code, which are still open), field incidents. Use for "tháng này tủ đó bị lỗi / bật tay mấy lần", "lịch sử can thiệp", "30 ngày qua tủ X thế nào". Never says who did anything.',
  schema: obj({ cabinet: CABINET_PROP, days: { type: 'integer', minimum: 1, description: 'Số ngày nhìn lại, mặc định 30, tối đa 90' } }, ['cabinet']),
  input: z.object({ cabinet: ref, days: z.coerce.number().int().min(1).default(30).transform((n) => Math.min(n, 90)) }),
  async run(ctx, { cabinet, days }) {
    const r = await resolveCabinet(ctx, cabinet);
    if (r.kind !== 'one') return notResolved(r);
    const id = r.cabinet.id;
    setFocus(ctx.focus, r.cabinet);
    const o = { signal: ctx.signal };
    const from = Date.now() - days * 86_400_000;
    const since = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() >= from;
    const noRight = (e: unknown) => (e instanceof ApiProblem && e.status === 403 ? null : Promise.reject(e));
    const [commands, alarms, incidents] = await Promise.all([
      ctx.reads.cabinetCommands(id, 200, o).catch(noRight),
      ctx.reads.cabinetAlarms(id, 100, o).catch(noRight),
      ctx.reads.incidents({ q: 'all', size: 100 }, o).then((p) => p.items).catch(noRight),
    ]);
    const count = <T,>(xs: T[], key: (x: T) => string) => {
      const m = new Map<string, number>();
      for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
      return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
    };
    const cmds = (commands ?? []).filter((c) => since(c.queuedAt));
    const failed = cmds.filter((c) => ['failed', 'timeout', 'cancelled'].includes(c.status as string));
    const al = (alarms ?? []).filter((a) => since(a.startedAt));
    const inc = (incidents ?? []).filter((i) => i.cabinetId === id && since(i.reportedAt));
    return {
      cabinet: r.cabinet.code, name: r.cabinet.name, so_ngay: days,
      lenh: commands === null ? 'không có quyền xem lệnh' : {
        tong_so: cmds.length,
        theo_loai: count(cmds, commandVi),
        that_bai: failed.length,
        gan_nhat: cmds.slice(0, 5).map((c) => ({ lenh: commandVi(c), ket_qua: COMMAND_STATUS_VI[c.status] ?? c.status, luc: vnTime(c.queuedAt) })),
      },
      canh_bao: alarms === null ? 'không có quyền xem cảnh báo' : {
        tong_so: al.length,
        theo_ma: count(al, (a) => `${a.code} ${viText(a.message)}`.trim()),
        dang_mo: al.filter((a) => a.active).map((a) => a.code),
        ...(alarms.length >= 100 ? { ghi_chu: 'Chỉ xem được 100 cảnh báo gần nhất.' } : {}),
      },
      su_co: incidents === null ? 'không có quyền xem sự cố' : inc.slice(0, 5).map((i) => ({ code: i.code, category: i.category, status: INCIDENT_STATUS_VI[i.status] ?? i.status, bao_luc: vnTime(i.reportedAt) })),
      ghi_chu: 'Không nói ai đã gửi lệnh hay xử lý sự cố. Nếu mọi phần đều 0 thì nói tủ không có can thiệp nào trong khoảng này.',
    };
  },
};

/**
 * Alarms over the last N days by area and code, and whether they are rising (Gemini review 2026-11-23, "xu hướng 30
 * ngày"). Built from the alarm list filtered by date: the server has no aggregate endpoint and Jarvis does not change the
 * server (spec G1). Counts alarms that started in the period, open or ended.
 */
const getAlarmTrends: ToolDef<{ area?: string; days: number }> = {
  name: 'get_alarm_trends',
  kind: 'read',
  description:
    'Alarm TRENDS over the last N days (default 30, max 90) for one ward or district or the whole system: how many alarms started, by area and by code, last 7 days against the 7 before (rising or falling), how long they stayed open, how many are still open. Use for "xu hướng", "30 ngày qua", "tháng qua khu vực nào nhiều lỗi nhất", "so với tuần trước".',
  schema: obj({ area: { type: 'string', description: 'Tên phường hoặc quận; bỏ trống = toàn hệ thống' }, days: { type: 'integer', minimum: 7, description: 'Số ngày, mặc định 30, tối đa 90' } }),
  input: z.object({ area: z.string().trim().max(100).optional(), days: z.coerce.number().int().min(7).default(30).transform((n) => Math.min(n, 90)) }),
  async run(ctx, { area, days }) {
    const o = { signal: ctx.signal };
    const now = Date.now();
    const from = new Date(now - days * 86_400_000).toISOString();
    const first = await ctx.reads.alarms({ from, size: 100, page: 1 }, o);
    const items = [...first.items];
    for (let p = 2; items.length < first.total && p <= MAX_ALARM_PAGES; p++) {
      const next = await ctx.reads.alarms({ from, size: 100, page: p }, o);
      if (!next.items.length) break;
      items.push(...next.items);
    }
    let rows = items.filter((a) => new Date(a.startedAt).getTime() >= now - days * 86_400_000);
    let where: Record<string, unknown> = { khu_vuc: 'toàn hệ thống' };
    let groupBy = (a: Alarm) => a.districtName || 'khu vực khác';
    if (!wholeSystem(area)) {
      const found = await pickArea(ctx, area!);
      if ('error' in found) return found.error;
      const id = found.pick.id;
      const cabinets = await ctx.reads.mapCabinets(o);
      const inArea = new Map(cabinets.filter((c) => c.districtId === id || c.wardId === id).map((c) => [c.id, c]));
      rows = rows.filter((a) => inArea.has(a.cabinetId));
      // inside a district: by ward; inside a ward: by cabinet
      const names = new Map(found.areas.map((x) => [x.id, x.name]));
      groupBy = found.pick.kind === 'district' ? (a) => names.get(inArea.get(a.cabinetId)?.wardId ?? '') ?? 'phường khác' : (a) => a.cabinetCode;
      where = { khu_vuc: withParent(found.pick, found.areas), ...(found.heardAs ? { ghi_chu_ten: `Không có khu vực "${area}", hiểu là ${found.heardAs}. Nói rõ điều này.` } : {}) };
    }
    const top = (key: (a: Alarm) => string, n: number) => {
      const m = new Map<string, number>();
      for (const a of rows) m.set(key(a), (m.get(key(a)) ?? 0) + 1);
      return [...m].sort((x, y) => y[1] - x[1]).slice(0, n).map(([ten, so]) => ({ ten, so }));
    };
    const inDays = (a: Alarm, d0: number, d1: number) => {
      const t = new Date(a.startedAt).getTime();
      return t >= now - d1 * 86_400_000 && t < now - d0 * 86_400_000;
    };
    const last7 = rows.filter((a) => inDays(a, 0, 7)).length;
    const prev7 = rows.filter((a) => inDays(a, 7, 14)).length;
    const ended = rows.filter((a) => a.endedAt);
    const hours = ended.map((a) => (new Date(a.endedAt!).getTime() - new Date(a.startedAt).getTime()) / 3_600_000).sort((x, y) => x - y);
    return {
      ...where,
      so_ngay: days,
      tong_so_canh_bao: rows.length,
      ...(items.length < first.total ? { ghi_chu_du_lieu: `Chỉ tính trên ${items.length} / ${first.total} cảnh báo mới nhất trong khoảng này.` } : {}),
      nhieu_nhat_theo_khu_vuc: top(groupBy, 5),
      nhieu_nhat_theo_ma: top((a) => `${a.code} ${viText(a.message)}`.trim(), 5),
      bay_ngay_qua_so_voi_bay_ngay_truoc: { bay_ngay_qua: last7, bay_ngay_truoc: prev7, xu_huong: last7 > prev7 * 1.2 && last7 - prev7 >= 2 ? 'tăng' : prev7 > last7 * 1.2 && prev7 - last7 >= 2 ? 'giảm' : 'gần như không đổi' },
      thoi_gian_mo_trung_vi_gio: hours.length ? Math.round(hours[Math.floor(hours.length / 2)]! * 10) / 10 : null,
      con_mo: rows.filter((a) => a.active).length,
      // "khu vực Phú Nhuận có nhiều lỗi nhất" with no number (test 2026-11-24)
      ghi_chu: 'Chỉ có số cảnh báo; không có số giờ mất kết nối hay điện năng theo ngày. Trả lời kèm con số: khu vực (hoặc mã) đứng đầu với số cảnh báo, 2 cái tiếp theo, và xu hướng 7 ngày. Không đoán nguyên nhân.',
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
    return { cabinet: r.cabinet.code, ...scheduleVi(s), ...(s.appliedAt ? { da_ap_dung_luc: vnTime(s.appliedAt as string) } : {}) };
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
  getSystemOverview, getCabinet, getCabinetHistory, listAlarms, explainAlarmCode, getAreaCabinets, findScheduleMismatch, getShiftReport, getCabinetInterventions, getAlarmTrends, getSchedule, listIncidents,
] as unknown as ToolDef[];

/** Not offered to the model: list_areas, find_cabinets run only through the keyword router; get_command_status comes back with actions (milestone 4). */
export const SPARE_TOOLS = [findCabinets, listAreas, getCommandStatus] as unknown as ToolDef[];
