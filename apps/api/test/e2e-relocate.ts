// "Update the cabinet location from GPS" end-to-end check (shared/relocate.ts): GPS history in telemetry,
// unknown device GPS for the register form, suggestion (too few fixes / jumping GPS / ok / already matches),
// permission + scope, stale dialog, the move itself (audited, ingest reloads), map overlay of open E802.
// Needs api + ingest. Users *@e2e-gps.citylight.test, cabinet E2E.GPS01 (LTID E2EGPS01), removed at the end. ~1 min.
// Run: npm run e2e:relocate
import { hash } from '@node-rs/argon2';
import { Redis } from 'ioredis';
import { CONFIG_CHANNEL } from '@citylight/db/notify';
import { createSql } from '@citylight/db';
import { distanceM, GPS_RELOCATE_MIN_SAMPLES } from '@citylight/shared';
import { SimCabinet } from '../../simulator/src/cabinet';
import { base32Decode } from '../src/totp';
import { login, nextCode } from './client';

const DOMAIN = 'e2e-gps.citylight.test';
const LTID = 'E2EGPS01';
const CODE = 'E2E.GPS01';
// simulated cabinets on the backend listener (no authn); e2e-mqtt-auth covers the cabinet port 1883 + login
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

// where the cabinet really is (simulator GPS) and where it was declared: ~500 m further north
const REAL = { lat: 10.8012345, lng: 106.7123456 };
const DECLARED = { lat: REAL.lat + 500 / 111_195, lng: REAL.lng };

