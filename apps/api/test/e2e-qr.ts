// QR cabinet registration end-to-end check: a board reporting a cabinet code (LCOD) waits in the unregistered
// list until someone with cabinet approval registers it; a new board for a registered cabinet is a replacement.
// Needs api + ingest. Users *@e2e-qr.citylight.test, test cabinets E2E.QR*, removed at the end. ~1 min.
// Run: npm run e2e:qr
import { hash } from '@node-rs/argon2';
import { Redis } from 'ioredis';
import mqtt from 'mqtt';
import { CONFIG_CHANNEL } from '@citylight/db/notify';
import { createSql } from '@citylight/db';
import { TOPICS } from '@citylight/coreif';
import { parseMasterKey } from '@citylight/coreif/sign';
import { SimCabinet, uidFor } from '../../simulator/src/cabinet';
import { base32Decode } from '../src/totp';
import { login, nextCode, reauth } from './client';

const DOMAIN = 'e2e-qr.citylight.test';
const CODE = 'E2E.QR01';
const CODE_TWICE = 'E2E.QR02';
const LTIDS = Array.from({ length: 19 }, (_, i) => `E2EQR${String(i + 1).padStart(2, '0')}`);
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

const master = parseMasterKey(process.env.DEVICE_MASTER_KEY);
if (!master) throw new Error('e2e:qr needs DEVICE_MASTER_KEY');
const sim = (ltid: string, cabinetCode: string, signWith: Buffer | null) =>
  new SimCabinet({ ltid, brokerUrl: MQTT_URL, fault: 'none', location: { lat: 10.77, lng: 106.69 }, telemetryMs: 2000, cabinetCode, cmdTopic: true, sign: signWith ? { master: signWith } : undefined });
