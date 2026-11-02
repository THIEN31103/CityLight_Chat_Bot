// D7-lite command signing (S59): a signing cabinet (simulator --sign) turns signing on by itself, runs only commands
// the server signed for its current boot, refuses replayed / forged / expired / other-boot frames, and the server
// re-signs once after a refusal caused by a reboot. Fake identities raise E806, another board UID raises E805 until
// the provider accepts it, a fake LFWV'3 frame does not make the server send unsigned, and "turn off" comes back on
// while the cabinet still signs.
// Needs EMQX, api, ingest and command-worker running with the same DEVICE_MASTER_KEY as here (a test master).
// Cabinet E2E.SIG01 (LTID E2ESIG1), user admin@e2e-signing.citylight.test, removed at the end. ~2 min.
// Run: npm run e2e:signing
import { hash } from '@node-rs/argon2';
import mqtt, { type MqttClient } from 'mqtt';
import { Redis } from 'ioredis';
import { TOPICS, buildCommandFrames, cabinetCommandTopic } from '@citylight/coreif';
import { cabinetKey, keyFingerprint, parseMasterKey, signCommand } from '@citylight/coreif/sign';
import { CONFIG_CHANNEL } from '@citylight/db/notify';
import { createSql } from '@citylight/db';
import { CONFIRMED_BY_TELEMETRY } from '@citylight/shared';
import { SimCabinet } from '../../simulator/src/cabinet';
import { base32Decode } from '../src/totp';
import { login, nextCode, reauth } from './client';

