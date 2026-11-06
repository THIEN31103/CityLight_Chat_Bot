// LTID visibility end-to-end: only the provider role (device.identity) ever receives an LTID. Everyone else registers a
// device of the unregistered list by its id, and finds no LTID in responses, errors, exports or realtime events.
// Needs the api. Users *@e2e-ltid.citylight.test, test cabinets E2E.LT*, removed at the end. ~20 s.
// Run: npm run e2e:ltid
import { hash } from '@node-rs/argon2';
import ExcelJS from 'exceljs';
import { Redis } from 'ioredis';
import { io } from 'socket.io-client';
import { createSql } from '@citylight/db';
import { base32Decode } from '../src/totp';
import { BASE, login, nextCode, type Client } from './client';

const DOMAIN = 'e2e-ltid.citylight.test';
const LTIDS = ['E2ELT01', 'E2ELT02', 'E2ELT03', 'E2ELT04'] as const;
const [BY_INSTALLER, BY_MANAGER, BY_ADMIN, FORGED] = LTIDS;
const CODES = ['E2E.LT01', 'E2E.LT02', 'E2E.LT03', 'E2E.LT04'] as const;
const sql = createSql(process.env.DATABASE_URL, 2);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const leaks = (body: unknown) => {
  const text = JSON.stringify(body) ?? '';
  return LTIDS.filter((l) => text.includes(l)).concat(/"ltid"\s*:/i.test(text) ? ['field ltid'] as never[] : []);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function workbookText(c: Client, path: string) {
  const res = await fetch(`${BASE}/api/v1${path}`, { headers: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  if (!res.ok) return { status: res.status, text: '' };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await res.arrayBuffer()) as ArrayBuffer);
  const cells: string[] = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value)))));
  return { status: res.status, text: cells.join('\n') };
}

