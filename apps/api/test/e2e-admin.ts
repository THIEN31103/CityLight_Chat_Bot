// M8 admin end-to-end check: areas / management units / zones (assign cabinets), unknown device ->
// registered cabinet picked up by the ingest worker without a restart, edit, decommission / reactivate,
// settings (offline delay applied by the ingest worker), field map. Needs api + ingest.
// Users *@e2e-adm.citylight.test, test cabinet E2E.ADM01 (LTID E2EADM01), removed at the end. ~2 min.
// Run: npm run e2e:admin
import { hash } from '@node-rs/argon2';
import { createSql } from '@citylight/db';
import { SimCabinet } from '../../simulator/src/cabinet';
import { base32Decode } from '../src/totp';
import { login, nextCode } from './client';

const DOMAIN = 'e2e-adm.citylight.test';
const LTID = 'E2EADM01';
const CODE = 'E2E.ADM01';
const MQTT_URL = process.env.E2E_MQTT_URL ?? 'mqtt://localhost:1883';
const sql = createSql(process.env.DATABASE_URL, 2);
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

async function main() {
  const cleanup = async () => {
    await sql`DELETE FROM cabinets WHERE ltid = ${LTID}`;
    await sql`DELETE FROM unknown_devices WHERE ltid = ${LTID}`;
    await sql`DELETE FROM areas WHERE name LIKE 'E2E %'`;
    await sql`DELETE FROM management_units WHERE name LIKE 'E2E %'`;
    await sql`DELETE FROM zones WHERE name LIKE 'E2E %'`;
    await sql`DELETE FROM system_settings WHERE key = 'offline_after_s'`;
  };
  await cleanup();
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const unit = (await sql<{ id: string }[]>`SELECT id FROM areas WHERE kind = 'unit' LIMIT 1`)[0]!.id;
  const pw = `Adm-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const h = await hash(pw);
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
    (${org}, ${'admin@' + DOMAIN}, 'E2E admin', ${h}, 'admin', true), (${org}, ${'op@' + DOMAIN}, 'E2E operator', ${h}, 'operator', true)`;
  const { c: admin } = await login(`admin@${DOMAIN}`, pw);
  const setup = await admin.post('/auth/2fa/setup');
  const secret = base32Decode(setup.data.secret);
  await admin.post('/auth/2fa/enable', { code: nextCode(secret, { step: 0 }) });
  const { c: op } = await login(`op@${DOMAIN}`, pw);
  const sop = await op.post('/auth/2fa/setup');
  await op.post('/auth/2fa/enable', { code: nextCode(base32Decode(sop.data.secret), { step: 0 }) });
  const sim = new SimCabinet({ ltid: LTID, brokerUrl: MQTT_URL, fault: 'none', location: { lat: 10.77, lng: 106.69 }, telemetryMs: 2000 });

  try {
    // ---------- areas ----------
    check('Điều hành không sửa danh mục → 403', (await op.post('/areas', { kind: 'district', name: 'E2E Quận X', parentId: unit })).status === 403);
    const d = await admin.post('/areas', { kind: 'district', name: 'E2E Quận X', parentId: unit });
    const w = await admin.post('/areas', { kind: 'ward', name: 'E2E Phường 1', parentId: d.data.id });
    check('Thêm quận + phường', d.status === 201 && w.status === 201);
    check('Phường dưới phường → 422, trùng tên → 409',
      (await admin.post('/areas', { kind: 'ward', name: 'E2E Phường 2', parentId: w.data.id })).status === 422 && (await admin.post('/areas', { kind: 'ward', name: 'e2e phường 1', parentId: d.data.id })).status === 409);
    check('Đổi tên khu vực', (await admin.call('PATCH', `/areas/${w.data.id}`, { name: 'E2E Phường Một' })).status === 200);
    const delBusy = await admin.call('DELETE', `/areas/${d.data.id}`);
    check('Xóa quận còn phường → 409 (nêu lý do)', delBusy.status === 409 && delBusy.data.detail.includes('1 khu vực con'));

    // ---------- management units + zones ----------
    const mu = await admin.post('/management-units', { name: 'E2E Khu QL' });
    const z = await admin.post('/zones', { name: 'E2E Vùng', center: { lat: 10.77, lng: 106.69 } });
    check('Thêm khu quản lý + vùng (có tâm)', mu.status === 201 && z.status === 201);

    // ---------- unknown device -> register ----------
    sim.start();
    await waitFor('unknown device', async () => (await admin.get('/devices/unknown')).data.some((x: { ltid: string }) => x.ltid === LTID), 20_000);
    check('Tủ lạ gửi frame → nằm ở "Thiết bị chưa đăng ký"', true);
    const reg = await admin.post('/cabinets', {
      ltid: LTID.toLowerCase(), code: CODE, name: 'Tủ thử quản trị', location: { lat: 10.77, lng: 106.69 }, wardId: w.data.id, zone1Id: z.data.id, managementUnitId: mu.data.id,
    });
    const cid = reg.data?.id;
    check('Đăng ký tủ (LTID chữ thường → chuẩn hóa, quận suy ra từ phường)', reg.status === 201
      && (await sql`SELECT 1 FROM cabinets WHERE id = ${cid} AND ltid = ${LTID} AND district_id = ${d.data.id}`).length === 1);
    check('Đăng ký trùng LTID / mã → 409', (await admin.post('/cabinets', { ltid: LTID, code: 'E2E.OTHER', name: 'x', location: { lat: 10.77, lng: 106.69 } })).status === 409);
    const t0 = Date.now();
    await waitFor('online', async () => (await sql`SELECT 1 FROM cabinet_state WHERE cabinet_id = ${cid} AND online`).length === 1, 20_000);
    check('Ingest nhận tủ mới ngay, không cần khởi động lại', !(await admin.get('/devices/unknown')).data.some((x: { ltid: string }) => x.ltid === LTID), `online sau ${Math.round((Date.now() - t0) / 1000)} s`);
    const map = await admin.get('/map/cabinets');
    check('Tủ mới có trên bản đồ, đúng vùng', map.data.some((c: { id: string }) => c.id === cid) && (await admin.get('/zones')).data.find((x: { id: string }) => x.id === z.data.id).cabinetCount === 1);
    const busyZone = await admin.call('DELETE', `/zones/${z.data.id}`);
    check('Xóa vùng còn tủ → 409', busyZone.status === 409);

    // ---------- edit ----------
    const pt = await admin.call('PATCH', `/cabinets/${cid}`, { name: 'Tủ thử (đã sửa)', location: { lat: 10.7701, lng: 106.6901 }, notes: 'ghi chú' });
    const det = await admin.get(`/cabinets/${cid}`);
    check('Sửa tên / vị trí tủ', pt.status === 200 && det.data.cabinet.name === 'Tủ thử (đã sửa)' && Math.abs(det.data.cabinet.location.lat - 10.7701) < 1e-7);
    check('Điều hành không sửa tủ → 403', (await op.call('PATCH', `/cabinets/${cid}`, { name: 'x' })).status === 403);
    const wrongWard = await admin.call('PATCH', `/cabinets/${cid}`, { districtId: (await sql<{ id: string }[]>`SELECT id FROM areas WHERE kind = 'district' AND name NOT LIKE 'E2E %' LIMIT 1`)[0]!.id, wardId: w.data.id });
    check('Phường không thuộc quận → 422', wrongWard.status === 422);

    // ---------- decommission ----------
    const before = (await admin.get('/map/stats')).data.cabinets.total;
    const dc = await admin.post(`/cabinets/${cid}/decommission`);
    const statsAfter = (await admin.get('/map/stats')).data.cabinets.total;
    const cmd = await op.post(`/cabinets/${cid}/commands`, { type: 'AUTO', params: {} }, { 'Idempotency-Key': crypto.randomUUID() });
    check('Ngừng sử dụng: biến khỏi bản đồ + bộ đếm, chặn lệnh', dc.status === 204 && statsAfter === before - 1 && !(await admin.get('/map/cabinets')).data.some((c: { id: string }) => c.id === cid)
      && cmd.status === 409 && cmd.data.code === 'cabinet_decommissioned', `${before} → ${statsAfter}`);
    await sleep(5000);
    const ignored = (await sql<{ online: boolean }[]>`SELECT online FROM cabinet_state WHERE cabinet_id = ${cid}`)[0]!;
    check('Ingest bỏ qua tủ ngừng dùng (vẫn gửi frame nhưng không online lại)', !ignored.online);
    await admin.post(`/cabinets/${cid}/reactivate`);
    await waitFor('online again', async () => (await sql`SELECT 1 FROM cabinet_state WHERE cabinet_id = ${cid} AND online`).length === 1, 20_000);
    check('Dùng lại tủ → online trở lại, lại có trên bản đồ', (await admin.get('/map/cabinets')).data.some((c: { id: string }) => c.id === cid));

    // ---------- settings: offline delay ----------
    const s0 = await admin.get('/settings');
    check('Cấu hình mặc định: mất kết nối sau 60 s', s0.data.offlineAfterS === 60);
    check('Giá trị ngoài 30–900 → 422', (await admin.put('/settings', { offlineAfterS: 5, lampGroupLabels: s0.data.lampGroupLabels })).status === 422);
    const s1 = await admin.put('/settings', { offlineAfterS: 30, lampGroupLabels: { ...s0.data.lampGroupLabels, 3: 'Đèn công viên' } });
    check('Lưu cấu hình (30 s, đổi tên nhóm đèn 3)', s1.status === 200 && s1.data.offlineAfterS === 30 && s1.data.lampGroupLabels['3'] === 'Đèn công viên' && s1.data.updatedBy === `admin@${DOMAIN}`);
    await sleep(2000);
    await sim.stop();
    const t1 = Date.now();
    await waitFor('offline', async () => (await sql`SELECT 1 FROM cabinet_state WHERE cabinet_id = ${cid} AND NOT online`).length === 1, 70_000);
    const off = Math.round((Date.now() - t1) / 1000);
    check('Ingest áp dụng ngay: tủ mất kết nối sau ~30 s thay vì 60 s', off >= 25 && off <= 45, `${off} s`);

    // ---------- field map ----------
    const fm = await admin.get('/field-map');
    check('Ánh xạ telemetry: danh sách key + key lạ', fm.status === 200 && fm.data.entries.some((e: { key: string }) => e.key === 'LTID') && Array.isArray(fm.data.unknownKeys));

    // ---------- clean areas ----------
    await sql`DELETE FROM cabinets WHERE id = ${cid}`;
    check('Xóa vùng / khu QL / phường / quận khi không còn dùng',
      (await admin.call('DELETE', `/zones/${z.data.id}`)).status === 204 && (await admin.call('DELETE', `/management-units/${mu.data.id}`)).status === 204
      && (await admin.call('DELETE', `/areas/${w.data.id}`)).status === 204 && (await admin.call('DELETE', `/areas/${d.data.id}`)).status === 204);
    const logs = await sql<{ action: string }[]>`SELECT DISTINCT action FROM activity_logs WHERE user_email = ${'admin@' + DOMAIN} AND ts > now() - interval '10 minutes'`;
    const la = logs.map((l) => l.action);
    check('Nhật ký quản trị', ['Thêm khu vực', 'Đăng ký tủ', 'Sửa thông tin tủ', 'Ngừng sử dụng tủ', 'Dùng lại tủ', 'Cấu hình hệ thống', 'Xóa vùng'].every((a) => la.includes(a)));
  } finally {
    await sim.stop().catch(() => undefined);
    await cleanup();
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
    // put the ingest worker back on the default offline delay
    await fetch('http://localhost:3000/api/v1/health').catch(() => undefined);
  }
  await sql.end();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[e2e:admin] ${checks.length - failed.length}/${checks.length} kiểm tra đạt`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
