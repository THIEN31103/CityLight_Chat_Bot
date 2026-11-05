// MSW handlers implementing the /api/v1 contract of docs/spec.md section 11 against the in-browser mock DB.
import { http, HttpResponse, delay, type PathParams } from 'msw';
import type { Alarm, CommandBatch, CommandType, DimmingProfile, GpsDriftItem, GpsSuggestion, Incident, LampGroup, Schedule, Thresholds, User } from '@citylight/shared';
import { GPS_RELOCATE_WINDOW_MIN, canManageRole, categoryForAlarm, defaultFieldMap, errorCatalog, distanceM, estimateDimming, judgeGpsSuggestion, roleRequires2fa, validateDimming } from '@citylight/shared';
import { getLang } from '@/i18n';
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
    const u = users.find((x) => x.id === id) ?? null;
    // mock data is rebuilt on every reload: this browser's remembered language stands in for users.lang
    if (u) u.lang = getLang();
    return u;
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

const notify = {
  minSeverity: 'major' as 'critical' | 'major' | 'minor',
  telegram: { available: true, botUsername: 'citylight_demo_bot', linked: false, enabled: false },
  zalo: { available: false },
  email: { available: false },
};

// Dimming (M9): cabinet > zone > system > default, with a fake lamp count (20 × 150 W per cabinet) for the estimate.
const zoneDimming = new Map<string, DimmingProfile>();
/** command signing (S59): the first cabinet signs, so the info tab shows the card filled in */
const signing = new Map<string, { signed: boolean; uid: string | null; uidPending: string | null; keyFp: string | null; boot: number | null; cmdSeq: number; lastInvalidAt: string | null }>();
const signingOf = (id: string, first: boolean) => {
  let s = signing.get(id);
  if (!s) {
    s = first
      ? { signed: true, uid: '3a00470013504d3437323920', uidPending: null, keyFp: 'bc8e4b3a', boot: 42, cmdSeq: 17, lastInvalidAt: null }
      : { signed: false, uid: null, uidPending: null, keyFp: null, boot: null, cmdSeq: 0, lastInvalidAt: null };
    signing.set(id, s);
  }
  return s;
};
function mockEstimate(segments: DimmingProfile['segments'], cabs: number) {
  const lamps = cabs * 20;
  return { ...estimateDimming(segments, lamps, lamps * 150, 2000), ratedW: lamps * 150, pricePerKwh: 2000, lampsWithoutPower: 0 };
}
function levelDimmingOf(group: LampGroup, zoneId: string | null): DimmingProfile {
  const own = zoneId ? zoneDimming.get(`${zoneId}:${group}`) : undefined;
  const sys = groupDimming.get(group);
  const p = own ?? sys ?? defaultDimming(group);
  const source = own ? 'zone' : sys && !sys.inheritedFromZone ? 'system' : 'default';
  const cabs = zoneId ? cabinets.filter((c) => c.zone1Id === zoneId).length : cabinets.length;
  return { lampGroup: group, segments: p.segments, source, inheritedFromZone: zoneId ? source !== 'zone' : source === 'default', estimate: mockEstimate(p.segments, cabs) };
}
function cabinetDimmingOf(id: string, group: LampGroup): DimmingProfile {
  const own = dimming.get(`${id}:${group}`);
  if (own) return { ...own, source: 'cabinet', inheritedFromZone: false, estimate: mockEstimate(own.segments, 1) };
  const up = levelDimmingOf(group, cabinetById.get(id)?.zone1Id ?? null);
  return { ...up, inheritedFromZone: true, estimate: mockEstimate(up.segments, 1) };
}

