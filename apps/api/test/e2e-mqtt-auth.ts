// Device port with user/pass (S43): 1884 refuses no / wrong credentials and the backend's secret username,
// accepts the shared device account, whose rights stay those of a cabinet (ACL); 1883 stays anonymous.
// Needs EMQX (infra:up, device-users.csv rendered) + ingest. LTID E2EAUTH1 (unknown device, removed after).
// Run: npm run e2e:mqtt-auth
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { TOPICS } from '@citylight/coreif';
import { createSql } from '@citylight/db';
import { SimCabinet } from '../../simulator/src/cabinet';

const HOST = process.env.E2E_MQTT_HOST ?? 'localhost';
const DEV = `mqtt://${HOST}:1884`;
const ANON = `mqtt://${HOST}:1883`;
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
      resolve({ c: null, err: (e as Error & { code?: number }).code !== undefined ? `code ${(e as Error & { code?: number }).code}` : e.message });
    });
  });
}

async function main() {
  if (!USER || !PASS) throw new Error('set MQTT_DEVICE_USERNAME / MQTT_DEVICE_PASSWORD (npm script loads infra/.env)');
  await sql`DELETE FROM unknown_devices WHERE ltid = ${LTID}`;
  const none = await tryConnect(DEV);
  check('1884 không user/pass → từ chối', !none.c, none.err ?? '');
  const wrong = await tryConnect(DEV, { username: USER, password: `${PASS}x` });
  check('1884 sai mật khẩu → từ chối', !wrong.c, wrong.err ?? '');
  const backend = await tryConnect(DEV, { username: process.env.MQTT_USERNAME });
  check('1884 dùng username bí mật của backend (không mật khẩu) → từ chối', !backend.c, backend.err ?? '');
  const good = await tryConnect(DEV, { username: USER, password: PASS });
  check('1884 đúng user/pass → vào được', !!good.c);
  const anon = await tryConnect(ANON);
  check('1883 ẩn danh vẫn vào được (tủ firmware cũ)', !!anon.c);

  // rights of the device account = those of a cabinet: uplinks + subscribe to commands, nothing else
  const be = await tryConnect(ANON, { username: process.env.MQTT_USERNAME });
  const seenCmd: string[] = [];
  be.c!.on('message', (t, p) => t === TOPICS.command && seenCmd.push(p.toString()));
  await be.c!.subscribeAsync(TOPICS.command);
  // suback per topic (mqtt.js rejects the whole call when one topic is refused)
  const grant = (topic: string) =>
    new Promise<number>((r) => good.c!.subscribe(topic, (err, g) => r(err ? 128 : (g?.[0]?.qos ?? 128))));
  const gCmd = await grant(TOPICS.command);
  const gTele = await grant(TOPICS.telemetry);
  check('Tài khoản tủ: subscribe topic lệnh được, đọc telemetry tủ khác thì không', gCmd === 0 && gTele === 128, `cmd ${gCmd}, telemetry ${gTele}`);
  good.c!.publish(TOPICS.command, `*#LTID'${LTID}&PMAN'1$`);
  await sleep(1500);
  check('Tài khoản tủ: gửi lệnh lên topic lệnh bị chặn', seenCmd.length === 0);

  const sim = new SimCabinet({ ltid: LTID, brokerUrl: `mqtt://${encodeURIComponent(USER)}:${encodeURIComponent(PASS)}@${HOST}:1884`, fault: 'none', location: { lat: 10.8, lng: 106.7 }, telemetryMs: 2000 });
  sim.start();
  let seen = false;
  for (let i = 0; i < 20 && !seen; i++) {
    await sleep(1000);
    seen = (await sql`SELECT 1 FROM unknown_devices WHERE ltid = ${LTID}`).length === 1;
  }
  check('Simulator qua 1884 (user/pass trong URL) → server nhận frame', seen);

  await sim.stop();
  for (const c of [good.c, anon.c, be.c]) c?.end(true);
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
