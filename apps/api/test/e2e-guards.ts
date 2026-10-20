// Anonymous-broker guards end-to-end (S42): IMEI identity (learn / mismatch -> frame ignored + E805 /
// candidates / accept / re-learn), two IMEIs under one unknown LTID (registration must choose), implausible
// values dropped, per-LTID frame budget. Needs api + ingest. Users *@e2e-grd.citylight.test,
// cabinets E2E.GRD01/02 (LTID E2EGRD01/02), removed at the end. ~1.5 min. Run: npm run e2e:guards
import { hash } from '@node-rs/argon2';
import mqtt from 'mqtt';
import { Redis } from 'ioredis';
import { TOPICS } from '@citylight/coreif';
import { CONFIG_CHANNEL } from '@citylight/db/notify';
import { createSql } from '@citylight/db';
import { SimCabinet } from '../../simulator/src/cabinet';
import { base32Decode } from '../src/totp';
import { login, nextCode } from './client';

const DOMAIN = 'e2e-grd.citylight.test';
const LTID = 'E2EGRD01';
const LTID2 = 'E2EGRD02';
const MQTT_URL = process.env.E2E_MQTT_URL ?? 'mqtt://localhost:1883';
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
const LOC = { lat: 10.8123, lng: 106.7321 };
const FAKE_IMEI = '869999000123456';
/** a real frame of `sim` with some fields replaced (LIME / MPU1 / LGPS …) */
const forge = (sim: SimCabinet, fields: Record<string, string>) => {
  let f = sim.buildTelemetry();
  for (const [k, v] of Object.entries(fields)) f = f.replace(new RegExp(`${k}'[^&$]*`), `${k}'${v}`);
  return f;
};

