// Per-cabinet command topic (S53, LTE firmware dev_lte_cmd_topic_dgb): a cabinet that reports LFWV'3 becomes
// fw_profile v3 and gets its command frames on citylight/cmd/<LTID> only; a cabinet without LFWV stays on the
// shared stm32/ec25/cmd only; LFWV'2 / no LFWV turns v3 back into v2-current. The device account may subscribe
// citylight/cmd/<LTID> on 1883 (ACL) but never publish there.
// Needs EMQX (ACL re-rendered: node infra/scripts/gen-emqx-acl.mjs + EMQX restart), api, ingest, command-worker.
// Cabinets E2E.TOP01 / E2E.TOP02 (LTID E2ETOP1 / E2ETOP2), user admin@e2e-cmdtopic.citylight.test, removed at
// the end. ~1 min. Run: npm run e2e:cmdtopic
import { hash } from '@node-rs/argon2';
import mqtt, { type MqttClient } from 'mqtt';
import { Redis } from 'ioredis';
import { TOPICS, cabinetCommandTopic } from '@citylight/coreif';
import { CONFIG_CHANNEL } from '@citylight/db/notify';
import { createSql } from '@citylight/db';
import { CONFIRMED_BY_TELEMETRY } from '@citylight/shared';
import { SimCabinet } from '../../simulator/src/cabinet';
import { base32Decode } from '../src/totp';
import { login, nextCode } from './client';

const DOMAIN = 'e2e-cmdtopic.citylight.test';
const NEW = 'E2ETOP1'; // firmware with its own command topic
const OLD = 'E2ETOP2'; // firmware before it (shared topic, no LFWV)
const HOST = process.env.E2E_MQTT_HOST ?? 'localhost';
const CAB = `mqtt://${HOST}:1883`;
const BACKEND = `mqtt://${HOST}:1885`;
const LOC = { lat: 10.8212, lng: 106.7123 };
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
function connect(url: string, o: mqtt.IClientOptions): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(url, { clientId: `e2e-cmdtopic-${Math.random().toString(16).slice(2)}`, reconnectPeriod: 0, connectTimeout: 5000, ...o });
    c.once('connect', () => resolve(c));
    c.once('error', (e) => reject(e));
  });
}
const TERMINAL = new Set(['confirmed', 'acked_unconfirmed', 'failed', 'timeout', 'cancelled']);

