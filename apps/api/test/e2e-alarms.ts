// M5 end-to-end check: thresholds API -> ingest rules (30 s debounce) -> alarms -> notify-worker ->
// Telegram, with a fake Telegram Bot API on localhost (no real bot needed). Needs api + ingest running
// (containers or source); this script starts its own notify-worker (NOTIFY_INSTANCE=e2e) against the fake.
// Simulator cabinets SIM9001 (Quận 1) and SIM9020 (Quận 7); users *@e2e-alarm.citylight.test.
// About 2 minutes. Run: npm run e2e:alarms
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import { Redis } from 'ioredis';
import { createSql } from '@citylight/db';
import { TG_BOT_KEY } from '@citylight/db/notify';
import { defaultThresholds, type MapStats } from '@citylight/shared';
import { SimCabinet } from '../../simulator/src/cabinet';
import { base32Decode } from '../src/totp';
import { login, nextCode } from './client';

const DOMAIN = 'e2e-alarm.citylight.test';
// simulated cabinets on the backend listener (no authn); e2e-mqtt-auth covers the cabinet port 1883 + login
const MQTT_URL = process.env.E2E_MQTT_URL ?? process.env.MQTT_URL ?? 'mqtt://localhost:1885';
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
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
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${what}`);
}

// ---------------- fake Telegram Bot API ----------------
const sent: { chat: string; text: string; at: number }[] = [];
const updates: object[] = [];
let updateId = 1;
const tg = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const method = req.url!.split('/').pop();
    const json = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
    res.setHeader('content-type', 'application/json');
    if (method === 'getMe') return json({ id: 1, is_bot: true, username: 'cl_e2e_bot' });
    if (method === 'sendMessage') {
      const b = JSON.parse(body) as { chat_id: string; text: string };
      sent.push({ chat: String(b.chat_id), text: b.text, at: Date.now() });
      return json({ message_id: sent.length });
    }
    if (method === 'getUpdates') {
      const reply = () => json(updates.splice(0, updates.length));
      return updates.length ? reply() : void setTimeout(reply, 500);
    }
    res.statusCode = 404;
    res.end('{"ok":false}');
  });
});
const tgSay = (chat: number, text: string) => updates.push({ update_id: updateId++, message: { chat: { id: chat }, text } });
const to = (chat: number) => sent.filter((m) => m.chat === String(chat));

async function main() {
  await new Promise<void>((r) => tg.listen(0, '127.0.0.1', () => r()));
  const tgUrl = `http://127.0.0.1:${(tg.address() as AddressInfo).port}`;
  const worker = spawn(process.execPath, ['--env-file=.env', '--import', 'tsx', 'apps/workers/src/notify-worker.ts'], {
    cwd: ROOT,
    env: {
      ...process.env, TELEGRAM_BOT_TOKEN: 'e2e-token', TELEGRAM_API_URL: tgUrl, NOTIFY_INSTANCE: 'e2e',
      NOTIFY_GATHER_MS: '1500', NOTIFY_BATCH_MS: '4000', NOTIFY_SUMMARY_OVER: '2', WEB_URL: 'https://citylight.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const wlog: string[] = [];
  worker.stdout.on('data', (d) => wlog.push(String(d)));
  worker.stderr.on('data', (d) => wlog.push(String(d)));
  const sims: SimCabinet[] = [];
  try {
    await waitFor('notify-worker active', async () => wlog.join('').includes('[notify] active'), 20_000);

    // ---------- users ----------
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
    const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
    const cab = await sql<{ ltid: string; id: string; district_id: string; code: string }[]>`SELECT ltid, id, district_id, code FROM cabinets WHERE ltid IN ('SIM9001', 'SIM9020') ORDER BY ltid`;
    const [A, B] = cab as [typeof cab[0], typeof cab[0]];
    if (!A || !B || A.district_id === B.district_id) throw new Error('SIM9001 / SIM9020 phải ở 2 quận khác nhau (npm run sim:register -- --count 10000)');
    const pw = `Alm-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const h = await hash(pw);
    const users = await sql<{ id: string; email: string }[]>`
      INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
        (${org}, ${'operator@' + DOMAIN}, 'E2E alarm operator', ${h}, 'operator', true),
        (${org}, ${'va@' + DOMAIN}, 'E2E viewer A', ${h}, 'viewer', false),
        (${org}, ${'vb@' + DOMAIN}, 'E2E viewer B', ${h}, 'viewer', false)
      RETURNING id, email`;
    const uid = (p: string) => users.find((u) => u.email.startsWith(p))!.id;
    await sql`INSERT INTO user_scopes (user_id, area_id) VALUES (${uid('va')}, ${A.district_id}), (${uid('vb')}, ${B.district_id})`;
    const { c: op } = await login(`operator@${DOMAIN}`, pw);
    const setup = await op.post('/auth/2fa/setup');
    await op.post('/auth/2fa/enable', { code: nextCode(base32Decode(setup.data.secret), { step: 0 }) });
    const { c: va } = await login(`va@${DOMAIN}`, pw);
    const { c: vb } = await login(`vb@${DOMAIN}`, pw);

    // ---------- Telegram linking ----------
    const st0 = await va.get('/me/notifications');
    check('Web thấy bot Telegram đã cấu hình', st0.data.telegram.available === true && st0.data.telegram.botUsername === 'cl_e2e_bot' && !st0.data.telegram.linked);
    const notLinked = await va.put('/me/notifications', { minSeverity: 'minor', telegram: true });
    check('Bật Telegram khi chưa liên kết → 409', notLinked.status === 409 && notLinked.data.code === 'telegram_not_linked');
    const la = await va.post('/me/notifications/telegram/link');
    check('Tạo mã liên kết + link t.me', la.status === 201 && la.data.url === `https://t.me/cl_e2e_bot?start=${la.data.code}`);
    tgSay(1001, '/start sai-ma');
    tgSay(1001, `/start ${la.data.code}`);
    const lb = await vb.post('/me/notifications/telegram/link');
    tgSay(1002, `/start ${lb.data.code}`);
    await waitFor('linked', async () => (await va.get('/me/notifications')).data.telegram.linked && (await vb.get('/me/notifications')).data.telegram.linked, 15_000);
    check('Mã sai → bot trả lời mã không đúng', to(1001).some((m) => m.text.includes('không đúng')));
    check('/start <mã> → liên kết, bot xác nhận email', to(1001).some((m) => m.text.includes(`va@${DOMAIN}`)) && to(1002).some((m) => m.text.includes(`vb@${DOMAIN}`)));
    const reuse = to(1003).length;
    tgSay(1003, `/start ${la.data.code}`);
    await waitFor('reply to reused code', async () => to(1003).length > reuse, 10_000);
    check('Mã chỉ dùng 1 lần', to(1003).some((m) => m.text.includes('không đúng')));
    const saved = await va.put('/me/notifications', { minSeverity: 'minor', telegram: true });
    check('Viewer A nhận mọi mức', saved.status === 200 && saved.data.minSeverity === 'minor' && saved.data.telegram.enabled);

    // ---------- thresholds API ----------
    const T = defaultThresholds();
    const bad = await op.put(`/cabinets/${A.id}/thresholds`, { ...T, voltageLow: { enabled: true, value: 250 } });
    check('Ngưỡng thấp áp ≥ quá áp → 422', bad.status === 422);
    const denied = await va.put(`/cabinets/${A.id}/thresholds`, T);
    check('Viewer không sửa được ngưỡng → 403', denied.status === 403);
    const rules = await va.get('/alarm-rules');
    const rule = (t: string) => rules.data.find((r: { type: string }) => r.type === t);
    check('Quy tắc cảnh báo: quá áp bật, cửa tủ chờ firmware', rule('over_voltage')?.enabled === true && rule('door_open')?.enabled === false && rule('schedule_mismatch')?.enabled === true);

    // ---------- cabinets ----------
    // simulators of an earlier e2e must be seen offline first, or their "mất kết nối" alarms land in our messages
    await waitFor('earlier simulators offline', async () => (await sql`SELECT 1 FROM cabinet_state WHERE online LIMIT 1`).length === 0, 120_000);
    await sleep(5000); // their offline alarms are batched and sent before we start counting
    for (const ltid of [A.ltid, B.ltid]) sims.push(new SimCabinet({ ltid, brokerUrl: MQTT_URL, fault: 'none', location: { lat: 10.78, lng: 106.7 }, telemetryMs: 2000 }));
    sims.forEach((s) => s.start());
    await waitFor('sims online', async () => (await sql`SELECT 1 FROM cabinet_state WHERE online AND cabinet_id IN (${A.id}, ${B.id})`).length === 2, 30_000);
    await sleep(5000); // a few frames with default thresholds first
    const cleanA = await sql`SELECT 1 FROM alarms WHERE active AND cabinet_id = ${A.id} AND type IN ('over_voltage', 'over_temp', 'battery_low')`;
    check('Ngưỡng mặc định: không có cảnh báo đo lường', cleanA.length === 0);
    const before = sent.length;

    // A: 3 thresholds crossed at once (major + minor + minor) -> one summary to viewer A
    const tA = { ...T, voltageHigh: { enabled: true, value: 210 }, tempC: { enabled: true, value: 20 }, batteryLowMv: { enabled: true, value: 4500 } };
    const tB = { ...T, leakMa: { enabled: true, value: 1 } }; // B: critical leak
    const setAt = Date.now();
    const pa = await op.put(`/cabinets/${A.id}/thresholds`, tA);
    const pb = await op.put(`/cabinets/${B.id}/thresholds`, tB);
    check('Lưu ngưỡng tủ → 200, chi tiết tủ trả ngưỡng mới', pa.status === 200 && pb.status === 200 && (await op.get(`/cabinets/${A.id}`)).data.thresholds.voltageHigh.value === 210);
    await sleep(20_000);
    const early = await sql`SELECT 1 FROM alarms WHERE active AND cabinet_id IN (${A.id}, ${B.id}) AND type IN ('over_voltage', 'over_temp', 'battery_low', 'leak_current')`;
    check('Chưa mở cảnh báo trước 30 s (chống nhiễu)', early.length === 0, `${early.length} cảnh báo sau 20 s`);
    const opened = await waitFor('alarms open', async () => {
      const r = await sql<{ type: string; cabinet_id: string; started_at: Date }[]>`
        SELECT type, cabinet_id, started_at FROM alarms WHERE active AND cabinet_id IN (${A.id}, ${B.id}) AND type IN ('over_voltage', 'over_temp', 'battery_low', 'leak_current')`;
      return r.length === 4 ? r : null;
    }, 40_000);
    const delay = Math.round((Math.min(...opened.map((o) => o.started_at.getTime())) - setAt) / 1000);
    check('Mở đủ 4 cảnh báo sau khoảng 30 s: quá áp, nhiệt, pin (A) + rò dòng (B)', delay >= 28 && delay <= 50, `sau ${delay} s`);
    // cabinet_state is written by the ingest flush (every 500 ms), right after the alarm row
    const faultB = await waitFor('B fault', async () => (await sql`SELECT 1 FROM cabinet_state WHERE cabinet_id = ${B.id} AND status = 'fault'`).length === 1, 5000).catch(() => false);
    check('Tủ B (rò dòng) ở trạng thái Lỗi', faultB === true);
    const stats = (await op.get('/map/stats')).data as MapStats;
    const crit = (await sql<{ n: number }[]>`
      SELECT count(DISTINCT a.cabinet_id)::int AS n FROM alarms a JOIN cabinet_state s ON s.cabinet_id = a.cabinet_id
      WHERE a.active AND a.severity = 'critical' AND a.type <> 'offline' AND s.online`)[0]!.n;
    check('Bộ đếm "Lỗi" = số tủ online có cảnh báo nghiêm trọng đang mở', stats.cabinets.fault === crit && crit >= 1, `${stats.cabinets.fault} / ${crit}`);

    await waitFor('messages', async () => to(1001).some((m) => m.at > setAt) && to(1002).some((m) => m.at > setAt), 20_000);
    await sleep(6000); // let any second batch arrive
    const msgA = to(1001).filter((m) => m.at > setAt);
    const msgB = to(1002).filter((m) => m.at > setAt);
    check('Viewer A: 3 cảnh báo cùng lúc gom thành 1 tin tóm tắt', msgA.length === 1 && msgA[0]!.text.includes('3 cảnh báo mới') && msgA[0]!.text.includes('https://citylight.test/alarms'), msgA.map((m) => m.text.split('\n')[0]).join(' | '));
    check('Viewer A không nhận rò dòng của tủ ngoài khu vực', !msgA.some((m) => m.text.includes('Rò dòng')));
    check('Viewer B nhận rò dòng chi tiết (mã, tủ, giá trị)', msgB.length === 1 && msgB[0]!.text.includes('E501 Rò dòng') && /Rò \d+ mA > 1 mA/.test(msgB[0]!.text), msgB[0]?.text.replace(/\n/g, ' / '));
    check('Viewer B (mức Cao trở lên) không nhận quá áp/pin của tủ A', !msgB.some((m) => m.text.includes('Quá áp') || m.text.includes('Pin')));

    // ---------- back to normal ----------
    const resetAt = Date.now();
    await op.put(`/cabinets/${A.id}/thresholds`, T);
    await op.put(`/cabinets/${B.id}/thresholds`, T);
    await waitFor('alarms closed', async () => (await sql`SELECT 1 FROM alarms WHERE active AND cabinet_id IN (${A.id}, ${B.id}) AND type IN ('over_voltage', 'over_temp', 'battery_low', 'leak_current')`).length === 0, 60_000);
    const closedAfter = Math.round((Date.now() - resetAt) / 1000);
    check('Trả ngưỡng → cảnh báo tự đóng sau khoảng 30 s', closedAfter >= 28, `sau ${closedAfter} s`);
    await waitFor('cleared messages', async () => to(1002).some((m) => m.at > resetAt && m.text.includes('Hết')), 20_000);
    await sleep(6000);
    const clrA = to(1001).filter((m) => m.at > resetAt).map((m) => m.text).join('\n');
    check('Báo "hết" cho mức Cao/Nghiêm trọng, không báo hết cho mức Thấp', clrA.includes('Hết: E403') && !clrA.includes('E502') && !clrA.includes('E803'), clrA.replace(/\n/g, ' / '));
    // only messages about this test's two cabinets: simulators of an earlier e2e going offline also alert
    const ours = sent.slice(before).filter((m) => m.text.includes(A.code) || m.text.includes(B.code) || m.text.includes('cảnh báo mới'));
    check('Không gửi tin thừa về 2 tủ của bài', ours.length <= 6, `${ours.length} tin`);

    // ---------- stop / unlink ----------
    tgSay(1002, '/stop');
    await waitFor('stop', async () => !(await vb.get('/me/notifications')).data.telegram.enabled, 10_000);
    check('/stop trong Telegram tắt thông báo', true);
    const un = await va.call('DELETE', '/me/notifications/telegram');
    check('Hủy liên kết → 204', un.status === 204 && !(await va.get('/me/notifications')).data.telegram.linked);
    check('Không lỗi gửi tin', !wlog.join('').includes('failed'), wlog.filter((l) => l.includes('failed')).join(' '));
  } finally {
    for (const s of sims) await s.stop();
    worker.kill('SIGTERM');
    tg.close();
    const ids = (await sql<{ id: string }[]>`SELECT id FROM cabinets WHERE ltid IN ('SIM9001', 'SIM9020')`).map((c) => c.id);
    await sql`DELETE FROM thresholds WHERE cabinet_id = ANY(${ids}::uuid[])`;
    await redis.publish('cl:config', '{"type":"thresholds"}');
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
    // the real worker (if any) owns the bot key: drop the fake bot's entry
    if ((await redis.get(TG_BOT_KEY))?.includes('cl_e2e_bot')) await redis.del(TG_BOT_KEY);
  }
  await sql.end();
  redis.disconnect();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[e2e:alarms] ${checks.length - failed.length}/${checks.length} kiểm tra đạt`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
