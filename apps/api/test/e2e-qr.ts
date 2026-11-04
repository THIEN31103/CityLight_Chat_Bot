// QR cabinet registration end-to-end check: a board reporting a cabinet code (LCOD) waits in the unregistered
// list, is registered only by POST /devices/enroll, and the installer's answers never carry its LTID.
// Needs api + ingest. Users *@e2e-qr.citylight.test, test cabinets E2E.QR*, removed at the end. ~1 min.
// Run: npm run e2e:qr
import { hash } from '@node-rs/argon2';
import { Redis } from 'ioredis';
import { CONFIG_CHANNEL } from '@citylight/db/notify';
import { createSql } from '@citylight/db';
import { SimCabinet } from '../../simulator/src/cabinet';
import { base32Decode } from '../src/totp';
import { login, nextCode } from './client';

const DOMAIN = 'e2e-qr.citylight.test';
const CODE = 'E2E.QR01';
const CODE_TWICE = 'E2E.QR02';
const LTIDS = ['E2EQR01', 'E2EQR02', 'E2EQR03'];
const MQTT_URL = process.env.E2E_MQTT_URL ?? process.env.MQTT_URL ?? 'mqtt://localhost:1885';
const sql = createSql(process.env.DATABASE_URL, 2);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timeout waiting for ${what}`);
}

const board = (ltid: string, cabinetCode: string) =>
  new SimCabinet({ ltid, brokerUrl: MQTT_URL, fault: 'none', location: { lat: 10.77, lng: 106.69 }, telemetryMs: 2000, cabinetCode });

async function main() {
  const cleanup = async () => {
    await sql`DELETE FROM cabinets WHERE ltid = ANY(${LTIDS})`;
    await sql`DELETE FROM unknown_devices WHERE ltid = ANY(${LTIDS})`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
    await redis.publish(CONFIG_CHANNEL, JSON.stringify({ type: 'registry' }));
  };
  await cleanup();

  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Qr-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const h = await hash(pw);
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
    (${org}, ${'admin@' + DOMAIN}, 'E2E admin', ${h}, 'admin', true), (${org}, ${'view@' + DOMAIN}, 'E2E viewer', ${h}, 'viewer', true)`;
  const { c: manager } = await login(`admin@${DOMAIN}`, pw);
  const setup = await manager.post('/auth/2fa/setup');
  await manager.post('/auth/2fa/enable', { code: nextCode(base32Decode(setup.data.secret), { step: 0 }) });
  const { c: viewer } = await login(`view@${DOMAIN}`, pw);

  const boards = [board(LTIDS[0]!, CODE), board(LTIDS[1]!, CODE_TWICE), board(LTIDS[2]!, CODE_TWICE)];
  try {
    boards.forEach((b) => b.start());
    await waitFor('unknown devices', async () => {
      const rows = (await manager.get('/devices/unknown')).data as { ltid: string; code: string | null }[];
      return LTIDS.every((l) => rows.some((r) => r.ltid === l && r.code));
    }, 30_000);
    check('Board gửi mã tủ → nằm trong danh sách chưa đăng ký kèm mã tủ', true);
    check('Chưa quét thì chưa là tủ chính thức', (await sql`SELECT 1 FROM cabinets WHERE ltid = ANY(${LTIDS})`).length === 0);

    const ready = await manager.get(`/devices/by-code/${CODE}`);
    check('Quét mã có thiết bị → ready', ready.status === 200 && ready.data.status === 'ready');
    check('Kết quả tra không lộ LTID', !JSON.stringify(ready.data).includes(LTIDS[0]!));
    check('Kết quả tra không lộ đủ IMEI', /^\d{4}$/.test(ready.data.device.imeiTail));

    const none = await manager.get('/devices/by-code/E2E.QR99');
    check('Mã chưa có thiết bị → waiting', none.data.status === 'waiting');
    check('Đăng ký mã chưa có thiết bị → 409', (await manager.post('/devices/enroll', { code: 'E2E.QR99' })).status === 409);

    check('Hai board cùng mã → conflict', (await manager.get(`/devices/by-code/${CODE_TWICE}`)).data.status === 'conflict');
    check('Đăng ký mã trùng trên hai board → 409', (await manager.post('/devices/enroll', { code: CODE_TWICE })).status === 409);

    const minimal = await manager.post('/cabinets', { ltid: LTIDS[1]!, code: 'E2E.QR03' });
    const named = (await sql<{ name: string }[]>`SELECT name FROM cabinets WHERE code = 'E2E.QR03'`)[0];
    check('Form quản trị: chỉ cần LTID và mã tủ, tên lấy theo mã tủ', minimal.status === 201 && named?.name === 'E2E.QR03');

    check('Không có quyền thì không tra được', (await viewer.get(`/devices/by-code/${CODE}`)).status === 403);
    check('Không có quyền thì không đăng ký được', (await viewer.post('/devices/enroll', { code: CODE })).status === 403);

    const viewerId = (await manager.get('/users')).data.find((x: { email: string }) => x.email === `view@${DOMAIN}`).id;
    await manager.call('PATCH', `/users/${viewerId}`, { canEnroll: true });
    const { c: installer } = await login(`view@${DOMAIN}`, pw);
    check('Tài khoản được cấp quyền tra được mã tủ', (await installer.get(`/devices/by-code/${CODE}`)).status === 200);
    check('Quyền duyệt không mở được khu quản trị', (await installer.get('/devices/registered')).status === 403 && (await installer.get('/users')).status === 403);

    const done = await installer.post('/devices/enroll', { code: CODE });
    check('Xác nhận → đăng ký xong, tên mặc định là mã tủ', done.status === 201 || done.status === 200);
    const row = (await sql<{ ltid: string; name: string }[]>`SELECT ltid, name FROM cabinets WHERE code = ${CODE}`)[0];
    check('Tủ gắn đúng ID của board', row?.ltid === LTIDS[0] && row?.name === CODE);
    await waitFor('online', async () => (await sql`SELECT 1 FROM cabinet_state s JOIN cabinets c ON c.id = s.cabinet_id WHERE c.code = ${CODE} AND s.online`).length === 1, 20_000);
    check('Ingest nhận tủ ngay sau khi đăng ký', true);

    const history = (await manager.get('/devices/registered')).data as { code: string; via: string; by: string }[];
    check('Lịch sử ghi đúng người duyệt', history.some((h) => h.code === CODE && h.via === 'qr' && h.by === `view@${DOMAIN}`));
    await manager.call('PATCH', `/users/${viewerId}`, { canEnroll: false });
    const { c: revoked } = await login(`view@${DOMAIN}`, pw);
    check('Bỏ quyền thì không duyệt được nữa', (await revoked.post('/devices/enroll', { code: 'E2E.QR99' })).status === 403);
    check('Lịch sử có tủ duyệt ở Quản trị', history.some((h) => h.code === 'E2E.QR03' && h.via === 'form'));

    check('Quét lại mã đã đăng ký → registered', (await manager.get(`/devices/by-code/${CODE}`)).data.status === 'registered');
    check('Đăng ký lại mã đã có → 409', (await manager.post('/devices/enroll', { code: CODE })).status === 409);
  } finally {
    await Promise.all(boards.map((b) => b.stop()));
    await cleanup();
  }
  await sql.end();
  redis.disconnect();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[e2e:qr] ${checks.length - failed.length}/${checks.length} kiểm tra đạt`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
