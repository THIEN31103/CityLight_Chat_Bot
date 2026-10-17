// M0 end-to-end check without Docker: in-process MQTT broker (aedes) + simulator + a subscriber
// that parses every uplink with @citylight/coreif and sends real command frames.
// Same flow later runs against EMQX (infra/docker-compose.yml) by pointing MQTT_URL at it.
import { createServer } from 'node:net';
import aedesFactory from 'aedes'; // CJS: module.exports = Aedes (callable factory)
type Aedes = InstanceType<typeof aedesFactory>;
import mqtt from 'mqtt';
import { TOPICS, buildCommandFrame, parseAck, parseBoot, parseDemo, parseTelemetry, type TelemetryPatch } from '@citylight/coreif';
import { SimCabinet, type Fault } from './cabinet';

const PORT = Number(process.env.E2E_PORT ?? 18830);
const URL = process.env.MQTT_URL ?? `mqtt://127.0.0.1:${PORT}`;
const COUNT = Number(process.env.E2E_COUNT ?? 50);
const useEmbedded = !process.env.MQTT_URL;

const checks: { name: string; ok: boolean; info?: string }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let broker: Aedes | null = null;
  let server: ReturnType<typeof createServer> | null = null;
  if (useEmbedded) {
    broker = new aedesFactory();
    server = createServer(broker.handle);
    await new Promise<void>((r) => server!.listen(PORT, '127.0.0.1', () => r()));
    console.log(`[e2e] embedded broker on ${URL}`);
  }

  const latest = new Map<string, TelemetryPatch>();
  const acks: ReturnType<typeof parseAck>[] = [];
  let tele = 0;
  let teleErrors = 0;
  let boots = 0;
  const demos: ReturnType<typeof parseDemo>[] = [];

  const auth = process.env.MQTT_USERNAME ? { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD } : {};
  const server_ = mqtt.connect(URL, { clientId: 'citylight-backend-e2e', ...auth });
  await new Promise<void>((r) => server_.on('connect', () => r()));
  server_.subscribe([TOPICS.telemetry, TOPICS.echo, TOPICS.demo, TOPICS.boot]);
  server_.on('message', (topic, buf) => {
    const raw = buf.toString();
    try {
      if (topic === TOPICS.telemetry) {
        const t = parseTelemetry(raw);
        latest.set(t.ltid, t);
        tele++;
      } else if (topic === TOPICS.echo) acks.push(parseAck(raw));
      else if (topic === TOPICS.boot) (parseBoot(raw), boots++);
      else if (topic === TOPICS.demo) demos.push(parseDemo(raw));
    } catch (e) {
      teleErrors++;
      console.error(`[e2e] parse error on ${topic}: ${(e as Error).message} :: ${raw.slice(0, 120)}`);
    }
  });

  const faults: Record<number, Fault> = { 2: 'plc_lost', 3: 'bus_down', 4: 'dh_meter_lost', 5: 'temp_sensor_fault', 6: 'old_firmware', 7: 'offline', 8: 'logo_lost' };
  const sims = Array.from({ length: COUNT }, (_, i) =>
    new SimCabinet({ ltid: `SIM${String(i + 1).padStart(4, '0')}`, brokerUrl: URL, fault: faults[i] ?? 'none', location: { lat: 10.78, lng: 106.7 }, telemetryMs: 2000 }),
  );
  sims.forEach((s) => s.start());
  await sleep(5000);

  const online = COUNT - 1; // SIM0008 is 'offline'
  check('Mọi tủ online đã gửi telemetry', latest.size === online, `${latest.size}/${online} tủ, ${tele} frame`);
  check('Không có frame parse lỗi', teleErrors === 0, `${teleErrors} lỗi`);
  check('Nhận frame boot của mọi tủ online', boots === online, `${boots}`);
  check('LCLI=1 cho tủ mất PLC (SIM0003)', latest.get('SIM0003')?.busStatus === '1' && latest.get('SIM0003')?.branch1On === null);
  check('LCLI=4 cho tủ mất bus (SIM0004)', latest.get('SIM0004')?.busStatus === '4');
  check('MCON=1 nhưng U=0 cho tủ mất DH (SIM0005)', latest.get('SIM0005')?.pmOnline === true && latest.get('SIM0005')?.vL1 === 0);
  check('CTTE=1000 → lỗi cảm biến (SIM0006)', latest.get('SIM0006')?.tempSensorFault === true);
  check('Firmware cũ không có LQ2 (SIM0007)', latest.get('SIM0007')?.branch1On === null && latest.get('SIM0007')?.plcOnline === true);
  check('Không có frame từ tủ offline (SIM0008)', !latest.has('SIM0008'));

  // ---- command round trip: manual all ON on SIM0001 ----
  acks.length = 0;
  server_.publish(TOPICS.command, buildCommandFrame('SIM0001', 'MANUAL_ALL', { on: true }));
  await sleep(4500);
  const a1 = acks.find((a) => a.ltid === 'SIM0001');
  check('SIM0001 ack PLN1/PLN2/PMAN rc=0', !!a1 && a1.acks.every((x) => x.rc === 0) && a1.acks.length === 3, JSON.stringify(a1?.acks));
  const t1 = latest.get('SIM0001');
  check('SIM0001 telemetry xác nhận LQ2=LQ3=1, PMAN=1', t1?.branch1On === true && t1?.branch2On === true && t1?.manualMode === true);
  check('Tủ firmware mới khác không phản hồi lệnh của SIM0001', acks.filter((a) => a.ltid && a.ltid !== 'SIM0001').length === 0);
  check('Tủ firmware cũ vẫn ack (không lọc LTID, ack không có id)', acks.some((a) => a.ltid === null));

  // ---- PLC lost: manual command must fail rc=-1 ----
  acks.length = 0;
  server_.publish(TOPICS.command, buildCommandFrame('SIM0003', 'MANUAL_BRANCH', { branch: 1, on: true }));
  await sleep(1500);
  const a3 = acks.find((a) => a.ltid === 'SIM0003');
  check('SIM0003 (mất PLC) trả rc=-1', !!a3 && a3.acks.every((x) => x.rc === -1), JSON.stringify(a3?.acks));

  // ---- LOGO lost: ack 0 but no effect (E702 case) ----
  acks.length = 0;
  server_.publish(TOPICS.command, buildCommandFrame('SIM0009', 'MANUAL_ALL', { on: true }));
  await sleep(4500);
  const a9 = acks.find((a) => a.ltid === 'SIM0009');
  check('SIM0009 (mất LOGO) ack rc=0 nhưng LQ2 không đổi', !!a9 && a9.acks.every((x) => x.rc === 0) && latest.get('SIM0009')?.manualMode === false);

  // ---- LTID ALL: only LTIM ----
  acks.length = 0;
  server_.publish(TOPICS.command, buildCommandFrame('ALL', 'SET_TIME', {}));
  await sleep(1500);
  check('LTID ALL: mọi tủ firmware mới ack LTIM', acks.filter((a) => a.ltid).length === online - 1);

  // ---- LDIA ----
  server_.publish(TOPICS.command, buildCommandFrame('SIM0010', 'DIAG', {}));
  await sleep(1500);
  const st = demos.find((d) => d.kind === 'selftest' && d.ltid === 'SIM0010');
  check('LDIA: báo cáo RS485 parse được (A1D1B1C1)', !!st && st.kind === 'selftest' && st.summary === 'A1D1B1C1');

  // ---- broker ACL (only meaningful against EMQX with infra/emqx/acl.conf) ----
  if (!useEmbedded) {
    // An anonymous client (= what a cabinet or an attacker looks like) must not be able to send commands ...
    acks.length = 0;
    const intruder = mqtt.connect(URL, { clientId: `ec25_intruder_${Date.now()}` });
    await new Promise<void>((r) => intruder.on('connect', () => r()));
    intruder.publish(TOPICS.command, buildCommandFrame('SIM0002', 'MANUAL_ALL', { on: true }));
    await sleep(2500);
    check('ACL: client anonymous KHÔNG gửi được lệnh (SIM0002 không ack)', !acks.some((a) => a.ltid === 'SIM0002'));
    // ... nor read other cabinets' telemetry.
    // mqtt.js rejects the promise when the broker answers SUBACK 0x80 (not authorized).
    const subResult = await intruder.subscribeAsync(TOPICS.telemetry).then(
      (g) => g.map((x) => x.qos).join(','),
      (e: { packet?: { granted?: number[] } }) => `denied ${e.packet?.granted?.join(',') ?? ''}`.trim(),
    );
    check('ACL: client anonymous KHÔNG subscribe được telemetry', subResult.startsWith('denied') || subResult === '128', subResult);
    await intruder.endAsync();
    // Guessing a backend-looking username gives no extra rights.
    acks.length = 0;
    const guess = mqtt.connect(URL, { clientId: `guess_${Date.now()}`, username: 'citylight-backend' });
    await new Promise<void>((r) => guess.on('connect', () => r()));
    guess.publish(TOPICS.command, buildCommandFrame('SIM0002', 'MANUAL_ALL', { on: true }));
    await sleep(2500);
    check('ACL: đoán username backend vẫn KHÔNG gửi được lệnh', !acks.some((a) => a.ltid === 'SIM0002'));
    await guess.endAsync();
  }

  await Promise.all(sims.map((s) => s.stop()));
  await server_.endAsync();
  if (broker) await new Promise<void>((r) => broker!.close(() => r()));
  server?.close();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[e2e] ${checks.length - failed.length}/${checks.length} kiểm tra đạt`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