async function main() {
  const cleanup = async () => {
    await sql`DELETE FROM incidents WHERE cabinet_id IN (SELECT id FROM cabinets WHERE ltid = ANY(${[...LTIDS]}))`;
    await sql`DELETE FROM cabinets WHERE ltid = ANY(${[...LTIDS]})`;
    await sql`DELETE FROM unknown_devices WHERE ltid = ANY(${[...LTIDS]})`;
    await sql`DELETE FROM activity_logs WHERE user_email LIKE ${'%@' + DOMAIN}`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  };
  await cleanup();

  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Lt-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const h = await hash(pw);
  const account = async (role: string, canEnroll = false) => {
    await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all, can_enroll)
              VALUES (${org}, ${`${role}${canEnroll ? '-enroll' : ''}@${DOMAIN}`}, ${`E2E ${role}`}, ${h}, ${role}, true, ${canEnroll})`;
    const { c } = await login(`${role}${canEnroll ? '-enroll' : ''}@${DOMAIN}`, pw);
    const setup = await c.post('/auth/2fa/setup');
    if (setup.status < 300 && setup.data?.secret) await c.post('/auth/2fa/enable', { code: nextCode(base32Decode(setup.data.secret), { step: 0 }) });
    return c;
  };
  const admin = await account('admin');
  const manager = await account('manager');
  const operator = await account('operator');
  const viewer = await account('viewer');
  const maintenance = await account('maintenance');
  const installer = await account('viewer', true);
  const others = { manager, operator, viewer, maintenance, installer };

  try {
    await sql`INSERT INTO unknown_devices (ltid, code, imei, ident) VALUES
      (${BY_INSTALLER}, ${CODES[0]}, '861000000000101', 'valid'),
      (${BY_MANAGER}, ${CODES[1]}, '861000000000102', NULL),
      (${FORGED}, ${CODES[3]}, '861000000000104', 'invalid')`;

    // ---------- the unregistered list
    const seen = (await installer.get('/devices/unknown')).data as { id: string; code: string; ltid?: string }[];
    const mine = (code: string) => seen.find((d) => d.code === code)!;
    check('Người duyệt thấy thiết bị nhưng không thấy LTID', !!mine(CODES[0])?.id && leaks(seen).length === 0, leaks(seen).join());
    const adminList = (await admin.get('/devices/unknown')).data as { ltid?: string }[];
    check('Nhà cung cấp thấy LTID', adminList.some((d) => d.ltid === BY_INSTALLER));

    // ---------- registering without knowing it
    for (const [who, c] of [['Quản lý', manager], ['Người duyệt', installer]] as const) {
      const r = await c.post('/cabinets', { ltid: BY_INSTALLER, code: CODES[0] });
      check(`${who} không gõ LTID tay được`, r.status === 403 && r.data.code === 'ltid_forbidden', `HTTP ${r.status}`);
    }
    check('Không gửi cả LTID lẫn thiết bị → từ chối', (await installer.post('/cabinets', { code: CODES[0] })).status === 422);
    const firstId = mine(CODES[0]).id;
    const done = await installer.post('/cabinets', { deviceId: firstId, code: CODES[0] });
    check('Người duyệt đăng ký bằng thiết bị trong danh sách', done.status === 201, `HTTP ${done.status} ${JSON.stringify(done.data)}`);
    const stored = (await sql<{ ltid: string }[]>`SELECT ltid FROM cabinets WHERE code = ${CODES[0]}`)[0];
    check('Server tự gắn đúng LTID', stored?.ltid === BY_INSTALLER);
    const gone = await installer.post('/cabinets', { deviceId: firstId, code: 'E2E.LT99' });
    check('Thiết bị đã đăng ký thì không dùng lại được', gone.status === 409 && gone.data.code === 'device_gone', `HTTP ${gone.status}`);
    check('Quản lý duyệt được board chưa ký', (await manager.post('/cabinets', { deviceId: mine(CODES[1]).id, code: CODES[1] })).status === 201);
    check('Nhà cung cấp vẫn gõ LTID tay được', (await admin.post('/cabinets', { ltid: BY_ADMIN, code: CODES[2] })).status === 201);

    // ---------- errors
    const forged = await installer.post('/cabinets', { deviceId: mine(CODES[3]).id, code: CODES[3] });
    check('Lỗi board ký sai không lộ LTID', forged.status === 409 && forged.data.code === 'device_bad_signature' && leaks(forged.data).length === 0, JSON.stringify(forged.data));
    const taken = await manager.post('/cabinets', { deviceId: mine(CODES[3]).id, code: CODES[0] });
    check('Lỗi trùng mã không lộ LTID', taken.status === 409 && leaks(taken.data).length === 0, JSON.stringify(taken.data));

    // ---------- changing it
    const cid = (await sql<{ id: string }[]>`SELECT id FROM cabinets WHERE code = ${CODES[0]}`)[0]!.id;
    check('Quản lý không đổi được LTID', (await manager.patch(`/cabinets/${cid}`, { ltid: 'E2ELT77' })).status === 403);
    check('Quản lý vẫn sửa được thông tin khác', (await manager.patch(`/cabinets/${cid}`, { notes: 'e2e' })).status === 200);
    check('LTID trong database không đổi', (await sql`SELECT 1 FROM cabinets WHERE id = ${cid} AND ltid = ${BY_INSTALLER}`).length === 1);

    // ---------- guessing it
    for (const [who, c] of Object.entries(others)) {
      const hits = [(await c.get(`/search?q=${BY_INSTALLER}`)).data, (await c.get(`/cabinets?q=${BY_INSTALLER}`)).data?.items ?? []];
      check(`${who}: tìm theo LTID không ra tủ`, hits.every((h) => Array.isArray(h) && h.length === 0));
    }
    check('Nhà cung cấp tìm theo LTID ra tủ', (await admin.get(`/search?q=${BY_INSTALLER}`)).data.length === 1);

    // ---------- every text that reaches a browser, old rows included
    const aid = (await sql<{ id: string }[]>`
      INSERT INTO alarms (cabinet_id, code, type, severity, message, started_at)
      VALUES (${cid}, 'E805', 'spoof_suspect', 'major', ${`Frame mang LTID ${BY_INSTALLER} với IMEI 1 khác IMEI đã ghi nhận 2: frame bị bỏ qua`}, now())
      RETURNING id`)[0]!.id;
    const incident = await manager.post('/incidents', { alarmId: aid });
    check('Tạo sự cố từ cảnh báo cũ', incident.status === 201, `HTTP ${incident.status}`);
    const paths = ['/map/cabinets', '/map/gps-drift', `/cabinets?q=${CODES[0]}`, `/cabinets/${cid}`, `/cabinets/${cid}/diagnostics`, `/cabinets/${cid}/alarms`, `/cabinets/${cid}/commands`,
      `/search?q=${CODES[0]}`, '/areas/unassigned/cabinets', '/alarms', '/incidents', `/incidents/${incident.data?.id}`, '/commands', '/logs/activity', '/logs/activity?size=200', '/devices/unknown', '/devices/registered'];
    for (const [who, c] of Object.entries(others)) {
      const dirty: string[] = [];
      let read = 0;
      for (const p of paths) {
        const r = await c.get(p);
        if (r.status === 200) read++;
        if (leaks(r.data).length) dirty.push(p);
      }
      check(`${who}: không có LTID trong ${read} API đọc được`, read > 0 && dirty.length === 0, dirty.join(' '));
    }
    const log = (await manager.get('/logs/activity?size=200')).data.items as { newValue: string | null }[];
    check('Nhật ký vẫn còn dòng đăng ký nhưng đã che LTID', log.some((l) => l.newValue?.startsWith('LTID ***')));
    const adminMap = (await admin.get('/map/cabinets')).data as { ltid?: string }[];
    check('Nhà cung cấp vẫn nhận LTID sau khi người khác đọc cùng cache', adminMap.some((c) => c.ltid === BY_INSTALLER));
    check('Nhà cung cấp mở được LTID trong lịch sử', ((await admin.get('/devices/registered')).data as { ltid?: string }[]).some((r) => r.ltid === BY_INSTALLER));

    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    for (const [name, path] of [['cảnh báo', '/alarms/export.xlsx'], ['sự cố', '/incidents/export.xlsx'], ['1 tủ', `/cabinets/${cid}/export.xlsx?from=${from}&to=${to}&granularity=raw`]] as const) {
      const x = await workbookText(manager, path);
      check(`File xuất ${name} không có LTID`, x.status === 200 && x.text.length > 0 && !x.text.includes(BY_INSTALLER), `HTTP ${x.status}`);
    }

    // ---------- realtime
    const sock = io(BASE, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie: [...viewer.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    const received: unknown[] = [];
    sock.on('cabinet.state', (s: { cabinetId: string }) => s.cabinetId === cid && received.push(s));
    sock.on('alarm.raised', (a: { cabinetId: string }) => a.cabinetId === cid && received.push(a));
    await new Promise<void>((ok, bad) => {
      sock.once('connect', () => ok());
      sock.once('connect_error', bad);
    });
    await sleep(500);
    await redis.publish('cl:events', JSON.stringify({ type: 'cabinet.state', items: [{ cabinetId: cid, ltid: BY_INSTALLER, status: 'normal', online: true }] }));
    await redis.publish('cl:events', JSON.stringify({ type: 'alarm.raised', alarm: { cabinetId: cid, ltid: BY_INSTALLER, message: `Frame mang LTID ${BY_INSTALLER} với IMEI 1` } }));
    await sleep(1000);
    sock.close();
    check('Sự kiện realtime đến nơi nhưng không có LTID', received.length === 2 && leaks(received).length === 0, JSON.stringify(received));
  } finally {
    await cleanup();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  await sql.end();
  redis.disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
