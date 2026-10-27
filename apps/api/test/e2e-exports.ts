// S54 + S55 end-to-end: the DS18B20 flag per cabinet (no E503 / over_temp while not fitted, diagnostics
// "unsupported", alarm again once an admin ticks it) and the Excel / CSV exports (one cabinet = a sheet per tab;
// several cabinets by code prefix = summary + data; CSV with BOM; row / range limits; activity log).
// Needs api + ingest. Cabinet E2E.EXP01 (LTID E2EEXP1, simulator reporting CTTE=1000), user
// admin@e2e-exports.citylight.test, removed at the end. ~1 min. Run: npm run e2e:exports
import { hash } from '@node-rs/argon2';
import ExcelJS from 'exceljs';
import { Redis } from 'ioredis';
import { CONFIG_CHANNEL } from '@citylight/db/notify';
import { createSql } from '@citylight/db';
import { SimCabinet } from '../../simulator/src/cabinet';
import { base32Decode } from '../src/totp';
import { BASE, login, nextCode, type Client } from './client';

const DOMAIN = 'e2e-exports.citylight.test';
const LTID = 'E2EEXP1';
const CODE = 'E2E.EXP01';
const MQTT_URL = process.env.E2E_MQTT_URL ?? process.env.MQTT_URL ?? 'mqtt://localhost:1885';
const LOC = { lat: 10.8312, lng: 106.6921 };
const sql = createSql(process.env.DATABASE_URL, 2);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  console.log(`  (timeout waiting for ${what})`);
  return null;
}

