// M3 acceptance check ("bộ đếm khớp danh sách"): for three scopes (whole system, one district, one ward)
// the KPI counters, the map list, the paginated list, the per-status lists, the area tree and the
// search results must agree with each other and with the DB, and never leak cabinets out of scope.
// Also: saved map views (favorites) per user. Read-only on cabinets; creates and deletes its own
// viewer accounts (*@e2e-map.citylight.test). Run with no simulator writing: npm run e2e:map
import { hash } from '@node-rs/argon2';
import { createSql } from '@citylight/db';
import type { CabinetStatus, CabinetSummary, MapStats } from '@citylight/shared';
import { Client, login } from './client';

const DOMAIN = 'e2e-map.citylight.test';
const sql = createSql(process.env.DATABASE_URL, 2);
const STATUSES: CabinetStatus[] = ['offline', 'fault', 'dimming', 'on', 'off', 'unknown'];

const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};

/** Counters from the DB for cabinets matching a WHERE fragment (alias c). */
async function expected(where: ReturnType<typeof sql>) {
  const rows = await sql<{ status: CabinetStatus; n: number }[]>`
    SELECT coalesce(s.status, 'offline') AS status, count(*)::int AS n FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id
    WHERE ${where} GROUP BY 1`;
  const m: Record<string, number> = { total: 0 };
  for (const s of STATUSES) m[s] = 0;
  for (const r of rows) { m[r.status] += r.n; m.total += r.n; }
  return m;
}