/** Cabinet codes of a batch (S56), as the API reads them. */
function batchCodes(text: string | undefined) {
  return (text ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

/** Cabinets of a batch: zones (zone 1 or 2) and / or codes, "TM01.*" = prefix (same rule as apps/api/src/scope.ts). */
function batchCabinets(b: { zoneIds: string[]; codes?: string }) {
  const codes = batchCodes(b.codes).map((c) => c.toUpperCase());
  return cabinets.filter((c) =>
    b.zoneIds.includes(c.zone1Id ?? '') || b.zoneIds.includes(c.zone2Id ?? '') ||
    codes.some((k) => (k.endsWith('*') ? c.code.toUpperCase().startsWith(k.slice(0, -1)) : c.code.toUpperCase() === k)));
}

function problem(status: number, code: string, detail: string) {
  return HttpResponse.json({ type: `https://citylight.local/errors/${code}`, title: code, status, detail, code }, { status });
}

function requireUser() {
  if (!sessionRef.current) throw new MockApiError(401, 'unauthenticated', 'Chưa đăng nhập');
  return sessionRef.current;
}

let reauthUntil = 0;
/** A4 (S45), like the API: user administration, IMEI and decommission need the 2FA code (mock: 123456) within 5 min. */
function requireReauth() {
  if (Date.now() > reauthUntil) throw new MockApiError(403, 'reauth_required', 'Nhập mã xác thực 2 lớp để tiếp tục');
}

type Info = { request: Request; params: Record<string, string> };

// QR registration in the mock: TM0900 is already a cabinet, CTY9003 is its new board
const enrolled = new Map<string, string>([['TM0900', 'Tủ Lê Lợi 1']]);
const registeredLtids = new Set<string>();
const registrationHistory: { at: string; code: string; name: string; ltid: string | null; by: string; via: 'form' | 'qr' | 'replace'; active: boolean }[] = [
  { at: new Date(Date.now() - 2 * 3600000).toISOString(), code: 'TM0900', name: 'Tủ Lê Lợi 1', ltid: 'CTY8001', by: 'admin@citylight.local', via: 'qr', active: true },
  { at: new Date(Date.now() - 26 * 3600000).toISOString(), code: 'TM0899', name: 'Tủ Nguyễn Huệ', ltid: 'CTY8000', by: 'manager@citylight.local', via: 'form', active: true },
  { at: new Date(Date.now() - 72 * 3600000).toISOString(), code: 'TM0850', name: 'Tủ Pasteur', ltid: 'CTY7900', by: 'admin@citylight.local', via: 'qr', active: false },
];

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

function mockGpsSuggestion(cabinetId: string): GpsSuggestion {
  const c = cabinetById.get(cabinetId)!;
  const st = states.get(cabinetId);
  const gps = st?.online && st.gpsDevice ? st.gpsDevice : null;
  const s = { samples: gps ? 180 : 0, spreadM: gps ? 8 : null, distanceM: gps ? Math.round(distanceM(c.location, gps)) : null };
  return { declared: c.location, gps, ...s, windowMin: GPS_RELOCATE_WINDOW_MIN, ...judgeGpsSuggestion(s, getLang()) };
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
  // S55 exports need the real server: 404 = downloadFile() returns false and the page says so
  http.get(`${API}/cabinets/:id/export.xlsx`, () => problem(404, 'not_found', 'Bản demo không xuất được file')),
  http.get(`${API}/reports/telemetry.xlsx`, () => problem(404, 'not_found', 'Bản demo không xuất được file')),
  http.get(`${API}/reports/telemetry.csv`, () => problem(404, 'not_found', 'Bản demo không xuất được file')),
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
    reauthUntil = 0;
    return new HttpResponse(null, { status: 204 });
  })),
  http.post(`${API}/auth/reauth`, wrap(async ({ request }: { request: Request }) => {
    requireUser();
    const body = (await request.json()) as { code: string };
    if (body.code !== '123456') return problem(422, 'invalid_otp', 'Mã xác thực không đúng (mock: 123456)');
    reauthUntil = Date.now() + 300_000;
    return HttpResponse.json({ validForS: 300 });
  })),
  http.get(`${API}/auth/me`, wrap(() => HttpResponse.json(requireUser()))),
