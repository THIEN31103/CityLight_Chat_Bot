// M2 end-to-end check against a running API (docker compose --profile app): 2FA, CSRF, forced steps,
// RBAC, area scope (REST + Socket.IO), session revocation, lockout, rate limit.
// Creates its own users (*@e2e.citylight.test) straight in the DB and deletes them at the end, so the
// real admin account is never touched. Needs DATABASE_URL and REDIS_URL (root .env).
// Run: npm run e2e:api   (rate-limit check is last: wait 1 minute before running it again)
import { hash } from '@node-rs/argon2';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { createSql } from '@citylight/db';
import { base32Decode, hotp, totpStep } from '../src/totp';
import { BASE, Client, login, nextCode } from './client';

const DOMAIN = 'e2e.citylight.test';
const sql = createSql(process.env.DATABASE_URL, 2);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const checks: { name: string; ok: boolean; info?: string }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function socketFor(c: Client): Promise<{ s: Socket; events: { cabinetId: string }[] }> {
  return new Promise((resolve, reject) => {
    const events: { cabinetId: string }[] = [];
    const s = io(BASE, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, reconnection: false });
    s.on('cabinet.state', (e) => events.push(e));
    s.on('connect', () => resolve({ s, events }));
    s.on('connect_error', reject);
  });
}

/** true when the server drops the socket right after the handshake (no live data). */
function socketRefused(c: Client): Promise<boolean> {
  return new Promise((resolve) => {
    const s = io(BASE, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, reconnection: false });
    const done = (v: boolean) => {
      s.close();
      resolve(v);
    };
    s.on('disconnect', (reason) => done(reason === 'io server disconnect'));
    s.on('connect_error', () => done(true));
    setTimeout(() => done(false), 2000);
  });
}

