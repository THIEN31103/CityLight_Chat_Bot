// M6 end-to-end check: zone / cabinet schedules -> scheduler (reconcile) -> SET_SCHEDULE -> ack ->
// schedule_applied; astronomical times; batches with OTP, progress and per-cabinet results.
// Needs api + ingest + command-worker + scheduler running. Zone "Vùng Thủ Đức" (7 simulator cabinets),
// its schedule is restored at the end. About 2 minutes.
//   npm run e2e:schedules
//   npm run e2e:schedules -- --load 1000   (adds a 1,000-cabinet batch on "Vùng Bắc")
import { hash } from '@node-rs/argon2';
import { io } from 'socket.io-client';
import { createSql } from '@citylight/db';
import { astroWindow, vnDate, type ScheduleWindow } from '@citylight/shared';
import { SimCabinet } from '../../simulator/src/cabinet';
import { base32Decode, totpStep } from '../src/totp';
import { BASE, login, nextCode } from './client';

const DOMAIN = 'e2e-sched.citylight.test';
const MQTT_URL = process.env.E2E_MQTT_URL ?? 'mqtt://localhost:1883';
const LOAD = (() => {
  const i = process.argv.indexOf('--load');
  return i > 0 ? Number(process.argv[i + 1]) : 0;
})();
const sql = createSql(process.env.DATABASE_URL, 4);

const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // with ~1,000 simulator MQTT connections Docker Desktop's port forwarding may reset an HTTP request
    const v = await fn().catch((e) => (String(e).includes('fetch failed') ? null : Promise.reject(e)));
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** Fresh TOTP code (each step is accepted once): waits for the next 30 s step if needed. */
async function otp(secret: Buffer, last: { step: number }) {
  while (Math.max(totpStep(Date.now()), last.step + 1) > totpStep(Date.now()) + 1) await sleep(1000);
  return nextCode(secret, last);
}

const applied = async (ids: string[]) =>
  new Map((await sql<{ cabinet_id: string; values: ScheduleWindow }[]>`SELECT cabinet_id, values FROM schedule_applied WHERE cabinet_id = ANY(${ids}::uuid[])`).map((r) => [r.cabinet_id, r.values]));

