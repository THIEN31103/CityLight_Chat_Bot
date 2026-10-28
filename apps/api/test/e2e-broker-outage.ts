// Ingest lost the broker (EMQX down, or the VPN to a customer's broker down): no mass "mất kết nối" (E101), the
// offline checks pause while ingest is disconnected and for offline_after once it is back; a cabinet that really
// stops is still called offline afterwards. Needs ingest running (source or container) against the local EMQX in
// Docker: this script pauses / unpauses the citylight-emqx container. Uses 2 registered simulator cabinets SIM91xx.
// About 5 minutes. Run: npm run e2e:broker-outage
import { execFileSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { createSql } from '@citylight/db';
import { SimCabinet } from '../../simulator/src/cabinet';

const MQTT_URL = process.env.E2E_MQTT_URL ?? process.env.MQTT_URL ?? 'mqtt://localhost:1885';
const EMQX = process.env.E2E_EMQX_CONTAINER ?? 'citylight-emqx';
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
    await sleep(1000);
  }
  console.log(`  (timeout waiting for ${what})`);
  return null;
}
const link = async () => JSON.parse((await redis.get('cl:ingest:mqtt')) ?? 'null') as { connected: boolean; since: string | null; at: string } | null;
const offlineSince = (ids: string[], t: Date) =>
  sql<{ cabinet_id: string }[]>`SELECT cabinet_id FROM alarms WHERE type = 'offline' AND cabinet_id = ANY(${ids}::uuid[]) AND started_at >= ${t}`;
const online = (ids: string[]) => sql<{ cabinet_id: string }[]>`SELECT cabinet_id FROM cabinet_state WHERE online AND cabinet_id = ANY(${ids}::uuid[])`;
const docker = (...args: string[]) => execFileSync('docker', args, { stdio: 'pipe' });

async function main() {
  const cabs = await sql<{ id: string; ltid: string }[]>`SELECT id, ltid FROM cabinets WHERE active AND ltid LIKE 'SIM91%' ORDER BY ltid LIMIT 2`;
  if (cabs.length < 2) throw new Error('cần 2 tủ simulator SIM91xx đã đăng ký (npm run sim:register -- --count 10000)');
  const ids = cabs.map((c) => c.id);
  const [A, B] = cabs as [(typeof cabs)[0], (typeof cabs)[0]];
  const offlineAfterS = (await sql<{ value: number }[]>`SELECT value FROM system_settings WHERE key = 'offline_after_s'`)[0]?.value ?? 60;
  const l0 = await link();
  check('Ingest báo kết nối broker (cl:ingest:mqtt)', !!l0?.connected, JSON.stringify(l0));

  const sims = cabs.map((c) => new SimCabinet({ ltid: c.ltid, brokerUrl: MQTT_URL, fault: 'none', location: { lat: 10.78, lng: 106.7 }, telemetryMs: 5000 }));
  let paused = false;
  try {
    sims.forEach((s) => s.start());
    check('2 tủ giả online', !!(await waitFor('sims online', async () => (await online(ids)).length === 2, 60_000)));

    // ---------- broker down longer than offline_after ----------
    const t0 = new Date();
    docker('pause', EMQX);
    paused = true;
    const down = await waitFor('ingest notices the lost broker', async () => (await link())?.connected === false, 60_000);
    check('Ingest nhận ra mất broker (keepalive 15 s)', !!down, down ? `sau ${Math.round((Date.now() - t0.getTime()) / 1000)} s` : '');
    await sleep(Math.max(0, t0.getTime() + (offlineAfterS + 40) * 1000 - Date.now()));
    const dOff = await offlineSince(ids, t0);
    const dOn = await online(ids);
    check(`Mất broker ${offlineAfterS + 40} s (> offline_after ${offlineAfterS} s) → không E101, tủ vẫn online`, dOff.length === 0 && dOn.length === 2, `E101 ${dOff.length}, online ${dOn.length}`);

    // ---------- broker back: grace, the cabinets reconnect (firmware-like 30 s retry) ----------
    docker('unpause', EMQX);
    paused = false;
    const up = await waitFor('ingest back on the broker', async () => (await link())?.connected === true, 60_000);
    check('Ingest nối lại broker', !!up);
    await sleep((offlineAfterS + 20) * 1000);
    const uOff = await offlineSince(ids, t0);
    const fresh = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cabinet_state WHERE online AND cabinet_id = ANY(${ids}::uuid[]) AND last_seen_at > now() - interval '30 seconds'`;
    check('Sau ân hạn: vẫn không E101, cả 2 tủ gửi frame lại', uOff.length === 0 && fresh[0]!.n === 2, `E101 ${uOff.length}, tủ có frame mới ${fresh[0]!.n}`);

    // ---------- a cabinet that really stops is still called offline ----------
    const t1 = new Date();
    await sims[1]!.stop();
    const gone = await waitFor('E101 for B', async () => (await offlineSince([B.id], t1)).length > 0, (offlineAfterS + 60) * 1000);
    const aOff = await offlineSince([A.id], t1);
    check('Broker bình thường, 1 tủ ngừng gửi → E101 đúng tủ đó, tủ kia không', !!gone && aOff.length === 0, `${B.ltid} ${gone ? 'E101' : 'không E101'}, ${A.ltid} E101 ${aOff.length}`);
  } finally {
    if (paused) docker('unpause', EMQX);
    for (const s of sims) await s.stop().catch(() => undefined);
    await redis.quit();
    await sql.end();
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n[e2e:broker-outage] ${checks.length - failed}/${checks.length} kiểm tra đạt`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
