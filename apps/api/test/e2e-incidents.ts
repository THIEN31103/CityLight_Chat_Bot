// M7 end-to-end check: alarm -> incident -> assign (maintenance user) -> photos -> resolve -> close,
// permissions and area scope, fake images refused, Excel exports read back, monthly report vs DB,
// overdue reminder (scheduler) and assignment event (for the notify-worker).
// Needs api + scheduler running. Users *@e2e-inc.citylight.test, removed at the end. About 1.5 minutes.
// Run: npm run e2e:incidents
import ExcelJS from 'exceljs';
import { hash } from '@node-rs/argon2';
import { Redis } from 'ioredis';
import { createSql } from '@citylight/db';
import { base32Decode } from '../src/totp';
import { BASE, Client, login, nextCode } from './client';

const DOMAIN = 'e2e-inc.citylight.test';
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

// a real 1×1 PNG, and files that only pretend to be images
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** multipart upload with the session cookie + CSRF header, like the browser */
async function upload(c: Client, path: string, data: Buffer, name: string, type: string) {
  const form = new FormData();
  form.append('file', new Blob([data], { type }), name);
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method: 'POST',
    headers: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': c.jar.get('cl_csrf') ?? '' },
    body: form,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function getRaw(c: Client, path: string) {
  const res = await fetch(`${BASE}/api/v1${path}`, { headers: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  return { status: res.status, type: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) };
}
async function readXlsx(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0]!;
  const rows: unknown[][] = [];
  ws.eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
  return rows;
}

async function main() {
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const [dX, dY] = await sql<{ id: string; name: string }[]>`
    SELECT d.id, d.name FROM areas d JOIN cabinets c ON c.district_id = d.id WHERE d.kind = 'district' GROUP BY d.id ORDER BY d.name LIMIT 2`;
  const cab = (await sql<{ id: string; code: string }[]>`SELECT id, code FROM cabinets WHERE district_id = ${dX!.id} ORDER BY code LIMIT 1`)[0]!;
  // a closed historical alarm (not touched by the ingest worker)
  const alarm = (await sql<{ id: string }[]>`
    INSERT INTO alarms (cabinet_id, code, type, severity, message, started_at, ended_at, active)
    VALUES (${cab.id}, 'E501', 'leak_current', 'critical', 'Rò 42 mA > 30 mA (e2e)', now() - interval '10 minutes', now(), false) RETURNING id`)[0]!;

  const pw = `Inc-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const h = await hash(pw);
  const users = await sql<{ id: string; email: string }[]>`
    INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
      (${org}, ${'manager@' + DOMAIN}, 'E2E Quản lý', ${h}, 'operator', true),
      (${org}, ${'maint-a@' + DOMAIN}, 'E2E Bảo trì A', ${h}, 'maintenance', false),
      (${org}, ${'maint-b@' + DOMAIN}, 'E2E Bảo trì B', ${h}, 'maintenance', false),
      (${org}, ${'maint-c@' + DOMAIN}, 'E2E Bảo trì C', ${h}, 'maintenance', false),
      (${org}, ${'viewer@' + DOMAIN}, 'E2E Giám sát', ${h}, 'viewer', false)
    RETURNING id, email`;
  const uid = (p: string) => users.find((u) => u.email.startsWith(p))!.id;
  await sql`INSERT INTO user_scopes (user_id, area_id) VALUES
    (${uid('maint-a')}, ${dX!.id}), (${uid('maint-b')}, ${dY!.id}), (${uid('maint-c')}, ${dX!.id}), (${uid('viewer')}, ${dX!.id})`;
  const { c: mgr } = await login(`manager@${DOMAIN}`, pw);
  const setup = await mgr.post('/auth/2fa/setup');
  await mgr.post('/auth/2fa/enable', { code: nextCode(base32Decode(setup.data.secret), { step: 0 }) });
  const { c: ma } = await login(`maint-a@${DOMAIN}`, pw);
  const { c: mb } = await login(`maint-b@${DOMAIN}`, pw);
  const { c: mc } = await login(`maint-c@${DOMAIN}`, pw);
  const { c: viewer } = await login(`viewer@${DOMAIN}`, pw);

  const events: { type: string; incident: { id: string; assigneeId: string } }[] = [];
  const sub = redis.duplicate();
  await sub.subscribe('cl:events');
  sub.on('message', (_c, m) => {
    if (m.startsWith('{"type":"incident.')) events.push(JSON.parse(m));
  });

  let incId = '';
  try {
    // ---------- create from an alarm ----------
    const vc = await viewer.post('/incidents', { alarmId: alarm.id });
    check('Giám sát không tạo được sự cố → 403', vc.status === 403);
    const cr = await mgr.post('/incidents', { alarmId: alarm.id });
    incId = cr.data?.id;
    check('Tạo sự cố từ cảnh báo: mã SC, nguồn cảnh báo, phân loại + nội dung lấy từ cảnh báo',
      cr.status === 201 && /^SC\d{5}$/.test(cr.data.code) && cr.data.source === 'alarm' && cr.data.category === 'Rò điện' && cr.data.content.includes('E501'),
      `${cr.data?.code} · ${cr.data?.category} · ${cr.data?.content}`);
    const dup = await mgr.post('/incidents', { alarmId: alarm.id });
    check('Cảnh báo đã có sự cố đang mở → 409', dup.status === 409 && dup.data.code === 'incident_exists');
    check('Ngoài phạm vi khu vực: Bảo trì B không xem được → 403', (await mb.get(`/incidents/${incId}`)).status === 403);
    check('Bảo trì A (đúng khu vực) xem được', (await ma.get(`/incidents/${incId}`)).status === 200);

    // ---------- assign ----------
    const as = await mgr.get(`/incidents/assignees?cabinetId=${cab.id}`);
    const names = (as.data as { id: string }[]).map((u) => u.id);
    check('Danh sách người xử lý: có A, C (đúng khu vực); không có B, Giám sát', names.includes(uid('maint-a')) && names.includes(uid('maint-c')) && !names.includes(uid('maint-b')) && !names.includes(uid('viewer')));
    const skip = await mgr.post(`/incidents/${incId}/transition`, { to: 'resolved', resolution: 'x' });
    check('Chuyển trạng thái sai luồng (mới → đã xử lý) → 409', skip.status === 409 && skip.data.code === 'invalid_transition');
    const wrong = await mgr.post(`/incidents/${incId}/transition`, { to: 'assigned', assigneeId: uid('maint-b'), deadline: new Date(Date.now() + 86400_000).toISOString() });
    check('Giao cho người ngoài khu vực → 422', wrong.status === 422 && wrong.data.code === 'invalid_assignee');
    const past = await mgr.post(`/incidents/${incId}/transition`, { to: 'assigned', assigneeId: uid('maint-a'), deadline: new Date(Date.now() - 60_000).toISOString() });
    check('Hạn xử lý trong quá khứ → 422', past.status === 422);
    const notMgr = await ma.post(`/incidents/${incId}/transition`, { to: 'assigned', assigneeId: uid('maint-a'), deadline: new Date(Date.now() + 86400_000).toISOString() });
    check('Bảo trì không tự giao việc → 403', notMgr.status === 403);
    // deadline a few seconds ahead: the scheduler must flag it overdue and remind the assignee
    const deadline = new Date(Date.now() + 4000);
    const asg = await mgr.post(`/incidents/${incId}/transition`, { to: 'assigned', assigneeId: uid('maint-a'), deadline: deadline.toISOString(), note: 'Kiểm tra tuyến N1' });
    check('Giao xử lý cho Bảo trì A, có hạn', asg.status === 200 && asg.data.status === 'assigned' && asg.data.assignee === 'E2E Bảo trì A' && asg.data.assigneeId === uid('maint-a'));
    await waitFor('assigned event', async () => events.some((e) => e.type === 'incident.assigned' && e.incident.id === incId), 5000).catch(() => false);
    check('Sự kiện "giao việc" cho notify-worker (tin Telegram tới người được giao)', events.some((e) => e.type === 'incident.assigned' && e.incident.assigneeId === uid('maint-a')));
    const mine = await ma.get('/incidents?q=mine');
    check('"Việc của tôi" của Bảo trì A có sự cố này', mine.data.items.some((i: { id: string }) => i.id === incId));

    // ---------- photos ----------
    const up = await upload(ma, `/incidents/${incId}/photos?kind=report`, PNG, 'hien-truong.png', 'image/png');
    check('Bảo trì A thêm ảnh hiện trường (PNG thật) → 201', up.status === 201 && up.data.kind === 'report');
    const fake = await upload(ma, `/incidents/${incId}/photos?kind=report`, Buffer.from('<script>alert(1)</script>'), 'anh.jpg', 'image/jpeg');
    check('File giả ảnh (tên .jpg, nội dung text) → 415', fake.status === 415);
    const big = await upload(ma, `/incidents/${incId}/photos?kind=report`, Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]), 'to.png', 'image/png');
    check('Ảnh > 5 MB → 413', big.status === 413, `HTTP ${big.status}`);
    const vu = await upload(viewer, `/incidents/${incId}/photos?kind=report`, PNG, 'x.png', 'image/png');
    check('Giám sát không thêm ảnh → 403', vu.status === 403);
    const img = await getRaw(ma, `/incidents/${incId}/photos/${up.data.id}`);
    check('Xem ảnh: đúng nội dung + content-type', img.status === 200 && img.type === 'image/png' && img.body.equals(PNG));
    check('Người ngoài khu vực không xem được ảnh → 403', (await getRaw(mb, `/incidents/${incId}/photos/${up.data.id}`)).status === 403);

    // ---------- overdue (scheduler, every 60 s) ----------
    await waitFor('overdue reminder', async () => events.some((e) => e.type === 'incident.overdue' && e.incident.id === incId), 75_000);
    const ov = await mgr.get(`/incidents/${incId}`);
    check('Quá hạn: scheduler nhắc 1 lần, timeline ghi "Quá hạn xử lý"', ov.data.overdue === true && ov.data.events.some((e: { action: string }) => e.action === 'Quá hạn xử lý'));
    const ovList = await mgr.get('/incidents?q=overdue');
    const stats = await mgr.get('/map/stats');
    check('Lọc "Quá hạn" và KPI sự cố quá hạn trên bản đồ', ovList.data.items.some((i: { id: string }) => i.id === incId) && stats.data.overdueIncidents >= 1, `KPI ${stats.data.overdueIncidents}`);
    await sleep(2000);
    check('Không nhắc lại lần 2', events.filter((e) => e.type === 'incident.overdue' && e.incident.id === incId).length === 1);

    // ---------- resolve / close ----------
    const other = await mc.post(`/incidents/${incId}/transition`, { to: 'resolved', resolution: 'Đã xử lý' });
    check('Bảo trì khác (cùng khu vực) không báo xử lý hộ → 403', other.status === 403 && other.data.code === 'not_assignee');
    const noText = await ma.post(`/incidents/${incId}/transition`, { to: 'resolved' });
    check('Báo đã xử lý mà không ghi nội dung → 422', noText.status === 422);
    const res = await ma.post(`/incidents/${incId}/transition`, { to: 'resolved', resolution: 'Thay hộp nối bị ngập nước ở trụ 12, đo cách điện đạt' });
    check('Bảo trì A báo đã xử lý', res.status === 200 && res.data.status === 'resolved' && !!res.data.resolvedAt);
    const up2 = await upload(ma, `/incidents/${incId}/photos?kind=resolution`, PNG, 'sau-xu-ly.png', 'image/png');
    check('Ảnh sau xử lý', up2.status === 201 && up2.data.kind === 'resolution');
    const close = await mgr.post(`/incidents/${incId}/transition`, { to: 'closed', note: 'Nghiệm thu đạt' });
    check('Quản lý đóng sự cố', close.status === 200 && close.data.status === 'closed');
    const full = await mgr.get(`/incidents/${incId}`);
    const acts = full.data.events.map((e: { action: string }) => e.action);
    check('Timeline đủ bước', ['Tạo từ cảnh báo', 'Giao xử lý', 'Thêm ảnh hiện trường', 'Quá hạn xử lý', 'Báo đã xử lý', 'Thêm ảnh sau xử lý', 'Đóng sự cố'].every((a) => acts.includes(a)), acts.join(' → '));
    check('2 nhóm ảnh trong chi tiết', full.data.photoList.length === 2);
    const again = await mgr.post('/incidents', { alarmId: alarm.id });
    check('Sự cố cũ đã đóng → cảnh báo tạo được sự cố mới', again.status === 201);
    if (again.data?.id) await sql`DELETE FROM incidents WHERE id = ${again.data.id}`;

    // ---------- Excel ----------
    const x = await getRaw(mgr, `/incidents/export.xlsx?q=closed`);
    const rows = await readXlsx(x.body);
    check('Xuất Excel sự cố theo bộ lọc (.xlsx đọc lại được)', x.status === 200 && x.type?.includes('spreadsheetml') === true && rows[0]![0] === 'Mã' && rows.some((r) => r[0] === full.data.code), `${rows.length - 1} dòng`);
    const ax = await getRaw(viewer, `/alarms/export.xlsx?type=leak_current`);
    const arows = await readXlsx(ax.body);
    check('Xuất Excel cảnh báo theo bộ lọc + phạm vi', ax.status === 200 && arows[0]![0] === 'Mã lỗi' && arows.slice(1).every((r) => r[0] === 'E501'), `${arows.length - 1} dòng`);

    // ---------- report ----------
    const month = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
    const rep = await mgr.get(`/incidents/report?month=${month}`);
    const db = (await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM incidents WHERE reported_at >= ${new Date(`${month}-01T00:00:00+07:00`)} AND cabinet_id IS NOT NULL`)[0]!.n;
    check('Báo cáo tháng khớp DB, có phân loại "Rò điện", thời gian xử lý TB', rep.status === 200 && rep.data.total === db && rep.data.byCategory['Rò điện'] >= 1 && rep.data.avgResolveHours >= 0,
      `${rep.data.total} sự cố, TB ${rep.data.avgResolveHours} h, trễ hạn ${rep.data.lateRate} %`);
    const vrep = await viewer.get(`/incidents/report?month=${month}`);
    check('Báo cáo theo phạm vi (Giám sát 1 quận ≤ toàn hệ thống)', vrep.data.total <= rep.data.total && (vrep.data.byDistrict[dY!.name] ?? 0) === 0);

    // ---------- audit ----------
    const logs = await sql<{ action: string }[]>`SELECT action FROM activity_logs WHERE target_type = 'incident' AND target_id = ${incId}`;
    const la = logs.map((l) => l.action);
    check('Nhật ký: tạo, giao, ảnh, xử lý, đóng', ['Tạo sự cố', 'Giao xử lý', 'Thêm ảnh sự cố', 'Báo đã xử lý', 'Đóng sự cố'].every((a) => la.includes(a)));

    const del = await mgr.call('DELETE', `/incidents/${incId}/photos/${up.data.id}`);
    check('Quản lý xóa ảnh → 204, file không còn', del.status === 204 && (await getRaw(mgr, `/incidents/${incId}/photos/${up.data.id}`)).status === 404);
  } finally {
    sub.disconnect();
    if (incId) {
      for (const p of (await mgr.get(`/incidents/${incId}`)).data?.photoList ?? []) await mgr.call('DELETE', `/incidents/${incId}/photos/${p.id}`);
      await sql`DELETE FROM incidents WHERE id = ${incId}`;
    }
    await sql`DELETE FROM incidents WHERE alarm_id = ${alarm.id}`;
    await sql`DELETE FROM alarms WHERE id = ${alarm.id}`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  }
  await sql.end();
  redis.disconnect();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[e2e:incidents] ${checks.length - failed.length}/${checks.length} kiểm tra đạt`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
