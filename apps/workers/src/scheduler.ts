// Scheduler (spec 9, M6, decision A): keeps every cabinet on its desired schedule.
// desired = cabinet's own schedule > zone schedule; astronomical ones recomputed per VN day.
// Cabinets with neither are left alone: the default schedule is never pushed, so a cabinet whose LOGO
// schedule was set by hand keeps it until someone configures a schedule for it on the server.
// A cabinet is sent SET_SCHEDULE when it is online, its firmware is safe, the schedule it last acked
// (schedule_applied) differs, no SET_SCHEDULE of its own is still open, and this same schedule did
// not fail (rejected / no ack) in the last RETRY_MS — a changed schedule goes out at once. Runs every INTERVAL_MS, on Redis "cl:schedules" (a schedule was saved) and for
// cabinets that just came back online (cabinet.state events) — so an offline cabinet catches up.
// One active instance (advisory lock). Commands go through the command-worker queue (M4).
import { Redis } from 'ioredis';
import { buildCommandFrames } from '@citylight/coreif';
import { createSql } from '@citylight/db';
import { SCHEDULES_CHANNEL, SYSTEM_USER_ID } from '@citylight/db/batches';
import { COMMANDS_NOTIFY, EVENTS_CHANNEL } from '@citylight/db/commands';
import { loadDesired } from '@citylight/db/schedules';
import { firmwareBlocksCommands, sameSchedule, type FwProfile, type ScheduleWindow } from '@citylight/shared';

const INTERVAL_MS = Number(process.env.SCHED_INTERVAL_MS ?? 5 * 60_000);
const RETRY_MS = Number(process.env.SCHED_RETRY_MS ?? 30 * 60_000);
const DEBOUNCE_MS = 2000;

const sql = createSql(process.env.DATABASE_URL, 4);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 2 });
const stats = { runs: 0, checked: 0, differing: 0, sent: 0, offline: 0, blocked: 0, waiting: 0, lastRunMs: 0 };

/**
 * Reconcile all cabinets (ids = null) or only these. `fresh` = cabinets that just came back online:
 * a failed attempt from before they reconnected does not hold them back.
 */
async function reconcile(ids: string[] | null, fresh: Set<string> = new Set()): Promise<number> {
  const started = Date.now();
  const desired = await loadDesired(sql, ids);
  const state = await sql<{ id: string; fw_profile: FwProfile; online: boolean | null; applied: ScheduleWindow | null; open: boolean; tried: ScheduleWindow | null }[]>`
    SELECT c.id, c.fw_profile, s.online, a.values AS applied,
      EXISTS (SELECT 1 FROM commands m WHERE m.cabinet_id = c.id AND m.type = 'SET_SCHEDULE' AND (m.status = 'queued' OR m.deadline_at IS NOT NULL)) AS open,
      (SELECT m.params FROM commands m WHERE m.cabinet_id = c.id AND m.type = 'SET_SCHEDULE' AND m.requested_by = ${SYSTEM_USER_ID}
         AND m.status IN ('failed', 'timeout') AND m.queued_at > now() - make_interval(secs => ${RETRY_MS / 1000})
         ORDER BY m.queued_at DESC LIMIT 1) AS tried
    FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id LEFT JOIN schedule_applied a ON a.cabinet_id = c.id
    ${ids ? sql`WHERE c.id = ANY(${ids}::uuid[])` : sql``}`;
  const byId = new Map(state.map((r) => [r.id, r]));
  const send = { ids: [] as string[], params: [] as string[], frames: [] as string[] };
  let differing = 0;
  for (const d of desired) {
    const st = byId.get(d.cabinetId);
    if (!st || d.source === 'default' || sameSchedule(d.window, st.applied)) continue;
    differing++;
    if (!st.online) stats.offline++;
    else if (firmwareBlocksCommands(st.fw_profile)) stats.blocked++;
    else if (st.open || (!fresh.has(d.cabinetId) && sameSchedule(d.window, st.tried))) stats.waiting++; // in flight, or this exact schedule failed in the last RETRY_MS
    else {
      send.ids.push(d.cabinetId);
      send.params.push(JSON.stringify(d.window));
      send.frames.push(buildCommandFrames(d.ltid, 'SET_SCHEDULE', d.window as unknown as Record<string, unknown>).join('\n'));
    }
  }
  if (send.ids.length) {
    await sql`
      INSERT INTO commands (cabinet_id, type, params, frame, requested_by)
      SELECT x.cabinet_id, 'SET_SCHEDULE', x.params::jsonb, x.frame, ${SYSTEM_USER_ID}
      FROM unnest(${send.ids}::uuid[], ${send.params}::text[], ${send.frames}::text[]) AS x(cabinet_id, params, frame)`;
    await sql`SELECT pg_notify(${COMMANDS_NOTIFY}, 'scheduler')`;
  }
  stats.runs++;
  stats.checked += desired.length;
  stats.differing = ids ? stats.differing : differing;
  stats.sent += send.ids.length;
  stats.lastRunMs = Date.now() - started;
  if (send.ids.length || !ids) console.log(`[scheduler] ${ids ? `${ids.length} tủ` : 'toàn bộ'}: ${desired.length} kiểm, ${differing} lệch lịch, gửi ${send.ids.length} (${stats.lastRunMs} ms)`);
  return send.ids.length;
}

