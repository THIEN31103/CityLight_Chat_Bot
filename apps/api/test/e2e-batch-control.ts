// S56 end-to-end check: command batches by cabinet code (exact, case-insensitive, "XX.*" prefix) and control batches
// (manual on / back to auto) with 2FA, per-cabinet results (online / offline / old firmware 1307ebc), retry with the
// stored command, the 2,000-cabinet limit, one log line per batch.
// Needs api + ingest + command-worker running and the 10,000 simulator cabinets registered
// (npm run sim:register -- --count 10000). Cabinets SIM8101..SIM8104 + one v2-1307ebc cabinet, user
// admin@e2e-batch.citylight.test (removed at the end). ~2 min. Run: npm run e2e:batch-control
import { hash } from '@node-rs/argon2';
import { createSql } from '@citylight/db';
import { SimCabinet } from '../../simulator/src/cabinet';
import { base32Decode, totpStep } from '../src/totp';
import { login, nextCode } from './client';

const DOMAIN = 'e2e-batch.citylight.test';
const MQTT_URL = process.env.E2E_MQTT_URL ?? process.env.MQTT_URL ?? 'mqtt://localhost:1885';
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
/** Fresh TOTP code (each step is accepted once): waits for the next 30 s step if needed. */
async function otp(secret: Buffer, last: { step: number }) {
  while (Math.max(totpStep(Date.now()), last.step + 1) > totpStep(Date.now()) + 1) await sleep(1000);
  return nextCode(secret, last);
}

type Cab = { id: string; code: string; ltid: string };

