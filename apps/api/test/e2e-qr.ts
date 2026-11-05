// QR cabinet registration end-to-end check: a board reporting a cabinet code (LCOD) waits in the unregistered
// list until someone with cabinet approval registers it; a new board for a registered cabinet is a replacement.
// Needs api + ingest. Users *@e2e-qr.citylight.test, test cabinets E2E.QR*, removed at the end. ~1 min.
// Run: npm run e2e:qr
import { hash } from '@node-rs/argon2';
import { Redis } from 'ioredis';
import { CONFIG_CHANNEL } from '@citylight/db/notify';
import { createSql } from '@citylight/db';
import { parseMasterKey } from '@citylight/coreif/sign';
import { SimCabinet, uidFor } from '../../simulator/src/cabinet';
import { base32Decode } from '../src/totp';
import { login, nextCode, reauth } from './client';

const DOMAIN = 'e2e-qr.citylight.test';
const CODE = 'E2E.QR01';
const CODE_TWICE = 'E2E.QR02';
const LTIDS = ['E2EQR01', 'E2EQR02', 'E2EQR03', 'E2EQR04', 'E2EQR05', 'E2EQR06', 'E2EQR07', 'E2EQR08', 'E2EQR09', 'E2EQR10', 'E2EQR11', 'E2EQR12'];
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
  const secret = base32Decode(setup.data.secret);
  const step = { step: 0 };
  await manager.post('/auth/2fa/enable', { code: nextCode(secret, step) });
  const { c: viewer } = await login(`view@${DOMAIN}`, pw);

  const boards = [board(LTIDS[0]!, CODE), board(LTIDS[1]!, CODE_TWICE), board(LTIDS[2]!, CODE_TWICE)];
  const started: SimCabinet[] = [...boards];
  type Row = { ltid: string; code: string | null; replaces: { id: string; name: string } | null };
  const listed = async () => (await manager.get('/devices/unknown')).data as Row[];
  const row = async (ltid: string) => (await listed()).find((r) => r.ltid === ltid);
  try {
    boards.forEach((b) => b.start());
    await waitFor('unknown devices', async () => {
      const rows = await listed();
      return LTIDS.slice(0, 3).every((l) => rows.some((r) => r.ltid === l && r.code));
    }, 30_000);
    check('Board gửi mã tủ → nằm trong danh sách chưa đăng ký kèm mã tủ', (await row(LTIDS[0]!))?.code === CODE);
    check('Chưa duyệt thì chưa là tủ chính thức', (await sql`SELECT 1 FROM cabinets WHERE ltid = ANY(${LTIDS})`).length === 0);
    check('Board mới chưa bị coi là thay thế', (await row(LTIDS[0]!))?.replaces === null);

    // ---------- permissions ----------
    check('Không có quyền thì không xem được danh sách', (await viewer.get('/devices/unknown')).status === 403);
    check('Không có quyền thì không duyệt được', (await viewer.post('/cabinets', { ltid: LTIDS[0]!, code: CODE })).status === 403);
    check('Không có quyền thì không xem được lịch sử', (await viewer.get('/devices/registered')).status === 403);

    const viewerId = (await manager.get('/users')).data.find((x: { email: string }) => x.email === `view@${DOMAIN}`).id;
    await reauth(manager, secret, step);
    const granted = await manager.call('PATCH', `/users/${viewerId}`, { canEnroll: true });
    check('Cấp quyền Duyệt tủ cho tài khoản', granted.status === 200 && granted.data.canEnroll === true, `HTTP ${granted.status}`);
    const { c: installer } = await login(`view@${DOMAIN}`, pw);
    check('Tài khoản được cấp quyền xem được danh sách', (await installer.get('/devices/unknown')).status === 200);
    check('Quyền Duyệt tủ không đủ để thay board', (await installer.post('/devices/replace', { code: CODE })).status === 403);
    check('Quyền Duyệt tủ không mở được phần quản trị khác', (await installer.get('/users')).status === 403);

    // ---------- approve ----------
    const done = await installer.post('/cabinets', { ltid: LTIDS[0]!, code: CODE, scanned: true });
    check('Chỉ cần LTID và mã tủ, đăng ký bằng QR', done.status === 201, `HTTP ${done.status}`);
    const cab = (await sql<{ ltid: string; name: string }[]>`SELECT ltid, name FROM cabinets WHERE code = ${CODE}`)[0];
    check('Tủ gắn đúng ID, tên lấy theo mã tủ', cab?.ltid === LTIDS[0] && cab?.name === CODE);
    await waitFor('online', async () => (await sql`SELECT 1 FROM cabinet_state s JOIN cabinets c ON c.id = s.cabinet_id WHERE c.code = ${CODE} AND s.online`).length === 1, 20_000);
    check('Ingest nhận tủ ngay sau khi đăng ký', true);

    const first = await manager.post('/cabinets', { ltid: LTIDS[1]!, code: CODE_TWICE });
    const twice = await manager.post('/cabinets', { ltid: LTIDS[2]!, code: CODE_TWICE });
    check('Hai board cùng mã: board thứ hai bị từ chối', first.status === 201 && twice.status === 409, `HTTP ${first.status}, ${twice.status}`);
    check('Board thứ hai hiện là board mới của tủ đó', (await row(LTIDS[2]!))?.replaces?.name === CODE_TWICE);
    await boards[2]!.stop();
    await sleep(6000);
    await sql`DELETE FROM unknown_devices WHERE ltid = ${LTIDS[2]!}`;

    await reauth(manager, secret, step);
    await manager.call('PATCH', `/users/${viewerId}`, { canEnroll: false });
    const { c: revoked } = await login(`view@${DOMAIN}`, pw);
    check('Bỏ quyền thì không duyệt được nữa', (await revoked.get('/devices/unknown')).status === 403);

    const logged = (await manager.get('/devices/registered')).data as { code: string; via: string; by: string }[];
    check('Lịch sử ghi đúng người duyệt, loại QR', logged.some((h) => h.code === CODE && h.via === 'qr' && h.by === `view@${DOMAIN}`));
    check('Lịch sử có tủ duyệt tay', logged.some((h) => h.code === CODE_TWICE && h.via === 'form'));

    // ---------- board replacement ----------
    const before = (await sql<{ id: string; imei: string }[]>`SELECT id, imei FROM cabinets WHERE code = ${CODE}`)[0]!;
    await reauth(manager, secret, step);
    check('Chưa có board mới thì không thay được', (await manager.post('/devices/replace', { code: CODE })).status === 409);
    await boards[0]!.stop();
    const spare = board(LTIDS[3]!, CODE);
    started.push(spare);
    spare.start();
    await waitFor('new board', async () => (await row(LTIDS[3]!))?.replaces?.id === before.id, 30_000);
    check('Board mới báo mã đã đăng ký → hiện là board mới của tủ', true);
    check('Không đăng ký chồng lên tủ đang có', (await manager.post('/cabinets', { ltid: LTIDS[3]!, code: CODE })).status === 409);
    await reauth(manager, secret, step);
    const swapped = await manager.post('/devices/replace', { code: CODE });
    check('Thay board thành công', swapped.status === 200 && swapped.data.id === before.id, JSON.stringify(swapped.data));
    const after = (await sql<{ id: string; ltid: string; imei: string }[]>`SELECT id, ltid, imei FROM cabinets WHERE code = ${CODE}`)[0]!;
    check('Tủ giữ nguyên, ID và IMEI chuyển sang board mới', after.id === before.id && after.ltid === LTIDS[3] && after.imei !== before.imei);
    check('Board mới rời danh sách chưa đăng ký', !(await row(LTIDS[3]!)));
    const lastSeen = async () => (await sql<{ ts: Date }[]>`SELECT last_seen_at AS ts FROM cabinet_state WHERE cabinet_id = ${after.id}`)[0]?.ts?.getTime() ?? 0;
    const t0 = await lastSeen();
    await waitFor('data from the new board', async () => (await lastSeen()) > t0, 20_000);
    check('Server nhận dữ liệu của board mới ngay', true);
    check('Không còn báo E805 cho tủ', (await sql`SELECT 1 FROM alarms WHERE cabinet_id = ${after.id} AND type = 'spoof_suspect' AND active`).length === 0);
    check('Lịch sử ghi lần thay board', ((await manager.get('/devices/registered')).data as { code: string; via: string }[]).some((h) => h.code === CODE && h.via === 'replace'));

    const oldBoard = board(LTIDS[0]!, CODE);
    started.push(oldBoard);
    oldBoard.start();
    await waitFor('old board back', async () => row(LTIDS[0]!), 30_000);
    check('Board cũ bật lại không chiếm lại tủ', (await sql<{ ltid: string }[]>`SELECT ltid FROM cabinets WHERE code = ${CODE}`)[0]?.ltid === LTIDS[3]);
    const another = board(LTIDS[4]!, CODE);
    started.push(another);
    another.start();
    await waitFor('second new board', async () => row(LTIDS[4]!), 30_000);
    await reauth(manager, secret, step);
    check('Hai board mới cùng báo mã → không cho thay', (await manager.post('/devices/replace', { code: CODE })).status === 409);
    await Promise.all([oldBoard.stop(), another.stop()]);
    await sleep(6000);
    await sql`DELETE FROM unknown_devices WHERE ltid = ANY(${[LTIDS[0]!, LTIDS[4]!]})`;

    // ---------- other registration cases ----------
    check('Mã đã có → từ chối', (await manager.post('/cabinets', { ltid: 'E2EQRXX', code: CODE })).status === 409);
    check('LTID đã có → từ chối', (await manager.post('/cabinets', { ltid: LTIDS[3]!, code: 'E2E.QR98' })).status === 409);
    check('Không tự cấp quyền cho chính mình', (await manager.call('PATCH', `/users/${(await manager.get('/auth/me')).data.id}`, { canEnroll: true })).status === 409);

    await sql`INSERT INTO unknown_devices (ltid, code, imei) VALUES (${LTIDS[7]!}, 'E2E.QR08', '861000000000008')`;
    const noPosition = await manager.post('/cabinets', { ltid: LTIDS[7]!, code: 'E2E.QR08' });
    const fallback = (await sql<{ lat: number }[]>`SELECT ST_Y(location) AS lat FROM cabinets WHERE code = 'E2E.QR08'`)[0];
    check('Không có GPS, không nhập tọa độ → vị trí mặc định', noPosition.status === 201 && Math.abs(fallback!.lat - 10.7769) < 1e-6);

    await sql`INSERT INTO unknown_devices (ltid, code, imei, other_imei) VALUES (${LTIDS[9]!}, 'E2E.QR10', '861000000000010', '861000000000011')`;
    const pick = await manager.post('/cabinets', { ltid: LTIDS[9]!, code: 'E2E.QR10' });
    check('Một ID báo 2 IMEI → buộc chọn IMEI', pick.status === 409 && pick.data.code === 'imei_conflict', `HTTP ${pick.status}`);
    const picked = await manager.post('/cabinets', { ltid: LTIDS[9]!, code: 'E2E.QR10', imei: '861000000000011' });
    check('Chọn IMEI xong đăng ký được', picked.status === 201);

    // ---------- signing board replaced by a signing board ----------
    const master = parseMasterKey(process.env.DEVICE_MASTER_KEY);
    if (master) {
      const signed = (ltid: string) => new SimCabinet({ ltid, brokerUrl: MQTT_URL, fault: 'none', location: { lat: 10.77, lng: 106.69 }, telemetryMs: 2000, cabinetCode: 'E2E.QR11', cmdTopic: true, sign: { master } });
      const firstSigned = signed(LTIDS[10]!);
      started.push(firstSigned);
      firstSigned.start();
      await waitFor('signed board', async () => row(LTIDS[10]!), 30_000);
      await manager.post('/cabinets', { ltid: LTIDS[10]!, code: 'E2E.QR11' });
      const firstUid = await waitFor('uid learned', async () => (await sql<{ uid: string | null }[]>`SELECT uid FROM cabinets WHERE code = 'E2E.QR11'`)[0]?.uid, 20_000);
      check('Board có chữ ký: tủ học UID của board', firstUid === uidFor(LTIDS[10]!));
      await firstSigned.stop();
      const second = signed(LTIDS[11]!);
      started.push(second);
      second.start();
      await waitFor('signed spare', async () => (await row(LTIDS[11]!))?.replaces, 30_000);
      await reauth(manager, secret, step);
      check('Thay board có chữ ký thành công', (await manager.post('/devices/replace', { code: 'E2E.QR11' })).status === 200);
      const nextUid = await waitFor('new uid', async () => {
        const uid = (await sql<{ uid: string | null }[]>`SELECT uid FROM cabinets WHERE code = 'E2E.QR11'`)[0]?.uid;
        return uid && uid !== firstUid ? uid : null;
      }, 20_000);
      check('Board mới: tủ học UID mới, không cần chấp nhận tay', nextUid === uidFor(LTIDS[11]!));
      const cid = (await sql<{ id: string; uid_pending: string | null }[]>`SELECT id, uid_pending FROM cabinets WHERE code = 'E2E.QR11'`)[0]!;
      check('Thay board có chữ ký không báo E805', !cid.uid_pending && (await sql`SELECT 1 FROM alarms WHERE cabinet_id = ${cid.id} AND type = 'spoof_suspect' AND active`).length === 0);
    } else {
      check('Bỏ qua board có chữ ký: chưa đặt DEVICE_MASTER_KEY', true);
    }
  } finally {
    await Promise.all(started.map((b) => b.stop()));
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