const DOMAIN = 'e2e-signing.citylight.test';
const LTID = 'E2ESIG1';
const CODE = 'E2E.SIG01';
const HOST = process.env.E2E_MQTT_HOST ?? 'localhost';
// trial stack (S60): the customer broker on other ports, backend listener with a password (MQTT_PASSWORD)
const CAB = process.env.E2E_CAB_URL ?? `mqtt://${HOST}:1883`;
const BACKEND = process.env.E2E_BACKEND_URL ?? `mqtt://${HOST}:1885`;
const LOC = { lat: 10.8212, lng: 106.7123 };
const NEW_UID = 'aa00000000000000000000bb';
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
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${what}`);
}
function connect(url: string, o: mqtt.IClientOptions): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(url, { clientId: `e2e-signing-${Math.random().toString(16).slice(2)}`, reconnectPeriod: 0, connectTimeout: 5000, ...o });
    c.once('connect', () => resolve(c));
    c.once('error', (e) => reject(e));
  });
}
const TERMINAL = new Set(['confirmed', 'acked_unconfirmed', 'failed', 'timeout', 'cancelled']);

async function main() {
  const master = parseMasterKey(process.env.DEVICE_MASTER_KEY);
  if (!master) throw new Error('set DEVICE_MASTER_KEY (64 hex test master) here and in api / ingest / command-worker');
  const USER = process.env.MQTT_DEVICE_USERNAME ?? '';
  const PASS = process.env.MQTT_DEVICE_PASSWORD ?? '';
  if (!USER || !PASS) throw new Error('set MQTT_DEVICE_USERNAME / MQTT_DEVICE_PASSWORD (the npm script loads infra/.env)');
  const cleanup = async () => {
    const cids = (await sql<{ id: string }[]>`SELECT id FROM cabinets WHERE ltid = ${LTID}`).map((r) => r.id);
    if (cids.length) {
      await sql`DELETE FROM commands WHERE cabinet_id = ANY(${cids}::uuid[])`;
      await sql`DELETE FROM alarms WHERE cabinet_id = ANY(${cids}::uuid[])`;
    }
    await sql`DELETE FROM cabinets WHERE ltid = ${LTID}`;
    await sql`DELETE FROM unknown_devices WHERE ltid = ${LTID}`;
    await redis.publish(CONFIG_CHANNEL, JSON.stringify({ type: 'registry' }));
  };
  await cleanup();
  await sql`DELETE FROM activity_logs WHERE user_email LIKE ${'%@' + DOMAIN}`;
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Sig-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all)
            VALUES (${org}, ${'admin@' + DOMAIN}, 'E2E admin', ${await hash(pw)}, 'admin', true)`;
  const { c: admin } = await login(`admin@${DOMAIN}`, pw);
  const secret = base32Decode((await admin.post('/auth/2fa/setup')).data.secret);
  const step = { step: 0 };
  await admin.post('/auth/2fa/enable', { code: nextCode(secret, step) });

  let sim = new SimCabinet({ ltid: LTID, brokerUrl: CAB, fault: 'none', location: LOC, telemetryMs: 2000, cmdTopic: true, sign: { master, boot: 7 } });
  // the broker owner (customer root): reads and publishes anything, here through the backend account
  const owner = await connect(BACKEND, { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD });
  const dev = await connect(CAB, { username: USER, password: PASS });
  const seen: { topic: string; frame: string }[] = [];
  owner.on('message', (topic, p) => seen.push({ topic, frame: p.toString() }));
  await owner.subscribeAsync([TOPICS.command, 'citylight/cmd/+']);
  const own = cabinetCommandTopic(LTID);
  const row = async () =>
    (await sql<{ signed: boolean; uid: string | null; uid_pending: string | null; sig_boot: number | null; key_fp: string | null; cmd_seq: number }[]>`
      SELECT signed, uid, uid_pending, sig_boot, key_fp, cmd_seq FROM cabinets WHERE ltid = ${LTID}`)[0];
  const alarm = async (type: string) => (await sql`SELECT 1 FROM alarms a JOIN cabinets c ON c.id = a.cabinet_id WHERE c.ltid = ${LTID} AND a.type = ${type} AND a.active`).length > 0;
  let cid = '';
  const send = async (type: string, params: object = {}) => {
    const r = await admin.post(`/cabinets/${cid}/commands`, { type, params }, { 'Idempotency-Key': `e2e-sig-${Math.random().toString(36).slice(2)}` });
    if (r.status !== 202) throw new Error(`command ${type}: ${r.status} ${JSON.stringify(r.data)}`);
    return waitFor(`${type}`, async () => {
      const c = (await admin.get(`/commands/${r.data.id}`)).data;
      const done = TERMINAL.has(c.status) || (c.status === 'acked' && !CONFIRMED_BY_TELEMETRY.includes(c.type));
      return done ? (c as { status: string; error: string | null }) : null;
    }, 90_000);
  };
  /** frame published by the broker owner straight to the cabinet; returns why the cabinet refused it (null = ran) */
  const inject = async (frame: string) => {
    const before = sim.stats.rejected;
    sim.lastReject = null;
    owner.publish(own, frame);
    await sleep(800);
    return sim.stats.rejected > before ? sim.lastReject : null;
  };

  try {
    // ---------- registration: signing turns on by itself ----------
    sim.start();
    await waitFor('unknown', async () => (await admin.get('/devices/unknown')).data.some((x: { ltid: string }) => x.ltid === LTID), 20_000);
    const reg = await admin.post('/cabinets', { ltid: LTID, code: CODE, name: 'Tủ thử ký lệnh', location: LOC });
    if (reg.status !== 201) throw new Error(`register: ${reg.status} ${JSON.stringify(reg.data)}`);
    cid = reg.data.id;
    await waitFor('online', async () => (await sql`SELECT 1 FROM cabinet_state WHERE cabinet_id = ${cid} AND online`).length === 1, 20_000);
    const r0 = await waitFor('signed', async () => {
      const r = await row();
      return r?.signed ? r : null;
    }, 20_000).catch(() => null);
    const fp = keyFingerprint(cabinetKey(master, sim.uid));
    check('Định danh ký đúng → bật ký, khóa UID, BOOT, LKFP', !!r0 && r0.uid === sim.uid && Number(r0.sig_boot) === 7 && r0.key_fp === fp,
      r0 ? `uid ${r0.uid}, boot ${r0.sig_boot}, fp ${r0.key_fp}` : 'chưa bật');
    const api0 = (await admin.get(`/cabinets/${cid}/signing`)).data;
    check('API /signing trả trạng thái', api0.signed === true && api0.keyFp === fp && api0.boot === 7, JSON.stringify(api0));

    // ---------- signed command runs ----------
    seen.length = 0;
    const a = await send('MANUAL_BRANCH', { branch: 1, on: true });
    const signedFrames = seen.filter((s) => s.topic === own && /&CSEQ'00000007\.\d+&CEXP'\d+&.*&CSIG'[0-9a-f]{32}\$$/.test(s.frame));
    check('Lệnh được ký (CSEQ boot 7, CEXP, CSIG) và xác nhận', a.status === 'confirmed' && signedFrames.length >= 1, `${a.status}, ${signedFrames.length} frame ký`);
    check('Tủ không từ chối frame nào', sim.stats.rejected === 0, `${sim.stats.rejected}`);

    // ---------- the broker owner tries ----------
    const captured = signedFrames[0]!.frame;
    check('Phát lại lệnh cũ → tủ từ chối (sequence)', (await inject(captured)) === 'sequence');
    check('Lệnh không ký → tủ từ chối', (await inject(buildCommandFrames(LTID, 'MANUAL_ALL', { on: false })[0]!)) === 'format');
    check('Sửa giá trị trong lệnh đã ký → tủ từ chối (signature)', (await inject(captured.replace("PLN1'1", "PLN1'0"))) === 'signature');
    const key = cabinetKey(master, sim.uid);
    const old = signCommand(buildCommandFrames(LTID, 'AUTO', {})[0]!, key, { boot: 7, m: 4_000_000_000 }, Date.now() - 100_000);
    check('Lệnh hết hạn (ký 100 s trước) → tủ từ chối (expired)', (await inject(old)) === 'expired');
    const otherBoot = signCommand(buildCommandFrames(LTID, 'AUTO', {})[0]!, key, { boot: 8, m: 4_000_000_001 });
    check('Lệnh ký trước cho BOOT kế tiếp → tủ từ chối (boot)', (await inject(otherBoot)) === 'boot');
    const nAll = sim.stats.commands;
    owner.publish(own, signCommand(buildCommandFrames('ALL', 'SET_TIME', {})[0]!, key, { boot: 7, m: 4_000_000_002 }));
    owner.publish(TOPICS.command, `*#LTID'ALL&LTIM'2026-01-01T00:00:00+07:00$`);
    await sleep(800);
    check("LTID'ALL bị bỏ qua", sim.stats.commands === nAll);

    // ---------- reboot the server has not seen yet: refused once, re-signed ----------
    await send('AUTO');
    await sleep(5000); // the cabinet acks at most one refusal per 5 s
    sim.muted = true;
    await sleep(2500);
    sim.reboot(false); // boot 8, no telemetry yet
    const rej0 = sim.stats.rejected;
    setTimeout(() => (sim.muted = false), 3000);
    const b = await send('MANUAL_BRANCH', { branch: 2, on: true });
    const r1 = await row();
    check('Tủ khởi động lại: lệnh bị -3 rồi được ký lại cho BOOT mới và chạy', b.status === 'confirmed' && sim.stats.rejected > rej0 && Number(r1?.sig_boot) === 8,
      `${b.status}${b.error ? ` (${b.error})` : ''}, refused ${sim.stats.rejected - rej0}, boot ${r1?.sig_boot}`);
    check('Sau -3, cmd_seq nhảy ≥ 10000', Number(r1?.cmd_seq) >= 10_000, `${r1?.cmd_seq}`);
    await send('AUTO');

    // ---------- fake identities ----------
    const tele = sim.buildTelemetry();
    dev.publish(TOPICS.telemetry, tele.replace(/LSIG'[0-9a-f]{32}/, `LSIG'${'0'.repeat(32)}`));
    await waitFor('E806', () => alarm('sig_invalid'), 10_000).catch(() => null);
    check('Định danh ký sai → E806', await alarm('sig_invalid'));
    await sleep(1200);
    const futureBoot = tele.replace(/LSEQ'[0-9a-f]{8}/, "LSEQ'000000ff");
    dev.publish(TOPICS.telemetry, futureBoot);
    await sleep(1500);
    check('BOOT giả (sửa LSEQ, giữ LSIG) không được nhận', Number((await row())?.sig_boot) === 8, `${(await row())?.sig_boot}`);
    await sleep(1200);
    // fake LFWV'3 frame without identity (as if the firmware were downgraded): still signed
    sim.muted = true;
    dev.publish(TOPICS.telemetry, tele.replace(/&LFWV'[^&$]*&LUID'[^&$]*&LSEQ'[^&$]*&LSIG'[^&$]*/, "&LFWV'3"));
    await sleep(1500);
    sim.muted = false;
    seen.length = 0;
    const c = await send('AUTO');
    check("Frame LFWV'3 giả không làm server gửi lệnh không ký", c.status === 'confirmed' && seen.some((s) => s.frame.includes("&CSIG'")) && !seen.some((s) => s.frame.includes(`LTID'${LTID}`) && !s.frame.includes("&CSIG'")),
      c.status);

    // ---------- turn off: comes back while the cabinet still signs ----------
    check('Tắt ký khi chưa nhập lại 2FA → reauth_required', (await admin.call('POST', `/cabinets/${cid}/signing/disable`)).data?.code === 'reauth_required');
    await reauth(admin, secret, step);
    const off = await admin.call('POST', `/cabinets/${cid}/signing/disable`);
    check('Tắt ký (2FA)', off.status === 200 && (await row())?.signed === false, `${off.status}`);
    await waitFor('signed again', async () => (await row())?.signed === true, 10_000).catch(() => null);
    check('Tủ vẫn gửi định danh ký đúng → tự bật lại', (await row())?.signed === true);

    // ---------- LTE board replaced (another UID, same modem) ----------
    await sim.stop();
    sim = new SimCabinet({ ltid: LTID, brokerUrl: CAB, fault: 'none', location: LOC, telemetryMs: 2000, cmdTopic: true, imei: sim.imei, sign: { master, uid: NEW_UID, boot: 1 } });
    sim.start();
    await waitFor('E805', () => alarm('spoof_suspect'), 15_000).catch(() => null);
    const r2 = await row();
    check('Board UID khác → E805, UID chờ chấp nhận, không ký cho board mới', (await alarm('spoof_suspect')) && r2?.uid_pending === NEW_UID && r2?.uid !== NEW_UID,
      `pending ${r2?.uid_pending}`);
    const acc = await admin.call('PUT', `/cabinets/${cid}/uid`, { uid: NEW_UID });
    check('Chấp nhận UID mới (2FA)', acc.status === 200, `${acc.status} ${JSON.stringify(acc.data)}`);
    const r3 = await waitFor('new boot', async () => {
      const r = await row();
      return r?.uid === NEW_UID && r.sig_boot !== null ? r : null;
    }, 20_000).catch(() => null);
    check('Board mới: UID ghi nhận, BOOT học lại, LKFP mới', !!r3 && Number(r3.sig_boot) === 1 && r3.key_fp === keyFingerprint(cabinetKey(master, NEW_UID)), r3 ? `boot ${r3.sig_boot}` : 'chưa');
    await waitFor('online', async () => (await sql`SELECT 1 FROM cabinet_state WHERE cabinet_id = ${cid} AND online`).length === 1, 15_000).catch(() => null);
    const d = await send('MANUAL_ALL', { on: true });
    check('Lệnh tới board mới được ký đúng và chạy', d.status === 'confirmed', `${d.status}${d.error ? ` (${d.error})` : ''}`);
    await send('AUTO');
  } finally {
    await sim.stop();
    owner.end(true);
    dev.end(true);
    await cleanup();
    await sql`DELETE FROM activity_logs WHERE user_email LIKE ${'%@' + DOMAIN} OR (user_email = 'hệ thống' AND target_name = ${CODE})`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
    await redis.quit();
    await sql.end();
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n[e2e:signing] ${checks.length - failed}/${checks.length} kiểm tra đạt`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
