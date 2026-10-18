// M4 end-to-end check: real API + command-worker + ingest + EMQX, with simulator cabinets SIM9991..9996
// (registered fleet LTIDs; do not run `npm run sim` with >= 9990 cabinets at the same time).
// Lifecycle (queued -> sent -> acked -> confirmed / acked_unconfirmed / failed / timeout), one command in
// flight per cabinet, PULSE_ON = 2 frames, refusals (offline, old firmware, capability, permission),
// idempotency, cancel, schedule apply, audit, Socket.IO command.updated.
// Uses the worker's default timeouts (ack 30 s + 1 retry, confirm 20 s): about 90 s.
// Run: npm run e2e:commands
import { hash } from '@node-rs/argon2';
import mqtt from 'mqtt';
import { io } from 'socket.io-client';
import { createSql } from '@citylight/db';
import { TOPICS } from '@citylight/coreif';
import { CONFIRMED_BY_TELEMETRY } from '@citylight/shared';
import { SimCabinet, type Fault } from '../../simulator/src/cabinet';
import { base32Decode } from '../src/totp';
import { BASE, Client, login, nextCode } from './client';

const DOMAIN = 'e2e-cmd.citylight.test';
const MQTT_URL = process.env.E2E_MQTT_URL ?? 'mqtt://localhost:1883';
const sql = createSql(process.env.DATABASE_URL, 2);

const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = () => crypto.randomUUID();