async function main() {
  const cleanup = async () => {
    await sql`DELETE FROM alarms WHERE cabinet_id IN (SELECT id FROM cabinets WHERE ltid IN (${LTID}, ${LTID2}))`;
    await sql`DELETE FROM cabinets WHERE ltid IN (${LTID}, ${LTID2})`;
    await sql`DELETE FROM unknown_devices WHERE ltid IN (${LTID}, ${LTID2})`;
    await redis.publish(CONFIG_CHANNEL, JSON.stringify({ type: 'registry' }));
  };
  await cleanup();
  await sql`DELETE FROM activity_logs WHERE user_email LIKE ${'%@' + DOMAIN}`;
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Grd-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const h = await hash(pw);
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
    (${org}, ${'admin@' + DOMAIN}, 'E2E admin', ${h}, 'admin', true), (${org}, ${'op@' + DOMAIN}, 'E2E operator', ${h}, 'operator', true)`;
  const { c: admin } = await login(`admin@${DOMAIN}`, pw);
  await admin.post('/auth/2fa/enable', { code: nextCode(base32Decode((await admin.post('/auth/2fa/setup')).data.secret), { step: 0 }) });
  const { c: op } = await login(`op@${DOMAIN}`, pw);
  await op.post('/auth/2fa/enable', { code: nextCode(base32Decode((await op.post('/auth/2fa/setup')).data.secret), { step: 0 }) });

  const sim = new SimCabinet({ ltid: LTID, brokerUrl: MQTT_URL, fault: 'none', location: LOC, telemetryMs: 2000 });
  const sim2a = new SimCabinet({ ltid: LTID2, brokerUrl: MQTT_URL, fault: 'none', location: LOC, telemetryMs: 2000 });
  // same LTID, another "modem" (simulator IMEIs are derived from the LTID unless given)
  const sim2b = new SimCabinet({ ltid: LTID2, brokerUrl: MQTT_URL, fault: 'none', location: LOC, telemetryMs: 2000, imei: '869111222333444' });
  const attacker = mqtt.connect(MQTT_URL, { clientId: `e2e-attacker-${Date.now()}`, clean: true });
  await new Promise<void>((r) => attacker.once('connect', () => r()));
  const send = (frame: string) => attacker.publish(TOPICS.telemetry, frame, { qos: 0 });
  const state = async (cid: string) =>
    (await sql<{ v_l1: number | null; last_seen_at: Date | null; lat: number | null }[]>`SELECT v_l1, last_seen_at, ST_Y(gps_device) AS lat FROM cabinet_state WHERE cabinet_id = ${cid}`)[0]!;
  const alarm = async (cid: string) => (await sql<{ id: string; active: boolean }[]>`SELECT id, active FROM alarms WHERE cabinet_id = ${cid} AND type = 'spoof_suspect' ORDER BY started_at DESC LIMIT 1`)[0];

  try {
    // ---------- register: the IMEI the device reported becomes the cabinet's ----------
    sim.start();
    await waitFor('unknown', async () => (await admin.get('/devices/unknown')).data.some((x: { ltid: string }) => x.ltid === LTID), 20_000);
    const reg = await admin.post('/cabinets', { ltid: LTID, code: 'E2E.GRD01', name: 'Tủ thử chống giả', location: LOC });
    const cid: string = reg.data.id;
    const imei = (await sql<{ imei: string }[]>`SELECT imei FROM cabinets WHERE id = ${cid}`)[0]!.imei;
    check('Đăng ký: IMEI tự lấy từ frame của thiết bị', reg.status === 201 && imei === sim.imei, imei);
    await waitFor('online', async () => (await sql`SELECT 1 FROM cabinet_state WHERE cabinet_id = ${cid} AND online`).length === 1, 20_000);

    // ---------- foreign IMEI: frame ignored, E805 ----------
    const before = await state(cid);
    send(forge(sim, { LIME: FAKE_IMEI, MPU1: '111.1' }));
    send(forge(sim, { LIME: 'X', MPU1: '111.1' }));
    const a = await waitFor('E805', () => alarm(cid).then((x) => x?.active && x), 10_000);
    await sleep(1500);
    const after = await state(cid);
    check('Frame IMEI lạ / không có IMEI → mở E805 "Nghi giả mạo tủ"', !!a);
    check('… và frame đó KHÔNG được áp vào trạng thái tủ (điện áp giả 111,1 V không xuất hiện)', after.v_l1 !== 111.1, `v_l1 ${before.v_l1} → ${after.v_l1}`);
    const raw = await sql<{ parse_error: string | null }[]>`SELECT parse_error FROM frames_raw WHERE ltid = ${LTID} AND payload LIKE ${'%' + FAKE_IMEI + '%'} ORDER BY ts DESC LIMIT 1`;
    check('Frame thô vẫn lưu, ghi chú "IMEI … khác"', !!raw[0]?.parse_error?.includes(FAKE_IMEI), raw[0]?.parse_error ?? '');
    const cand = await admin.get(`/cabinets/${cid}/imei-candidates`);
    check('Danh sách IMEI 24 h: IMEI thật (đang dùng) + IMEI lạ', cand.data.registered === imei && cand.data.seen.some((s: { imei: string; registered: boolean }) => s.imei === FAKE_IMEI && !s.registered)
      && cand.data.seen.some((s: { imei: string; registered: boolean }) => s.imei === imei && s.registered));
    check('Điều hành không đổi được IMEI → 403', (await op.call('PUT', `/cabinets/${cid}/imei`, { imei: FAKE_IMEI })).status === 403);
    check('IMEI sai định dạng → 422', (await admin.call('PUT', `/cabinets/${cid}/imei`, { imei: '12ab' })).status === 422);

    // ---------- modem replaced: accept the new IMEI (the old modem is gone: stop the simulator first) ----------
    await sim.stop();
    const acc = await admin.call('PUT', `/cabinets/${cid}/imei`, { imei: FAKE_IMEI });
    check('Chấp nhận IMEI mới → ghi DB + nhật ký', acc.status === 200
      && (await sql`SELECT 1 FROM activity_logs WHERE user_email = ${'admin@' + DOMAIN} AND action = 'Đổi IMEI tủ' AND new_value = ${FAKE_IMEI}`).length === 1);
    await waitFor('E805 closed', () => alarm(cid).then((x) => x && !x.active), 25_000);
    check('E805 tự đóng sau khi đổi IMEI', true);
    send(forge(sim, { LIME: FAKE_IMEI, MPU1: '233.3' }));
    await waitFor('new IMEI frame applied', async () => (await state(cid)).v_l1 === 233.3, 10_000);
    check('Frame mang IMEI mới giờ được nhận', true);
    // the old modem comes back: its IMEI is now the foreign one
    sim.start();
    await waitFor('old IMEI now foreign', () => alarm(cid).then((x) => x?.active && x), 15_000);
    check('Frame mang IMEI cũ giờ bị coi là lạ', true);

    // ---------- re-learn ----------
    await admin.call('PUT', `/cabinets/${cid}/imei`, { imei: null });
    const relearned = await waitFor('re-learned', async () => (await sql<{ imei: string | null }[]>`SELECT imei FROM cabinets WHERE id = ${cid}`)[0]!.imei, 15_000);
    check('Học lại IMEI: frame tiếp theo ghi IMEI mới, có nhật ký "hệ thống"', relearned === sim.imei
      && (await sql`SELECT 1 FROM activity_logs WHERE user_email = 'hệ thống' AND target_id = ${cid} AND action LIKE 'Ghi nhận IMEI%'`).length >= 1);

    // ---------- implausible values ----------
    await sim.stop();
    await sleep(2500);
    send(forge(sim, { MPU1: '5000', LGPS: "48.8566'2.3522'9" }));
    await sleep(2000);
    const s3 = await state(cid);
    check('Giá trị vô lý bị bỏ: 5000 V không vào trạng thái, GPS ở Paris bị bỏ', s3.v_l1 !== 5000 && (s3.lat === null || Math.abs(s3.lat - LOC.lat) < 0.01), `v_l1=${s3.v_l1}, lat=${s3.lat}`);

    // ---------- frame budget ----------
    await sleep(6000); // bucket full again
    const t0 = new Date();
    for (let i = 0; i < 40; i++) send(forge(sim, { MPU1: String(200 + i / 10) }));
    await sleep(2500);
    // every frame past the budget is kept raw (telemetry itself dedupes frames of the same millisecond)
    const kept = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM frames_raw WHERE ltid = ${LTID} AND ts >= ${t0}`)[0]!.n;
    check('Xả 40 frame/lúc cho 1 LTID → chỉ ~5 frame qua được', kept >= 4 && kept <= 8, `${kept}/40`);

    // ---------- two IMEIs under one unknown LTID ----------
    sim2a.start();
    sim2b.start();
    const u2 = await waitFor('conflict seen', async () =>
      (await admin.get('/devices/unknown')).data.find((x: { ltid: string; otherImei: string | null }) => x.ltid === LTID2 && x.otherImei), 20_000);
    check('LTID chưa đăng ký gửi từ 2 IMEI → danh sách báo cả 2', [u2.imei, u2.otherImei].sort().join() === [sim2a.imei, sim2b.imei].sort().join());
    const noPick = await admin.post('/cabinets', { ltid: LTID2, code: 'E2E.GRD02', name: 'Tủ thử 2', location: LOC });
    check('Đăng ký không chọn IMEI → 409 imei_conflict', noPick.status === 409 && noPick.data.code === 'imei_conflict');
    const pick = await admin.post('/cabinets', { ltid: LTID2, code: 'E2E.GRD02', name: 'Tủ thử 2', location: LOC, imei: sim2b.imei });
    const cid2: string = pick.data?.id;
    check('Đăng ký chọn IMEI → tủ dùng đúng IMEI đã chọn', pick.status === 201 && (await sql<{ imei: string }[]>`SELECT imei FROM cabinets WHERE id = ${cid2}`)[0]!.imei === sim2b.imei);
    await waitFor('E805 on cabinet 2', () => alarm(cid2).then((x) => x?.active && x), 20_000);
    check('… IMEI còn lại thành "lạ" → E805 ngay', true);
  } finally {
    sim.stop();
    sim2a.stop();
    sim2b.stop();
    attacker.end(true);
    await cleanup();
    await sql`DELETE FROM activity_logs WHERE user_email LIKE ${'%@' + DOMAIN} OR (user_email = 'hệ thống' AND target_name LIKE 'E2E.GRD%')`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
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