// one run at a time; targeted requests are merged while a run is going on
let chain = Promise.resolve();
let pendingIds: Set<string> | null = null;
let pendingFresh = new Set<string>();
let pendingAll = false;
let timer: NodeJS.Timeout | null = null;

function request(ids: string[] | null, fresh: string[] = []) {
  fresh.forEach((i) => pendingFresh.add(i));
  if (ids === null) pendingAll = true;
  else {
    pendingIds ??= new Set();
    ids.forEach((i) => pendingIds!.add(i));
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const all = pendingAll;
    const some = pendingIds ? [...pendingIds] : null;
    const fresh = pendingFresh;
    pendingAll = false;
    pendingIds = null;
    pendingFresh = new Set();
    chain = chain.then(() => reconcile(all ? null : some, fresh)).then(() => undefined).catch((e) => console.error('[scheduler]', (e as Error).message));
  }, DEBOUNCE_MS);
}

async function main() {
  const lockConn = await sql.reserve();
  const got = await lockConn<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('cl-scheduler')) AS ok`;
  if (!got[0]?.ok) {
    console.log('[scheduler] another scheduler is active, waiting as standby');
    await lockConn`SELECT pg_advisory_lock(hashtext('cl-scheduler'))`;
  }
  console.log(`[scheduler] active (every ${INTERVAL_MS / 1000} s, retry after ${RETRY_MS / 60_000} min)`);
  const sub = redis.duplicate();
  await sub.subscribe(SCHEDULES_CHANNEL, EVENTS_CHANNEL);
  sub.on('message', (ch, msg) => {
    if (ch === SCHEDULES_CHANNEL) {
      const p = JSON.parse(msg) as { cabinetId?: string };
      request(p.cabinetId ? [p.cabinetId] : null); // a zone changed: check everyone (cheap)
      return;
    }
    if (!msg.startsWith('{"type":"cabinet.state"')) return;
    const ev = JSON.parse(msg) as { items: { cabinetId: string; online: boolean; cameOnline?: boolean }[] };
    const back = ev.items.filter((i) => i.cameOnline).map((i) => i.cabinetId);
    if (back.length) request(back, back); // came back online: catch up if its schedule is stale
  });
  request(null);
  setInterval(() => request(null), INTERVAL_MS);
  setInterval(() => void redis.set('cl:scheduler:stats', JSON.stringify({ ...stats, at: Date.now() })).catch(() => undefined), 30_000);
  const shutdown = async () => {
    await chain;
    lockConn.release();
    await sql.end({ timeout: 5 });
    redis.disconnect();
    sub.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

process.on('unhandledRejection', (e) => console.error('[scheduler] unhandled', (e as Error)?.message ?? e));
await main();