async function main() {
  const zone = (await sql<{ id: string; lat: number; lng: number }[]>`SELECT id, ST_Y(center) AS lat, ST_X(center) AS lng FROM zones WHERE name = 'Vùng Thủ Đức'`)[0]!;
  const centre = { lat: Number(zone.lat), lng: Number(zone.lng) };
  const cabs = await sql<{ id: string; ltid: string; lat: number; lng: number }[]>`
    SELECT id, ltid, ST_Y(location) AS lat, ST_X(location) AS lng FROM cabinets
    WHERE zone1_id = ${zone.id} AND ltid LIKE 'SIM8%' ORDER BY ltid LIMIT 7`;
  if (cabs.length < 7) throw new Error('cần ≥ 7 tủ SIM8xxx trong Vùng Thủ Đức (npm run sim:register -- --count 10000)');
  const ids = cabs.map((c) => c.id);
  const [late, ...early] = cabs as [typeof cabs[0], ...typeof cabs];
  const originalZone = await sql`SELECT * FROM schedules WHERE zone_id = ${zone.id}`;
  await sql`DELETE FROM schedules WHERE cabinet_id = ANY(${ids}::uuid[])`;
  await sql`DELETE FROM schedule_applied WHERE cabinet_id = ANY(${ids}::uuid[])`;
  // isolation from a previous run: its failed attempts would hold the scheduler back (30 min), and
  // its cabinets must be seen offline first (no frame for 60 s) for the "comes back online" step
  await sql`DELETE FROM commands WHERE cabinet_id = ANY(${ids}::uuid[]) AND type = 'SET_SCHEDULE'`;
  await waitFor('test cabinets offline', async () => (await sql`SELECT 1 FROM cabinet_state WHERE online AND cabinet_id = ANY(${ids}::uuid[])`).length === 0, 90_000);

  // ---------- users ----------
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Sch-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const h = await hash(pw);
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
    (${org}, ${'admin@' + DOMAIN}, 'E2E sched admin', ${h}, 'admin', true),
    (${org}, ${'viewer@' + DOMAIN}, 'E2E sched viewer', ${h}, 'viewer', true)`;
  const { c: admin } = await login(`admin@${DOMAIN}`, pw);
  const setup = await admin.post('/auth/2fa/setup');
  const secret = base32Decode(setup.data.secret);
  const last = { step: 0 };
  await admin.post('/auth/2fa/enable', { code: await otp(secret, last) });
  const { c: viewer } = await login(`viewer@${DOMAIN}`, pw);

  const sims = early.map((c) => new SimCabinet({ ltid: c.ltid, brokerUrl: MQTT_URL, fault: 'none', location: { lat: 10.85, lng: 106.77 }, telemetryMs: 2000 }));
  const lateSim = new SimCabinet({ ltid: late.ltid, brokerUrl: MQTT_URL, fault: 'none', location: { lat: 10.85, lng: 106.77 }, telemetryMs: 2000 });
  const loadSims: SimCabinet[] = [];
  try {
    sims.forEach((s) => s.start());
    await waitFor('sims online', async () => (await sql`SELECT 1 FROM cabinet_state WHERE online AND cabinet_id = ANY(${early.map((c) => c.id)}::uuid[])`).length === early.length, 30_000);
    await sleep(3000);
    check('Chưa cấu hình lịch: scheduler không đẩy lịch mặc định', (await applied(ids)).size === 0);

    // ---------- zone schedule (manual) -> reconcile ----------
    const manual = { mode: 1, source: 'manual', on1: '18:07', off1: '05:33', on2: '18:15', off2: '23:00', branch1Enabled: true, branch2Enabled: true, offsetOnMin: 10, offsetOffMin: -10 };
    const denied = await viewer.put(`/zones/${zone.id}/schedule`, manual);
    check('Viewer không sửa được lịch vùng → 403', denied.status === 403);
    const t0 = Date.now();
    const put = await admin.put(`/zones/${zone.id}/schedule`, manual);
    check('Lưu lịch vùng → 200', put.status === 200 && put.data.on1 === '18:07');
    const got = await waitFor('zone schedule applied', async () => {
      const a = await applied(early.map((c) => c.id));
      return [...a.values()].filter((v) => v.on1 === '18:07' && v.off1 === '05:33').length === early.length ? a : null;
    }, 40_000);
    check('Scheduler tự gửi lịch vùng tới 6 tủ online, tủ ack', got.size === early.length, `sau ${Math.round((Date.now() - t0) / 1000)} s`);
    const sys = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM commands WHERE cabinet_id = ANY(${ids}::uuid[]) AND type = 'SET_SCHEDULE' AND requested_by = '00000000-0000-0000-0000-000000000000'`;
    const hist = await admin.get(`/cabinets/${early[0]!.id}/commands`);
    check('Lệnh do "Hệ thống" gửi', sys[0]!.n >= early.length && hist.data[0]?.requestedBy === 'Hệ thống');
    check('Tủ offline chưa nhận lịch', !(await applied([late.id])).has(late.id));

    // offline cabinet catches up as soon as it comes online
    const t1 = Date.now();
    lateSim.start();
    await waitFor('late cabinet applied', async () => (await applied([late.id])).get(late.id)?.on1 === '18:07', 40_000);
    check('Tủ offline nhận lịch ngay khi có kết nối lại', true, `sau ${Math.round((Date.now() - t1) / 1000)} s`);

    // stable: nothing re-sent once applied
    const before = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM commands WHERE cabinet_id = ANY(${ids}::uuid[]) AND type = 'SET_SCHEDULE'`)[0]!.n;
    await sleep(12_000);
    const after = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM commands WHERE cabinet_id = ANY(${ids}::uuid[]) AND type = 'SET_SCHEDULE'`)[0]!.n;
    check('Đã khớp lịch thì không gửi lại', after === before, `${before} → ${after}`);

    // ---------- cabinet's own astronomical schedule, then back to the zone ----------
    const own = early[0]!;
    const astroOwn = { ...manual, source: 'astronomical', offsetOnMin: 15, offsetOffMin: -5 };
    const ps = await admin.put(`/cabinets/${own.id}/schedule`, astroOwn, { 'Idempotency-Key': crypto.randomUUID() });
    const wOwn = astroWindow({ lat: Number(own.lat), lng: Number(own.lng) }, vnDate(), 15, -5);
    await waitFor('own astro applied', async () => (await applied([own.id])).get(own.id)?.on1 === wOwn.on, 40_000);
    check('Lịch riêng thiên văn: tủ nhận giờ lặn +15′ / mọc −5′ theo vị trí tủ', ps.status === 202, `${wOwn.on} → ${wOwn.off} (lặn ${wOwn.sunset}, mọc ${wOwn.sunrise})`);
    const drop = await admin.call('DELETE', `/cabinets/${own.id}/schedule`);
    await waitFor('back to zone', async () => (await applied([own.id])).get(own.id)?.on1 === '18:07', 40_000);
    check('Bỏ lịch riêng → tủ tự về lịch vùng', drop.status === 204);

    // ---------- zone astronomical ----------
    const astroZone = { ...manual, source: 'astronomical', offsetOnMin: 10, offsetOffMin: -10 };
    await admin.put(`/zones/${zone.id}/schedule`, astroZone);
    const wZone = astroWindow(centre, vnDate(), 10, -10);
    const prev = await admin.get(`/zones/${zone.id}/schedule/preview?days=30`);
    check('Xem trước 30 ngày từ server khớp hàm dùng chung', prev.data.length === 30 && prev.data[0].on === wZone.on && prev.data[0].off === wZone.off);
    await waitFor('zone astro applied', async () => [...(await applied(ids)).values()].filter((v) => v.on1 === wZone.on && v.off1 === wZone.off).length === ids.length, 60_000);
    check('Lịch vùng thiên văn: cả 7 tủ nhận giờ theo tâm vùng', true, `${wZone.on} → ${wZone.off}`);

    // ---------- batches ----------
    const events: { id: string; pending: number }[] = [];
    const sock = io(BASE, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie: [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, reconnection: false });
    await new Promise<void>((res, rej) => { sock.on('connect', () => res()); sock.on('connect_error', rej); });
    sock.on('batch.progress', (b: { id: string; pending: number }) => events.push(b));
    const pv = await admin.post('/command-batches/preview', { zoneIds: [zone.id] });
    const offline = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id WHERE c.zone1_id = ${zone.id} AND NOT coalesce(s.online, false)`)[0]!.n;
    check('Xem trước batch: tổng / offline', pv.status === 200 && pv.data.offline === offline, `${pv.data.total} tủ, ${pv.data.offline} offline`);
    const vb = await viewer.post('/command-batches', { kind: 'time', zoneIds: [zone.id], otp: '000000' });
    check('Viewer không chạy batch → 403', vb.status === 403);
    const noOtp = await admin.post('/command-batches', { kind: 'time', zoneIds: [zone.id] });
    const badOtp = await admin.post('/command-batches', { kind: 'time', zoneIds: [zone.id], otp: '123456' });
    check('Batch thiếu / sai mã 2FA → 422', noOtp.status === 422 && badOtp.status === 422 && badOtp.data.code === 'invalid_otp');
    const code = await otp(secret, last);
    const b = await admin.post('/command-batches', { kind: 'time', zoneIds: [zone.id], otp: code });
    check('Tạo batch đồng bộ giờ cho vùng → 202', b.status === 202 && b.data.total === pv.data.total, `${b.data.total} tủ`);
    const replay = await admin.post('/command-batches', { kind: 'time', zoneIds: [zone.id], otp: code });
    check('Dùng lại mã 2FA → 422', replay.status === 422);
    const done = await waitFor('batch finished', async () => {
      const d = await admin.get(`/command-batches/${b.data.id}`);
      return d.data.batch.finishedAt ? d.data : null;
    }, 60_000);
    // cabinets the ingest flagged as firmware 1307ebc (earlier simulator runs) are refused, not sent
    check('Batch xong: 7 tủ ok, firmware cũ bị chặn, còn lại offline',
      done.batch.succeeded === 7 && done.batch.failed === pv.data.blocked && done.batch.succeeded + done.batch.failed + done.batch.offline === pv.data.total,
      `ok ${done.batch.succeeded}, chặn/lỗi ${done.batch.failed} (firmware cũ ${pv.data.blocked}), offline ${done.batch.offline}`);
    check('Kết quả từng tủ: lỗi/offline lên trước, ok cuối, có lý do', done.items.length === pv.data.total && done.items[0].result !== 'ok' && done.items.at(-1).result === 'ok'
      && done.items.filter((i: { result: string; error: string | null }) => i.result === 'failed').every((i: { error: string | null }) => i.error?.includes('Firmware cũ')));
    check('Tiến độ realtime qua Socket.IO (batch.progress)', events.some((e) => e.id === b.data.id && e.pending === 0));
    const list = await admin.get('/command-batches');
    check('Danh sách batch có batch vừa chạy', list.data.some((x: { id: string }) => x.id === b.data.id));
    const rt = await admin.post(`/command-batches/${b.data.id}/retry-failed`, { otp: await otp(secret, last) });
    check('Gửi lại tủ lỗi/offline → 202 (tủ vẫn offline thì giữ offline)', rt.status === 202);
    await waitFor('retry settled', async () => (await admin.get(`/command-batches/${b.data.id}`)).data.batch.finishedAt, 20_000);
    const dim = await admin.post('/command-batches', { kind: 'dimming', zoneIds: [zone.id], otp: await otp(secret, last) });
    check('Batch tiết giảm → 409 (firmware chưa hỗ trợ)', dim.status === 409);
    // by user id: earlier runs left rows with the same e-mail
    const logs = await sql`SELECT 1 FROM activity_logs WHERE user_id = (SELECT id FROM users WHERE email = ${'admin@' + DOMAIN}) AND action = 'Đồng bộ giờ hàng loạt'`;
    const noise = await sql`SELECT 1 FROM activity_logs a JOIN commands m ON m.id::text = a.target_id WHERE m.batch_id = ${b.data.id}`;
    check('Nhật ký: 1 dòng cho batch, không 1 dòng/tủ', logs.length === 1 && noise.length === 0);
    sock.close();

    // ---------- optional load: 1,000 cabinets in one zone ----------
    if (LOAD > 0) {
      const big = (await sql<{ id: string }[]>`SELECT id FROM zones WHERE name = 'Vùng Bắc'`)[0]!.id;
      const lc = await sql<{ ltid: string }[]>`SELECT ltid FROM cabinets WHERE zone1_id = ${big} ORDER BY ltid LIMIT ${LOAD}`;
      console.log(`[e2e] tải: khởi động ${lc.length} tủ giả trong Vùng Bắc…`);
      for (const c of lc) {
        const s = new SimCabinet({ ltid: c.ltid, brokerUrl: MQTT_URL, fault: 'none', location: { lat: 10.85, lng: 106.65 }, telemetryMs: 10_000 });
        loadSims.push(s);
        s.start();
        if (loadSims.length % 100 === 0) await sleep(300);
      }
      await waitFor('load sims online', async () => {
        const n = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cabinets c JOIN cabinet_state s ON s.cabinet_id = c.id WHERE c.zone1_id = ${big} AND s.online`)[0]!.n;
        return n >= lc.length * 0.99;
      }, 120_000);
      const lpv = await admin.post('/command-batches/preview', { zoneIds: [big] });
      const tb = Date.now();
      const lb = await admin.post('/command-batches', { kind: 'time', zoneIds: [big], otp: await otp(secret, last) });
      const ld = await waitFor('load batch', async () => {
        const d = await admin.get(`/command-batches/${lb.data.id}`);
        return d.data.batch.finishedAt ? d.data : null;
      }, 300_000);
      const secs = Math.round((Date.now() - tb) / 1000);
      check(`Tải: batch ${ld.batch.total} tủ Vùng Bắc, ${lc.length} tủ giả online đều ok`, ld.batch.succeeded >= lc.length * 0.99 && ld.batch.failed === lpv.data.blocked,
        `ok ${ld.batch.succeeded}, chặn firmware cũ ${ld.batch.failed}/${lpv.data.blocked}, offline ${ld.batch.offline}, ${secs} s (${Math.round(ld.batch.succeeded / secs)} tủ/s)`);
    }
  } finally {
    for (const s of [...sims, lateSim, ...loadSims]) await s.stop().catch(() => undefined);
    await sql`DELETE FROM schedules WHERE zone_id = ${zone.id} OR cabinet_id = ANY(${ids}::uuid[])`;
    for (const r of originalZone) await sql`INSERT INTO schedules ${sql(r as never)}`;
    await sql`DELETE FROM schedule_applied WHERE cabinet_id = ANY(${ids}::uuid[])`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  }
  await sql.end();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[e2e:schedules] ${checks.length - failed.length}/${checks.length} kiểm tra đạt`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
