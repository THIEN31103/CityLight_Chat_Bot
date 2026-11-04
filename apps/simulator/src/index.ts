// CLI: npm run start -w @citylight/simulator -- --count 100 --broker mqtt://localhost:1883
import { fleetLocation } from '@citylight/db/fixtures';
import { parseMasterKey } from '@citylight/coreif/sign';
import { SimCabinet, type Fault } from './cabinet';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const count = Number(arg('count', '100'));
const broker = arg('broker', process.env.MQTT_URL ?? 'mqtt://localhost:1883');
const prefix = arg('prefix', 'SIM');
const faultRate = Number(arg('fault-rate', '0.08'));
const telemetryMs = Number(arg('interval', '10000'));
/** --cmd-topic: firmware with its own command topic citylight/cmd/<LTID> + LFWV (S53) */
const cmdTopic = process.argv.includes('--cmd-topic');
/** --code-prefix TM: boards carry a factory cabinet code TM0001, TM0002... (telemetry LCOD), for the QR flow */
const codePrefix = arg('code-prefix', '');
/** --sign: signing firmware (S59) with DEVICE_MASTER_KEY of this environment (use a test master, never a customer's) */
const master = process.argv.includes('--sign') ? parseMasterKey(process.env.DEVICE_MASTER_KEY) : null;
if (process.argv.includes('--sign') && !master) throw new Error('--sign needs DEVICE_MASTER_KEY (64 hex)');

const FAULTS: Fault[] = ['offline', 'plc_lost', 'bus_down', 'pm_lost', 'ct_lost', 'dh_meter_lost', 'phase_loss', 'temp_sensor_fault', 'logo_lost', 'old_firmware', 'ack_lost'];

export function pickFault(i: number, rate: number): Fault {
  // deterministic spread so every scenario appears in a small fleet
  if (rate <= 0) return 'none';
  const every = Math.max(1, Math.round(1 / rate));
  return i % every === every - 1 ? FAULTS[Math.floor(i / every) % FAULTS.length]! : 'none';
}

const cabinets: SimCabinet[] = [];
for (let i = 0; i < count; i++) {
  const c = new SimCabinet({
    ltid: `${prefix}${String(i + 1).padStart(4, '0')}`,
    brokerUrl: broker,
    fault: pickFault(i, faultRate),
    location: fleetLocation(i),
    telemetryMs,
    cmdTopic,
    sign: master ? { master } : undefined,
    cabinetCode: codePrefix ? `${codePrefix}${String(i + 1).padStart(4, '0')}` : undefined,
    log: (m) => console.error(m),
  });
  cabinets.push(c);
  // stagger connects (10k clients must not hit the broker in the same millisecond)
  setTimeout(() => c.start(), Math.floor(i * Math.min(20, 30_000 / count)));
}

console.log(`[sim] ${count} cabinets -> ${broker} (prefix ${prefix}, fault rate ${faultRate}, interval ${telemetryMs} ms${cmdTopic ? ', own cmd topic' : ''}${master ? ', signing' : ''})`);
setInterval(() => {
  const t = cabinets.reduce((s, c) => s + c.stats.telemetry, 0);
  const a = cabinets.reduce((s, c) => s + c.stats.acks, 0);
  console.log(`[sim] telemetry sent ${t} · acks ${a}`);
}, 30_000);

process.on('SIGINT', async () => {
  await Promise.all(cabinets.map((c) => c.stop()));
  process.exit(0);
});
