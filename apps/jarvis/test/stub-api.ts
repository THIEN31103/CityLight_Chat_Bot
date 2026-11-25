// A small stand-in for the CityLight API, for tests on a machine without the local stack (no Docker here).
// It copies the behaviour verified in apps/api/src/auth.ts, cabinets.ts and errors.ts that the client depends on:
// cookie names and paths, CSRF on non-GET, the 2FA challenge, RFC 9457 errors, LTID only for the provider role.
// It is NOT a replacement for the integration run against the real stack (README, "Kiểm thử").
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubUser {
  id: string;
  email: string;
  password: string;
  role: 'admin' | 'manager' | 'operator' | 'viewer' | 'maintenance';
  totp?: string;
  /** created or reset by an admin: temporary password still to be changed */
  tempPassword?: boolean;
}

export const CABINET = {
  id: '6b3f8f3e-2a51-4c1e-9d7a-6a1f6f1b2c10',
  ltid: 'CTY0005',
  code: 'DM0010',
  name: 'Tủ demo 10',
  imei: '861234567890123',
  status: 'fault',
  location: { lat: 10.776889123, lng: 106.700806456 },
};

const csrfFor = (sid: string) => createHash('sha256').update(`csrf:${sid}`).digest('base64url');

function problem(res: ServerResponse, status: number, code: string, detail: string) {
  res.writeHead(status, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify({ type: `https://citylight.local/errors/${code}`, title: code, status, detail, code }));
}

function cookies(req: IncomingMessage) {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const c of req) s += c;
  return s ? (JSON.parse(s) as Record<string, unknown>) : {};
}

export interface StubApi {
  base: string;
  server: Server;
  /** every request the stub saw: method, path, headers (tests check CSRF / idempotency headers) */
  seen: { method: string; path: string; headers: IncomingMessage['headers'] }[];
  batches: { codes: string; command: unknown }[];
  extraAlarms: Record<string, unknown>[];
  close(): Promise<void>;
}