http.patch(`${API}/me/preferences`, wrap(async ({ request }: { request: Request }) => {    const u = requireUser();    const body = (await request.json()) as { lang: 'vi' | 'en' };    u.lang = body.lang;    return HttpResponse.json(u);  })),
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
    const poles = inside.flatMap((c) => polesOf(c.id).map((p) => ({ ...p, cabinetName: c.name })));
    // M8 shape: routes drawn cabinet -> poles in order
    const routes = inside.flatMap((c) =>
      (['N1', 'N2'] as const).flatMap((br) => {
        const list = poles.filter((p) => p.cabinetId === c.id && p.branch === br);
        if (!list.length) return [];
        return [{ id: `${c.id}-${br}`, cabinetId: c.id, code: list[0]!.routeCode, branch: br, updatedAt: new Date().toISOString(),
          path: [[c.location.lng, c.location.lat], ...list.map((p) => [p.location.lng, p.location.lat])] }];
      }),
    );
    return HttpResponse.json({ routes, poles, truncated: false });
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
  http.get(`${API}/me/notifications`, wrap(() => HttpResponse.json(notify))),
  http.put(`${API}/me/notifications`, wrap(async ({ request }: { request: Request }) => {
    const b = (await request.json()) as { minSeverity: typeof notify.minSeverity; telegram: boolean };
    notify.minSeverity = b.minSeverity;
    notify.telegram.enabled = b.telegram && notify.telegram.linked;
    return HttpResponse.json(notify);
  })),
  http.post(`${API}/me/notifications/telegram/link`, wrap(() => {
    // demo: pretend the user pressed Start in Telegram a moment later
    setTimeout(() => Object.assign(notify.telegram, { linked: true, enabled: true }), 4000);
    return HttpResponse.json({ code: 'DEMO1234', botUsername: notify.telegram.botUsername, url: 'https://t.me/citylight_demo_bot?start=DEMO1234', expiresAt: new Date(Date.now() + 600_000).toISOString() });
  })),
  http.delete(`${API}/me/notifications/telegram`, wrap(() => {
    Object.assign(notify.telegram, { linked: false, enabled: false });
    return new HttpResponse(null, { status: 204 });
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
  // GPS relocation (shared/relocate.ts): the mock has one fix per cabinet, treated as a steady 30-min median
  http.get(`${API}/cabinets/:id/gps-suggestion`, wrap(({ params }: { params: Record<string, string> }) => HttpResponse.json(mockGpsSuggestion(params.id!)))),
  http.post(`${API}/cabinets/:id/location-from-gps`, wrap(({ params }: { params: Record<string, string> }) => {
    const u = requireUser();
    if (!['admin'].includes(u.role)) return problem(403, 'forbidden', 'Bạn không có quyền thực hiện thao tác này');
    const c = cabinetById.get(params.id!)!;
    const s = mockGpsSuggestion(c.id);
    if (!s.ok || !s.gps) return problem(409, 'gps_not_ready', s.reason ?? 'GPS chưa sẵn sàng');
    const from = c.location;
    c.location = s.gps;
    for (const a of alarms) if (a.cabinetId === c.id && a.type === 'gps_drift' && a.active) Object.assign(a, { active: false, endedAt: new Date().toISOString() });
    addLog(u.email, 'Cập nhật vị trí tủ theo GPS', 'cabinet', `${c.code} - ${c.name}`, JSON.stringify(from), JSON.stringify(s.gps));
    return HttpResponse.json({ id: c.id, location: s.gps, movedM: s.distanceM });
  })),
  // IMEI identity (S42): candidates = the registered IMEI + the foreign one of an open E805
  http.get(`${API}/cabinets/:id/imei-candidates`, wrap(({ params }: { params: Record<string, string> }) => {
    requireUser();
    const c = cabinetById.get(params.id!)!;
    const reg = (c as { imei?: string | null }).imei ?? null;
    const seen: { imei: string | null; frames: number; lastSeenAt: string; registered: boolean }[] = reg ? [{ imei: reg, frames: 8640, lastSeenAt: new Date().toISOString(), registered: true }] : [];
    if (alarms.some((a) => a.cabinetId === c.id && a.type === 'spoof_suspect' && a.active))
      seen.unshift({ imei: '869999000123456', frames: 37, lastSeenAt: new Date(Date.now() - 120_000).toISOString(), registered: false });
    return HttpResponse.json({ registered: reg, seen });
  })),
  http.put(`${API}/cabinets/:id/imei`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    requireReauth();
    const u = requireUser();
    if (u.role !== 'admin') return problem(403, 'forbidden', 'Bạn không có quyền thực hiện thao tác này');
    const c = cabinetById.get(params.id!)! as { id: string; code: string; name: string; imei?: string | null };
    const { imei } = (await request.json()) as { imei: string | null };
    const old = c.imei ?? null;
    c.imei = imei;
    for (const a of alarms) if (a.cabinetId === c.id && a.type === 'spoof_suspect' && a.active) Object.assign(a, { active: false, endedAt: new Date().toISOString() });
    addLog(u.email, imei ? 'Đổi IMEI tủ' : 'Học lại IMEI tủ', 'cabinet', `${c.code} - ${c.name}`, old, imei ?? '(học từ frame tiếp theo)');
    return HttpResponse.json({ id: c.id, imei });
  })),
  http.get(`${API}/cabinets/:id/signing`, wrap(({ params }: { params: Record<string, string> }) => {
    requireUser();
    return HttpResponse.json(signingOf(params.id!, params.id === cabinets[0]?.id));
  })),
  http.put(`${API}/cabinets/:id/uid`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    requireReauth();
    const u = requireUser();
    if (u.role !== 'admin') return problem(403, 'forbidden', 'Bạn không có quyền thực hiện thao tác này');
    const c = cabinetById.get(params.id!)!;
    const s = signingOf(c.id, c.id === cabinets[0]?.id);
    const { uid } = (await request.json()) as { uid: string };
    if (s.uidPending !== uid.toLowerCase()) return problem(409, 'uid_not_pending', 'UID này không phải UID đang chờ chấp nhận của tủ');
    addLog(u.email, 'Chấp nhận UID board mới', 'cabinet', `${c.code} - ${c.name}`, s.uid, uid);
    Object.assign(s, { uid: uid.toLowerCase(), uidPending: null, boot: null });
    return HttpResponse.json({ id: c.id, uid });
  })),
  http.post(`${API}/cabinets/:id/signing/disable`, wrap(({ params }: { params: Record<string, string> }) => {
    requireReauth();
    const u = requireUser();
    if (u.role !== 'admin') return problem(403, 'forbidden', 'Bạn không có quyền thực hiện thao tác này');
    const c = cabinetById.get(params.id!)!;
    const s = signingOf(c.id, c.id === cabinets[0]?.id);
    if (s.signed) addLog(u.email, 'Tắt ký lệnh', 'cabinet', `${c.code} - ${c.name}`, 'bật', 'tắt');
    s.signed = false;
    return HttpResponse.json({ id: c.id, signed: false });
  })),
  // no service region in the mock data (S62)
  http.get(`${API}/map/region`, wrap(() => {
    requireUser();
    return HttpResponse.json({ region: null });
  })),
  http.get(`${API}/map/gps-drift`, wrap(() => {
    requireUser();
    const items: GpsDriftItem[] = [];
    for (const a of alarms) {
      const g = a.active && a.type === 'gps_drift' ? states.get(a.cabinetId)?.gpsDevice : null;
      const c = g && cabinetById.get(a.cabinetId);
      if (g && c) items.push({ cabinetId: c.id, code: c.code, name: c.name, declared: c.location, gps: g, distanceM: Math.round(distanceM(c.location, g)) });
    }
    return HttpResponse.json(items);
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
    return HttpResponse.json(cabinetDimmingOf(params.id!, group));
  })),
  http.put(`${API}/cabinets/:id/dimming`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as DimmingProfile;
    const errors = validateDimming(body.segments, getLang());
    if (errors.length) return problem(422, 'invalid_profile', errors.join('; '));
    const group = (body.lampGroup ?? 0) as LampGroup;
    dimming.set(`${params.id}:${group}`, { lampGroup: group, segments: body.segments, inheritedFromZone: false });
    const c = cabinetById.get(params.id!)!;
    addLog(u.email, 'Lưu hồ sơ tiết giảm', 'cabinet', `${c.code} - ${c.name}`, null, 'Chưa gửi xuống tủ (thiết bị chưa hỗ trợ)');
    return HttpResponse.json(cabinetDimmingOf(params.id!, group));
  })),
  http.delete(`${API}/cabinets/:id/dimming`, wrap(({ params, request }: { params: Record<string, string>; request: Request }) => {
    requireUser();
    dimming.delete(`${params.id}:${Number(new URL(request.url).searchParams.get('group') ?? 0)}`);
    return new HttpResponse(null, { status: 204 });
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
    const body = (await request.json()) as { kind: CommandBatch['kind']; zoneIds: string[]; codes?: string; command?: CommandBatch['command'] };
    if (body.kind === 'dimming') return problem(409, 'capability_unsupported', 'Tủ hiện tại chưa hỗ trợ tiết giảm (cần firmware có lệnh tiết giảm và bộ điều khiển đèn thông minh); hồ sơ chỉ được lưu.');
    const ids = batchCabinets(body).map((c) => c.id);
    if (!ids.length) return problem(422, 'empty_batch', 'Không có tủ nào trong phạm vi của bạn ở các vùng / mã đã chọn');
    const scope = [...zones.filter((z) => body.zoneIds.includes(z.id)).map((z) => z.name), ...batchCodes(body.codes)].join(', ');
    return HttpResponse.json(createBatch(body.kind, scope, ids, u.email, body.command ?? null), { status: 202 });
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
    const body = (await request.json()) as { kind?: CommandBatch['kind']; zoneIds: string[]; codes?: string };
    const list = batchCabinets(body);
    return HttpResponse.json({ total: list.length, offline: list.filter((c) => !states.get(c.id)!.online).length, blocked: 0, unsupported: 0, max: body.kind === 'control' ? 2000 : null });
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
  http.get(`${API}/incidents/assignees`, wrap(() =>
    HttpResponse.json(users.filter((x) => x.role === 'admin' || x.role === 'maintenance').map((x) => ({ id: x.id, fullName: x.fullName, email: x.email, role: x.role }))),
  )),
  http.get(`${API}/incidents/:id`, wrap(({ params }: { params: Record<string, string> }) => {
    const i = incidents.find((x) => x.id === params.id);
    return i ? HttpResponse.json(i) : problem(404, 'not_found', 'Không tìm thấy sự cố');
  })),
  http.post(`${API}/incidents`, wrap(async ({ request }: { request: Request }) => {
    const u = requireUser();
    const body = (await request.json()) as { cabinetId?: string; alarmId?: string; category?: string; content?: string };
    // from an alarm (M7): cabinet, category and text come from the alarm
    const alarm = body.alarmId ? alarms.find((a) => a.id === body.alarmId) : undefined;
    const c = cabinetById.get(alarm?.cabinetId ?? body.cabinetId ?? '')!;
    const inc: Incident = {
      id: `inc${Date.now()}`,
      code: `SC${String(incidents.length + 1).padStart(5, '0')}`,
      cabinetId: c.id,
      cabinetName: c.name,
      districtName: districtName(c),
      wardName: wardName(c),
      source: alarm ? 'alarm' : 'manual',
      category: body.category ?? (alarm ? categoryForAlarm(alarm.type) : 'Khác'),
      content: body.content ?? (alarm ? `${alarm.code}: ${alarm.message}` : ''),
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
    const body = (await request.json()) as { to: Incident['status']; note?: string; assigneeId?: string; deadline?: string; resolution?: string };
    const label: Record<Incident['status'], string> = { new: 'Mở lại', assigned: 'Giao xử lý', deferred: 'Chưa cần xử lý', resolved: 'Đã xử lý', closed: 'Đóng sự cố' };
    inc.status = body.to;
    if (body.assigneeId) {
      inc.assigneeId = body.assigneeId;
      inc.assignee = users.find((x) => x.id === body.assigneeId)?.fullName ?? null;
    }
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
  http.get(`${API}/dimming-profiles/:group`, wrap(({ params, request }: { params: Record<string, string>; request: Request }) =>
    HttpResponse.json(levelDimmingOf(Number(params.group) as LampGroup, new URL(request.url).searchParams.get('zoneId'))),
  )),
  http.put(`${API}/dimming-profiles/:group`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    const u = requireUser();
    const group = Number(params.group) as LampGroup;
    const zoneId = new URL(request.url).searchParams.get('zoneId');
    const body = (await request.json()) as DimmingProfile;
    const errors = validateDimming(body.segments, getLang());
    if (errors.length) return problem(422, 'invalid_profile', errors.join('; '));
    const p = { lampGroup: group, segments: body.segments, inheritedFromZone: false };
    if (zoneId) zoneDimming.set(`${zoneId}:${group}`, p);
    else groupDimming.set(group, p);
    addLog(u.email, 'Lưu hồ sơ tiết giảm', zoneId ? 'zone' : 'system', zoneId ? `Vùng ${zones.find((z) => z.id === zoneId)?.name}` : 'Toàn hệ thống', null, null);
    return HttpResponse.json(levelDimmingOf(group, zoneId));
  })),
  http.delete(`${API}/dimming-profiles/:group`, wrap(({ params, request }: { params: Record<string, string>; request: Request }) => {
    requireUser();
    zoneDimming.delete(`${new URL(request.url).searchParams.get('zoneId')}:${params.group}`);
    return new HttpResponse(null, { status: 204 });
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
  http.get(`${API}/users`, wrap(() => {
    const me = requireUser();
    return HttpResponse.json(users.map((x) => ({ ...x, manageable: canManageRole(me.role, x.role) })));
  })),
  http.post(`${API}/users`, wrap(async ({ request }: { request: Request }) => {
    requireReauth();
    const u = requireUser();
    const body = (await request.json()) as Partial<User>;
    const role = body.role ?? 'viewer';
    const nu: User = {
      id: `u${Date.now()}`, email: body.email ?? '', fullName: body.fullName ?? '', role, scopeAll: role === 'admin' || !!body.scopeAll, scopeAreaIds: body.scopeAreaIds ?? [],
      canEnroll: role === 'admin' || role === 'manager' || !!body.canEnroll,
      totpEnabled: false, totpRequired: roleRequires2fa(role), passwordChangeRequired: true, active: true, lastLoginAt: null, lang: 'vi',
    };
    users.push(nu);
    addLog(u.email, 'Tạo người dùng', 'user', nu.email, null, nu.role);
    return HttpResponse.json({ user: nu, tempPassword: 'demo' }, { status: 201 });
  })),
  http.patch(`${API}/users/:id`, wrap(async ({ params, request }: { params: Record<string, string>; request: Request }) => {
    requireReauth();
    const u = requireUser();
    const target = users.find((x) => x.id === params.id)!;
    const body = (await request.json()) as Partial<User>;
    Object.assign(target, body);
    if (body.role) target.totpRequired = roleRequires2fa(body.role);
    addLog(u.email, 'Cập nhật người dùng', 'user', target.email, null, JSON.stringify(body));
    return HttpResponse.json(target);
  })),
  http.post(`${API}/users/:id/reset-password`, wrap(({ params }: { params: Record<string, string> }) => {
    requireReauth();
    const target = users.find((x) => x.id === params.id)!;
    target.passwordChangeRequired = true;
    return HttpResponse.json({ user: target, tempPassword: 'demo' });
  })),
  http.post(`${API}/users/:id/unlock`, wrap(({ params }: { params: Record<string, string> }) => HttpResponse.json(users.find((x) => x.id === params.id)))),
  http.post(`${API}/users/:id/reset-2fa`, wrap(({ params }: { params: Record<string, string> }) => {
    requireReauth();
    const target = users.find((x) => x.id === params.id)!;
    target.totpEnabled = false;
    return HttpResponse.json(target);
  })),
  http.get(`${API}/devices/registered`, wrap(() => HttpResponse.json(registrationHistory))),
  http.post(`${API}/devices/replace`, wrap(async ({ request }) => {
    requireReauth();
    const b = (await request.json()) as { code: string };
    registeredLtids.add('CTY9003');
    registrationHistory.unshift({ at: new Date().toISOString(), code: b.code, name: enrolled.get(b.code) ?? b.code, ltid: 'CTY9003', by: requireUser().email, via: 'replace', active: true });
    return HttpResponse.json({ id: b.code });
  })),
  http.post(`${API}/cabinets`, wrap(async ({ request }) => {
    const b = (await request.json()) as { ltid: string; code: string; name: string | null; scanned?: boolean };
    const ltid = b.ltid.toUpperCase();
    if (registeredLtids.has(ltid) || cabinets.some((c) => c.ltid.toUpperCase() === ltid)) throw new MockApiError(409, 'ltid_taken', `LTID ${ltid} đã được đăng ký`);
    if (enrolled.has(b.code) || cabinets.some((c) => c.code === b.code)) throw new MockApiError(409, 'cabinet_code_taken', `Mã tủ ${b.code} đã có`);
    registeredLtids.add(ltid);
    enrolled.set(b.code, b.name || b.code);
    registrationHistory.unshift({ at: new Date().toISOString(), code: b.code, name: b.name || b.code, ltid, by: requireUser().email, via: b.scanned ? 'qr' : 'form', active: true });
    return HttpResponse.json({ id: b.code }, { status: 201 });
  })),
  http.get(`${API}/devices/unknown`, wrap(({ request }) =>
    HttpResponse.json([
      { ltid: 'CTY9001', code: 'TM0001', ident: 'valid', replaces: null, firstSeenAt: new Date(Date.now() - 3600000).toISOString(), lastSeenAt: new Date().toISOString(), frames: 352, imei: '861234567890123', otherImei: null, gps: { lat: 10.7769401, lng: 106.7008765 } },
      { ltid: 'CTY9004', code: 'TM0004', ident: 'invalid', replaces: null, firstSeenAt: new Date(Date.now() - 600000).toISOString(), lastSeenAt: new Date().toISOString(), frames: 12, imei: '861234567892222', otherImei: null, gps: null },
      { ltid: 'CTY9003', code: 'TM0900', ident: 'valid', replaces: { id: 'TM0900', name: 'Tủ Lê Lợi 1' }, firstSeenAt: new Date(Date.now() - 900000).toISOString(), lastSeenAt: new Date().toISOString(), frames: 40, imei: '861234567891111', otherImei: null, gps: { lat: 10.7701, lng: 106.7002 } },
      { ltid: 'CTY9002', code: null, ident: null, replaces: null, firstSeenAt: new Date(Date.now() - 86400000).toISOString(), lastSeenAt: new Date(Date.now() - 600000).toISOString(), frames: 8120, imei: '861234567890456', otherImei: '861999000111222', gps: null },
    ].filter((d) => !registeredLtids.has(d.ltid) && [null, d.code?.toUpperCase()].includes(new URL(request.url).searchParams.get('code')?.toUpperCase() ?? null))),
  )),
  http.get(`${API}/field-map`, wrap(() => HttpResponse.json({ entries: defaultFieldMap(getLang()), unknownKeys: [] }))),
  http.get(`${API}/settings`, wrap(() => HttpResponse.json({ offlineAfterS: 60, pricePerKwh: 2000, lampGroupLabels: { 0: 'Đèn chính', 1: 'Đèn giao lộ', 2: 'Đèn trên cầu', 3: 'Nhóm mở rộng' }, updatedAt: null, updatedBy: null }))),
  // like the API (alarm-config.ts): the catalog in the reader's language, condition = the rule's telemetry evidence
  http.get(`${API}/alarm-rules`, wrap(() =>
    HttpResponse.json(
      errorCatalog(getLang()).map((e) => ({ type: e.type, code: e.code, title: e.title, severity: e.severity, condition: e.source, enabled: e.supported })),
    ),
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
      dbSizeGb: 5.6, // = total of /system/storage below
      brokerConnections: online + 3,
      brokerLink: { connected: true, since: new Date(Date.now() - 72.4 * 3_600_000).toISOString() },
      uptimeHours: 72.4,
    });
  })),
  // S57: sizes of a ~600-cabinet system in steady state (scaled from the 2026-10-27 measurement)
  http.get(`${API}/system/storage`, wrap(() => {
    const GB = 1024 ** 3;
    const items = [
      { name: 'telemetry', bytes: 3.8 * GB, compressedBytes: 3.5 * GB, keep: '30 days', compressAfter: '6 hours' },
      { name: 'frames_raw', bytes: 0.09 * GB, compressedBytes: 0.06 * GB, keep: '7 days', compressAfter: '1 day' },
      { name: 'telemetry_5m', bytes: 1.1 * GB, compressedBytes: 0.9 * GB, keep: '400 days', compressAfter: '7 days' },
      { name: 'telemetry_1h', bytes: 0.25 * GB, compressedBytes: 0.1 * GB, keep: null, compressAfter: '30 days' },
      { name: 'telemetry_1d', bytes: 0.02 * GB, compressedBytes: 0, keep: null, compressAfter: null },
    ].map((i) => ({ ...i, bytes: Math.round(i.bytes), compressedBytes: Math.round(i.compressedBytes) }));
    const otherBytes = Math.round(0.3 * GB);
    return HttpResponse.json({ items, otherBytes, totalBytes: items.reduce((s, i) => s + i.bytes, otherBytes) });
  })),
  http.get(`${API}/server-time`, () => HttpResponse.json({ now: new Date().toISOString() })),
];
