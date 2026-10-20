// Role hierarchy end-to-end (S47): provider (admin) > manager (customer's top account) > operator > viewer / maintenance.
// A manager runs the customer side (own users below manager, catalog, cabinet registration, settings, all cabinets)
// but cannot create a manager or provider, touch a provider account, or reach the provider-only parts
// (IMEI identity, telemetry field map, server health). Needs the api. Users *@e2e-role.citylight.test,
// removed at the end. ~40 s (waits for fresh TOTP steps). Run: npm run e2e:roles
import { hash } from '@node-rs/argon2';
import { createSql } from '@citylight/db';
import { base32Decode } from '../src/totp';
import { login, nextCode, reauth, type Client } from './client';

const DOMAIN = 'e2e-role.citylight.test';
const sql = createSql(process.env.DATABASE_URL, 2);
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};

/** signed in with 2FA enabled and a re-auth window open */
async function signIn(email: string, pw: string): Promise<Client> {
  const { c } = await login(email, pw);
  const secret = base32Decode((await c.post('/auth/2fa/setup')).data.secret);
  const last = { step: 0 };
  await c.post('/auth/2fa/enable', { code: nextCode(secret, last) });
  await reauth(c, secret, last);
  return c;
}

async function main() {
  const wipe = async () => {
    await sql`DELETE FROM activity_logs WHERE user_email LIKE ${'%@' + DOMAIN} OR target_name LIKE ${'%@' + DOMAIN}`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  };
  await wipe();
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Role-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const h = await hash(pw);
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
    (${org}, ${'admin@' + DOMAIN}, 'E2E provider', ${h}, 'admin', true), (${org}, ${'mgr@' + DOMAIN}, 'E2E manager', ${h}, 'manager', false)`;
  const ids = Object.fromEntries((await sql<{ email: string; id: string }[]>`SELECT email, id FROM users WHERE email LIKE ${'%@' + DOMAIN}`).map((r) => [r.email.split('@')[0], r.id]));
  const cab = (await sql<{ id: string }[]>`SELECT id FROM cabinets WHERE active LIMIT 1`)[0]!.id;
  const activeCabinets = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cabinets WHERE active`)[0]!.n;

  try {
    const admin = await signIn(`admin@${DOMAIN}`, pw);
    const mgr = await signIn(`mgr@${DOMAIN}`, pw);

    // ---------- what a manager sees ----------
    const list = await mgr.get('/users');
    const row = (email: string) => (list.data as { email: string; manageable: boolean }[]).find((u) => u.email === email);
    check('Manager xem danh sách user (kể cả nhà cung cấp)', list.status === 200 && !!row(`admin@${DOMAIN}`));
    check('… tài khoản nhà cung cấp: chỉ xem (manageable=false)', row(`admin@${DOMAIN}`)?.manageable === false && row(`mgr@${DOMAIN}`)?.manageable === false);
    const stats = await mgr.get('/map/stats');
    check('Manager thấy toàn bộ tủ (không cần gán khu vực)', stats.status === 200 && stats.data.cabinets.total === activeCabinets, `${stats.data?.cabinets?.total}/${activeCabinets}`);

    // ---------- manager creates only roles below itself ----------
    const op = await mgr.post('/users', { email: `op@${DOMAIN}`, fullName: 'E2E op', role: 'operator', scopeAll: true });
    check('Manager tạo Điều hành → 201', op.status === 201);
    const asMgr = await mgr.post('/users', { email: `mgr2@${DOMAIN}`, fullName: 'E2E mgr2', role: 'manager' });
    check('Manager tạo Quản lý khác → 403 role_forbidden', asMgr.status === 403 && asMgr.data.code === 'role_forbidden');
    const asAdmin = await mgr.post('/users', { email: `adm2@${DOMAIN}`, fullName: 'E2E adm2', role: 'admin' });
    check('Manager tạo Nhà cung cấp → 403 role_forbidden', asAdmin.status === 403 && asAdmin.data.code === 'role_forbidden');
    const up = await mgr.patch(`/users/${op.data.user.id}`, { role: 'manager' });
    check('Manager nâng Điều hành lên Quản lý → 403', up.status === 403 && up.data.code === 'role_forbidden');
    const down = await mgr.patch(`/users/${op.data.user.id}`, { role: 'viewer' });
    check('Manager đổi Điều hành → Giám sát → 200', down.status === 200 && down.data.role === 'viewer');

    // ---------- provider account untouchable by a manager ----------
    const a = ids.admin!;
    const tries = {
      sửa: await mgr.patch(`/users/${a}`, { fullName: 'hijack' }),
      khóa: await mgr.patch(`/users/${a}`, { active: false }),
      'đặt lại mật khẩu': await mgr.post(`/users/${a}/reset-password`),
      'đặt lại 2FA': await mgr.post(`/users/${a}/reset-2fa`),
      'mở khóa': await mgr.post(`/users/${a}/unlock`),
    };
    const bad = Object.entries(tries).filter(([, r]) => !(r.status === 403 && r.data.code === 'user_forbidden')).map(([k, r]) => `${k}:${r.status}`);
    check('Manager không sửa/khóa/đặt lại/mở khóa được tài khoản nhà cung cấp → 403', bad.length === 0, bad.join(' '));
    const stillAdmin = await sql<{ full_name: string; active: boolean }[]>`SELECT full_name, active FROM users WHERE id = ${a}`;
    check('… tài khoản nhà cung cấp không đổi', stillAdmin[0]!.full_name === 'E2E provider' && stillAdmin[0]!.active);
    const self = await mgr.patch(`/users/${ids.mgr}`, { fullName: 'E2E manager 2' });
    const selfRole = await mgr.patch(`/users/${ids.mgr}`, { role: 'admin' });
    check('Manager tự đổi tên được, tự nâng quyền thì 409', self.status === 200 && selfRole.status === 409);

    // ---------- provider-only parts ----------
    const vendor = {
      'giám sát hệ thống': await mgr.get('/system/stats'),
      'ánh xạ telemetry': await mgr.get('/field-map'),
      'IMEI ứng viên': await mgr.get(`/cabinets/${cab}/imei-candidates`),
      'đổi IMEI': await mgr.put(`/cabinets/${cab}/imei`, { imei: null }),
    };
    const open = Object.entries(vendor).filter(([, r]) => r.status !== 403).map(([k, r]) => `${k}:${r.status}`);
    check('Manager không vào phần riêng nhà cung cấp (hệ thống, ánh xạ, IMEI) → 403', open.length === 0, open.join(' '));
    check('Manager đọc được cấu hình (giá điện)', (await mgr.get('/settings')).status === 200);

    // ---------- provider ----------
    const m2 = await admin.post('/users', { email: `mgr2@${DOMAIN}`, fullName: 'E2E mgr2', role: 'manager' });
    check('Nhà cung cấp tạo Quản lý → 201', m2.status === 201 && m2.data.user.role === 'manager' && m2.data.user.scopeAll === true);
    check('Nhà cung cấp đặt lại mật khẩu Quản lý → 200', (await admin.post(`/users/${ids.mgr}/reset-password`)).status === 200);
    check('Nhà cung cấp vào giám sát hệ thống', (await admin.get('/system/stats')).status === 200);
  } finally {
    await wipe();
    await sql.end();
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
