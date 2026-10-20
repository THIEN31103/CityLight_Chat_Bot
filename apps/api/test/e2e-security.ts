// Security alerts end-to-end (A6): the API publishes `security` events on cl:events for a sign-in from a new IP
// (not the first sign-in), an account lock after 5 failures, a recovery-code sign-in, and user administration
// (create / role change / disable / password reset / 2FA reset). The notify-worker turns them into Telegram
// messages (formatting: apps/workers/test/notify-format.test.ts). Also A4 re-auth lockout. Needs api + Redis. Users *@e2e-sec.citylight.test,
// removed at the end. ~20 s. Run: npm run e2e:security
import { hash } from '@node-rs/argon2';
import { Redis } from 'ioredis';
import { createSql } from '@citylight/db';
import { EVENTS_CHANNEL } from '@citylight/db/commands';
import type { SecurityEvent } from '@citylight/shared';
import { base32Decode, hotp, totpStep } from '../src/totp';
import { login, nextCode, reauth } from './client';

const DOMAIN = 'e2e-sec.citylight.test';
const sql = createSql(process.env.DATABASE_URL, 2);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const sub = redis.duplicate();
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const events: SecurityEvent[] = [];
/** events of one kind for one account since `from` (after a short settle for the pub/sub hop) */
async function got(kind: SecurityEvent['kind'], email: string, from: number) {
  await sleep(600);
  return events.slice(from).filter((e) => e.kind === kind && e.email === email);
}

async function main() {
  const wipe = async () => {
    await sql`DELETE FROM activity_logs WHERE user_email LIKE ${'%@' + DOMAIN} OR target_name LIKE ${'%@' + DOMAIN}`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
    const keys = await redis.keys('cl:secalert:*');
    if (keys.length) await redis.del(...keys);
  };
  await wipe();
  await sub.subscribe(EVENTS_CHANNEL);
  sub.on('message', (_ch, raw) => {
    const ev = JSON.parse(raw) as { type: string; security?: SecurityEvent };
    if (ev.type === 'security' && ev.security?.email.endsWith(DOMAIN)) events.push(ev.security);
  });

  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Sec-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const h = await hash(pw);
  const adminEmail = `admin@${DOMAIN}`;
  const userEmail = `viewer@${DOMAIN}`;
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
    (${org}, ${adminEmail}, 'E2E admin', ${h}, 'admin', true), (${org}, ${userEmail}, 'E2E viewer', ${h}, 'viewer', false)`;

  try {
    // ---------- new IP: never on the first sign-in, once for an IP not in the 90-day history ----------
    let n = events.length;
    const first = await login(userEmail, pw);
    check('Đăng nhập lần đầu: không báo IP mới', first.r.status === 200 && (await got('new_ip', userEmail, n)).length === 0);
    await sql`UPDATE activity_logs SET ip = '203.0.113.9' WHERE user_email = ${userEmail} AND action = 'Đăng nhập'`; // history = another IP
    n = events.length;
    await login(userEmail, pw);
    const ip1 = await got('new_ip', userEmail, n);
    check('Đăng nhập từ IP chưa thấy: 1 cảnh báo new_ip có IP + trình duyệt', ip1.length === 1 && !!ip1[0]!.ip && ip1[0]!.ua !== undefined, `ip ${ip1[0]?.ip}`);
    check('Cảnh báo không chứa mật khẩu', !JSON.stringify(ip1).includes(pw));
    n = events.length;
    await login(userEmail, pw);
    check('Đăng nhập lại cùng IP: không báo nữa', (await got('new_ip', userEmail, n)).length === 0);

    // ---------- lock after 5 failures: one alert, none while locked ----------
    n = events.length;
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await login(userEmail, 'wrong-password')).r.status);
    const locked = await got('locked', userEmail, n);
    check('Sai 5 lần: tài khoản khóa + 1 cảnh báo locked', locked.length === 1 && codes.join() === '401,401,401,401,401', codes.join());
    n = events.length;
    const whileLocked = await login(userEmail, 'wrong-password');
    check('Thử tiếp khi đang khóa: 423, không thêm cảnh báo', whileLocked.r.status === 423 && (await got('locked', userEmail, n)).length === 0);

    // ---------- admin with 2FA; recovery-code sign-in ----------
    const { c: admin } = await login(adminEmail, pw);
    const totp = { step: 0 };
    const secret = base32Decode((await admin.post('/auth/2fa/setup')).data.secret);
    const enabled = await admin.post('/auth/2fa/enable', { code: nextCode(secret, totp) });
    const recovery: string = enabled.data.recoveryCodes[0];
    n = events.length;
    const { c: viaCode } = await login(adminEmail, pw);
    const rec = await viaCode.post('/auth/2fa/verify', { recoveryCode: recovery });
    check('Đăng nhập bằng mã khôi phục: cảnh báo recovery_login', rec.status === 200 && (await got('recovery_login', adminEmail, n)).length === 1);

    // ---------- user administration: who did what (A4: after re-entering the 2FA code) ----------
    await reauth(admin, secret, totp);
    const vid = (await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${userEmail}`)[0]!.id;
    await admin.post(`/users/${vid}/unlock`);
    n = events.length;
    const created = await admin.post('/users', { email: `new@${DOMAIN}`, fullName: 'E2E new', role: 'viewer' });
    const c1 = await got('user_created', `new@${DOMAIN}`, n);
    check('Tạo user: user_created, bởi admin', created.status === 201 && c1.length === 1 && c1[0]!.by === adminEmail && !!c1[0]!.detail?.startsWith('viewer'), c1[0]?.detail ?? '');
    n = events.length;
    await admin.patch(`/users/${vid}`, { role: 'operator' });
    const rc = await got('role_changed', userEmail, n);
    check('Đổi vai trò: role_changed "viewer → operator"', rc.length === 1 && rc[0]!.detail === 'viewer → operator');
    n = events.length;
    await admin.patch(`/users/${vid}`, { fullName: 'E2E viewer 2' });
    check('Sửa tên: không cảnh báo', events.length === n || (await got('role_changed', userEmail, n)).length === 0);
    n = events.length;
    await admin.post(`/users/${vid}/reset-password`);
    check('Đặt lại mật khẩu: password_reset', (await got('password_reset', userEmail, n)).length === 1);
    n = events.length;
    await admin.post(`/users/${vid}/reset-2fa`);
    check('Đặt lại 2FA: totp_reset', (await got('totp_reset', userEmail, n)).length === 1);
    n = events.length;
    await admin.patch(`/users/${vid}`, { active: false });
    check('Khóa tài khoản: user_disabled', (await got('user_disabled', userEmail, n)).length === 1);

    // ---------- A4: guessing re-auth codes on a (stolen) session locks the account and ends every session ----------
    const wrong = () => ('000000' === hotp(secret, totpStep(Date.now())) ? '111111' : '000000');
    n = events.length;
    const tries: number[] = [];
    for (let i = 0; i < 5; i++) tries.push((await viaCode.post('/auth/reauth', { code: wrong() })).status);
    check('Nhập lại 2FA sai 5 lần → 422×4 rồi 423', tries.join() === '422,422,422,422,423', tries.join());
    check('… và mọi phiên của tài khoản bị đăng xuất', (await admin.get('/auth/me')).status === 401 && (await viaCode.get('/auth/me')).status === 401);
    check('… và có cảnh báo locked', (await got('locked', adminEmail, n)).length === 1);
  } finally {
    await wipe();
    await sub.quit();
    await redis.quit();
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