async function main() {
  const sims4 = await sql<Cab[]>`SELECT id, code, ltid FROM cabinets WHERE ltid IN ('SIM8101', 'SIM8102', 'SIM8103', 'SIM8104') AND active ORDER BY ltid`;
  if (sims4.length < 4) throw new Error('cần tủ SIM8101..SIM8104 (npm run sim:register -- --count 10000)');
  const [a1, a2, a3, off] = sims4 as [Cab, Cab, Cab, Cab];
  const old = (await sql<Cab[]>`SELECT id, code, ltid FROM cabinets WHERE fw_profile = 'v2-1307ebc' AND active ORDER BY code LIMIT 1`)[0];
  if (!old) throw new Error('cần ít nhất 1 tủ v2-1307ebc');
  const online = [a1, a2, a3];
  const ids = [...online, off].map((c) => c.id);
  await waitFor('test cabinets offline', async () => (await sql`SELECT 1 FROM cabinet_state WHERE online AND cabinet_id = ANY(${ids}::uuid[])`).length === 0, 90_000);

  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Bat-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const h = await hash(pw);
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
    (${org}, ${'admin@' + DOMAIN}, 'E2E batch admin', ${h}, 'admin', true),
    (${org}, ${'viewer@' + DOMAIN}, 'E2E batch viewer', ${h}, 'viewer', true)`;
  const { c: admin } = await login(`admin@${DOMAIN}`, pw);
  const setup = await admin.post('/auth/2fa/setup');
  const secret = base32Decode(setup.data.secret);
  const last = { step: 0 };
  await admin.post('/auth/2fa/enable', { code: await otp(secret, last) });
  const { c: viewer } = await login(`viewer@${DOMAIN}`, pw);

  const sim = (c: Cab) => new SimCabinet({ ltid: c.ltid, brokerUrl: MQTT_URL, fault: 'none', location: { lat: 10.85, lng: 106.77 }, telemetryMs: 2000 });
  const sims = online.map(sim);
  const offSim = sim(off);
  try {
    sims.forEach((s) => s.start());
    await waitFor('sims online', async () => (await sql`SELECT 1 FROM cabinet_state WHERE online AND cabinet_id = ANY(${online.map((c) => c.id)}::uuid[])`).length === online.length, 30_000);

    // ---------- selection by code ----------
    // exact codes in any case, separated by commas / spaces / new lines
    const codes = `${a1.code}, ${a2.code.toLowerCase()}\n${a3.code} ${off.code};${old.code}`;
    const allOn = { type: 'MANUAL_ALL', params: { on: true } };
    const pv = await admin.post('/command-batches/preview', { kind: 'control', codes, command: allOn });
    check('Xem trước theo mã tủ (không phân biệt hoa thường): 5 tủ, 1 offline + 1 firmware cũ offline, 1 bị chặn',
      pv.status === 200 && pv.data.total === 5 && pv.data.offline === 2 && pv.data.blocked === 1 && pv.data.unsupported === 0 && pv.data.max === 2000,
      JSON.stringify(pv.data));
    const prefix = `${a1.code.slice(0, -1)}*`;
    const want = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cabinets WHERE active AND upper(code) LIKE ${a1.code.slice(0, -1).toUpperCase() + '%'}`)[0]!.n;
    const pp = await admin.post('/command-batches/preview', { kind: 'time', codes: prefix.toLowerCase() });
    check(`Tiền tố "${prefix}" chọn mọi mã bắt đầu như vậy`, pp.status === 200 && pp.data.total === want && pp.data.max === null, `${pp.data.total} tủ`);
    const all = await admin.post('/command-batches/preview', { kind: 'control', codes: '*', command: allOn });
    check('"*" = mọi tủ: xem trước báo vượt giới hạn 2.000', all.data.total > 2000 && all.data.max === 2000, `${all.data.total} tủ`);

    // ---------- refusals (no OTP burnt on them) ----------
    const vb = await viewer.post('/command-batches', { kind: 'control', codes, command: allOn, otp: '000000' });
    check('Viewer không chạy lô điều khiển → 403', vb.status === 403);
    const noCmd = await admin.post('/command-batches', { kind: 'control', codes, otp: '000000' });
    check('Lô điều khiển thiếu lệnh → 422 invalid_params', noCmd.status === 422 && noCmd.data.code === 'invalid_params');
    const badCmd = await admin.post('/command-batches', { kind: 'control', codes, command: { type: 'SET_TIME', params: {} }, otp: '000000' });
    check('Lệnh ngoài danh sách cho phép → 422 invalid_request', badCmd.status === 422 && badCmd.data.code === 'invalid_request');
    const badParams = await admin.post('/command-batches', { kind: 'control', codes, command: { type: 'MANUAL_BRANCH', params: { branch: 3, on: true } }, otp: '000000' });
    check('Tham số sai (nhánh 3) → 422 invalid_request', badParams.status === 422 && badParams.data.code === 'invalid_request');
    const none = await admin.post('/command-batches', { kind: 'control', codes: 'KHONGCO.0001', command: allOn, otp: '000000' });
    check('Mã không khớp tủ nào → 422 empty_batch', none.status === 422 && none.data.code === 'empty_batch');
    const big = await admin.post('/command-batches', { kind: 'control', codes: '*', command: allOn, otp: '000000' });
    check('Quá 2.000 tủ → 422 too_many_cabinets', big.status === 422 && big.data.code === 'too_many_cabinets' && big.data.params?.max === 2000);
    const noOtp = await admin.post('/command-batches', { kind: 'control', codes, command: allOn });
    check('Không có mã 2FA → 422 invalid_otp', noOtp.status === 422 && noOtp.data.code === 'invalid_otp');

    // ---------- control batch: whole cabinet on (manual) ----------
    const b = await admin.post('/command-batches', { kind: 'control', codes, command: allOn, otp: await otp(secret, last) });
    check('Tạo lô "Bật toàn tủ" theo mã → 202, lưu lệnh của lô', b.status === 202 && b.data.kind === 'control' && b.data.total === 5 && b.data.command?.type === 'MANUAL_ALL' && b.data.command.params.on === true);
    const done = await waitFor('control batch finished', async () => {
      const d = await admin.get(`/command-batches/${b.data.id}`);
      return d.data.batch.finishedAt ? d.data : null;
    }, 90_000);
    const item = (c: Cab) => done.items.find((i: { cabinetId: string }) => i.cabinetId === c.id);
    check('Kết quả: 3 tủ online thành công, 1 offline, firmware cũ ghi lỗi',
      done.batch.succeeded === 3 && done.batch.offline === 1 && done.batch.failed === 1 && item(old).result === 'failed' && /1307ebc/.test(item(old).error ?? '') && item(off).result === 'offline',
      `ok ${done.batch.succeeded}, offline ${done.batch.offline}, lỗi ${done.batch.failed}`);
    const st = await sql<{ manual_mode: boolean | null; branch1_on: boolean | null; branch2_on: boolean | null }[]>`
      SELECT manual_mode, branch1_on, branch2_on FROM cabinet_state WHERE cabinet_id = ANY(${online.map((c) => c.id)}::uuid[])`;
    check('3 tủ online: thủ công + cả 2 nhánh sáng (xác nhận qua telemetry)', st.length === 3 && st.every((s) => s.manual_mode && s.branch1_on && s.branch2_on));
    const sent = await sql<{ type: string; n: number }[]>`SELECT type, count(*)::int AS n FROM commands WHERE batch_id = ${b.data.id} GROUP BY type`;
    check('Chỉ tủ online được tạo lệnh, đúng loại MANUAL_ALL', sent.length === 1 && sent[0]!.type === 'MANUAL_ALL' && sent[0]!.n === 3);
    const list = await admin.get('/command-batches');
    const inList = list.data.find((x: { id: string }) => x.id === b.data.id);
    check('Danh sách lô trả về lệnh của lô', inList?.kind === 'control' && inList.command?.type === 'MANUAL_ALL');
    const logs = await sql<{ action: string; new_value: string }[]>`SELECT action, new_value FROM activity_logs WHERE target_type = 'batch' AND target_id = ${b.data.id}`;
    check('Nhật ký: 1 dòng "Điều khiển hàng loạt" kèm tên lệnh', logs.length === 1 && logs[0]!.action === 'Điều khiển hàng loạt' && logs[0]!.new_value.includes('toàn tủ'), logs[0]?.new_value);
    check('Phạm vi lô liệt kê mã đã nhập (viết hoa)', b.data.scope.includes(a1.code) && b.data.scope.includes(a2.code.toUpperCase()) && b.data.scope.includes(old.code), b.data.scope);

    // ---------- retry: the offline cabinet comes back, gets the stored command ----------
    offSim.start();
    await waitFor('offline cabinet back', async () => (await sql`SELECT 1 FROM cabinet_state WHERE online AND cabinet_id = ${off.id}`).length === 1, 30_000);
    const rt = await admin.post(`/command-batches/${b.data.id}/retry-failed`, { otp: await otp(secret, last) });
    const again = await waitFor('retry finished', async () => {
      const d = await admin.get(`/command-batches/${b.data.id}`);
      return d.data.batch.finishedAt ? d.data : null;
    }, 60_000);
    const offCmd = (await sql<{ type: string; params: { on?: boolean } }[]>`SELECT type, params FROM commands WHERE batch_id = ${b.data.id} AND cabinet_id = ${off.id}`)[0];
    check('Gửi lại: tủ vừa online nhận đúng lệnh của lô (MANUAL_ALL bật), firmware cũ vẫn lỗi',
      rt.status === 202 && again.batch.succeeded === 4 && again.batch.failed === 1 && offCmd?.type === 'MANUAL_ALL' && offCmd.params.on === true,
      `ok ${again.batch.succeeded}, lỗi ${again.batch.failed}`);

    // ---------- back to automatic, by prefix-free code list ----------
    const back = await admin.post('/command-batches', { kind: 'control', codes: [a1, a2, a3, off].map((c) => c.code).join('\n'), command: { type: 'AUTO', params: {} }, otp: await otp(secret, last) });
    await waitFor('auto batch finished', async () => (await admin.get(`/command-batches/${back.data.id}`)).data.batch.finishedAt, 60_000);
    const autoDone = (await admin.get(`/command-batches/${back.data.id}`)).data.batch;
    const manual = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cabinet_state WHERE manual_mode AND cabinet_id = ANY(${ids}::uuid[])`;
    check('Lô "Về tự động": 4 tủ thành công, không còn tủ thủ công', autoDone.succeeded === 4 && manual[0]!.n === 0, `ok ${autoDone.succeeded}`);
  } finally {
    await Promise.all([...sims, offSim].map((s) => s.stop().catch(() => undefined)));
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  }
}

main()
  .catch((e) => {
    console.error(e);
    checks.push({ name: 'run', ok: false });
  })
  .finally(async () => {
    await sql.end();
    const bad = checks.filter((c) => !c.ok).length;
    console.log(`\n${checks.length - bad}/${checks.length} checks passed`);
    process.exit(bad ? 1 : 0);
  });