/** Firmware of the trial: signs its identity with this environment's master. */
const board = (ltid: string, cabinetCode: string) => sim(ltid, cabinetCode, master);
/** Older firmware: no identity block. */
const unsigned = (ltid: string, cabinetCode: string) => sim(ltid, cabinetCode, null);
/** Knows the broker password, not the master. */
const forged = (ltid: string, cabinetCode: string) => sim(ltid, cabinetCode, Buffer.alloc(32, 0x11));

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
  type Row = { id: string; ltid: string; code: string | null; ident: string | null; replaces: { id: string; name: string } | null };
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
    check('Board ký đúng được ghi nhận chữ ký hợp lệ', (await row(LTIDS[0]!))?.ident === 'valid');
    const byCode = (await manager.get(`/devices/unknown?code=${CODE}`)).data as Row[];
    check('Quét mã tìm đúng thiết bị của mã đó', byCode.length === 1 && byCode[0]!.ltid === LTIDS[0]);
    check('Nhập mã chữ thường vẫn tìm được', ((await manager.get(`/devices/unknown?code=${CODE.toLowerCase()}`)).data as Row[])[0]?.ltid === LTIDS[0]);
    check('Mã chưa có thiết bị → không trả về gì', ((await manager.get('/devices/unknown?code=E2E.QR99')).data as Row[]).length === 0);
    check('Hai board cùng mã → trả về cả hai', ((await manager.get(`/devices/unknown?code=${CODE_TWICE}`)).data as Row[]).length === 2);

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
    const done = await installer.post('/cabinets', { deviceId: (await row(LTIDS[0]!))!.id, code: CODE, scanned: true });
    check('Chỉ cần LTID và mã tủ, đăng ký bằng QR', done.status === 201, `HTTP ${done.status}`);
    const cab = (await sql<{ ltid: string; name: string }[]>`SELECT ltid, name FROM cabinets WHERE code = ${CODE}`)[0];
    check('Tủ gắn đúng ID, tên lấy theo mã tủ', cab?.ltid === LTIDS[0] && cab?.name === CODE);
    check('UID đã kiểm được gán ngay khi đăng ký', (await sql<{ uid: string | null }[]>`SELECT uid FROM cabinets WHERE code = ${CODE}`)[0]?.uid === uidFor(LTIDS[0]!));
    await waitFor('online', async () => (await sql`SELECT 1 FROM cabinet_state s JOIN cabinets c ON c.id = s.cabinet_id WHERE c.code = ${CODE} AND s.online`).length === 1, 20_000);
    check('Ingest nhận tủ ngay sau khi đăng ký', true);

    const first = await manager.post('/cabinets', { ltid: LTIDS[1]!, code: CODE_TWICE });
    const twice = await manager.post('/cabinets', { ltid: LTIDS[2]!, code: CODE_TWICE });
    check('Hai board cùng mã: board thứ hai bị từ chối', first.status === 201 && twice.status === 409, `HTTP ${first.status}, ${twice.status}`);
    check('Board thứ hai hiện là board mới của tủ đó', (await row(LTIDS[2]!))?.replaces?.name === CODE_TWICE);
    await boards[2]!.stop();
    await sleep(6000);
    await sql`DELETE FROM unknown_devices WHERE ltid = ${LTIDS[2]!}`;

    // ---------- signatures ----------
    const fake = forged(LTIDS[12]!, 'E2E.QR13');
    const old = unsigned(LTIDS[13]!, 'E2E.QR14');
    started.push(fake, old);
    fake.start();
    old.start();
    await waitFor('forged and unsigned boards', async () => (await row(LTIDS[12]!)) && (await row(LTIDS[13]!)), 30_000);
    await sleep(2500);
    check('Board ký sai bị ghi nhận chữ ký sai', (await row(LTIDS[12]!))?.ident === 'invalid');
    check('Firmware cũ: chưa có chữ ký', (await row(LTIDS[13]!))?.ident === null);
    const fakeByInstaller = await installer.post('/cabinets', { deviceId: (await row(LTIDS[12]!))!.id, code: 'E2E.QR13' });
    check('Người có quyền duyệt không duyệt được board ký sai', fakeByInstaller.status === 409 && fakeByInstaller.data.code === 'device_bad_signature', `HTTP ${fakeByInstaller.status}`);
    const fakeByAdmin = await manager.post('/cabinets', { ltid: LTIDS[12]!, code: 'E2E.QR13' });
    check('Admin cũng không duyệt được board ký sai', fakeByAdmin.status === 409 && fakeByAdmin.data.code === 'device_bad_signature', `HTTP ${fakeByAdmin.status}`);
    const oldByInstaller = await installer.post('/cabinets', { deviceId: (await row(LTIDS[13]!))!.id, code: 'E2E.QR14' });
    check('Board chưa có chữ ký: quyền Duyệt tủ không đủ', oldByInstaller.status === 403 && oldByInstaller.data.code === 'device_unsigned', `HTTP ${oldByInstaller.status}`);
    check('Board chưa có chữ ký: quản lý vẫn duyệt được', (await manager.post('/cabinets', { ltid: LTIDS[13]!, code: 'E2E.QR14' })).status === 201);
    await Promise.all([fake.stop(), old.stop()]);

    const fakeSpare = forged(LTIDS[14]!, CODE_TWICE);
    started.push(fakeSpare);
    fakeSpare.start();
    await waitFor('forged spare', async () => (await row(LTIDS[14]!))?.ident === 'invalid', 30_000);
    await reauth(manager, secret, step);
    const fakeSwap = await manager.post('/devices/replace', { code: CODE_TWICE });
    check('Board ký sai không thay được tủ thật', fakeSwap.status === 409 && fakeSwap.data.code === 'device_bad_signature', `HTTP ${fakeSwap.status}`);
    await fakeSpare.stop();
    await sleep(3000);
    await sql`DELETE FROM unknown_devices WHERE ltid = ${LTIDS[14]!}`;

    const proven = board(LTIDS[15]!, 'E2E.QR16');
    started.push(proven);
    proven.start();
    await waitFor('signed board', async () => (await row(LTIDS[15]!))?.ident === 'valid', 30_000);
    await proven.stop();
    const hijack = unsigned(LTIDS[15]!, 'E2E.QR17');
    started.push(hijack);
    hijack.start();
    await sleep(6000);
    await hijack.stop();
    await sleep(2000);
    const held = await row(LTIDS[15]!);
    check('Frame không ký không đổi được mã tủ của board đã chứng minh', held?.code === 'E2E.QR16' && held?.ident === 'valid', `${held?.code} ${held?.ident}`);

    // both frames in one ingest write batch (FLUSH_MS): the unsigned one arrives right after the signed one
    const sender = mqtt.connect(MQTT_URL, { clientId: `e2e-qr-${Date.now()}`, clean: true });
    await new Promise((resolve, reject) => {
      sender.once('connect', resolve);
      sender.once('error', reject);
    });
    // read after every pair: the next signed frame would put the right code back. 3 s between pairs stays inside the frame budget.
    const sameBatch: (string | null | undefined)[] = [];
    await sleep(6000);
    for (let i = 0; i < 3; i++) {
      sender.publish(TOPICS.telemetry, proven.buildTelemetry(), { qos: 0 });
      sender.publish(TOPICS.telemetry, hijack.buildTelemetry(), { qos: 0 });
      await sleep(1500);
      sameBatch.push((await row(LTIDS[15]!))?.code);
      await sleep(1500);
    }
    await sender.endAsync();
    check('Frame không ký cùng đợt ghi với frame ký đúng không đổi được mã tủ', sameBatch.every((c) => c === 'E2E.QR16'), sameBatch.join(', '));

    // ---------- cabinet code rule, same as the firmware ----------
    check('Mã tủ 25 ký tự bị từ chối', (await manager.post('/cabinets', { ltid: 'E2EQRXX', code: 'X'.repeat(25) })).status === 422);
    check('Mã tủ 24 ký tự đăng ký được', (await manager.post('/cabinets', { ltid: LTIDS[16]!, code: 'Y'.repeat(24) })).status === 201);
    const oneChar = await manager.post('/cabinets', { ltid: 'E2EQRXX', code: 'X' });
    check('Mã 1 ký tự bị từ chối', oneChar.status === 422, `HTTP ${oneChar.status} ${JSON.stringify(oneChar.data).slice(0, 90)}`);
    check('Mã khác hoa thường vẫn tính là trùng', (await manager.post('/cabinets', { ltid: 'E2EQRXX', code: CODE.toLowerCase() })).status === 409);
    await sql`UPDATE cabinets SET active = false WHERE ltid = ${LTIDS[16]!}`;
    await sql`INSERT INTO unknown_devices (ltid, code, imei, ident) VALUES (${LTIDS[17]!}, ${'Y'.repeat(24)}, '861000000000018', 'valid')`;
    check('Tủ đã ngừng dùng không hiện là thay board', (await row(LTIDS[17]!))?.replaces === null);
    await sql`UPDATE cabinets SET active = true WHERE ltid = ${LTIDS[16]!}`;

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
    {
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
