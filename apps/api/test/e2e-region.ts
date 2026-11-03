// S62 service region end-to-end check, against an API started with SERVICE_REGION=hcm-2025 (the trial stack) after
// trial-ctl.sh seed-region: GET /map/region, area tree locked, cabinet / pole positions outside TP. Hồ Chí Minh refused.
// Users *@e2e-region.citylight.test, test cabinet E2E.REG01 (LTID E2EREG01), removed at the end. No broker needed.
// Run (local trial): API_URL=http://localhost:3100 DATABASE_URL=<trial db> npm run e2e:region
import { hash } from '@node-rs/argon2';
import { createSql } from '@citylight/db';
import { base32Decode } from '../src/totp';
import { login, nextCode } from './client';

const DOMAIN = 'e2e-region.citylight.test';
const LTID = 'E2EREG01';
const CODE = 'E2E.REG01';
const BEN_THANH = { lat: 10.7725, lng: 106.698 };
const HA_NOI = { lat: 21.028, lng: 105.854 };
const sql = createSql(process.env.DATABASE_URL, 2);
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};

async function main() {
  const cleanup = async () => {
    await sql`DELETE FROM poles WHERE route_id IN (SELECT r.id FROM routes r JOIN cabinets c ON c.id = r.cabinet_id WHERE c.ltid = ${LTID})`;
    await sql`DELETE FROM routes WHERE cabinet_id IN (SELECT id FROM cabinets WHERE ltid = ${LTID})`;
    await sql`DELETE FROM cabinets WHERE ltid = ${LTID}`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  };
  await cleanup();
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Reg-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
    (${org}, ${'admin@' + DOMAIN}, 'E2E region admin', ${await hash(pw)}, 'admin', true)`;
  const { c: admin } = await login(`admin@${DOMAIN}`, pw);
  const setup = await admin.post('/auth/2fa/setup');
  await admin.post('/auth/2fa/enable', { code: nextCode(base32Decode(setup.data.secret), { step: 0 }) });

  try {
    const reg = await admin.get('/map/region');
    const r = reg.data?.region;
    check('GET /map/region = hcm-2025, chỉ viền (không gửi polygon / danh sách phường)', reg.status === 200 && r?.id === 'hcm-2025'
      && r.outline?.length > 0 && !('polygons' in r) && !('groups' in r), r ? `${r.name}, bbox ${r.bbox.join(', ')}` : JSON.stringify(reg.data));
    if (!r) throw new Error('API has no service region: start it with SERVICE_REGION=hcm-2025');

    // ---------- area tree ----------
    const tree = (await admin.get('/areas/tree')).data.areas as { id: string; kind: string; name: string; parentId: string | null }[];
    const ward = tree.find((a) => a.kind === 'ward' && a.name === 'Phường Bến Thành');
    const dist = tree.find((a) => a.id === ward?.parentId);
    check('Cây khu vực có Phường Bến Thành dưới "Quận 1 (cũ)"', dist?.name === 'Quận 1 (cũ)');
    check('Có đủ 168 đơn vị mới (113 phường, 54 xã, 1 đặc khu)',
      tree.filter((a) => a.kind === 'ward' && /^(Phường|Xã|Đặc khu) /.test(a.name) && tree.find((d) => d.id === a.parentId)?.name.endsWith(' (cũ)')).length === 168);
    const unit = tree.find((a) => a.kind === 'unit')!;
    const add = await admin.post('/areas', { kind: 'district', name: 'E2E Quận X', parentId: unit.id });
    const ren = await admin.call('PATCH', `/areas/${ward!.id}`, { name: 'E2E đổi tên' });
    const del = await admin.call('DELETE', `/areas/${ward!.id}`);
    check('Thêm / đổi tên / xóa khu vực → 409 areas_locked', [add, ren, del].every((x) => x.status === 409 && x.data?.code === 'areas_locked'),
      [add, ren, del].map((x) => x.status).join(' '));

    // ---------- cabinet positions ----------
    const out = await admin.post('/cabinets', { ltid: LTID, code: CODE, name: 'Tủ thử vùng', location: HA_NOI, wardId: ward!.id });
    check('Đăng ký tủ ở Hà Nội → 422 outside_region', out.status === 422 && out.data?.code === 'outside_region' && out.data?.params?.region === 'TP. Hồ Chí Minh');
    const ok = await admin.post('/cabinets', { ltid: LTID, code: CODE, name: 'Tủ thử vùng', location: BEN_THANH, wardId: ward!.id });
    const cid = ok.data?.id as string;
    check('Đăng ký tủ ở Bến Thành → 201, quận suy ra = Quận 1 (cũ)', ok.status === 201
      && (await sql`SELECT 1 FROM cabinets WHERE id = ${cid} AND district_id = ${dist!.id}`).length === 1);
    const patchOut = await admin.patch(`/cabinets/${cid}`, { location: HA_NOI });
    const patchIn = await admin.patch(`/cabinets/${cid}`, { location: { lat: 10.98, lng: 106.652 } });
    check('Sửa vị trí ra Hà Nội → 422, sang Thủ Dầu Một → 200', patchOut.status === 422 && patchIn.status === 200, `${patchOut.status} ${patchIn.status}`);

    // ---------- map editor ----------
    const move = await admin.post('/map/edits', { ops: [{ op: 'moveCabinet', cabinetId: cid, ...HA_NOI }] });
    const pole = await admin.post('/map/edits', { ops: [{ op: 'addPole', cabinetId: cid, branch: 1, ...HA_NOI }] });
    const route = await admin.post('/map/edits', { ops: [{ op: 'upsertRoute', cabinetId: cid, branch: 1, path: [[106.652, 10.98], [HA_NOI.lng, HA_NOI.lat]] }] });
    check('Bản đồ: kéo tủ / thêm trụ / vẽ tuyến ra ngoài vùng → 422', [move, pole, route].every((x) => x.status === 422 && x.data?.code === 'outside_region'),
      [move, pole, route].map((x) => x.status).join(' '));
    const poleIn = await admin.post('/map/edits', { ops: [
      { op: 'upsertRoute', cabinetId: cid, branch: 1, path: [[106.652, 10.98], [106.653, 10.981]] },
      { op: 'addPole', cabinetId: cid, branch: 1, lat: 10.9805, lng: 106.6525 },
    ] });
    check('Vẽ tuyến + thêm trụ trong vùng → 200', poleIn.status === 200, `${poleIn.status} ${JSON.stringify(poleIn.data).slice(0, 120)}`);
    const pos = (await sql<{ lat: number }[]>`SELECT ST_Y(location) AS lat FROM cabinets WHERE id = ${cid}`)[0]!;
    check('Vị trí tủ không đổi sau các lệnh bị từ chối', Math.abs(pos.lat - 10.98) < 1e-6);
  } finally {
    await cleanup();
    await sql.end();
  }
  const bad = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - bad.length}/${checks.length} checks passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