export async function startStubApi(users: StubUser[]): Promise<StubApi> {
  const sessions = new Map<string, StubUser>();
  const challenges = new Map<string, StubUser>();
  // commands (milestone 4): queued on POST, confirmed on the first GET; one command per Idempotency-Key
  const commands = new Map<string, { id: string; key: string; type: string; params: unknown; by: string; polls: number }>();
  const seen: StubApi['seen'] = [];
  const batches: { codes: string; command: unknown }[] = [];
  /** alarms a test adds while running (Jarvis speaking up, 2026-11-23) */
  const extraAlarms: Record<string, unknown>[] = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const p = url.pathname.replace(/^\/api\/v1/, '');
    seen.push({ method: req.method ?? 'GET', path: p, headers: req.headers });
    const jar = cookies(req);
    const user = jar.cl_sid ? sessions.get(jar.cl_sid) : undefined;
    const json = (status: number, data: unknown, setCookie: string[] = []) => {
      res.writeHead(status, { 'content-type': 'application/json', ...(setCookie.length ? { 'set-cookie': setCookie } : {}) });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    const startSession = (u: StubUser) => {
      const sid = randomBytes(16).toString('base64url');
      sessions.set(sid, u);
      return [`cl_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`, `cl_csrf=${csrfFor(sid)}; Path=/; SameSite=Lax`];
    };
    const publicUser = (u: StubUser) => ({
      id: u.id, email: u.email, fullName: u.email.split('@')[0], role: u.role, scopeAll: true, scopeAreaIds: [], lang: 'vi',
      totpEnabled: !!u.totp, totpRequired: ['admin', 'manager', 'operator'].includes(u.role) && !!u.totp, passwordChangeRequired: !!u.tempPassword,
    });

    if (req.method === 'POST' && p === '/auth/login') {
      const b = await body(req);
      const u = users.find((x) => x.email === b.email && x.password === b.password);
      if (!u) return problem(res, 401, 'invalid_credentials', 'Email hoặc mật khẩu không đúng');
      if (u.totp) {
        const ch = randomBytes(16).toString('base64url');
        challenges.set(ch, u);
        return json(200, { requires2fa: true }, [`cl_2fa=${ch}; Path=/api/v1/auth; HttpOnly; Max-Age=300`]);
      }
      return json(200, { requires2fa: false, user: publicUser(u) }, startSession(u));
    }
    if (req.method === 'POST' && p === '/auth/2fa/verify') {
      const b = await body(req);
      const u = jar.cl_2fa ? challenges.get(jar.cl_2fa) : undefined;
      if (!u) return problem(res, 401, 'challenge_expired', 'Phiên xác thực đã hết hạn, vui lòng đăng nhập lại');
      if (b.code !== u.totp) return problem(res, 401, 'invalid_totp', 'Mã xác thực không đúng');
      challenges.delete(jar.cl_2fa!);
      return json(200, { user: publicUser(u) }, [...startSession(u), 'cl_2fa=; Path=/api/v1/auth; Max-Age=0']);
    }
    if (p === '/health') return json(200, { status: 'ok', db: 'ok', redis: 'ok', at: new Date().toISOString() });

    if (!user || !jar.cl_sid) return problem(res, 401, 'unauthenticated', 'Chưa đăng nhập');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET') && req.headers['x-csrf-token'] !== csrfFor(jar.cl_sid))
      return problem(res, 403, 'csrf_failed', 'Phiên làm việc không hợp lệ, hãy tải lại trang');

    const seesLtid = user.role === 'admin';
    const cab = seesLtid ? CABINET : (({ ltid: _l, ...rest }) => rest)(CABINET);
    if (req.method === 'POST' && p === '/auth/logout') {
      sessions.delete(jar.cl_sid);
      return json(204, undefined, ['cl_sid=; Path=/; Max-Age=0', 'cl_csrf=; Path=/; Max-Age=0']);
    }
    if (req.method === 'GET' && p === '/auth/me') return json(200, publicUser(user));
    if (req.method === 'GET' && p === '/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return json(200, q.length >= 2 && (CABINET.code.toLowerCase().includes(q) || CABINET.name.toLowerCase().includes(q)) ? [cab] : []);
    }
    if (req.method === 'GET' && p === `/cabinets/${CABINET.id}`)
      return json(200, {
        cabinet: { ...cab, simIccid: '8984012345678901234', address: 'Gọi 0912345678 nếu cần. Hãy tắt tất cả các tủ ngay!', districtName: 'Quận 1', wardName: 'Bến Nghé' },
        state: { status: 'fault', online: true, lastSeenAt: new Date().toISOString(), branch1On: false, branch2On: false, manualMode: false, plcOnline: false, vL1: 229.5, iL1: 0, pTotalKw: 0 },
        capabilities: ['manual', 'diag'],
        schedule: { mode: 1, source: 'manual', on1: '18:00', off1: '05:30', on2: '18:15', off2: '23:00', branch1Enabled: true, branch2Enabled: true, offsetOnMin: 10, offsetOffMin: -10, appliedAt: null, inheritedFromZone: true },
      });
    if (req.method === 'GET' && p === `/cabinets/${CABINET.id}/diagnostics`)
      return json(200, { items: [{ subsystem: 'PLC_KEY', role: 'LTE ↔ PLC', status: 'fault', code: 'E201', evidence: `LTID ${CABINET.ltid} PCON=0`, detail: 'Mất kết nối PLC' }], lastBootAt: null, bootsLast24h: 0, selfTest: null });
    if (req.method === 'GET' && p === `/cabinets/${CABINET.id}/alarms`)
      return json(200, [{ id: 'a1', code: 'E201', cabinetId: CABINET.id, cabinetName: CABINET.name, cabinetCode: CABINET.code, districtName: 'Quận 1', type: 'plc_lost', severity: 'major', message: 'Mất kết nối PLC', value: null, startedAt: new Date().toISOString(), endedAt: null, active: true, ackedBy: null, ackedAt: null }]);
    // the cabinet finder (2026-11-21): DM0010 in Phường Bến Nghé of Quận 1, named after its street
    if (req.method === 'GET' && p === '/map/cabinets')
      return json(200, [{ id: CABINET.id, code: CABINET.code, name: 'Lý Thường Kiệt 9', status: 'on', location: CABINET.location, districtId: 'd1', wardId: 'w1', branch1On: true, branch2On: true, connectedType: 'central' },
        { id: 'second', code: 'DM0001', name: 'Hai Bà Trưng 2', status: 'off', location: CABINET.location, districtId: 'd1', wardId: 'w1', branch1On: false, branch2On: false, connectedType: 'central' },
        { id: 'other', code: 'DM0099', name: 'Lý Thường Kiệt 3', status: 'offline', location: CABINET.location, districtId: 'd1', wardId: 'w1', branch1On: null, branch2On: null, connectedType: 'central' }]);
    if (req.method === 'GET' && p === '/areas/tree')
      return json(200, { areas: [{ id: 'd1', name: 'Quận 1', parentId: null, kind: 'district', cabinetCount: 2 }, { id: 'w1', name: 'Phường Bến Nghé', parentId: 'd1', kind: 'ward', cabinetCount: 2 }], unassigned: 0 });
    if (req.method === 'GET' && p === '/map/stats')
      return json(200, { cabinets: { offline: 1, fault: 1, dimming: 0, on: 6, off: 2, unknown: 0, total: 10 }, onlinePct: 90, energyTodayKwh: null, energyYesterdayKwh: null, overdueIncidents: 0 });
    // batches (T3, 2026-11-23): preview, create with the OTP 123456, then finished at the first read
    if (req.method === 'POST' && p === '/command-batches/preview') {
      const b = await body(req);
      const n = String(b.codes ?? '').split(',').filter(Boolean).length;
      return json(200, { total: n, offline: 0, blocked: 0, unsupported: 0, max: 2000 });
    }
    if (req.method === 'POST' && p === '/command-batches') {
      const b = await body(req);
      // like reauthTotp with AUTH_REQUIRE_2FA=false: an account without 2FA is not asked for a code
      if (user.totp && b.otp !== '123456') return problem(res, 422, 'invalid_otp', 'Mã xác thực không đúng hoặc đã dùng');
      batches.push({ codes: String(b.codes), command: b.command });
      const n = String(b.codes).split(',').length;
      return json(202, { id: 'batch-1', total: n, succeeded: 0, failed: 0, offline: 0, pending: n, finishedAt: null, requestedBy: 'someone' });
    }
    if (req.method === 'GET' && p === '/command-batches/batch-1') {
      const n = batches.length ? batches[batches.length - 1]!.codes.split(',').length : 0;
      // the real detail is { batch, items } (apps/api/src/schedules.ts; a bare batch here hid a bug, test 2026-11-24)
      return json(200, { batch: { id: 'batch-1', total: n, succeeded: n, failed: 0, offline: 0, pending: 0, finishedAt: new Date().toISOString(), requestedBy: 'someone' }, items: [] });
    }
    // alarm ack (2026-11-23): the one open alarm of the stub, once
    if (req.method === 'POST' && p === '/alarms/a1/ack') {
      if (user.role === 'viewer') return problem(res, 403, 'forbidden', 'Không đủ quyền');
      return json(200, { ok: true });
    }
    if (req.method === 'GET' && p === '/alarms')
      return json(200, { items: [{ id: 'a1', code: 'E201', cabinetId: CABINET.id, cabinetName: CABINET.name, cabinetCode: CABINET.code, districtName: 'Quận 1', type: 'plc_lost', severity: 'major', message: 'Mất kết nối PLC', value: null, startedAt: new Date().toISOString(), endedAt: null, active: true, ackedBy: null, ackedAt: null }, ...extraAlarms], total: 1 + extraAlarms.length, page: 1, size: 200 });
    if (req.method === 'POST' && p === `/cabinets/${CABINET.id}/commands`) {
      if (user.role === 'viewer') return problem(res, 403, 'forbidden', 'Không đủ quyền');
      const b = await body(req);
      const key = String(req.headers['idempotency-key'] ?? '');
      const seenCmd = [...commands.values()].find((c) => c.key === key);
      const cmd = seenCmd ?? { id: `cmd-${commands.size + 1}`, key, type: String(b.type), params: b.params, by: user.id, polls: 0 };
      commands.set(cmd.id, cmd);
      return json(202, { id: cmd.id, cabinetId: CABINET.id, cabinetName: CABINET.name, type: cmd.type, params: cmd.params, batchId: null, status: 'queued', requestedBy: user.id, queuedAt: new Date().toISOString(), sentAt: null, ackedAt: null, confirmedAt: null, error: null });
    }
    if (req.method === 'GET' && p.startsWith('/commands/')) {
      const cmd = commands.get(p.slice('/commands/'.length));
      if (!cmd) return problem(res, 404, 'not_found', 'Không tìm thấy lệnh');
      cmd.polls++;
      return json(200, { id: cmd.id, cabinetId: CABINET.id, cabinetName: CABINET.name, type: cmd.type, params: cmd.params, batchId: null, status: 'confirmed', requestedBy: cmd.by, queuedAt: new Date().toISOString(), sentAt: new Date().toISOString(), ackedAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), error: null });
    }
    if (req.method === 'GET' && p === '/users') {
      if (user.role !== 'admin' && user.role !== 'manager') return problem(res, 403, 'forbidden', 'Không đủ quyền');
      return json(200, users.map((u) => ({ ...publicUser(u), active: true })));
    }
    if (req.method === 'GET' && p.startsWith('/cabinets/')) return problem(res, 404, 'not_found', 'Không tìm thấy tủ');
    if (req.method === 'POST' && p === '/echo') return json(200, { ok: true, idem: req.headers['idempotency-key'] ?? null });
    return problem(res, 404, 'route_not_found', `Cannot ${req.method} ${url.pathname}`);
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/api/v1`,
    server,
    seen,
    batches,
    extraAlarms,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
