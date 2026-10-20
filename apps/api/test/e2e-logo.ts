// LOGO link end-to-end: a cabinet registered while it keeps sending frames must leave "unregistered devices"
// for good (frames buffered by ingest used to re-insert it); E301 from PLGO 2..5 (firmware LOGO_DIAG) at once
// with the probed cause, from PTIM'X after 15 s (older firmware), closed when the LOGO answers again.
// Needs api + ingest. User admin@e2e-logo.citylight.test, cabinet E2E.LOGO01 (LTID E2ELOGO1), removed at
// the end. ~1 min. Run: npm run e2e:logo
import { hash } from '@node-rs/argon2';
import mqtt from 'mqtt';
import { Redis } from 'ioredis';
import { TOPICS } from '@citylight/coreif';
import { CONFIG_CHANNEL } from '@citylight/db/notify';
import { createSql } from '@citylight/db';
import { SimCabinet } from '../../simulator/src/cabinet';
import { base32Decode } from '../src/totp';
import { login, nextCode } from './client';

const DOMAIN = 'e2e-logo.citylight.test';
const LTID = 'E2ELOGO1';
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
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${what}`);
}
const LOC = { lat: 10.8123, lng: 106.7321 };

async function main() {
  const cleanup = async () => {
    await sql`DELETE FROM alarms WHERE cabinet_id IN (SELECT id FROM cabinets WHERE ltid = ${LTID})`;
    await sql`DELETE FROM cabinets WHERE ltid = ${LTID}`;
    await sql`DELETE FROM unknown_devices WHERE ltid = ${LTID}`;
    await redis.publish(CONFIG_CHANNEL, JSON.stringify({ type: 'registry' }));
  };
  await cleanup();
  await sql`DELETE FROM activity_logs WHERE user_email LIKE ${'%@' + DOMAIN}`;
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Logo-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all)
            VALUES (${org}, ${'admin@' + DOMAIN}, 'E2E admin', ${await hash(pw)}, 'admin', true)`;
  const { c: admin } = await login(`admin@${DOMAIN}`, pw);
  await admin.post('/auth/2fa/enable', { code: nextCode(base32Decode((await admin.post('/auth/2fa/setup')).data.secret), { step: 0 }) });

  // 1 frame/s: inside the per-LTID budget, and a frame is almost always waiting in ingest's buffer
  const sim = new SimCabinet({ ltid: LTID, brokerUrl: MQTT_URL, fault: 'none', location: LOC, telemetryMs: 1000 });
  const dev = mqtt.connect(MQTT_URL, { clientId: `e2e-logo-${Date.now()}`, clean: true });
  await new Promise<void>((r) => dev.once('connect', () => r()));
  /** a real frame of the simulator with PTIM replaced and PLGO appended (null = firmware without LOGO_DIAG) */
  const frame = (ptimX: boolean, plgo: number | null) => {
    let f = sim.buildTelemetry();
    if (ptimX) f = f.replace(/PTIM'[^&$]*/, "PTIM'X");
    return plgo === null ? f : f.replace(/\$$/, `&PLGO'${plgo}$`);
  };
  let pump: NodeJS.Timeout | null = null;
  const sendEvery = (ptimX: boolean, plgo: number | null) => {
    if (pump) clearInterval(pump);
    const go = () => dev.publish(TOPICS.telemetry, frame(ptimX, plgo), { qos: 0 });
    go();
    pump = setInterval(go, 2000);
  };
  const logoAlarm = async (cid: string) =>
    (await sql<{ message: string }[]>`SELECT message FROM alarms WHERE cabinet_id = ${cid} AND type = 'logo_lost' AND active`)[0];

  try {
    // ---------- registration while the device keeps sending ----------
    sim.start();
    await waitFor('unknown', async () => (await admin.get('/devices/unknown')).data.some((x: { ltid: string }) => x.ltid === LTID), 20_000);
    const reg = await admin.post('/cabinets', { ltid: LTID, code: 'E2E.LOGO01', name: 'Tủ thử LOGO', location: LOC });
    const cid: string = reg.data.id;
    check('Đăng ký tủ đang gửi frame', reg.status === 201);
    await sleep(4000); // several frames + flushes after the registration
    const listed = (await admin.get('/devices/unknown')).data.some((x: { ltid: string }) => x.ltid === LTID);
    const row = (await sql`SELECT 1 FROM unknown_devices WHERE ltid = ${LTID}`).length;
    check('Không quay lại "Thiết bị chưa đăng ký" sau khi đăng ký', !listed && row === 0, `API ${listed ? 'còn' : 'không'}, bảng ${row} dòng`);
    await waitFor('online', async () => (await sql`SELECT 1 FROM cabinet_state WHERE cabinet_id = ${cid} AND online`).length === 1, 20_000);
    await sim.stop();

    // ---------- LOGO_DIAG firmware: PLGO 3 = ETH alive, TCP to LOGO down ----------
    sendEvery(true, 3);
    const t0 = Date.now();
    const a = await waitFor('E301 PLGO', () => logoAlarm(cid), 15_000);
    check('PLGO=3 → E301 ngay, nêu đúng nguyên nhân', a.message.startsWith('PLGO=3'), `${((Date.now() - t0) / 1000).toFixed(1)} s, "${a.message}"`);
    const st = (await sql<{ logo_link: number | null; branch1_on: boolean | null }[]>`SELECT logo_link, branch1_on FROM cabinet_state WHERE cabinet_id = ${cid}`)[0]!;
    check('cabinet_state: logo_link = 3, trạng thái nhánh = không rõ', st.logo_link === 3 && st.branch1_on === null, JSON.stringify(st));
    const diag = (await admin.get(`/cabinets/${cid}/diagnostics`)).data;
    const logo = (diag.items ?? diag).find((i: { code: string | null }) => i.code === 'E301');
    check('Tab chẩn đoán: E301 với bằng chứng PLGO=3', logo?.evidence === 'PLGO=3', logo?.evidence);

    sendEvery(false, 0);
    await waitFor('E301 closed', async () => !(await logoAlarm(cid)), 15_000);
    check('LOGO trả lời lại (PLGO=0, có PTIM) → E301 đóng', true);

    // ---------- firmware without LOGO_DIAG: PTIM'X only ----------
    sendEvery(true, null);
    const t1 = Date.now();
    await sleep(8000);
    check('PTIM=X chưa đủ 15 s → chưa báo', !(await logoAlarm(cid)));
    const b = await waitFor('E301 PTIM X', () => logoAlarm(cid), 25_000);
    const secs = (Date.now() - t1) / 1000;
    check('PTIM=X kéo dài → E301 trong ~15–30 s', secs >= 15 && secs <= 35, `${secs.toFixed(1)} s, "${b.message}"`);
    sendEvery(false, null);
    await waitFor('E301 closed 2', async () => !(await logoAlarm(cid)), 15_000);
    check('Có PTIM lại → E301 đóng', true);
  } finally {
    if (pump) clearInterval(pump);
    await sim.stop();
    dev.end(true);
    await cleanup();
    await sql`DELETE FROM activity_logs WHERE user_email LIKE ${'%@' + DOMAIN} OR (user_email = 'hệ thống' AND target_name LIKE 'E2E.LOGO%')`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
    await redis.quit();
    await sql.end();
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n[e2e:logo] ${checks.length - failed}/${checks.length} kiểm tra đạt`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
