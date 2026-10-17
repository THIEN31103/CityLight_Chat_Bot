// MSW handlers implementing the /api/v1 contract of docs/spec.md section 11 against the in-browser mock DB.
import { http, HttpResponse, delay, type PathParams } from 'msw';
import type { Alarm, CommandType, DimmingProfile, Incident, LampGroup, Schedule, Thresholds, User } from '@citylight/shared';
import { DEFAULT_FIELD_MAP } from '@citylight/shared';
import {
  MockApiError,
  batchItems,
  batches,
  cabinetById,
  capabilitiesOf,
  commands,
  createBatch,
  createCommand,
  energyEstimate,
  groupDimming,
  mapStats,
  polesOf,
  retryBatchFailed,
  scheduleOf,
  summary,
  telemetrySeries,
  thresholdsOf,
  dimming,
  defaultDimming,
  zoneSchedules,
  refreshState,
  diagnosticsOf,
} from './db';
import { activityLogs, addLog, alarms, areas, cabinets, districtName, incidents, managementUnits, states, users, wardName, zones, defaultSchedule } from './seed';

const API = '/api/v1';
// Mock session survives page reloads (the real API uses an httpOnly session cookie).
const SESSION_KEY = 'cl.mockSession';
function loadSession(): User | null {
  try {
    const id = sessionStorage.getItem(SESSION_KEY);
    return users.find((u) => u.id === id) ?? null;
  } catch {
    return null;
  }
}
let session: User | null = loadSession();
const sessionRef = {
  get current() {
    return session;
  },
  set current(u: User | null) {
    session = u;
    try {
      if (u) sessionStorage.setItem(SESSION_KEY, u.id);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* storage blocked */
    }
  },
};
let pendingTotpUser: User | null = null;

/** Hybrid mode: the real API owns auth; fallback mock routes act as that user (not persisted). */
export function setMockSessionUser(u: User) {
  session = u;
}
const favorites: { id: string; name: string; center: { lat: number; lng: number }; zoom: number }[] = [
  { id: 'f1', name: 'Trung tâm Quận 1', center: { lat: 10.7769, lng: 106.7009 }, zoom: 14 },
];

function problem(status: number, code: string, detail: string) {
  return HttpResponse.json({ type: `https://citylight.local/errors/${code}`, title: code, status, detail, code }, { status });
}

function requireUser() {
  if (!sessionRef.current) throw new MockApiError(401, 'unauthenticated', 'Chưa đăng nhập');
  return sessionRef.current;
}

type Info = { request: Request; params: Record<string, string> };

function wrap(fn: (info: Info) => Response | Promise<Response>) {
  return async (info: { request: Request; params: PathParams }) => {
    await delay(120 + Math.random() * 180);
    try {
      return await fn({ request: info.request, params: info.params as Record<string, string> });
    } catch (e) {
      if (e instanceof MockApiError) return problem(e.status, e.code, e.message);
      throw e;
    }
  };
}

function paginate<T>(items: T[], url: URL) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size') ?? 20)));
  return { items: items.slice((page - 1) * size, page * size), total: items.length, page, size };
}

