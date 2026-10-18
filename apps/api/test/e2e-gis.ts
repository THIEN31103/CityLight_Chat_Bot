// M8 GIS end-to-end check: Excel/CSV import (dry run, row errors, replace), map assets by bbox / zoom /
// scope, pole detail + lamps, batched map edits (one transaction, optimistic lock), pole generation
// along a route, decommissioned cabinets hidden. Needs the api running. Users *@e2e-gis.citylight.test.
//   npm run e2e:gis                     (~20 s)
//   npm run e2e:gis -- --load 200000    (+ synthetic poles for the whole fleet, map timings, removed after)
import ExcelJS from 'exceljs';
import { hash } from '@node-rs/argon2';
import { createSql } from '@citylight/db';
import { IMPORT_COLUMNS, distanceM, pointsAlong, type LngLat } from '@citylight/shared';
import { base32Decode } from '../src/totp';
import { BASE, Client, login, nextCode } from './client';

const DOMAIN = 'e2e-gis.citylight.test';
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

async function upload(c: Client, path: string, data: Buffer, name: string) {
  const form = new FormData();
  form.append('file', new Blob([data]), name);
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method: 'POST',
    headers: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': c.jar.get('cl_csrf') ?? '' },
    body: form,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function xlsx(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Trụ đèn');
  ws.addRow([...IMPORT_COLUMNS]);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const bboxAround = (lat: number, lng: number, d = 0.004) => `${lng - d},${lat - d},${lng + d},${lat + d}`;

async function main() {
  const [dX, dY] = await sql<{ id: string }[]>`SELECT id FROM areas WHERE name IN ('Quận 5', 'Quận 8') AND kind = 'district' ORDER BY name`;
  const cabs = await sql<{ id: string; code: string; lat: number; lng: number }[]>`
    SELECT id, code, ST_Y(location) AS lat, ST_X(location) AS lng FROM cabinets WHERE district_id = ${dX!.id} AND ltid LIKE 'SIM7%' ORDER BY code LIMIT 2`;
  const [A, B] = cabs as [typeof cabs[0], typeof cabs[0]];
  const origin = new Map(cabs.map((c) => [c.id, { lat: Number(c.lat), lng: Number(c.lng) }]));
  await sql`DELETE FROM routes WHERE cabinet_id = ANY(${cabs.map((c) => c.id)}::uuid[])`;
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Gis-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const h = await hash(pw);
  const users = await sql<{ id: string; email: string }[]>`
    INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
      (${org}, ${'admin@' + DOMAIN}, 'E2E GIS admin', ${h}, 'admin', true),
      (${org}, ${'vx@' + DOMAIN}, 'E2E viewer X', ${h}, 'viewer', false),
      (${org}, ${'vy@' + DOMAIN}, 'E2E viewer Y', ${h}, 'viewer', false)
    RETURNING id, email`;
  const uid = (p: string) => users.find((u) => u.email.startsWith(p))!.id;
  await sql`INSERT INTO user_scopes (user_id, area_id) VALUES (${uid('vx')}, ${dX!.id}), (${uid('vy')}, ${dY!.id})`;
  const { c: admin } = await login(`admin@${DOMAIN}`, pw);
  const setup = await admin.post('/auth/2fa/setup');
  await admin.post('/auth/2fa/enable', { code: nextCode(base32Decode(setup.data.secret), { step: 0 }) });
  const { c: vx } = await login(`vx@${DOMAIN}`, pw);
  const { c: vy } = await login(`vy@${DOMAIN}`, pw);

  try {
    // ---------- template ----------
    const tpl = await fetch(`${BASE}/api/v1/gis/import/template.xlsx`, { headers: { cookie: [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    const twb = new ExcelJS.Workbook();
    await twb.xlsx.load((await tpl.arrayBuffer()) as ArrayBuffer);
    const head = (twb.worksheets[0]!.getRow(1).values as unknown[]).slice(1);
    check('Tải file mẫu nhập trụ (.xlsx, đúng cột)', tpl.status === 200 && JSON.stringify(head) === JSON.stringify([...IMPORT_COLUMNS]));

    // ---------- import: errors ----------
    const csv = ['Mã tủ;Nhánh;Thứ tự trụ;Vĩ độ;Kinh độ;Số đèn', `${A.code};N3;1;10,76;106,68;1`, `KHONG.CO;N1;1;10.76;106.68;1`, `${A.code};N1;1;106.68;10.76;1`, `${A.code};N1;2;10.761;106.681;1`].join('\n');
    const bad = await upload(admin, '/gis/import?dryRun=false', Buffer.from(csv), 'tru.csv');
    check('File lỗi: báo đúng dòng, KHÔNG ghi gì (kể cả dòng đúng)', bad.status === 200 && bad.data.errorCount === 3 && bad.data.errors.map((e: { row: number }) => e.row).join() === '2,3,4'
      && (await sql`SELECT 1 FROM routes WHERE cabinet_id = ${A.id}`).length === 0, bad.data.errors.map((e: { row: number; message: string }) => `${e.row}: ${e.message}`).join(' | '));
    const vimp = await upload(vx, '/gis/import?dryRun=true', Buffer.from(csv), 'tru.csv');
    check('Giám sát không nhập được → 403', vimp.status === 403);

    // ---------- import: good file ----------
    const step = 0.00027; // ~30 m north per pole
    const rows: unknown[][] = [];
    for (let i = 1; i <= 5; i++) rows.push([A.code, 'N1', i, Number(A.lat) + i * step, Number(A.lng), 2, 150, 0, i === 3 ? 'T-CU-3' : '']);
    for (let i = 1; i <= 3; i++) rows.push([A.code, 2, i, Number(A.lat), Number(A.lng) + i * step, 1, 100, 1, '']);
    const file = await xlsx(rows);
    const dry = await upload(admin, '/gis/import', file, 'tru.xlsx');
    check('Kiểm tra trước (dry run): 2 tuyến, 8 trụ, 13 đèn, chưa ghi', dry.data.dryRun && dry.data.routes === 2 && dry.data.poles === 8 && dry.data.lamps === 13 && dry.data.errorCount === 0
      && (await sql`SELECT 1 FROM routes WHERE cabinet_id = ${A.id}`).length === 0);
    const imp = await upload(admin, '/gis/import?dryRun=false', file, 'tru.xlsx');
    const db1 = (await sql<{ r: number; p: number; l: number }[]>`
      SELECT (SELECT count(*)::int FROM routes WHERE cabinet_id = ${A.id}) AS r,
             (SELECT count(*)::int FROM poles p JOIN routes r ON r.id = p.route_id WHERE r.cabinet_id = ${A.id}) AS p,
             (SELECT count(*)::int FROM lamps l JOIN poles p ON p.id = l.pole_id JOIN routes r ON r.id = p.route_id WHERE r.cabinet_id = ${A.id}) AS l`)[0]!;
    check('Nhập: DB có 2 tuyến, 8 trụ, 13 đèn', imp.status === 200 && db1.r === 2 && db1.p === 8 && db1.l === 13, JSON.stringify(db1));
    const path = (await sql<{ start: string; n: number }[]>`SELECT ST_AsText(ST_StartPoint(path)) AS start, ST_NPoints(path) AS n FROM routes WHERE cabinet_id = ${A.id} AND branch = 1`)[0]!;
    const codes = (await sql<{ code: string; legacy_code: string | null }[]>`SELECT p.code, p.legacy_code FROM poles p JOIN routes r ON r.id = p.route_id WHERE r.cabinet_id = ${A.id} AND r.branch = 1 ORDER BY p.seq`);
    check('Tuyến bắt đầu tại tủ, nối trụ theo thứ tự; mã trụ + mã cũ', path.n === 6 && path.start.includes(String(Number(A.lng)).slice(0, 7)) && codes[0]!.code === `${A.code}_N1_1` && codes[2]!.legacy_code === 'T-CU-3');
    const re = await upload(admin, '/gis/import?dryRun=false', await xlsx(rows.slice(0, 3)), 'tru.xlsx');
    const db2 = (await sql<{ n1: number; n2: number }[]>`
      SELECT count(*) FILTER (WHERE r.branch = 1)::int AS n1, count(*) FILTER (WHERE r.branch = 2)::int AS n2 FROM poles p JOIN routes r ON r.id = p.route_id WHERE r.cabinet_id = ${A.id}`)[0]!;
    check('Nhập lại tủ + nhánh: THAY trụ của tuyến đó, nhánh kia giữ nguyên', re.status === 200 && db2.n1 === 3 && db2.n2 === 3, JSON.stringify(db2));

    // ---------- map assets ----------
    const bb = bboxAround(Number(A.lat), Number(A.lng));
    const z16 = await vx.get(`/map/assets?bbox=${bb}&zoom=16&layers=routes,poles`);
    check('Bản đồ zoom 16: tuyến + trụ của tủ trong phạm vi', z16.status === 200 && z16.data.routes.filter((r: { cabinetId: string }) => r.cabinetId === A.id).length === 2
      && z16.data.poles.filter((p: { cabinetId: string }) => p.cabinetId === A.id).length === 6);
    const z14 = await vx.get(`/map/assets?bbox=${bb}&zoom=14&layers=routes,poles`);
    const z12 = await vx.get(`/map/assets?bbox=${bb}&zoom=12&layers=routes,poles`);
    check('Zoom 14: chỉ tuyến; zoom 12: không gì (nhẹ bản đồ)', z14.data.routes.length >= 2 && z14.data.poles.length === 0 && z12.data.routes.length === 0);
    const out = await vy.get(`/map/assets?bbox=${bb}&zoom=16&layers=routes,poles`);
    check('Người ngoài khu vực không thấy tuyến / trụ', out.data.routes.every((r: { cabinetId: string }) => r.cabinetId !== A.id) && out.data.poles.every((p: { cabinetId: string }) => p.cabinetId !== A.id));
    const pole1 = z16.data.poles.find((p: { code: string }) => p.code === `${A.code}_N1_1`);
    const pd = await vx.get(`/poles/${pole1.id}`);
    check('Chi tiết trụ + 2 đèn 150 W', pd.status === 200 && pd.data.lamps.length === 2 && pd.data.lamps[0].ratedPowerW === 150);
    check('Trụ ngoài khu vực → 403', (await vy.get(`/poles/${pole1.id}`)).status === 403);
    const lamps = await vx.get(`/cabinets/${A.id}/lamps`);
    check('Tab Đèn của tủ: danh sách đèn thật', lamps.status === 200 && lamps.data.length === 9, `${lamps.data.length} đèn`);

    // ---------- edits ----------
    const ve = await vx.post('/map/edits', { ops: [{ op: 'moveCabinet', cabinetId: A.id, lat: 10.7, lng: 106.6 }] });
    check('Giám sát không chỉnh sửa bản đồ → 403', ve.status === 403);
    const bPath: LngLat[] = [[Number(B.lng), Number(B.lat)], [Number(B.lng) + 0.001, Number(B.lat)], [Number(B.lng) + 0.001, Number(B.lat) + 0.001]];
    const n2 = z16.data.poles.find((p: { code: string }) => p.code === `${A.code}_N2_3`);
    const ok = await admin.post('/map/edits', { ops: [
      { op: 'upsertRoute', cabinetId: B.id, branch: 1, path: bPath },
      { op: 'addPole', cabinetId: B.id, branch: 1, lat: Number(B.lat), lng: Number(B.lng) + 0.0005, lampCount: 1 },
      { op: 'addPole', cabinetId: B.id, branch: 1, lat: Number(B.lat), lng: Number(B.lng) + 0.001, lampCount: 3, ratedPowerW: 60 },
      { op: 'movePole', poleId: pole1.id, lat: Number(A.lat) + 0.0003, lng: Number(A.lng) + 0.0001, expectedUpdatedAt: pole1.updatedAt },
      { op: 'deletePole', poleId: n2.id, expectedUpdatedAt: n2.updatedAt },
      { op: 'setPoleLamps', poleId: pole1.id, lampCount: 4, ratedPowerW: 80, lampGroup: 2 },
    ] });
    const bPoles = await sql<{ code: string }[]>`SELECT p.code FROM poles p JOIN routes r ON r.id = p.route_id WHERE r.cabinet_id = ${B.id} ORDER BY p.seq`;
    const p1 = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM lamps WHERE pole_id = ${pole1.id} AND rated_power_w = 80 AND lamp_group = 2`)[0]!.n;
    check('Lưu nháp 6 thao tác trong 1 lần: tuyến mới, 2 trụ mã tự tăng, dời / xóa trụ, sửa đèn', ok.status === 200 && ok.data.saved === 6 && bPoles.map((x) => x.code).join() === `${B.code}_N1_1,${B.code}_N1_2`
      && p1 === 4 && (await sql`SELECT 1 FROM poles WHERE id = ${n2.id}`).length === 0);
    const stale = await admin.post('/map/edits', { ops: [
      { op: 'addPole', cabinetId: B.id, branch: 1, lat: Number(B.lat), lng: Number(B.lng) + 0.0002 },
      { op: 'movePole', poleId: pole1.id, lat: 10.1, lng: 106.1, expectedUpdatedAt: pole1.updatedAt },
    ] });
    const after = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM poles p JOIN routes r ON r.id = p.route_id WHERE r.cabinet_id = ${B.id}`)[0]!.n;
    check('Xung đột (trụ vừa bị người khác sửa) → 409, cả lô không ghi', stale.status === 409 && stale.data.code === 'edit_conflict' && after === 2, stale.data?.detail);
    const noRoute = await admin.post('/map/edits', { ops: [{ op: 'addPole', cabinetId: B.id, branch: 2, lat: Number(B.lat), lng: Number(B.lng) }] });
    check('Thêm trụ khi chưa có tuyến → 422', noRoute.status === 422);

    // ---------- generate ----------
    const rB = (await sql<{ id: string }[]>`SELECT id FROM routes WHERE cabinet_id = ${B.id} AND branch = 1`)[0]!.id;
    const gen = await admin.post(`/routes/${rB}/generate-poles`, { spacingM: 25, lampCount: 1, ratedPowerW: 100 });
    const want = pointsAlong(bPath, 25).length;
    const gp = await sql<{ lat: number; lng: number }[]>`SELECT ST_Y(p.location) AS lat, ST_X(p.location) AS lng FROM poles p WHERE p.route_id = ${rB} ORDER BY p.seq`;
    const gaps = gp.slice(1).map((p, i) => distanceM({ lat: Number(gp[i]!.lat), lng: Number(gp[i]!.lng) }, { lat: Number(p.lat), lng: Number(p.lng) }));
    check('Sinh trụ cách 25 m dọc tuyến (thay trụ cũ), đúng số lượng như web xem trước', gen.status === 200 && gen.data.poles === want && gp.length === want, `${want} trụ`);
    // a pole on each side of the bend is closer in a straight line than along the road
    check('Khoảng cách giữa các trụ ≈ 25 m (đo theo đường)', gaps.slice(0, -1).every((g) => g <= 25.5) && gaps.filter((g) => Math.abs(g - 25) < 0.5).length >= gaps.length - 3, gaps.map((g) => g.toFixed(1)).join(', '));

    // ---------- move cabinet ----------
    const mv = await admin.post('/map/edits', { ops: [{ op: 'moveCabinet', cabinetId: B.id, lat: Number(B.lat) + 0.0001, lng: Number(B.lng) }] });
    const det = await admin.get(`/cabinets/${B.id}`);
    check('Dời tủ: vị trí mới trong chi tiết tủ', mv.status === 200 && Math.abs(det.data.cabinet.location.lat - (Number(B.lat) + 0.0001)) < 1e-7);
    const del = await admin.post('/map/edits', { ops: [{ op: 'deleteRoute', routeId: rB }] });
    check('Xóa tuyến: trụ + đèn xóa theo', del.status === 200 && (await sql`SELECT 1 FROM poles WHERE route_id = ${rB}`).length === 0);
    const logs = await sql`SELECT 1 FROM activity_logs WHERE user_id = ${uid('admin')} AND action IN ('Nhập dữ liệu trụ', 'Chỉnh sửa bản đồ', 'Sinh trụ hàng loạt')`;
    check('Nhật ký: nhập, chỉnh sửa, sinh trụ', logs.length >= 6, `${logs.length} dòng`);

    // ---------- load ----------
    if (LOAD > 0) {
      const perCab = Math.max(2, Math.round(LOAD / 10_000 / 2));
      console.log(`[e2e:gis] tải: sinh ${perCab * 2} trụ / tủ cho 10.000 tủ…`);
      const t0 = Date.now();
      await sql`
        WITH c AS (SELECT id, code, location FROM cabinets WHERE active AND ltid LIKE 'SIM%' AND id <> ALL(${cabs.map((x) => x.id)}::uuid[])),
        r AS (
          INSERT INTO routes (cabinet_id, code, branch, path)
          SELECT c.id, c.code || '_N' || b, b, ST_MakeLine(ARRAY[c.location] || ARRAY(
            SELECT ST_Translate(c.location, CASE WHEN b = 1 THEN 0.00027 * i ELSE 0 END, CASE WHEN b = 2 THEN 0.00027 * i ELSE 0 END) FROM generate_series(1, ${perCab}) i))
          FROM c, generate_series(1, 2) b RETURNING id, cabinet_id, code, branch
        )
        INSERT INTO poles (route_id, code, location, lamp_count, seq, legacy_code)
        SELECT r.id, r.code || '_' || i, ST_Translate(c.location, CASE WHEN r.branch = 1 THEN 0.00027 * i ELSE 0 END, CASE WHEN r.branch = 2 THEN 0.00027 * i ELSE 0 END), 1, i, 'E2E-LOAD'
        FROM r JOIN c ON c.id = r.cabinet_id, generate_series(1, ${perCab}) i`;
      const total = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM poles`)[0]!.n;
      console.log(`[e2e:gis] ${total} trụ trong DB (${Math.round((Date.now() - t0) / 1000)} s)`);
      const time = async (q: string) => {
        const t = Date.now();
        const r = await admin.get(q);
        return { ms: Date.now() - t, r };
      };
      const city = '106.55,10.65,106.85,10.9';
      const z13 = await time(`/map/assets?bbox=${city}&zoom=13&layers=routes,poles`);
      const street = bboxAround(10.776, 106.7, 0.006);
      const z16b = await time(`/map/assets?bbox=${street}&zoom=16&layers=routes,poles`);
      check(`Tải ${total.toLocaleString('vi-VN')} trụ: cả thành phố zoom 13 (chỉ tuyến, cắt 5.000)`, z13.r.status === 200 && z13.r.data.poles.length === 0 && z13.ms < 3000,
        `${z13.r.data.routes.length} tuyến, cắt=${z13.r.data.truncated}, ${z13.ms} ms`);
      check('Tải: một khu phố zoom 16 (tuyến + trụ)', z16b.r.status === 200 && z16b.ms < 1500, `${z16b.r.data.routes.length} tuyến, ${z16b.r.data.poles.length} trụ, ${z16b.ms} ms`);
      await sql`DELETE FROM routes WHERE id IN (SELECT route_id FROM poles WHERE legacy_code = 'E2E-LOAD')`;
      console.log('[e2e:gis] đã xóa trụ tải thử');
    }
  } finally {
    await sql`DELETE FROM routes WHERE cabinet_id = ANY(${cabs.map((c) => c.id)}::uuid[])`;
    for (const [id, p] of origin) await sql`UPDATE cabinets SET location = ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326) WHERE id = ${id}`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  }
  await sql.end();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[e2e:gis] ${checks.length - failed.length}/${checks.length} kiểm tra đạt`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