async function main() {
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const adminPw = `Adm-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES (${org}, ${'admin@' + DOMAIN}, 'E2E Admin', ${await hash(adminPw)}, 'admin', true)`;
  const districts = await sql<{ id: string; name: string; n: number }[]>`
    SELECT d.id, d.name, count(c.id)::int AS n FROM areas d JOIN cabinets c ON c.district_id = d.id WHERE d.kind = 'district' GROUP BY d.id ORDER BY d.name LIMIT 2`;
  const [d1, d2] = districts as [typeof districts[0], typeof districts[0]];
  const totalCabinets = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cabinets`)[0]!.n;
  const c1 = (await sql<{ id: string; code: string }[]>`SELECT id, code FROM cabinets WHERE district_id = ${d1.id} ORDER BY code LIMIT 1`)[0]!;
  const c2 = (await sql<{ id: string; code: string }[]>`SELECT id, code FROM cabinets WHERE district_id = ${d2.id} ORDER BY code LIMIT 1`)[0]!;
  console.log(`[e2e] ${totalCabinets} cabinets; scope test ${d1.name} (${d1.n}) vs ${d2.name} (${d2.n})`);

  // ---------- admin: forced 2FA setup ----------
  const { c: admin, r: a1 } = await login(`admin@${DOMAIN}`, adminPw);
  check('Admin đăng nhập (chưa có 2FA) → vào thẳng, không hỏi mã', a1.status === 200 && a1.data.requires2fa === false && a1.data.user.totpRequired === true);
  const blocked = await admin.get('/map/stats');
  check('Admin chưa bật 2FA bị chặn: 403 totp_setup_required', blocked.status === 403 && blocked.data.code === 'totp_setup_required');
  admin.csrf = false;
  const noCsrf = await admin.post('/auth/2fa/setup');
  check('POST thiếu header CSRF → 403 csrf_failed', noCsrf.status === 403 && noCsrf.data.code === 'csrf_failed');
  admin.csrf = true;
  const setup = await admin.post('/auth/2fa/setup');
  check('Thiết lập 2FA trả otpauth URL + secret', setup.status === 200 && /^otpauth:\/\/totp\//.test(setup.data.otpauthUrl) && !!setup.data.secret);
  const secret = base32Decode(setup.data.secret);
  const last = { step: 0 };
  const wrong = await admin.post('/auth/2fa/enable', { code: '000000' === hotp(secret, totpStep(Date.now())) ? '111111' : '000000' });
  check('Bật 2FA với mã sai → 422', wrong.status === 422);
  const en = await admin.post('/auth/2fa/enable', { code: nextCode(secret, last) });
  check('Bật 2FA với mã đúng → 8 mã khôi phục', en.status === 200 && en.data.user.totpEnabled === true && en.data.recoveryCodes?.length === 8);
  const recovery: string[] = en.data.recoveryCodes ?? [];
  const st = await admin.get('/map/stats');
  check('Admin (toàn hệ thống) thấy đủ tủ', st.status === 200 && st.data.cabinets.total === totalCabinets, `${st.data?.cabinets?.total}/${totalCabinets}`);

  // ---------- admin: login with 2FA ----------
  await admin.post('/auth/logout');
  let r = await login(`admin@${DOMAIN}`, adminPw);
  check('Đăng nhập lại → hỏi mã 2FA, chưa có session', r.r.status === 200 && r.r.data.requires2fa === true && !r.c.jar.has('cl_sid'));
  const replay = await r.c.post('/auth/2fa/verify', { code: hotp(secret, last.step) });
  check('Dùng lại mã vừa dùng → 401 (chống replay)', replay.status === 401);
  const rc = await r.c.post('/auth/2fa/verify', { recoveryCode: recovery[0]!.toLowerCase() });
  check('Mã khôi phục (không phân biệt hoa thường) → đăng nhập được', rc.status === 200 && r.c.jar.has('cl_sid'));
  r = await login(`admin@${DOMAIN}`, adminPw);
  const rcAgain = await r.c.post('/auth/2fa/verify', { recoveryCode: recovery[0] });
  check('Mã khôi phục đã dùng → 401', rcAgain.status === 401);
  const ok2 = await r.c.post('/auth/2fa/verify', { code: nextCode(secret, last) });
  check('Mã TOTP mới → đăng nhập được', ok2.status === 200);
  const adm = r.c;
  await sql`UPDATE users SET failed_logins = 0 WHERE email = ${'admin@' + DOMAIN}`;

  // ---------- admin creates users ----------
  const mk = async (email: string, role: string, scopeAll: boolean, scopeAreaIds: string[]) => {
    const x = await adm.post('/users', { email: `${email}@${DOMAIN}`, fullName: email, role, scopeAll, scopeAreaIds });
    return x;
  };
  const v = await mk('viewer1', 'viewer', false, [d1.id]);
  check('Admin tạo user viewer phạm vi 1 quận → có mật khẩu tạm', v.status === 201 && typeof v.data.tempPassword === 'string' && v.data.user.passwordChangeRequired === true);
  const n = await mk('noscope', 'viewer', false, []);
  const o = await mk('operator1', 'operator', true, []);
  const dup = await mk('viewer1', 'viewer', false, []);
  check('Email trùng → 409', dup.status === 409);
  const self = await adm.patch(`/users/${a1.data.user.id}`, { role: 'viewer' });
  check('Admin tự hạ quyền mình → 409 self_change', self.status === 409 && self.data.code === 'self_change');

  // ---------- viewer: temp password, scope ----------
  const { c: vc } = await login(`viewer1@${DOMAIN}`, v.data.tempPassword);
  const pcr = await vc.get('/map/cabinets');
  check('Mật khẩu tạm: bị chặn tới khi đổi (403 password_change_required)', pcr.status === 403 && pcr.data.code === 'password_change_required');
  const vPw = `Viewer-${Date.now()}`;
  const short = await vc.post('/me/password', { oldPassword: v.data.tempPassword, newPassword: 'short' });
  check('Mật khẩu mới < 10 ký tự → 422', short.status === 422);
  const ch = await vc.post('/me/password', { oldPassword: v.data.tempPassword, newPassword: vPw });
  check('Đổi mật khẩu → 204', ch.status === 204);
  const map = await vc.get('/map/cabinets');
  const d1Wards = (await sql<{ id: string }[]>`SELECT id FROM areas WHERE parent_id = ${d1.id}`).map((x) => x.id);
  const allInD1 = Array.isArray(map.data) && map.data.every((c: { districtId: string; wardId: string }) => c.districtId === d1.id || d1Wards.includes(c.wardId));
  check('Viewer 1 quận: bản đồ chỉ có tủ quận đó', map.status === 200 && map.data.length === d1.n && allInD1, `${map.data?.length}/${d1.n}`);
  const vst = await vc.get('/map/stats');
  check('Viewer: thống kê chỉ đếm tủ trong phạm vi', vst.data?.cabinets?.total === d1.n);
  const inS = await vc.get(`/cabinets/${c1.id}`);
  const outS = await vc.get(`/cabinets/${c2.id}`);
  check('Viewer mở tủ trong phạm vi → 200', inS.status === 200);
  check('Viewer mở tủ ngoài phạm vi → 403 forbidden_scope', outS.status === 403 && outS.data.code === 'forbidden_scope');
  const outTele = await vc.get(`/cabinets/${c2.id}/telemetry`);
  check('Telemetry tủ ngoài phạm vi → 403', outTele.status === 403);
  const srch = await vc.get(`/search?q=${encodeURIComponent(c2.code)}`);
  check('Tìm kiếm không trả tủ ngoài phạm vi', srch.status === 200 && !srch.data.some((x: { id: string }) => x.id === c2.id));
  const list = await vc.get('/cabinets?size=5');
  check('Danh sách tủ: total = số tủ trong phạm vi', list.data?.total === d1.n);
  const tree = await vc.get('/areas/tree');
  check('Cây khu vực không có quận ngoài phạm vi', tree.status === 200 && !tree.data.areas.some((a: { id: string }) => a.id === d2.id) && tree.data.areas.some((a: { id: string }) => a.id === d1.id));
  const forbUsers = await vc.get('/users');
  check('Viewer gọi /users → 403 forbidden', forbUsers.status === 403 && forbUsers.data.code === 'forbidden');
  const forbAck = await vc.post('/alarms/00000000-0000-0000-0000-000000000000/ack');
  check('Viewer xác nhận cảnh báo → 403 forbidden', forbAck.status === 403);

  // ---------- realtime scope ----------
  const sock = await socketFor(vc);
  await sleep(300);
  const ev = (cabinetId: string) => ({ cabinetId, ltid: 'X', status: 'on', online: true, branch1On: true, branch2On: true, manualMode: false, activeAlarmCount: 0, lastSeenAt: new Date().toISOString() });
  await redis.publish('cl:events', JSON.stringify({ type: 'cabinet.state', items: [ev(c1.id), ev(c2.id)] }));
  await sleep(500);
  check('Socket viewer chỉ nhận sự kiện tủ trong phạm vi', sock.events.length === 1 && sock.events[0]!.cabinetId === c1.id, `${sock.events.length} sự kiện`);

  // ---------- no scope ----------
  const { c: nc } = await login(`noscope@${DOMAIN}`, n.data.tempPassword);
  await nc.post('/me/password', { oldPassword: n.data.tempPassword, newPassword: `NoScope-${Date.now()}` });
  const nmap = await nc.get('/map/cabinets');
  check('User mới chưa gán khu vực: không thấy tủ nào', nmap.status === 200 && nmap.data.length === 0);

  // ---------- operator: forced 2FA ----------
  const { c: oc } = await login(`operator1@${DOMAIN}`, o.data.tempPassword);
  await oc.post('/me/password', { oldPassword: o.data.tempPassword, newPassword: `Operator-${Date.now()}` });
  const ost = await oc.get('/map/stats');
  check('Operator chưa bật 2FA → 403 totp_setup_required', ost.status === 403 && ost.data.code === 'totp_setup_required');
  check('Operator chưa bật 2FA: socket bị server ngắt', await socketRefused(oc));

  // ---------- revocation ----------
  const disc = new Promise<boolean>((res) => {
    sock.s.on('disconnect', () => res(true));
    setTimeout(() => res(false), 3000);
  });
  const deact = await adm.patch(`/users/${v.data.user.id}`, { active: false });
  check('Admin khóa viewer → 200', deact.status === 200 && deact.data.active === false);
  check('Socket của viewer bị ngắt ngay', await disc);
  const vme = await vc.get('/auth/me');
  check('Session của viewer hết hiệu lực → 401', vme.status === 401);

  // ---------- lockout ----------
  for (let i = 0; i < 5; i++) await login(`noscope@${DOMAIN}`, 'wrong-password');
  const locked = await login(`noscope@${DOMAIN}`, 'whatever-password');
  check('Sai mật khẩu 5 lần → 423 account_locked', locked.r.status === 423 && locked.r.data.code === 'account_locked');
  const unl = await adm.post(`/users/${n.data.user.id}/unlock`);
  check('Admin mở khóa → 200', unl.status === 200);

  // ---------- admin reset password ----------
  const rp = await adm.post(`/users/${n.data.user.id}/reset-password`);
  const afterReset = await nc.get('/auth/me');
  check('Đặt lại mật khẩu: trả mật khẩu tạm mới, session cũ bị thu hồi', rp.status === 200 && !!rp.data.tempPassword && afterReset.status === 401);

  // ---------- disable 2FA blocked by role ----------
  const dis = await adm.post('/auth/2fa/disable', { password: adminPw });
  check('Admin không tắt được 2FA (vai trò bắt buộc) → 403', dis.status === 403 && dis.data.code === 'totp_required_by_role');

  // ---------- rate limit (last) ----------
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) {
    const x = await login(`nobody-${i}@${DOMAIN}`, 'x');
    if (x.r.status === 429) limited = true;
  }
  check('Quá 20 lần đăng nhập/phút từ một IP → 429', limited);

  sock.s.close();
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[e2e:api] ${checks.length - failed.length}/${checks.length} kiểm tra đạt`);
  await sql.end();
  redis.disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`.catch(() => undefined);
  process.exit(1);
});