function inRange(iso: string, url: URL) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from && iso < from) return false;
  if (to && iso > to) return false;
  return true;
}

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export const handlers = [
  // ---------- Auth ----------
  http.post(`${API}/auth/login`, wrap(async ({ request }: { request: Request }) => {
    const body = (await request.json()) as { email: string; password: string };
    const u = users.find((x) => x.email.toLowerCase() === body.email.trim().toLowerCase());
    if (!u || body.password !== 'demo') return problem(401, 'invalid_credentials', 'Email hoặc mật khẩu không đúng');
    if (!u.active) return problem(403, 'account_disabled', 'Tài khoản đã bị khóa');
    if (u.totpEnabled) {
      pendingTotpUser = u;
      return HttpResponse.json({ requires2fa: true });
    }
    sessionRef.current = u;
    return HttpResponse.json({ requires2fa: false, user: u });
  })),
  http.post(`${API}/auth/2fa/verify`, wrap(async ({ request }: { request: Request }) => {
    const body = (await request.json()) as { code: string };
    if (!pendingTotpUser || body.code !== '123456') return problem(401, 'invalid_totp', 'Mã xác thực không đúng');
    sessionRef.current = pendingTotpUser;
    pendingTotpUser = null;
    return HttpResponse.json({ user: sessionRef.current });
  })),
  http.post(`${API}/auth/logout`, wrap(() => {
    sessionRef.current = null;
    return new HttpResponse(null, { status: 204 });
  })),
  http.get(`${API}/auth/me`, wrap(() => HttpResponse.json(requireUser()))),
  http.post(`${API}/me/password`, wrap(() => {
    const u = requireUser();
    u.passwordChangeRequired = false;
    addLog(u.email, 'Đổi mật khẩu', 'user', u.email, null, null);
    return new HttpResponse(null, { status: 204 });
  })),
  http.post(`${API}/auth/2fa/setup`, wrap(() =>
    HttpResponse.json({ otpauthUrl: 'otpauth://totp/CityLight:demo?secret=JBSWY3DPEHPK3PXP&issuer=CityLight', secret: 'JBSWY3DPEHPK3PXP' }),
  )),
  http.post(`${API}/auth/2fa/disable`, wrap(async ({ request }: { request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as { password?: string };
    if (u.totpRequired) return problem(403, 'totp_required_by_role', 'Vai trò của bạn bắt buộc 2FA, không thể tắt');
    if (body.password !== 'demo') return problem(422, 'invalid_password', 'Mật khẩu không đúng');
    u.totpEnabled = false;
    return HttpResponse.json(u);
  })),
  http.post(`${API}/auth/2fa/enable`, wrap(async ({ request }: { request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as { code?: string };
    if (body.code !== '123456') return problem(422, 'invalid_totp', 'Mã xác thực không đúng (mock: 123456)');
    u.totpEnabled = true;
    return HttpResponse.json({ user: u, recoveryCodes: ['8F2K-MLQA', 'ZAP9-77XC', 'M4T2-QQ8H', 'R7YH-WB2D', 'K7QX-M2PA', 'H3NB-9TRE', 'PQ4W-ZX8C', 'L2DF-6YUJ'] });
  })),

  // ---------- Map ----------
  http.get(`${API}/map/stats`, wrap(() => HttpResponse.json(mapStats()))),
  http.get(`${API}/map/cabinets`, wrap(() => HttpResponse.json(cabinets.map(summary)))),
  http.get(`${API}/map/assets`, wrap(({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const [w, s, e, n] = (url.searchParams.get('bbox') ?? '0,0,0,0').split(',').map(Number) as [number, number, number, number];
    const inside = cabinets.filter((c) => c.location.lng >= w && c.location.lng <= e && c.location.lat >= s && c.location.lat <= n).slice(0, 80);
    return HttpResponse.json(inside.flatMap((c) => polesOf(c.id).map((p) => ({ ...p, cabinetName: c.name }))));
  })),
  http.get(`${API}/search`, wrap(({ request }: { request: Request }) => {
    const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase();
    if (!q) return HttpResponse.json([]);
    const res = cabinets
      .filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q) || c.ltid.toLowerCase().includes(q) || c.address.toLowerCase().includes(q))
      .slice(0, 10)
      .map(summary);
    return HttpResponse.json(res);
  })),
  http.get(`${API}/favorites`, wrap(() => HttpResponse.json(favorites))),
  http.post(`${API}/favorites`, wrap(async ({ request }: { request: Request }) => {
    const body = (await request.json()) as Omit<(typeof favorites)[number], 'id'>;
    const f = { ...body, id: `f${Date.now()}` };
    favorites.push(f);
    return HttpResponse.json(f, { status: 201 });
  })),
  http.delete(`${API}/favorites/:id`, wrap(({ params }: { params: Record<string, string> }) => {
    const i = favorites.findIndex((f) => f.id === params.id);
    if (i >= 0) favorites.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  })),
  http.post(`${API}/map/edits`, wrap(async ({ request }: { request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as { moves: { cabinetId: string; lat: number; lng: number }[] };
    for (const m of body.moves) {
      const c = cabinetById.get(m.cabinetId);
      if (!c) continue;
      const old = `${c.location.lat.toFixed(6)}, ${c.location.lng.toFixed(6)}`;
      c.location = { lat: m.lat, lng: m.lng };
      addLog(u.email, 'Cập nhật vị trí tủ', 'cabinet', `${c.code} - ${c.name}`, old, `${m.lat.toFixed(6)}, ${m.lng.toFixed(6)}`);
    }
    return HttpResponse.json({ saved: body.moves.length });
  })),

  // ---------- Hierarchy ----------
  http.get(`${API}/areas/tree`, wrap(() => HttpResponse.json({ areas, unassigned: cabinets.filter((c) => !c.districtId).length }))),
  http.get(`${API}/areas/:id/cabinets`, wrap(({ params }: { params: Record<string, string> }) => {
    const id = params.id;
    const list = id === 'unassigned' ? cabinets.filter((c) => !c.districtId) : cabinets.filter((c) => c.wardId === id);
    return HttpResponse.json(list.map(summary));
  })),
  http.get(`${API}/cabinets/nearby`, wrap(({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const center = { lat: Number(url.searchParams.get('lat')), lng: Number(url.searchParams.get('lng')) };
    const radius = Number(url.searchParams.get('radius') ?? 2000);
    const list = cabinets
      .map((c) => ({ c, d: haversineM(center, c.location) }))
      .filter((x) => x.d <= radius)
      .sort((a, b) => a.d - b.d)
      .slice(0, 100)
      .map((x) => ({ ...summary(x.c), distanceM: Math.round(x.d) }));
    return HttpResponse.json(list);
  })),
  http.get(`${API}/zones`, wrap(() => HttpResponse.json(zones))),
  http.get(`${API}/management-units`, wrap(() => HttpResponse.json(managementUnits))),

  // ---------- Cabinets ----------
  http.get(`${API}/cabinets`, wrap(({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    let list = cabinets.map((c) => ({ ...summary(c), districtName: districtName(c), fwProfile: c.fwProfile, lastSeenAt: states.get(c.id)!.lastSeenAt }));
    if (status) list = list.filter((c) => c.status === status);
    if (q) list = list.filter((c) => c.name.toLowerCase().includes(q) || c.ltid.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
    return HttpResponse.json(paginate(list, url));
  })),
  http.get(`${API}/cabinets/:id`, wrap(({ params }: { params: Record<string, string> }) => {
    const c = cabinetById.get(params.id!);
    if (!c) return problem(404, 'not_found', 'Không tìm thấy tủ');
    return HttpResponse.json({
      cabinet: { ...c, districtName: districtName(c), wardName: wardName(c) },
      state: refreshState(c.id),
      capabilities: capabilitiesOf(c),
      schedule: scheduleOf(c.id),
      thresholds: thresholdsOf(c.id),
    });
  })),
  http.patch(`${API}/cabinets/:id`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    const u = requireUser();
    const c = cabinetById.get(params.id!)!;
    const body = (await request.json()) as Record<string, unknown>;
    Object.assign(c, body);
    addLog(u.email, 'Cập nhật thông tin tủ', 'cabinet', `${c.code} - ${c.name}`, null, JSON.stringify(body));
    return HttpResponse.json(c);
  })),
  http.get(`${API}/cabinets/:id/telemetry`, wrap(({ params, request }: { params: Record<string, string>; request: Request }) => {
    const url = new URL(request.url);
    const metrics = (url.searchParams.get('metrics') ?? 'vL1').split(',');
    const to = Date.parse(url.searchParams.get('to') ?? new Date().toISOString());
    const from = Date.parse(url.searchParams.get('from') ?? new Date(to - 6 * 3600000).toISOString());
    return HttpResponse.json(telemetrySeries(params.id!, metrics, from, to));
  })),
  http.get(`${API}/cabinets/:id/energy`, wrap(({ params, request }: { params: Record<string, string>; request: Request }) => {
    const range = (new URL(request.url).searchParams.get('range') ?? 'day') as 'day' | '30d';
    return HttpResponse.json({ estimated: true, points: energyEstimate(params.id!, range) });
  })),
  http.put(`${API}/cabinets/:id/schedule`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as Schedule;
    const cmd = createCommand(params.id!, 'SET_SCHEDULE', { ...body, inheritedFromZone: false } as unknown as Record<string, unknown>, u.email);
    return HttpResponse.json(cmd, { status: 202 });
  })),
  http.put(`${API}/cabinets/:id/thresholds`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as Thresholds;
    const c = cabinetById.get(params.id!)!;
    Object.assign(thresholdsOf(c.id), body);
    addLog(u.email, 'Sửa ngưỡng cảnh báo', 'cabinet', `${c.code} - ${c.name}`, null, 'Lưu ở máy chủ');
    return HttpResponse.json(thresholdsOf(c.id));
  })),
  http.get(`${API}/cabinets/:id/dimming`, wrap(({ params, request }: { params: Record<string, string>; request: Request }) => {
    const group = Number(new URL(request.url).searchParams.get('group') ?? 0) as LampGroup;
    const key = `${params.id}:${group}`;
    return HttpResponse.json(dimming.get(key) ?? { ...groupDimming.get(group)!, inheritedFromZone: true });
  })),
  http.put(`${API}/cabinets/:id/dimming`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as DimmingProfile;
    dimming.set(`${params.id}:${body.lampGroup}`, { ...body, inheritedFromZone: false });
    const c = cabinetById.get(params.id!)!;
    addLog(u.email, 'Lưu hồ sơ tiết giảm', 'cabinet', `${c.code} - ${c.name}`, null, 'Chưa gửi xuống tủ (thiết bị chưa hỗ trợ)');
    return HttpResponse.json(dimming.get(`${params.id}:${body.lampGroup}`));
  })),
  http.get(`${API}/cabinets/:id/alarms`, wrap(({ params, request }: { params: Record<string, string>; request: Request }) => {
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 20);
    return HttpResponse.json(alarms.filter((a) => a.cabinetId === params.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit));
  })),
  http.get(`${API}/cabinets/:id/diagnostics`, wrap(({ params }) => HttpResponse.json(diagnosticsOf(params.id!)))),
  http.get(`${API}/cabinets/:id/commands`, wrap(({ params }: { params: Record<string, string> }) =>
    HttpResponse.json(commands.filter((c) => c.cabinetId === params.id).slice(0, 50)),
  )),
  http.get(`${API}/cabinets/:id/lamps`, wrap(({ params }: { params: Record<string, string> }) => {
    const poles = polesOf(params.id!);
    const lamps = poles.flatMap((p) =>
      Array.from({ length: p.lampCount }, (_, k) => ({
        id: `${p.id}-L${k + 1}`,
        code: `L${k + 1}`,
        poleCode: p.code,
        routeCode: p.routeCode,
        branch: p.branch,
        lampGroup: 0,
        ratedPowerW: 150,
        isSmart: false,
        location: p.location,
      })),
    );
    return HttpResponse.json(lamps);
  })),

  // ---------- Commands ----------
  http.post(`${API}/cabinets/:id/commands`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as { type: CommandType; params: Record<string, unknown>; queueIfOffline?: boolean };
    const cmd = createCommand(params.id!, body.type, body.params ?? {}, u.email, {
      idempotencyKey: request.headers.get('Idempotency-Key') ?? undefined,
      queueIfOffline: body.queueIfOffline,
    });
    return HttpResponse.json(cmd, { status: 202 });
  })),
  http.get(`${API}/commands/:id`, wrap(({ params }: { params: Record<string, string> }) => {
    const c = commands.find((x) => x.id === params.id);
    return c ? HttpResponse.json(c) : problem(404, 'not_found', 'Không tìm thấy lệnh');
  })),
  http.get(`${API}/commands`, wrap(({ request }: { request: Request }) => HttpResponse.json(paginate(commands, new URL(request.url))))),
  http.post(`${API}/command-batches`, wrap(async ({ request }: { request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as { kind: 'schedule' | 'dimming' | 'time'; zoneIds: string[] };
    const ids = cabinets.filter((c) => body.zoneIds.includes(c.zone1Id ?? '') || body.zoneIds.includes(c.zone2Id ?? '')).map((c) => c.id);
    const scope = zones.filter((z) => body.zoneIds.includes(z.id)).map((z) => z.name).join(', ');
    return HttpResponse.json(createBatch(body.kind, scope, ids, u.email), { status: 202 });
  })),
  http.get(`${API}/command-batches`, wrap(() => HttpResponse.json(batches))),
  http.get(`${API}/command-batches/:id`, wrap(({ params }: { params: Record<string, string> }) => {
    const b = batches.find((x) => x.id === params.id);
    if (!b) return problem(404, 'not_found', 'Không tìm thấy lô lệnh');
    return HttpResponse.json({ batch: b, items: batchItems.get(b.id) ?? [] });
  })),
  http.post(`${API}/command-batches/:id/retry-failed`, wrap(({ params }: { params: Record<string, string> }) => {
    const u = requireUser();
    return HttpResponse.json(retryBatchFailed(params.id!, u.email), { status: 202 });
  })),
  http.post(`${API}/command-batches/preview`, wrap(async ({ request }: { request: Request }) => {
    const body = (await request.json()) as { zoneIds: string[] };
    const list = cabinets.filter((c) => body.zoneIds.includes(c.zone1Id ?? '') || body.zoneIds.includes(c.zone2Id ?? ''));
    return HttpResponse.json({ total: list.length, offline: list.filter((c) => !states.get(c.id)!.online).length });
  })),

  // ---------- Alarms ----------
  http.get(`${API}/alarms`, wrap(({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const active = url.searchParams.get('active');
    const type = url.searchParams.get('type');
    const severity = url.searchParams.get('severity');
    const district = url.searchParams.get('district');
    let list: Alarm[] = [...alarms].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (active === 'true') list = list.filter((a) => a.active);
    if (type) list = list.filter((a) => a.type === type);
    if (severity) list = list.filter((a) => a.severity === severity);
    if (district) list = list.filter((a) => a.districtName === district);
    list = list.filter((a) => inRange(a.startedAt, url));
    return HttpResponse.json(paginate(list, url));
  })),
  http.post(`${API}/alarms/:id/ack`, wrap(({ params }: { params: Record<string, string> }) => {
    const u = requireUser();
    const a = alarms.find((x) => x.id === params.id);
    if (!a) return problem(404, 'not_found', 'Không tìm thấy cảnh báo');
    a.ackedBy = u.fullName;
    a.ackedAt = new Date().toISOString();
    addLog(u.email, 'Xác nhận cảnh báo', 'alarm', `${a.cabinetCode} - ${a.message}`, null, null);
    return HttpResponse.json(a);
  })),

  // ---------- Incidents ----------
  http.get(`${API}/incidents`, wrap(({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const q = url.searchParams.get('q') ?? 'all';
    const area = url.searchParams.get('district');
    let list: Incident[] = incidents;
    if (q !== 'all') {
      const set = q.split('_');
      list = list.filter((i) => set.includes(i.status));
    }
    if (area) list = list.filter((i) => i.districtName === area);
    list = list.filter((i) => inRange(i.reportedAt, url));
    return HttpResponse.json(paginate(list, url));
  })),
  http.get(`${API}/incidents/report`, wrap(({ request }: { request: Request }) => {
    const month = new URL(request.url).searchParams.get('month') ?? new Date().toISOString().slice(0, 7);
    const list = incidents.filter((i) => i.reportedAt.startsWith(month));
    const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    const byDay = Array.from({ length: days }, (_, d) => {
      const day = `${month}-${String(d + 1).padStart(2, '0')}`;
      const items = list.filter((i) => i.reportedAt.startsWith(day));
      return { day: d + 1, new: items.filter((i) => i.status === 'new').length, assigned: items.filter((i) => i.status === 'assigned').length, done: items.filter((i) => i.status === 'resolved' || i.status === 'closed').length, deferred: items.filter((i) => i.status === 'deferred').length };
    });
    const byDistrict: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    list.forEach((i) => {
      byDistrict[i.districtName] = (byDistrict[i.districtName] ?? 0) + 1;
      byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
    });
    const resolved = list.filter((i) => i.resolvedAt);
    const avgHours = resolved.length ? resolved.reduce((s, i) => s + (Date.parse(i.resolvedAt!) - Date.parse(i.reportedAt)) / 3600000, 0) / resolved.length : 0;
    const overdue = list.filter((i) => i.status === 'assigned' && i.deadline && Date.parse(i.deadline) < Date.now()).length;
    return HttpResponse.json({ month, total: list.length, byDay, byDistrict, byCategory, avgResolveHours: avgHours, overdue });
  })),
  http.get(`${API}/incidents/:id`, wrap(({ params }: { params: Record<string, string> }) => {
    const i = incidents.find((x) => x.id === params.id);
    return i ? HttpResponse.json(i) : problem(404, 'not_found', 'Không tìm thấy sự cố');
  })),
  http.post(`${API}/incidents`, wrap(async ({ request }: { request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as { cabinetId: string; category: string; content: string };
    const c = cabinetById.get(body.cabinetId)!;
    const inc: Incident = {
      id: `inc${Date.now()}`,
      code: `SC${String(incidents.length + 1).padStart(5, '0')}`,
      cabinetId: c.id,
      cabinetName: c.name,
      districtName: districtName(c),
      wardName: wardName(c),
      source: 'manual',
      category: body.category,
      content: body.content,
      location: c.location,
      reportedBy: u.fullName,
      reportedAt: new Date().toISOString(),
      status: 'new',
      assignee: null,
      deadline: null,
      resolution: null,
      resolvedAt: null,
      photos: [],
      events: [{ at: new Date().toISOString(), by: u.fullName, action: 'Tạo sự cố', note: null }],
    };
    incidents.unshift(inc);
    addLog(u.email, 'Tạo sự cố', 'incident', inc.code, null, inc.category);
    return HttpResponse.json(inc, { status: 201 });
  })),
  http.post(`${API}/incidents/:id/transition`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    const u = requireUser();
    const inc = incidents.find((x) => x.id === params.id)!;
    const body = (await request.json()) as { to: Incident['status']; note?: string; assignee?: string; deadline?: string; resolution?: string };
    const label: Record<Incident['status'], string> = { new: 'Mở lại', assigned: 'Giao xử lý', deferred: 'Chưa cần xử lý', resolved: 'Đã xử lý', closed: 'Đóng sự cố' };
    inc.status = body.to;
    if (body.assignee) inc.assignee = body.assignee;
    if (body.deadline) inc.deadline = body.deadline;
    if (body.to === 'resolved') {
      inc.resolution = body.resolution ?? body.note ?? null;
      inc.resolvedAt = new Date().toISOString();
    }
    inc.events.push({ at: new Date().toISOString(), by: u.fullName, action: label[body.to], note: body.note ?? null });
    addLog(u.email, label[body.to], 'incident', inc.code, null, body.note ?? null);
    return HttpResponse.json(inc);
  })),

  // ---------- Schedules / dimming (zone level) ----------
  http.get(`${API}/zones/:id/schedule`, wrap(({ params }: { params: Record<string, string> }) => {
    if (!zoneSchedules.has(params.id!)) zoneSchedules.set(params.id!, { ...defaultSchedule(), inheritedFromZone: false });
    return HttpResponse.json(zoneSchedules.get(params.id!));
  })),
  http.put(`${API}/zones/:id/schedule`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as Schedule;
    zoneSchedules.set(params.id!, body);
    const z = zones.find((x) => x.id === params.id)!;
    addLog(u.email, 'Lưu lịch vùng', 'zone', z.name, null, body.source === 'astronomical' ? 'Lịch thiên văn' : `${body.on1} → ${body.off1}`);
    return HttpResponse.json(body);
  })),
  http.get(`${API}/dimming-profiles/:group`, wrap(({ params }: { params: Record<string, string> }) =>
    HttpResponse.json(groupDimming.get(Number(params.group) as LampGroup) ?? defaultDimming(Number(params.group) as LampGroup)),
  )),
  http.put(`${API}/dimming-profiles/:group`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as DimmingProfile;
    groupDimming.set(Number(params.group) as LampGroup, body);
    addLog(u.email, 'Lưu hồ sơ tiết giảm nhóm', 'dimming', `Nhóm ${params.group}`, null, null);
    return HttpResponse.json(body);
  })),

  // ---------- Logs ----------
  http.get(`${API}/logs/activity`, wrap(({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const user = url.searchParams.get('user');
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    let list = activityLogs;
    if (user) list = list.filter((l) => l.userEmail === user);
    if (q) list = list.filter((l) => l.targetName.toLowerCase().includes(q) || l.action.toLowerCase().includes(q));
    list = list.filter((l) => inRange(l.ts, url));
    return HttpResponse.json(paginate(list, url));
  })),

  // ---------- Admin ----------
  http.get(`${API}/users`, wrap(() => HttpResponse.json(users))),
  http.post(`${API}/users`, wrap(async ({ request }: { request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as Partial<User>;
    const role = body.role ?? 'viewer';
    const nu: User = {
      id: `u${Date.now()}`, email: body.email ?? '', fullName: body.fullName ?? '', role, scopeAll: role === 'admin' || !!body.scopeAll, scopeAreaIds: body.scopeAreaIds ?? [],
      totpEnabled: false, totpRequired: role === 'admin' || role === 'operator', passwordChangeRequired: true, active: true, lastLoginAt: null,
    };
    users.push(nu);
    addLog(u.email, 'Tạo người dùng', 'user', nu.email, null, nu.role);
    return HttpResponse.json({ user: nu, tempPassword: 'demo' }, { status: 201 });
  })),
  http.patch(`${API}/users/:id`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    const u = requireUser();
    const target = users.find((x) => x.id === params.id)!;
    const body = (await request.json()) as Partial<User>;
    Object.assign(target, body);
    if (body.role) target.totpRequired = body.role === 'admin' || body.role === 'operator';
    addLog(u.email, 'Cập nhật người dùng', 'user', target.email, null, JSON.stringify(body));
    return HttpResponse.json(target);
  })),
  http.post(`${API}/users/:id/reset-password`, wrap(({ params }: { params: Record<string, string> }) => {
    const target = users.find((x) => x.id === params.id)!;
    target.passwordChangeRequired = true;
    return HttpResponse.json({ user: target, tempPassword: 'demo' });
  })),
  http.post(`${API}/users/:id/unlock`, wrap(({ params }: { params: Record<string, string> }) => HttpResponse.json(users.find((x) => x.id === params.id)))),
  http.post(`${API}/users/:id/reset-2fa`, wrap(({ params }: { params: Record<string, string> }) => {
    const target = users.find((x) => x.id === params.id)!;
    target.totpEnabled = false;
    return HttpResponse.json(target);
  })),
  http.get(`${API}/devices/unknown`, wrap(() =>
    HttpResponse.json([
      { ltid: 'CTY9001', firstSeenAt: new Date(Date.now() - 3600000).toISOString(), lastSeenAt: new Date().toISOString(), frames: 352, imei: '861234567890123' },
      { ltid: 'CTY9002', firstSeenAt: new Date(Date.now() - 86400000).toISOString(), lastSeenAt: new Date(Date.now() - 600000).toISOString(), frames: 8120, imei: '861234567890456' },
    ]),
  )),
  http.get(`${API}/field-map`, wrap(() => HttpResponse.json(DEFAULT_FIELD_MAP))),
  http.get(`${API}/alarm-rules`, wrap(() =>
    HttpResponse.json([
      { type: 'offline', severity: 'critical', condition: 'Không có frame > 60 s', enabled: true },
      { type: 'plc_lost', severity: 'critical', condition: 'PCON=0 > 30 s', enabled: true },
      { type: 'pm_lost', severity: 'major', condition: 'MCON=0 > 30 s', enabled: true },
      { type: 'over_voltage', severity: 'major', condition: 'U pha > ngưỡng cao, debounce 30 s', enabled: true },
      { type: 'under_voltage', severity: 'major', condition: 'U pha < ngưỡng thấp, debounce 30 s', enabled: true },
      { type: 'no_load', severity: 'major', condition: 'Nhánh sáng nhưng I < ngưỡng không tải', enabled: true },
      { type: 'leak_current', severity: 'critical', condition: 'CTVL > ngưỡng mA', enabled: true },
      { type: 'over_temp', severity: 'minor', condition: 'CTTE > ngưỡng °C', enabled: true },
      { type: 'clock_drift', severity: 'minor', condition: '|PTIM − giờ máy chủ| > 5 phút', enabled: true },
      { type: 'schedule_mismatch', severity: 'major', condition: 'Trạng thái nhánh lệch lịch > 10 phút (bỏ qua khi PMAN=1)', enabled: true },
      { type: 'door_open', severity: 'major', condition: 'PDOR=1 (chờ firmware)', enabled: false },
      { type: 'contactor_fault', severity: 'critical', condition: 'PFLT=1 (chờ firmware)', enabled: false },
    ]),
  )),
  http.get(`${API}/system/stats`, wrap(() => {
    const online = cabinets.filter((c) => states.get(c.id)!.online).length;
    return HttpResponse.json({
      cabinetsOnline: online,
      cabinetsTotal: cabinets.length,
      msgPerSec: +(online / 10 + Math.random() * 3).toFixed(1),
      ingestLagMs: Math.round(80 + Math.random() * 120),
      commandQueue: commands.filter((c) => c.status === 'queued' || c.status === 'sent').length,
      ackErrors24h: commands.filter((c) => c.status === 'failed' || c.status === 'timeout').length,
      dbSizeGb: 1.8,
      brokerConnections: online + 3,
      uptimeHours: 72.4,
    });
  })),
  http.get(`${API}/server-time`, () => HttpResponse.json({ now: new Date().toISOString() })),
];