async function checkScope(label: string, c: Client, where: ReturnType<typeof sql>, inScope: (x: CabinetSummary) => boolean) {
  const want = await expected(where);
  const stats = (await c.get('/map/stats')).data as MapStats;
  const map = (await c.get('/map/cabinets')).data as CabinetSummary[];
  const list = (await c.get('/cabinets?page=1&size=1')).data as { total: number };
  const byStatus: Record<string, number> = {};
  for (const x of map) byStatus[x.status] = (byStatus[x.status] ?? 0) + 1;
  check(`${label}: KPI tổng = DB = bản đồ = danh sách`, stats.cabinets.total === want.total && map.length === want.total && list.total === want.total,
    `KPI ${stats.cabinets.total}, DB ${want.total}, bản đồ ${map.length}, danh sách ${list.total}`);
  const bad: string[] = [];
  for (const s of STATUSES) {
    const l = (await c.get(`/cabinets?page=1&size=1&status=${s}`)).data as { total: number };
    if (stats.cabinets[s] !== want[s] || (byStatus[s] ?? 0) !== want[s] || l.total !== want[s]) bad.push(`${s}: KPI ${stats.cabinets[s]} / DB ${want[s]} / bản đồ ${byStatus[s] ?? 0} / lọc ${l.total}`);
  }
  check(`${label}: từng trạng thái KPI = bản đồ = danh sách lọc`, bad.length === 0, bad.join('; ') || STATUSES.map((s) => `${s} ${want[s]}`).join(', '));
  // % online must follow the online flag, not just the status column
  const flag = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cabinets c JOIN cabinet_state s ON s.cabinet_id = c.id WHERE s.online AND ${where}`)[0]!.n;
  check(`${label}: % online = số tủ có cờ online trong DB`, Math.abs(stats.onlinePct - (want.total ? (flag / want.total) * 100 : 0)) < 1e-6, `${stats.onlinePct.toFixed(2)} % (${flag}/${want.total})`);
  check(`${label}: bản đồ không lộ tủ ngoài phạm vi`, map.every(inScope));

  const tree = (await c.get('/areas/tree')).data as { areas: { id: string; kind: string; cabinetCount: number }[]; unassigned: number };
  const districts = tree.areas.filter((a) => a.kind === 'district');
  const wards = tree.areas.filter((a) => a.kind === 'ward');
  const dSum = districts.reduce((n, a) => n + a.cabinetCount, 0) + tree.unassigned;
  const wSum = wards.reduce((n, a) => n + a.cabinetCount, 0);
  check(`${label}: cây khu vực: tổng quận (+ chưa phân) = tổng`, dSum === want.total, `${dSum}`);
  check(`${label}: cây khu vực: tổng phường = tổng`, wSum === want.total, `${wSum}`);
  // the ward list behind each tree leaf must match its counter
  let wardMismatch = 0;
  for (const w of wards.filter((x) => x.cabinetCount > 0).slice(0, 15)) {
    const items = (await c.get(`/areas/${w.id}/cabinets`)).data as CabinetSummary[];
    if (items.length !== w.cabinetCount || !items.every(inScope)) wardMismatch++;
  }
  check(`${label}: danh sách tủ của phường = bộ đếm trên cây`, wardMismatch === 0, wardMismatch ? `${wardMismatch} phường lệch` : undefined);
  const found = (await c.get('/search?q=SIM')).data as CabinetSummary[];
  check(`${label}: tìm kiếm chỉ trả tủ trong phạm vi`, found.every(inScope), `${found.length} kết quả`);
  return want.total;
}

async function main() {
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const district = (await sql<{ id: string; name: string }[]>`
    SELECT d.id, d.name FROM areas d JOIN cabinets c ON c.district_id = d.id WHERE d.kind = 'district' GROUP BY d.id ORDER BY count(*) DESC LIMIT 1`)[0]!;
  const ward = (await sql<{ id: string; name: string }[]>`
    SELECT w.id, w.name FROM areas w JOIN cabinets c ON c.ward_id = w.id WHERE w.kind = 'ward' AND w.parent_id <> ${district.id}
    GROUP BY w.id ORDER BY count(*) DESC LIMIT 1`)[0]!;
  const pw = `Map-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const h = await hash(pw);
  const ids = await sql<{ id: string; email: string }[]>`
    INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
      (${org}, ${'all@' + DOMAIN}, 'E2E map all', ${h}, 'viewer', true),
      (${org}, ${'district@' + DOMAIN}, 'E2E map district', ${h}, 'viewer', false),
      (${org}, ${'ward@' + DOMAIN}, 'E2E map ward', ${h}, 'viewer', false)
    RETURNING id, email`;
  const uid = (p: string) => ids.find((u) => u.email.startsWith(p))!.id;
  await sql`INSERT INTO user_scopes (user_id, area_id) VALUES (${uid('district')}, ${district.id}), (${uid('ward')}, ${ward.id})`;
  console.log(`[e2e:map] phạm vi: toàn hệ thống / quận ${district.name} / phường ${ward.name}`);

  const all = (await login(`all@${DOMAIN}`, pw)).c;
  const dist = (await login(`district@${DOMAIN}`, pw)).c;
  const wd = (await login(`ward@${DOMAIN}`, pw)).c;
  const t0 = Date.now();
  const big = await all.get('/map/cabinets');
  check('Tải danh sách bản đồ 10.000 tủ', big.status === 200, `${big.data.length} tủ, ${Date.now() - t0} ms, ${Math.round(JSON.stringify(big.data).length / 1024)} KB`);

  // spec 6: a cabinet that is not online is "offline", whatever else its row says
  const broken = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cabinet_state WHERE NOT online AND status <> 'offline'`)[0]!.n;
  check('DB: tủ không online đều ở trạng thái offline', broken === 0, broken ? `${broken} tủ sai` : undefined);

  const total = await checkScope('Toàn hệ thống', all, sql`TRUE`, () => true);
  const nd = await checkScope(`Quận ${district.name}`, dist, sql`c.district_id = ${district.id}`, (x) => x.districtId === district.id);
  const nw = await checkScope(`Phường ${ward.name}`, wd, sql`c.ward_id = ${ward.id}`, (x) => x.wardId === ward.id);
  check('Phạm vi lồng nhau: phường < quận < toàn hệ thống', nw > 0 && nd > nw && total > nd, `${nw} < ${nd} < ${total}`);

  // ---------- saved map views ----------
  const f = await dist.post('/favorites', { name: 'Ngã tư thử', center: { lat: 10.77, lng: 106.7 }, zoom: 15 });
  check('Lưu vị trí bản đồ → 201', f.status === 201 && f.data.center.lat === 10.77 && f.data.zoom === 15);
  const mine = await dist.get('/favorites');
  const theirs = await wd.get('/favorites');
  check('Vị trí đã lưu là riêng từng user', mine.data.some((x: { id: string }) => x.id === f.data.id) && !theirs.data.some((x: { id: string }) => x.id === f.data.id));
  const steal = await wd.call('DELETE', `/favorites/${f.data.id}`);
  check('User khác không xóa được → 404', steal.status === 404);
  const bad = await dist.post('/favorites', { name: '', center: { lat: 200, lng: 0 }, zoom: 30 });
  check('Dữ liệu sai → 422', bad.status === 422);
  const del = await dist.call('DELETE', `/favorites/${f.data.id}`);
  check('Xóa vị trí của mình → 204', del.status === 204 && (await dist.get('/favorites')).data.length === 0);

  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  await sql.end();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[e2e:map] ${checks.length - failed.length}/${checks.length} kiểm tra đạt`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