async function main() {
  const USER = process.env.MQTT_DEVICE_USERNAME ?? '';
  const PASS = process.env.MQTT_DEVICE_PASSWORD ?? '';
  if (!USER || !PASS) throw new Error('set MQTT_DEVICE_USERNAME / MQTT_DEVICE_PASSWORD (the npm script loads infra/.env)');
  const cleanup = async () => {
    const cids = (await sql<{ id: string }[]>`SELECT id FROM cabinets WHERE ltid IN (${NEW}, ${OLD})`).map((r) => r.id);
    if (cids.length) {
      await sql`DELETE FROM commands WHERE cabinet_id = ANY(${cids}::uuid[])`;
      await sql`DELETE FROM alarms WHERE cabinet_id = ANY(${cids}::uuid[])`;
    }
    await sql`DELETE FROM cabinets WHERE ltid IN (${NEW}, ${OLD})`;
    await sql`DELETE FROM unknown_devices WHERE ltid IN (${NEW}, ${OLD})`;
    await redis.publish(CONFIG_CHANNEL, JSON.stringify({ type: 'registry' }));
  };
  await cleanup();
  await sql`DELETE FROM activity_logs WHERE user_email LIKE ${'%@' + DOMAIN}`;
  await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Top-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all)
            VALUES (${org}, ${'admin@' + DOMAIN}, 'E2E admin', ${await hash(pw)}, 'admin', true)`;
  const { c: admin } = await login(`admin@${DOMAIN}`, pw);
  await admin.post('/auth/2fa/enable', { code: nextCode(base32Decode((await admin.post('/auth/2fa/setup')).data.secret), { step: 0 }) });

  // cabinets log in on 1883 with the shared device account, like the field (SimCabinet reads MQTT_DEVICE_* from env)
  const simNew = new SimCabinet({ ltid: NEW, brokerUrl: CAB, fault: 'none', location: LOC, telemetryMs: 2000, cmdTopic: true });
  const simOld = new SimCabinet({ ltid: OLD, brokerUrl: CAB, fault: 'none', location: LOC, telemetryMs: 2000 });
  const sniff = await connect(BACKEND, { username: process.env.MQTT_USERNAME });
  const dev = await connect(CAB, { username: USER, password: PASS });
  const seen: { topic: string; frame: string }[] = [];
  sniff.on('message', (topic, p) => seen.push({ topic, frame: p.toString() }));
  await sniff.subscribeAsync([TOPICS.command, 'citylight/cmd/+']);
  const fw = async (ltid: string) => (await sql<{ fw_profile: string }[]>`SELECT fw_profile FROM cabinets WHERE ltid = ${ltid}`)[0]?.fw_profile;
  const id = new Map<string, string>();
  const send = async (ltid: string, type: string, params: object = {}) => {
    const r = await admin.post(`/cabinets/${id.get(ltid)}/commands`, { type, params }, { 'Idempotency-Key': `e2e-top-${Math.random().toString(36).slice(2)}` });
    if (r.status !== 202) throw new Error(`command ${type} for ${ltid}: ${r.status} ${JSON.stringify(r.data)}`);
    return waitFor(`${type} ${ltid}`, async () => {
      const c = (await admin.get(`/commands/${r.data.id}`)).data;
      const done = TERMINAL.has(c.status) || (c.status === 'acked' && !CONFIRMED_BY_TELEMETRY.includes(c.type));
      return done ? (c as { status: string }) : null;
    }, 60_000);
  };

  try {
    // ---------- ACL of the device account ----------
    const grant = (topic: string) => new Promise<number>((r) => dev.subscribe(topic, (err, g) => r(err ? 128 : (g?.[0]?.qos ?? 128))));
    const gOwn = await grant(cabinetCommandTopic(NEW));
    check('ACL: tài khoản tủ subscribe citylight/cmd/<LTID> được', gOwn === 0, `suback ${gOwn}`);
    dev.publish(cabinetCommandTopic(NEW), `*#LTID'${NEW}&PMAN'1$`);
    await sleep(1500);
    check('ACL: tài khoản tủ gửi lên topic lệnh riêng bị chặn', !seen.some((s) => s.topic === cabinetCommandTopic(NEW)));

    // ---------- registration, profile from LFWV ----------
    simNew.start();
    simOld.start();
    for (const [ltid, code] of [[NEW, 'E2E.TOP01'], [OLD, 'E2E.TOP02']] as const) {
      await waitFor(`unknown ${ltid}`, async () => (await admin.get('/devices/unknown')).data.some((x: { ltid: string }) => x.ltid === ltid), 20_000);
      const reg = await admin.post('/cabinets', { ltid, code, name: `Tủ thử topic ${code}`, location: LOC });
      if (reg.status !== 201) throw new Error(`register ${ltid}: ${reg.status} ${JSON.stringify(reg.data)}`);
      id.set(ltid, reg.data.id);
    }
    await waitFor('online', async () => (await sql`SELECT 1 FROM cabinet_state WHERE cabinet_id = ANY(${[...id.values()]}::uuid[]) AND online`).length === 2, 20_000);
    await waitFor('v3', async () => (await fw(NEW)) === 'v3', 15_000).catch(() => null);
    const fNew = await fw(NEW);
    const fOld = await fw(OLD);
    check('LFWV\'3 → fw_profile v3 (tự nhận)', fNew === 'v3', fNew);
    check('Không có LFWV → v2-current', fOld === 'v2-current', fOld);
    const det = (await admin.get(`/cabinets/${id.get(NEW)}`)).data;
    check('API chi tiết tủ: capability per_cabinet_topic', (det.capabilities ?? []).includes('per_cabinet_topic'));

    // ---------- routing ----------
    seen.length = 0;
    const a = await send(NEW, 'MANUAL_BRANCH', { branch: 1, on: true });
    const onOwn = seen.filter((s) => s.topic === cabinetCommandTopic(NEW) && s.frame.includes(`LTID'${NEW}`));
    const onShared = seen.filter((s) => s.topic === TOPICS.command && s.frame.includes(`LTID'${NEW}`));
    check('Tủ v3: lệnh đi topic riêng, xác nhận được', a.status === 'confirmed' && onOwn.length >= 1, `${a.status}, ${onOwn.length} frame`);
    check('Tủ v3: không frame nào lên topic chung (tránh chạy 2 lần)', onShared.length === 0, `${onShared.length}`);

    seen.length = 0;
    const b = await send(OLD, 'MANUAL_BRANCH', { branch: 1, on: true });
    const bShared = seen.filter((s) => s.topic === TOPICS.command && s.frame.includes(`LTID'${OLD}`));
    const bOwn = seen.filter((s) => s.topic.startsWith('citylight/cmd/'));
    check('Tủ cũ: lệnh đi topic chung, xác nhận được', b.status === 'confirmed' && bShared.length >= 1, `${b.status}, ${bShared.length} frame`);
    check('Tủ cũ: không frame nào lên topic riêng', bOwn.length === 0, `${bOwn.length}`);

    for (const ltid of [NEW, OLD]) await send(ltid, 'AUTO');

    // ---------- LFWV'2 (broker refused the own topic) / no LFWV -> back to v2-current ----------
    await simNew.stop();
    const frame = (lfwv: string | null) => {
      const f = simNew.buildTelemetry().replace(/&LFWV'[^&$]*/, '');
      return lfwv === null ? f : f.replace(/\$$/, `&LFWV'${lfwv}$`);
    };
    dev.publish(TOPICS.telemetry, frame('2'));
    await waitFor('v2 after LFWV 2', async () => (await fw(NEW)) === 'v2-current', 10_000).catch(() => null);
    check("LFWV'2 → về v2-current (lệnh sau đi topic chung)", (await fw(NEW)) === 'v2-current', await fw(NEW));
    await sleep(1200);
    dev.publish(TOPICS.telemetry, frame('3'));
    await waitFor('v3 again', async () => (await fw(NEW)) === 'v3', 10_000).catch(() => null);
    check("LFWV'3 lại → v3", (await fw(NEW)) === 'v3', await fw(NEW));
    await sleep(1200);
    dev.publish(TOPICS.telemetry, frame(null));
    await waitFor('v2 without LFWV', async () => (await fw(NEW)) === 'v2-current', 10_000).catch(() => null);
    check('Frame không có LFWV (nạp lại firmware cũ) → v2-current', (await fw(NEW)) === 'v2-current', await fw(NEW));
  } finally {
    await simNew.stop();
    await simOld.stop();
    sniff.end(true);
    dev.end(true);
    await cleanup();
    await sql`DELETE FROM activity_logs WHERE user_email LIKE ${'%@' + DOMAIN} OR (user_email = 'hệ thống' AND target_name LIKE 'E2E.TOP%')`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
    await redis.quit();
    await sql.end();
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n[e2e:cmdtopic] ${checks.length - failed}/${checks.length} kiểm tra đạt`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
