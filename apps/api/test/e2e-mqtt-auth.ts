// Cabinet port with user/pass (S43): 1883 refuses no / wrong credentials and the backend's secret username,
// accepts the shared device account, whose rights stay those of a cabinet (ACL). The backend listener 1885 has
// no authn (Docker network only; on 127.0.0.1 locally). Needs EMQX (infra:up) + ingest.
// LTID E2EAUTH1 (unknown device, removed after). Run: npm run e2e:mqtt-auth
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { TOPICS } from '@citylight/coreif';
import { createSql } from '@citylight/db';
import { SimCabinet } from '../../simulator/src/cabinet';

const HOST = process.env.E2E_MQTT_HOST ?? 'localhost';
const CAB = `mqtt://${HOST}:1883`;
const BACKEND = `mqtt://${HOST}:1885`;
const USER = process.env.MQTT_DEVICE_USERNAME ?? '';
const PASS = process.env.MQTT_DEVICE_PASSWORD ?? '';
const LTID = 'E2EAUTH1';
const sql = createSql(process.env.DATABASE_URL, 2);
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** connect once (no retry): resolves to the client or the broker's refusal */
function tryConnect(url: string, o: IClientOptions = {}): Promise<{ c: MqttClient | null; err: string | null }> {
  return new Promise((resolve) => {
    const c = mqtt.connect(url, { clientId: `e2e-auth-${Math.random().toString(16).slice(2)}`, reconnectPeriod: 0, connectTimeout: 5000, ...o });
    c.once('connect', () => resolve({ c, err: null }));
    c.once('error', (e) => {
      c.end(true);
      const code = (e as Error & { code?: number }).code;
      resolve({ c: null, err: code !== undefined ? `code ${code}` : e.message });
    });
  });
}

async function main() {
  if (!USER || !PASS) throw new Error('set MQTT_DEVICE_USERNAME / MQTT_DEVICE_PASSWORD (the npm script loads infra/.env)');
  await sql`DELETE FROM unknown_devices WHERE ltid = ${LTID}`;
  const none = await tryConnect(CAB);
  check('1883 không user/pass (firmware cũ) → từ chối', !none.c, none.err ?? '');
  const wrong = await tryConnect(CAB, { username: USER, password: `${PASS}x` });
  check('1883 sai mật khẩu → từ chối', !wrong.c, wrong.err ?? '');
  const backendOnCab = await tryConnect(CAB, { username: process.env.MQTT_USERNAME });
  check('1883 dùng username bí mật của backend (không mật khẩu) → từ chối', !backendOnCab.c, backendOnCab.err ?? '');
  const good = await tryConnect(CAB, { username: USER, password: PASS });
  check('1883 đúng tài khoản tủ → vào được', !!good.c);
  const be = await tryConnect(BACKEND, { username: process.env.MQTT_USERNAME });
  check('1885 (cổng backend, chỉ trong mạng nội bộ) → backend vào được', !!be.c);

  // rights of the device account = those of a cabinet: uplinks + subscribe to commands, nothing else
  const seenCmd: string[] = [];
  be.c!.on('message', (t, p) => t === TOPICS.command && seenCmd.push(p.toString()));
  await be.c!.subscribeAsync(TOPICS.command);
  // suback per topic (mqtt.js rejects the whole call when one topic is refused)
  const grant = (topic: string) => new Promise<number>((r) => good.c!.subscribe(topic, (err, g) => r(err ? 128 : (g?.[0]?.qos ?? 128))));
  const gCmd = await grant(TOPICS.command);
  const gTele = await grant(TOPICS.telemetry);
  check('Tài khoản tủ: subscribe topic lệnh được, đọc telemetry tủ khác thì không', gCmd === 0 && gTele === 128, `cmd ${gCmd}, telemetry ${gTele}`);
  good.c!.publish(TOPICS.command, `*#LTID'${LTID}&PMAN'1$`);
  await sleep(1500);
  check('Tài khoản tủ: gửi lệnh lên topic lệnh bị chặn', seenCmd.length === 0);

  const sim = new SimCabinet({ ltid: LTID, brokerUrl: CAB, fault: 'none', location: { lat: 10.8, lng: 106.7 }, telemetryMs: 2000 });
  sim.start();
  let seen = false;
  for (let i = 0; i < 20 && !seen; i++) {
    await sleep(1000);
    seen = (await sql`SELECT 1 FROM unknown_devices WHERE ltid = ${LTID}`).length === 1;
  }
  check('Simulator qua 1883 với tài khoản tủ → server nhận frame', seen);

  await sim.stop();
  for (const c of [good.c, be.c]) c?.end(true);
  await sql`DELETE FROM unknown_devices WHERE ltid = ${LTID}`;
  await sql.end();
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
