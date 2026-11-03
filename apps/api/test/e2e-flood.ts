// S61 untrusted-broker guards: whoever holds the broker (trial: the customer has root on it) floods telemetry under
// thousands of random LTIDs. The per-LTID budget does not stop that, the ingest guards must: unknown_devices stops
// at INGEST_MAX_UNKNOWN new rows, frames_raw grows by at most INGEST_MAX_RAW_PER_MIN (+ burst) per minute, the total
// rate is cut at INGEST_MAX_FPS. Needs an ingest started with these guards (trial stack) and the same values here.
// Publishes FLOOD frames with the device account on E2E_CAB_URL. ~1 min.
// Run: npm run e2e:flood
import mqtt from 'mqtt';
import { Redis } from 'ioredis';
import { buildFrame } from '@citylight/coreif';
import { createSql } from '@citylight/db';

const CAB = process.env.E2E_CAB_URL ?? 'mqtt://localhost:1883';
const MAX_UNKNOWN = Number(process.env.INGEST_MAX_UNKNOWN ?? 0);
const MAX_RAW_PER_MIN = Number(process.env.INGEST_MAX_RAW_PER_MIN ?? 0);
const MAX_FPS = Number(process.env.INGEST_MAX_FPS ?? 0);
const FLOOD = Number(process.env.E2E_FLOOD ?? 5000);
const PREFIX = 'FLD';
const sql = createSql(process.env.DATABASE_URL, 2);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = async (q: Promise<{ n: number }[]>) => Number((await q)[0]!.n);
const stats = async () => JSON.parse((await redis.get('cl:ingest:stats')) ?? '{}') as Record<string, number | boolean>;

async function main() {
  if (!MAX_UNKNOWN || !MAX_RAW_PER_MIN || !MAX_FPS) throw new Error('set INGEST_MAX_UNKNOWN / INGEST_MAX_RAW_PER_MIN / INGEST_MAX_FPS as in the ingest under test');
  await sql`DELETE FROM unknown_devices WHERE ltid LIKE ${PREFIX + '%'}`;
  const unknown0 = await count(sql`SELECT count(*)::int AS n FROM unknown_devices`);
  const raw0 = await count(sql`SELECT count(*)::int AS n FROM frames_raw`);
  const s0 = await stats();

  const c = mqtt.connect(CAB, { username: process.env.MQTT_DEVICE_USERNAME, password: process.env.MQTT_DEVICE_PASSWORD, reconnectPeriod: 0 });
  await new Promise<void>((res, rej) => { c.on('connect', () => res()); c.on('error', rej); });
  const started = Date.now();
  for (let i = 0; i < FLOOD; i++) {
    const ltid = `${PREFIX}${i.toString(36).toUpperCase().padStart(4, '0')}`;
    c.publish('electrical_cabinets_default', buildFrame([['LTID', ltid], ['LIME', String(860000000000000 + i)], ['LCLI', 0]]), { qos: 0 });
    if (i % 500 === 499) await sleep(50);
  }
  const sentS = (Date.now() - started) / 1000;
  console.log(`  sent ${FLOOD} frames under ${FLOOD} LTIDs in ${sentS.toFixed(1)} s`);
  await sleep(65_000); // one ingest guard check (60 s) + flushes
  c.end();

  const s1 = await stats();
  const unknown1 = await count(sql`SELECT count(*)::int AS n FROM unknown_devices`);
  const raw1 = await count(sql`SELECT count(*)::int AS n FROM frames_raw`);
  const newUnknown = await count(sql`SELECT count(*)::int AS n FROM unknown_devices WHERE ltid LIKE ${PREFIX + '%'}`);
  const overRate = Number(s1.overRate ?? 0) - Number(s0.overRate ?? 0);
  const rawDropped = Number(s1.rawDropped ?? 0) - Number(s0.rawDropped ?? 0);
  const unknownDropped = Number(s1.unknownDropped ?? 0) - Number(s0.unknownDropped ?? 0);

  check('Ingest báo số liệu chốt chặn (cl:ingest:stats)', 'overRate' in s1, JSON.stringify({ overRate, rawDropped, unknownDropped }));
  check(`Tổng số tủ lạ không vượt ${MAX_UNKNOWN}`, unknown1 <= Math.max(MAX_UNKNOWN, unknown0), `trước ${unknown0}, sau ${unknown1}, mới ${newUnknown}`);
  // the bucket starts full (1 min) and refills for ~sentS + 65 s
  const rawMax = MAX_RAW_PER_MIN + Math.ceil((MAX_RAW_PER_MIN / 60) * (sentS + 70));
  check(`frames_raw tăng ≤ ${rawMax} dòng`, raw1 - raw0 <= rawMax, `+${raw1 - raw0}, bỏ ${rawDropped}`);
  check('Frame vượt tổng tốc độ bị bỏ (INGEST_MAX_FPS)', FLOOD / Math.max(sentS, 0.1) > MAX_FPS * 2 ? overRate > 0 : true, `${overRate} frame bỏ`);
  check('Tủ lạ mới vượt giới hạn bị bỏ', unknown0 + newUnknown <= MAX_UNKNOWN || unknownDropped > 0 || overRate > 0, `${unknownDropped} LTID bỏ`);

  await sql`DELETE FROM unknown_devices WHERE ltid LIKE ${PREFIX + '%'}`;
  await sql`DELETE FROM frames_raw WHERE ltid LIKE ${PREFIX + '%'}`;
  const ok = checks.filter((x) => x.ok).length;
  console.log(`\n[e2e:flood] ${ok}/${checks.length} kiểm tra đạt`);
  await sql.end();
  redis.disconnect();
  process.exit(ok === checks.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