async function main() {
  const cleanup = async () => {
    await sql`DELETE FROM alarms WHERE cabinet_id IN (SELECT id FROM cabinets WHERE ltid = ${LTID})`;
    await sql`DELETE FROM cabinets WHERE ltid = ${LTID}`;
    await sql`DELETE FROM unknown_devices WHERE ltid = ${LTID}`;
    await redis.publish(CONFIG_CHANNEL, JSON.stringify({ type: 'registry' }));
  };
  await cleanup();
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Gps-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const h = await hash(pw);
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
    (${org}, ${'admin@' + DOMAIN}, 'E2E admin', ${h}, 'admin', true), (${org}, ${'op@' + DOMAIN}, 'E2E operator', ${h}, 'operator', true),
    (${org}, ${'view@' + DOMAIN}, 'E2E viewer', ${h}, 'viewer', false)`;
  const { c: admin } = await login(`admin@${DOMAIN}`, pw);
  await admin.post('/auth/2fa/enable', { code: nextCode(base32Decode((await admin.post('/auth/2fa/setup')).data.secret), { step: 0 }) });
  const { c: op } = await login(`op@${DOMAIN}`, pw);
  await op.post('/auth/2fa/enable', { code: nextCode(base32Decode((await op.post('/auth/2fa/setup')).data.secret), { step: 0 }) });
  const { c: viewer } = await login(`view@${DOMAIN}`, pw);
  const sim = new SimCabinet({ ltid: LTID, brokerUrl: MQTT_URL, fault: 'none', location: REAL, telemetryMs: 2000 });

  try {
    // ---------- unknown device: its GPS pre-fills the register form ----------
    sim.start();
    const unk = await waitFor('unknown device with GPS', async () =>
      (await admin.get('/devices/unknown')).data.find((x: { ltid: string; gps: unknown }) => x.ltid === LTID && x.gps), 20_000);
    check('Tủ lạ: danh sách có GPS thiết bị gửi lên', distanceM(unk.gps, REAL) < 1, `${unk.gps.lat}, ${unk.gps.lng}`);

    const reg = await admin.post('/cabinets', { ltid: LTID, code: CODE, name: 'Tủ thử GPS', location: DECLARED });
    const cid: string = reg.data?.id;
    check('Đăng ký tủ với tọa độ khai báo sai ~500 m', reg.status === 201);
    await waitFor('online', async () => (await sql`SELECT 1 FROM cabinet_state WHERE cabinet_id = ${cid} AND online`).length === 1, 20_000);

    // ---------- suggestion: too few fixes, then ok ----------
    const early = await admin.get(`/cabinets/${cid}/gps-suggestion`);
    check('Ít điểm GPS → chưa cho cập nhật (nêu lý do)', early.status === 200 && early.data.ok === false && early.data.samples < GPS_RELOCATE_MIN_SAMPLES && /cần ít nhất/.test(early.data.reason),
      `${early.data.samples} điểm: ${early.data.reason}`);
    const rows = await sql`SELECT count(*)::int AS n FROM telemetry WHERE cabinet_id = ${cid} AND gps_lat IS NOT NULL`;
    check('Telemetry lưu GPS theo từng frame', rows[0]!.n >= 1, `${rows[0]!.n} dòng có GPS`);
    const s = await waitFor('enough fixes', async () => {
      const r = await admin.get(`/cabinets/${cid}/gps-suggestion`);
      return r.data.samples >= GPS_RELOCATE_MIN_SAMPLES && r.data;
    }, 40_000);
    check('Đủ điểm GPS → đề xuất đúng vị trí thật, lệch ~500 m', s.ok === true && s.reason === null && distanceM(s.gps, REAL) < 1 && Math.abs(s.distanceM - 500) < 5 && s.spreadM < 1,
      `${s.samples} điểm, lệch ${s.distanceM} m, độ tụ ${s.spreadM} m`);

    // ---------- permissions / scope ----------
    check('Điều hành không được cập nhật vị trí → 403', (await op.post(`/cabinets/${cid}/location-from-gps`, { expected: s.gps })).status === 403);
    const vs = await viewer.get(`/cabinets/${cid}/gps-suggestion`);
    check('Người ngoài khu vực không xem được đề xuất → 403', vs.status === 403, vs.data?.code);

    // ---------- jumping GPS: refused ----------
    // 30 fixes scattered up to ~300 m (marked, removed right after)
    const now = Date.now();
    for (let i = 0; i < 40; i++) {
      const d = 300 / 111_195;
      await sql`INSERT INTO telemetry (ts, cabinet_id, online, gps_lat, gps_lng, extra)
                VALUES (${new Date(now - 60_000 - i * 1000 - 500)}, ${cid}, true, ${REAL.lat + (Math.random() - 0.5) * 2 * d}, ${REAL.lng + (Math.random() - 0.5) * 2 * d}, ${sql.json({ e2e: 'jitter' })})`;
    }
    const jump = await admin.get(`/cabinets/${cid}/gps-suggestion`);
    check('GPS nhảy (độ tụ > 50 m) → không cho cập nhật', jump.data.ok === false && /chưa ổn định/.test(jump.data.reason), `độ tụ ${jump.data.spreadM} m`);
    const jumpPost = await admin.post(`/cabinets/${cid}/location-from-gps`, { expected: s.gps });
    check('… và POST bị chặn 409 gps_not_ready', jumpPost.status === 409 && jumpPost.data.code === 'gps_not_ready');
    await sql`DELETE FROM telemetry WHERE cabinet_id = ${cid} AND extra->>'e2e' = 'jitter'`;

    // ---------- map overlay of open E802 (alarm row injected: the real rule needs 5 min) ----------
    await sql`INSERT INTO alarms (cabinet_id, code, type, severity, message, started_at, active)
              VALUES (${cid}, 'E802', 'gps_drift', 'minor', 'e2e', now(), true)`;
    const drift = (await admin.get('/map/gps-drift')).data.find((x: { cabinetId: string }) => x.cabinetId === cid);
    check('Bản đồ: tủ có E802 → đường khai báo → GPS', !!drift && Math.abs(drift.distanceM - 500) < 5 && distanceM(drift.gps, REAL) < 1, drift && `${drift.distanceM} m`);
    check('Bản đồ lệch GPS: người ngoài khu vực không thấy', !(await viewer.get('/map/gps-drift')).data.some((x: { cabinetId: string }) => x.cabinetId === cid));

    // ---------- stale dialog, then the move ----------
    const far = { lat: REAL.lat + 0.01, lng: REAL.lng };
    const stale = await admin.post(`/cabinets/${cid}/location-from-gps`, { expected: far });
    check('Hộp thoại cũ (GPS đã khác điểm đang hiện) → 409 gps_changed', stale.status === 409 && stale.data.code === 'gps_changed');
    const mv = await admin.post(`/cabinets/${cid}/location-from-gps`, { expected: s.gps });
    const loc = (await sql<{ lat: number; lng: number }[]>`SELECT ST_Y(location) AS lat, ST_X(location) AS lng FROM cabinets WHERE id = ${cid}`)[0]!;
    check('Cập nhật vị trí theo GPS → tủ về đúng chỗ thật', mv.status === 200 && Math.abs(mv.data.movedM - 500) < 5 && distanceM(loc, REAL) < 1, `dời ${mv.data.movedM} m`);
    const log = await sql`SELECT new_value FROM activity_logs WHERE user_email = ${'admin@' + DOMAIN} AND action = 'Cập nhật vị trí tủ theo GPS' AND target_id = ${cid}`;
    check('Ghi nhật ký thao tác (vị trí cũ → mới)', log.length === 1 && JSON.parse(log[0]!.new_value as string).movedM > 490);
    const mapC = (await admin.get('/map/cabinets')).data.find((c: { id: string }) => c.id === cid);
    check('Bản đồ thấy vị trí mới ngay', !!mapC && distanceM(mapC.location, REAL) < 1);
    const after = await admin.get(`/cabinets/${cid}/gps-suggestion`);
    check('Sau khi cập nhật: "đã khớp GPS", không đề xuất nữa', after.data.ok === false && /đã khớp/.test(after.data.reason) && after.data.distanceM < 1);
    const again = await admin.post(`/cabinets/${cid}/location-from-gps`, { expected: s.gps });
    check('Bấm lại lần nữa → 409 (không có gì để dời)', again.status === 409);
  } finally {
    await sim.stop();
    await cleanup();
    await sql`DELETE FROM activity_logs WHERE user_email LIKE ${'%@' + DOMAIN}`;
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