const SIMS: Record<string, Fault> = { SIM9991: 'none', SIM9992: 'plc_lost', SIM9993: 'logo_lost', SIM9994: 'ack_lost', SIM9995: 'old_firmware', SIM9996: 'none' };
const TERMINAL = new Set(['confirmed', 'acked_unconfirmed', 'failed', 'timeout', 'cancelled']);

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function main() {
  // ---------- users ----------
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Cmd-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const pwHash = await hash(pw);
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
            (${org}, ${'operator@' + DOMAIN}, 'E2E Operator', ${pwHash}, 'operator', true),
            (${org}, ${'viewer@' + DOMAIN}, 'E2E Viewer', ${pwHash}, 'viewer', true)`;
  const { c: op } = await login(`operator@${DOMAIN}`, pw);
  const setup = await op.post('/auth/2fa/setup');
  const en = await op.post('/auth/2fa/enable', { code: nextCode(base32Decode(setup.data.secret), { step: 0 }) });
  check('Operator bật 2FA xong', en.status === 200);
  const { c: viewer } = await login(`viewer@${DOMAIN}`, pw);

  // ---------- cabinets ----------
  const ids = new Map<string, string>();
  for (const r of await sql<{ id: string; ltid: string }[]>`SELECT id, ltid FROM cabinets WHERE ltid = ANY(${[...Object.keys(SIMS), 'SIM9990']})`)
    ids.set(r.ltid, r.id);
  if (ids.size < 7) throw new Error('SIM9990..SIM9996 chưa đăng ký: npm run sim:register -- --count 10000');
  const id = (ltid: string) => ids.get(ltid)!;
  const sims = Object.entries(SIMS).map(([ltid, fault]) => new SimCabinet({ ltid, brokerUrl: MQTT_URL, fault, location: { lat: 10.78, lng: 106.7 }, telemetryMs: 2000 }));
  sims.forEach((s) => s.start());
  await waitFor('sims online', async () => {
    const r = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cabinet_state WHERE online AND cabinet_id = ANY(${Object.keys(SIMS).map(id)}::uuid[])`;
    return r[0]!.n === sims.length;
  }, 30_000);
  await waitFor('old firmware detected', async () => (await sql`SELECT 1 FROM cabinets WHERE ltid = 'SIM9995' AND fw_profile = 'v2-1307ebc'`).length > 0, 15_000);
  console.log('[e2e] 6 tủ giả online');

  // raw view of the downlink topic, to see the actual frames
  const sniff = mqtt.connect(MQTT_URL, { clientId: `e2e-sniff-${process.pid}` });
  const frames: string[] = [];
  await new Promise<void>((res) => sniff.on('connect', () => sniff.subscribe(TOPICS.command, () => res())));
  sniff.on('message', (_t, b) => frames.push(b.toString()));

  // live events like the browser
  const events = new Map<string, string[]>();
  const sock = io(BASE, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie: [...op.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, reconnection: false });
  await new Promise<void>((res, rej) => { sock.on('connect', () => res()); sock.on('connect_error', rej); });
  sock.on('command.updated', (c: { id: string; status: string }) => events.set(c.id, [...(events.get(c.id) ?? []), c.status]));

  const send = (ltid: string, type: string, params: object = {}, k = key()) => op.post(`/cabinets/${id(ltid)}/commands`, { type, params }, { 'Idempotency-Key': k });
  const final = (cmdId: string, ms: number) =>
    waitFor(`command ${cmdId}`, async () => {
      const r = await op.get(`/commands/${cmdId}`);
      // SET_SCHEDULE / PULSE_ON / DIAG have nothing to confirm: "acked" is their final state
      return TERMINAL.has(r.data.status) || (r.data.status === 'acked' && !CONFIRMED_BY_TELEMETRY.includes(r.data.type)) ? r.data : null;
    }, ms);

  // ---------- refusals ----------
  const v = await viewer.post(`/cabinets/${id('SIM9991')}/commands`, { type: 'AUTO', params: {} }, { 'Idempotency-Key': key() });
  check('Viewer gửi lệnh → 403 forbidden', v.status === 403 && v.data.code === 'forbidden');
  const bad = await send('SIM9991', 'MANUAL_BRANCH', { branch: 3, on: true });
  check('Tham số sai (nhánh 3) → 422', bad.status === 422);
  const old = await send('SIM9995', 'AUTO');
  check('Firmware cũ 1307ebc → 409 cabinet_unsafe_firmware', old.status === 409 && old.data.code === 'cabinet_unsafe_firmware');
  const offRow = await sql<{ online: boolean | null }[]>`SELECT online FROM cabinet_state WHERE cabinet_id = ${id('SIM9990')}`;
  if (offRow[0]?.online) console.log('  (bỏ qua kiểm offline: SIM9990 đang online)');
  else {
    const off = await send('SIM9990', 'AUTO');
    check('Tủ offline → 409 cabinet_offline (không xếp hàng)', off.status === 409 && off.data.code === 'cabinet_offline');
  }
  const dim = await send('SIM9991', 'SET_DIMMING', {});
  check('Lệnh thiết bị chưa hỗ trợ → 409 capability_unsupported', dim.status === 409 && dim.data.code === 'capability_unsupported');

  // ---------- happy path + idempotency ----------
  const k1 = key();
  const a1 = await send('SIM9991', 'MANUAL_BRANCH', { branch: 1, on: true }, k1);
  const a2 = await send('SIM9991', 'MANUAL_BRANCH', { branch: 1, on: true }, k1);
  check('Gửi lệnh → 202 queued', a1.status === 202 && a1.data.status === 'queued');
  check('Cùng Idempotency-Key → cùng lệnh, không tạo lệnh mới', a2.data.id === a1.data.id);
  check('Không lộ frame thô ra API', !('frame' in a1.data));

  // ---------- parallel scenarios ----------
  const [happy, serial, plc, logo, lost, sim6] = await Promise.all([
    final(a1.data.id, 40_000),
    (async () => {
      await final(a1.data.id, 40_000);
      const m = await send('SIM9991', 'MANUAL_ALL', { on: false });
      const au = await send('SIM9991', 'AUTO');
      return { m: await final(m.data.id, 40_000), au: await final(au.data.id, 40_000) };
    })(),
    (async () => final((await send('SIM9992', 'MANUAL_ALL', { on: true })).data.id, 40_000))(),
    (async () => final((await send('SIM9993', 'MANUAL_ALL', { on: true })).data.id, 60_000))(),
    (async () => {
      const t = await send('SIM9994', 'MANUAL_ALL', { on: true });
      const q = await send('SIM9994', 'PULSE_ON');
      await waitFor('in flight', async () => (await op.get(`/commands/${t.data.id}`)).data.status === 'sent', 10_000);
      const qc = await op.post(`/commands/${q.data.id}/cancel`);
      const tc = await op.post(`/commands/${t.data.id}/cancel`);
      return { t: await final(t.data.id, 90_000), qc, tc };
    })(),
    (async () => {
      const p = await final((await send('SIM9996', 'PULSE_ON')).data.id, 70_000);
      const sched = { mode: 2, source: 'manual', on1: '18:05', off1: '05:40', on2: '18:20', off2: '22:30', branch1Enabled: true, branch2Enabled: true, offsetOnMin: 10, offsetOffMin: -10 };
      const sr = await op.put(`/cabinets/${id('SIM9996')}/schedule`, sched, { 'Idempotency-Key': key() });
      const s = await final(sr.data.id, 40_000);
      const t = await final((await send('SIM9996', 'SET_TIME')).data.id, 40_000);
      const d = await final((await send('SIM9996', 'DIAG')).data.id, 40_000);
      return { p, sr, s, t, d };
    })(),
  ]);

  check('Bật nhánh 1 (thủ công) → confirmed theo telemetry', happy.status === 'confirmed' && !!happy.confirmedAt, happy.status);
  const seen = events.get(a1.data.id) ?? [];
  check('Socket.IO command.updated: sent → acked → confirmed', ['sent', 'acked', 'confirmed'].every((s) => seen.includes(s)), seen.join(','));
  check('Tắt toàn tủ → confirmed', serial.m.status === 'confirmed', serial.m.status);
  check('Về tự động → confirmed', serial.au.status === 'confirmed', serial.au.status);
  check('Lệnh sau chỉ gửi khi lệnh trước xong (1 lệnh/tủ)', Date.parse(serial.au.sentAt) >= Date.parse(serial.m.confirmedAt), `${serial.m.confirmedAt} → ${serial.au.sentAt}`);
  check('Mất PLC: rc=-1 → failed, nêu key lỗi', plc.status === 'failed' && /rc=-1/.test(plc.error ?? ''), plc.error);
  check('Mất LOGO: ack rc 0 nhưng LQ2/LQ3 không đổi → acked_unconfirmed', logo.status === 'acked_unconfirmed', logo.status);
  check('Hủy lệnh đang chờ → cancelled', lost.qc.status === 200 && lost.qc.data.status === 'cancelled');
  check('Hủy lệnh đã gửi → 409 not_cancellable', lost.tc.status === 409 && lost.tc.data.code === 'not_cancellable');
  const att = await sql<{ attempts: number }[]>`SELECT attempts FROM commands WHERE id = ${lost.t.id}`;
  check('Mất ack: gửi lại 1 lần rồi timeout', lost.t.status === 'timeout' && att[0]?.attempts === 2, `${lost.t.status}, ${att[0]?.attempts} lần`);
  const pulse = frames.filter((f) => f.includes("LTID'SIM9996") && f.includes('PI2O'));
  check("PULSE_ON gửi 2 frame PI2O'0 rồi PI2O'1 → acked", sim6.p.status === 'acked' && pulse[0]?.includes("PI2O'0") === true && pulse[1]?.includes("PI2O'1") === true, pulse.join(' | '));
  check('Đặt lịch (PUT schedule) → 202, tủ nhận', sim6.sr.status === 202 && sim6.s.status === 'acked', sim6.s.status);
  const detail = await op.get(`/cabinets/${id('SIM9996')}`);
  check('Lịch tủ lưu + appliedAt có giá trị', detail.data.schedule?.on1 === '18:05' && detail.data.schedule?.mode === 2 && !!detail.data.schedule?.appliedAt);
  check('Đồng bộ giờ → confirmed (PTIM lệch ≤ 2 phút)', sim6.t.status === 'confirmed', sim6.t.status);
  check('LDIA rc=-1 → acked kèm ghi chú (không phải lỗi lệnh)', sim6.d.status === 'acked' && /Chẩn đoán/.test(sim6.d.error ?? ''), sim6.d.error);

  // M5: failed commands leave a closed event alarm (E701 rejected, E702 unconfirmed, E703 timeout)
  const ev = await sql<{ type: string; ltid: string }[]>`
    SELECT a.type, c.ltid FROM alarms a JOIN cabinets c ON c.id = a.cabinet_id
    WHERE a.type IN ('cmd_rejected', 'cmd_unconfirmed', 'cmd_timeout') AND a.started_at > now() - interval '5 minutes' AND NOT a.active`;
  const has = (t: string, l: string) => ev.some((e) => e.type === t && e.ltid === l);
  check('Cảnh báo sự kiện lệnh: E701 (SIM9992), E702 (SIM9993), E703 (SIM9994)', has('cmd_rejected', 'SIM9992') && has('cmd_unconfirmed', 'SIM9993') && has('cmd_timeout', 'SIM9994'));

  // ---------- history, audit ----------
  const hist = await op.get(`/cabinets/${id('SIM9996')}/commands`);
  check('Lịch sử lệnh của tủ (mới nhất trước)', hist.status === 200 && hist.data.length >= 4 && hist.data[0].type === 'DIAG');
  const page = await op.get('/commands?page=1&size=5');
  check('GET /commands phân trang', page.status === 200 && page.data.items.length === 5 && page.data.total >= 10);
  // by user id: earlier runs left rows with the same e-mail
  const logs = await sql<{ action: string; n: number }[]>`
    SELECT action, count(*)::int AS n FROM activity_logs
    WHERE user_id = (SELECT id FROM users WHERE email = ${'operator@' + DOMAIN}) GROUP BY action`;
  const n = Object.fromEntries(logs.map((l) => [l.action, l.n]));
  check('Nhật ký: "Gửi lệnh", "Kết quả lệnh", "Hủy lệnh"', n['Gửi lệnh'] >= 10 && n['Kết quả lệnh'] >= 10 && n['Hủy lệnh'] === 1, JSON.stringify(n));

  // ---------- cleanup ----------
  sock.close();
  await sniff.endAsync();
  sims.forEach((s) => s.stop?.());
  const users = (await sql<{ id: string }[]>`SELECT id FROM users WHERE email LIKE ${'%@' + DOMAIN}`).map((u) => u.id);
  await sql`DELETE FROM commands WHERE requested_by = ANY(${users}::uuid[])`;
  await sql`DELETE FROM schedule_applied WHERE cabinet_id = ${id('SIM9996')}`;
  await sql`DELETE FROM schedules WHERE cabinet_id = ${id('SIM9996')}`;
  await sql`DELETE FROM users WHERE id = ANY(${users}::uuid[])`;
  await sql.end();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[e2e:commands] ${checks.length - failed.length}/${checks.length} kiểm tra đạt`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