/** GET a file with the session cookie: status, headers, raw bytes. */
async function download(c: Client, path: string) {
  const res = await fetch(`${BASE}/api/v1${path}`, { headers: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') ?? '', disposition: res.headers.get('content-disposition') ?? '', buf };
}
async function workbook(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}
const headers = (ws: ExcelJS.Worksheet) => (ws.getRow(1).values as unknown[]).slice(1).map(String);

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
  const pw = `Exp-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all)
            VALUES (${org}, ${'admin@' + DOMAIN}, 'E2E admin', ${await hash(pw)}, 'admin', true)`;
  const { c: admin } = await login(`admin@${DOMAIN}`, pw);
  await admin.post('/auth/2fa/enable', { code: nextCode(base32Decode((await admin.post('/auth/2fa/setup')).data.secret), { step: 0 }) });

  // the DS18B20 of this simulator is "broken": CTTE=1000 in every frame
  const sim = new SimCabinet({ ltid: LTID, brokerUrl: MQTT_URL, fault: 'temp_sensor_fault', location: LOC, telemetryMs: 1000 });
  const tempAlarm = async (cid: string) => (await sql`SELECT 1 FROM alarms WHERE cabinet_id = ${cid} AND type = 'temp_sensor_fault' AND active`).length > 0;
  const tempDiag = async (cid: string) =>
    ((await admin.get(`/cabinets/${cid}/diagnostics`)).data.items as { status: string; code: string | null; evidence: string }[]).find(
      (i) => i.evidence.startsWith('CTTE') || i.evidence.startsWith('has_temp'),
    );

  try {
    sim.start();
    await waitFor('unknown', async () => (await admin.get('/devices/unknown')).data.some((x: { ltid: string }) => x.ltid === LTID), 20_000);
    const reg = await admin.post('/cabinets', { ltid: LTID, code: CODE, name: 'Tủ thử xuất Excel', location: LOC });
    const cid: string = reg.data.id;
    check('Đăng ký tủ (mặc định không có cảm biến nhiệt)', reg.status === 201 && (await admin.get(`/cabinets/${cid}`)).data.cabinet.hasTempSensor === false);
    await waitFor('online', async () => (await sql`SELECT 1 FROM cabinet_state WHERE cabinet_id = ${cid} AND online`).length === 1, 20_000);
    const t1 = new Date();
    await sleep(8000);

    // ---------- S57: frames_raw keeps 1 frame / 10 min of a registered cabinet (ingest RAW_SAMPLE_MIN default) ----------
    const rawN = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM frames_raw WHERE ltid = ${LTID} AND ts >= ${t1}`)[0]!.n;
    const teleN = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM telemetry WHERE cabinet_id = ${cid} AND ts >= ${t1}`)[0]!.n;
    check('frames_raw chỉ lấy mẫu (≤ 1 frame) trong khi telemetry ghi mọi frame', rawN <= 1 && teleN >= 5, `raw ${rawN}, telemetry ${teleN}`);

    // ---------- S54: DS18B20 flag ----------
    check('Không lắp cảm biến: CTTE=1000 không bật E503', !(await tempAlarm(cid)));
    const d0 = await tempDiag(cid);
    check('Chẩn đoán: cảm biến nhiệt = không hỗ trợ (không phải lỗi)', d0?.status === 'unsupported' && d0.code === null, JSON.stringify(d0));
    const on = await admin.call('PATCH', `/cabinets/${cid}`, { hasTempSensor: true });
    check('Admin bật "Có cảm biến nhiệt"', on.status === 200 && (await admin.get(`/cabinets/${cid}`)).data.cabinet.hasTempSensor === true, `${on.status}`);
    check('Có cảm biến + CTTE=1000 → E503', !!(await waitFor('E503', () => tempAlarm(cid), 15_000)));
    const d1 = await tempDiag(cid);
    check('Chẩn đoán: E503', d1?.code === 'E503', JSON.stringify(d1));

    // ---------- S55: one cabinet ----------
    const now = Date.now();
    const range = (h: number, step: string) => `from=${new Date(now - h * 3_600_000).toISOString()}&to=${new Date(now + 60_000).toISOString()}&step=${step}`;
    const x = await download(admin, `/cabinets/${cid}/export.xlsx?${range(1, 'raw')}`);
    check('Xuất 1 tủ (từng frame) → file xlsx', x.status === 200 && x.type.includes('spreadsheetml') && /E2E\.EXP01/.test(decodeURIComponent(x.disposition)), `${x.status} ${x.disposition}`);
    const wb = await workbook(x.buf);
    const names = wb.worksheets.map((w) => w.name);
    check('Đủ sheet theo tab', ['Giám sát', 'Điện áp', 'Dòng điện', 'Công suất', 'Rò điện - nhiệt độ', 'Trạng thái nhánh', 'Điện năng theo ngày', 'Cảnh báo', 'Lệnh'].every((n) => names.includes(n)), names.join(' | '));
    const volt = wb.getWorksheet('Điện áp')!;
    check('Sheet Điện áp có dữ liệu từng frame', volt.rowCount > 5 && headers(volt)[1] === 'L1-N (V)', `${volt.rowCount - 1} dòng`);
    check('Có cảm biến → sheet Rò điện - nhiệt độ có cột nhiệt độ', headers(wb.getWorksheet('Rò điện - nhiệt độ')!).includes('Nhiệt độ (°C)'));
    check('Sheet Cảnh báo có E503', ((wb.getWorksheet('Cảnh báo')!.getColumn(1).values as unknown[]) ?? []).includes('E503'));

    await admin.call('PATCH', `/cabinets/${cid}`, { hasTempSensor: false });
    check('Tắt lại → E503 đóng', !!(await waitFor('E503 closed', async () => !(await tempAlarm(cid)), 15_000)));
    const h = await download(admin, `/cabinets/${cid}/export.xlsx?${range(3, '1h')}`);
    const wbh = await workbook(h.buf);
    const leak = wbh.getWorksheet('Rò điện - nhiệt độ')!;
    check('Bước 1 giờ (dữ liệu gần nhất lấy từ bảng thô) → có dòng, không cột nhiệt độ', h.status === 200 && leak.rowCount >= 2 && !headers(leak).includes('Nhiệt độ (°C)'), `${leak.rowCount - 1} dòng, ${headers(leak).join(', ')}`);
    check('Bước 1 giờ: không có sheet Trạng thái nhánh, Công suất có cột kWh', !wbh.getWorksheet('Trạng thái nhánh') && headers(wbh.getWorksheet('Công suất')!).some((c) => c.includes('kWh')));
    const dd = await download(admin, `/cabinets/${cid}/export.xlsx?${range(30, '1d')}`);
    check('Bước 1 ngày → 200', dd.status === 200 && (await workbook(dd.buf)).getWorksheet('Điện áp')!.rowCount >= 2);
    const big = await download(admin, `/cabinets/${cid}/export.xlsx?${range(24 * 20, 'raw')}`);
    check('Quá nhiều dòng (từng frame 20 ngày) → 422 too_many_rows', big.status === 422 && JSON.parse(big.buf.toString()).code === 'too_many_rows', `${big.status}`);
    // S57: every-frame rows are kept 30 days; the 5-minute step reads telemetry_5m before that
    const old = await download(admin, `/cabinets/${cid}/export.xlsx?${range(24 * 40, 'raw')}`);
    const oldBody = old.status === 422 ? JSON.parse(old.buf.toString()) : null;
    check('Từng frame quá 30 ngày → 422 raw_too_old (có lời nhắn)', oldBody?.code === 'raw_too_old' && /30 ngày/.test(oldBody.detail ?? ''), `${old.status} ${oldBody?.code}`);
    const m5 = await download(admin, `/cabinets/${cid}/export.xlsx?${range(24 * 60, '5m')}`);
    check('Bước 5 phút 60 ngày (bảng tổng hợp + bảng thô) → 200, có dòng gần nhất', m5.status === 200 && (await workbook(m5.buf)).getWorksheet('Điện áp')!.rowCount >= 2, `${m5.status}`);
    const auto = await download(admin, `/reports/telemetry.xlsx?${range(24 * 45, 'auto')}&codes=${encodeURIComponent(CODE)}`);
    const autoInfo = auto.status === 200 ? (await workbook(auto.buf)).getWorksheet('Thông tin') : undefined;
    const autoStep = autoInfo ? ((autoInfo.getColumn(2).values as unknown[]) ?? []).map(String) : [];
    check('Tự động với khoảng 45 ngày không chọn "từng frame"', auto.status === 200 && !autoStep.some((v) => v.startsWith('Từng frame')), `${auto.status} ${autoStep.find((v) => /phút|giờ|ngày|frame/.test(v)) ?? ''}`);
    const bad = await download(admin, `/cabinets/${cid}/export.xlsx?from=${new Date(now).toISOString()}&to=${new Date(now - 1000).toISOString()}`);
    check('Khoảng ngược → 422 invalid_range', bad.status === 422 && JSON.parse(bad.buf.toString()).code === 'invalid_range', `${bad.status}`);

    // ---------- S55: several cabinets ----------
    const rx = await download(admin, `/reports/telemetry.xlsx?${range(1, 'auto')}&codes=E2E.EXP*`);
    const wr = await workbook(rx.buf);
    const sum = wr.getWorksheet('Tổng hợp');
    const data = wr.getWorksheet('Dữ liệu');
    check('Báo cáo theo tiền tố mã → Tổng hợp 1 tủ + Dữ liệu', rx.status === 200 && sum?.rowCount === 2 && sum.getCell('A2').value === CODE && (data?.rowCount ?? 0) > 5, `${rx.status}, tổng hợp ${sum?.rowCount}, dữ liệu ${data?.rowCount}`);
    const csv = await download(admin, `/reports/telemetry.csv?${range(1, '5m')}&codes=${encodeURIComponent(CODE)}`);
    const text = csv.buf.toString('utf8');
    check('CSV có BOM UTF-8, cột Mã tủ, dòng dữ liệu', csv.status === 200 && text.charCodeAt(0) === 0xfeff && text.slice(1).startsWith('Mã tủ,') && text.includes(CODE), `${csv.status}, ${text.split('\r\n').length - 2} dòng`);
    const none = await download(admin, `/reports/telemetry.xlsx?${range(1, 'auto')}&codes=KHONGCO.*`);
    check('Không tủ nào khớp → 422 no_cabinet', none.status === 422 && JSON.parse(none.buf.toString()).code === 'no_cabinet');
    const logs = await sql`SELECT 1 FROM activity_logs WHERE user_email = ${'admin@' + DOMAIN} AND action = 'Xuất dữ liệu'`;
    check('Nhật ký thao tác ghi mỗi lần xuất', logs.length >= 4, `${logs.length} dòng`);
  } finally {
    await sim.stop();
    await cleanup();
    await sql`DELETE FROM activity_logs WHERE user_email LIKE ${'%@' + DOMAIN}`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
    await redis.quit();
    await sql.end();
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n[e2e:exports] ${checks.length - failed}/${checks.length} kiểm tra đạt`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
