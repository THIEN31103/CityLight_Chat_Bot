// Command worker (spec 12, M4). Queue = the commands table (decision S17: no BullMQ, per-cabinet
// ordering would need BullMQ Pro groups):
//  - one active instance (Postgres advisory lock); a second instance waits as standby
//  - one command in flight per cabinet: the firmware ack carries the cabinet id and keys, no command id
//  - queued -> sent -> acked -> confirmed (telemetry shows the effect) | acked_unconfirmed
//                         \-> failed (rc != 0) | timeout (no ack; idempotent types re-sent once)
//  - SET_SCHEDULE / PULSE_ON / DIAG end at "acked": the device reports nothing that proves the effect
//  - every change -> commands row + Redis "command.updated" (Socket.IO) ; every outcome -> activity_logs
import mqtt from 'mqtt';
import { Redis } from 'ioredis';
import {
  RETRYABLE, TOPICS, ackError, ackMatches, buildCommandFrames, confirmRule, parseAck, parseTelemetry, type Ack,
} from '@citylight/coreif';
import { createSql } from '@citylight/db';
import { COMMANDS_NOTIFY, EVENTS_CHANNEL, commandById } from '@citylight/db/commands';
import { COMMAND_STATUS_LABELS, describeCommand, type CommandStatus, type CommandType } from '@citylight/shared';

const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const ACK_TIMEOUT_MS = Number(process.env.CMD_ACK_TIMEOUT_MS ?? 30_000);
const CONFIRM_MS = Number(process.env.CMD_CONFIRM_MS ?? 20_000);
const QUEUE_TTL_MS = Number(process.env.CMD_QUEUE_TTL_MS ?? 120_000);
const SEND_PER_SEC = Number(process.env.CMD_SEND_PER_SEC ?? 20);
const TICK_MS = 500;

const sql = createSql(process.env.DATABASE_URL, 5);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 2 });

interface InFlight {
  id: string;
  cabinetId: string;
  ltid: string;
  type: CommandType;
  params: Record<string, unknown>;
  frames: string[];
  step: number;
  attempts: number;
  phase: 'ack' | 'confirm';
  deadline: number;
  ackRc: Record<string, number>;
}

/** ltid -> the cabinet's command on the wire */
const inflight = new Map<string, InFlight>();
const stats = { sent: 0, resent: 0, acked: 0, confirmed: 0, unconfirmed: 0, failed: 0, timeout: 0, expired: 0, unmatchedAcks: 0 };

// ---------------- helpers ----------------

async function emit(id: string) {
  const cmd = await commandById(sql, id);
  if (cmd) await redis.publish(EVENTS_CHANNEL, JSON.stringify({ type: 'command.updated', command: cmd })).catch(() => undefined);
  return cmd;
}

/** Outcome in the activity log, attributed to the user who sent the command. */
async function audit(id: string, status: CommandStatus, error: string | null) {
  const cmd = await commandById(sql, id);
  if (!cmd) return;
  const text = `${describeCommand(cmd.type, cmd.params)}: ${COMMAND_STATUS_LABELS[status]}${error ? ` — ${error}` : ''}`;
  await sql`INSERT INTO activity_logs (user_id, user_email, action, target_type, target_id, target_name, new_value)
            SELECT requested_by, ${cmd.requestedBy}, 'Kết quả lệnh', 'cabinet', ${cmd.cabinetId}, ${cmd.cabinetName}, ${text}
            FROM commands WHERE id = ${id}`;
}

async function finish(f: InFlight | { id: string; ltid?: string }, status: CommandStatus, error: string | null, extra: { acked?: boolean; confirmed?: boolean } = {}) {
  if ('ltid' in f && f.ltid) inflight.delete(f.ltid);
  await sql`
    UPDATE commands SET status = ${status}, error = ${error}, deadline_at = NULL,
      acked_at = CASE WHEN ${!!extra.acked} THEN coalesce(acked_at, now()) ELSE acked_at END,
      confirmed_at = CASE WHEN ${!!extra.confirmed} THEN now() ELSE confirmed_at END
    WHERE id = ${f.id}`;
  await audit(f.id, status, error);
  await emit(f.id);
}

/** SET_TIME carries "now": rebuild it on every (re)send. */
function freshFrames(f: Pick<InFlight, 'ltid' | 'type' | 'params' | 'frames'>) {
  return f.type === 'SET_TIME' ? buildCommandFrames(f.ltid, f.type, f.params) : f.frames;
}

function publishFrame(frame: string) {
  mq.publish(TOPICS.command, frame, { qos: 0 });
}

// ---------------- dispatch ----------------

let sentThisSecond = 0;
let secondStart = Date.now();

async function dispatch() {
  if (!mq.connected) return;
  if (Date.now() - secondStart >= 1000) {
    secondStart = Date.now();
    sentThisSecond = 0;
  }
  if (sentThisSecond >= SEND_PER_SEC) return;
  const rows = await sql<
    { id: string; cabinet_id: string; ltid: string; type: CommandType; params: Record<string, unknown>; frame: string; queued_at: Date; online: boolean | null }[]
  >`
    SELECT m.id, m.cabinet_id, c.ltid, m.type, m.params, m.frame, m.queued_at, s.online
    FROM commands m JOIN cabinets c ON c.id = m.cabinet_id LEFT JOIN cabinet_state s ON s.cabinet_id = m.cabinet_id
    WHERE m.status = 'queued'
      AND NOT EXISTS (SELECT 1 FROM commands w WHERE w.cabinet_id = m.cabinet_id AND w.deadline_at IS NOT NULL)
    ORDER BY m.queued_at LIMIT 500`;
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.cabinet_id)) continue; // oldest first, one per cabinet
    seen.add(r.cabinet_id);
    const ltid = r.ltid.toUpperCase();
    if (inflight.has(ltid)) continue;
    if (Date.now() - r.queued_at.getTime() > QUEUE_TTL_MS) {
      stats.expired++;
      await finishQueued(r.id, 'failed', `Quá ${QUEUE_TTL_MS / 1000} s trong hàng đợi, lệnh không được gửi`);
      continue;
    }
    if (!r.online) {
      await finishQueued(r.id, 'failed', 'Tủ mất kết nối trước khi gửi, lệnh không được gửi');
      continue;
    }
    if (sentThisSecond >= SEND_PER_SEC) break;
    const f: InFlight = {
      id: r.id, cabinetId: r.cabinet_id, ltid, type: r.type, params: r.params, frames: r.frame.split('\n'),
      step: 0, attempts: 1, phase: 'ack', deadline: Date.now() + ACK_TIMEOUT_MS, ackRc: {},
    };
    f.frames = freshFrames(f);
    // the status guard loses against a concurrent cancel
    const claimed = await sql`
      UPDATE commands SET status = 'sent', sent_at = now(), step = 0, attempts = 1, frame = ${f.frames.join('\n')},
        deadline_at = ${new Date(f.deadline)}
      WHERE id = ${r.id} AND status = 'queued' RETURNING id`;
    if (!claimed.length) continue;
    inflight.set(ltid, f);
    publishFrame(f.frames[0]!);
    sentThisSecond++;
    stats.sent++;
    await emit(f.id);
  }
}

async function finishQueued(id: string, status: CommandStatus, error: string) {
  const done = await sql`UPDATE commands SET status = ${status}, error = ${error} WHERE id = ${id} AND status = 'queued' RETURNING id`;
  if (!done.length) return;
  await audit(id, status, error);
  await emit(id);
}

// ---------------- ack / telemetry ----------------

async function onAck(payload: string) {
  let ack: Ack;
  try {
    ack = parseAck(payload);
  } catch {
    return;
  }
  const f = ack.ltid ? inflight.get(ack.ltid) : undefined;
  if (!f || f.phase !== 'ack' || !ackMatches(f.ltid, f.frames[f.step]!, ack)) {
    stats.unmatchedAcks++; // late ack after timeout, another sender, or old firmware (no id)
    return;
  }
  for (const a of ack.acks) f.ackRc[a.key] = a.rc;
  await sql`UPDATE commands SET ack_rc = ${sql.json(f.ackRc)} WHERE id = ${f.id}`;
  // LDIA rc -1 = the self-test ran and found a fault / was inconclusive: the report is on stm32/ec25/demo
  if (f.type === 'DIAG' && ack.acks.every((a) => a.rc === 0 || a.rc === -1)) {
    stats.acked++;
    const note = ack.acks.some((a) => a.rc === -1) ? 'Tự kiểm tra RS485 báo lỗi hoặc không kết luận được, xem tab Chẩn đoán' : null;
    return finish(f, 'acked', note, { acked: true });
  }
  const err = ackError(ack);
  if (err) {
    stats.failed++;
    return finish(f, 'failed', err, { acked: true });
  }
  if (f.step + 1 < f.frames.length) {
    // next frame of a multi-frame command (PULSE_ON: PI2O'0 then PI2O'1)
    f.step++;
    f.attempts = 1;
    f.deadline = Date.now() + ACK_TIMEOUT_MS;
    await sql`UPDATE commands SET step = ${f.step}, attempts = 1, deadline_at = ${new Date(f.deadline)} WHERE id = ${f.id}`;
    publishFrame(f.frames[f.step]!);
    return;
  }
  stats.acked++;
  if (f.type === 'SET_SCHEDULE') {
    await sql`
      INSERT INTO schedule_applied (cabinet_id, values, applied_at, command_id) VALUES (${f.cabinetId}, ${sql.json(f.params as never)}, now(), ${f.id})
      ON CONFLICT (cabinet_id) DO UPDATE SET values = excluded.values, applied_at = excluded.applied_at, command_id = excluded.command_id`;
  }
  if (!confirmRule(f.type, f.params)) return finish(f, 'acked', null, { acked: true });
  f.phase = 'confirm';
  f.deadline = Date.now() + CONFIRM_MS;
  await sql`UPDATE commands SET status = 'acked', acked_at = now(), deadline_at = ${new Date(f.deadline)} WHERE id = ${f.id}`;
  await emit(f.id);
}

const LTID_RE = /LTID'([^&$]+)/;

async function onTelemetry(payload: string) {
  if (!inflight.size) return;
  const ltid = LTID_RE.exec(payload)?.[1]?.trim().toUpperCase();
  const f = ltid ? inflight.get(ltid) : undefined;
  if (!f || f.phase !== 'confirm') return;
  try {
    const t = parseTelemetry(payload);
    if (confirmRule(f.type, f.params)?.(t, new Date())) {
      stats.confirmed++;
      await finish(f, 'confirmed', null, { acked: true, confirmed: true });
    }
  } catch {
    /* ingest records parse errors */
  }
}

// ---------------- deadlines ----------------

async function checkDeadlines() {
  const now = Date.now();
  for (const f of [...inflight.values()]) {
    if (now < f.deadline) continue;
    if (f.phase === 'confirm') {
      stats.unconfirmed++;
      await finish(f, 'acked_unconfirmed', `Tủ đã nhận lệnh nhưng telemetry chưa phản ánh sau ${CONFIRM_MS / 1000} s`, { acked: true });
    } else if (RETRYABLE.has(f.type) && f.attempts < 2) {
      f.attempts++;
      f.frames = freshFrames(f);
      f.deadline = now + ACK_TIMEOUT_MS;
      await sql`UPDATE commands SET attempts = ${f.attempts}, frame = ${f.frames.join('\n')}, deadline_at = ${new Date(f.deadline)} WHERE id = ${f.id}`;
      publishFrame(f.frames[f.step]!);
      stats.resent++;
    } else {
      stats.timeout++;
      await finish(f, 'timeout', `Không nhận được phản hồi từ tủ sau ${f.attempts} lần gửi (${ACK_TIMEOUT_MS / 1000} s mỗi lần)`);
    }
  }
}

/** After a restart: pick up commands that were on the wire (their deadlines still apply). */
async function recover() {
  const rows = await sql<
    { id: string; cabinet_id: string; ltid: string; type: CommandType; params: Record<string, unknown>; frame: string; status: CommandStatus;
      step: number; attempts: number; deadline_at: Date; ack_rc: Record<string, number> | null }[]
  >`
    SELECT m.id, m.cabinet_id, c.ltid, m.type, m.params, m.frame, m.status, m.step, m.attempts, m.deadline_at, m.ack_rc
    FROM commands m JOIN cabinets c ON c.id = m.cabinet_id WHERE m.deadline_at IS NOT NULL`;
  for (const r of rows) {
    inflight.set(r.ltid.toUpperCase(), {
      id: r.id, cabinetId: r.cabinet_id, ltid: r.ltid.toUpperCase(), type: r.type, params: r.params, frames: r.frame.split('\n'),
      step: r.step, attempts: r.attempts, phase: r.status === 'acked' ? 'confirm' : 'ack', deadline: r.deadline_at.getTime(), ackRc: r.ack_rc ?? {},
    });
  }
  if (rows.length) console.log(`[cmd] recovered ${rows.length} in-flight commands`);
}

// ---------------- main ----------------

// Single active worker: block here until the lock is ours (a second instance is a hot standby).
const lockConn = await sql.reserve();
const got = await lockConn<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('cl-command-worker')) AS ok`;
if (!got[0]?.ok) {
  console.log('[cmd] another command-worker is active, waiting as standby');
  await lockConn`SELECT pg_advisory_lock(hashtext('cl-command-worker'))`;
}
console.log('[cmd] active');
await recover();

const mq = mqtt.connect(MQTT_URL, {
  clientId: `cl-cmd-${process.pid}`,
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  keepalive: 30,
  reconnectPeriod: 2000,
  clean: true,
});
mq.on('connect', () => {
  // not shared: this worker must see every ack and the telemetry of the cabinets it waits on
  mq.subscribe([TOPICS.echo, TOPICS.telemetry], { qos: 0 }, (err, granted) => {
    if (err) console.error('[cmd] subscribe failed', err.message);
    const denied = granted?.filter((g) => g.qos === 128) ?? [];
    if (denied.length) console.error(`[cmd] broker denied ${denied.map((g) => g.topic).join(', ')} — check MQTT_USERNAME vs infra/emqx/acl.conf`);
    else console.log(`[cmd] connected to ${MQTT_URL}`);
  });
});
mq.on('error', (e) => console.error('[cmd] mqtt', e.message));

// One handler at a time so in-flight state changes stay ordered.
let chain = Promise.resolve();
const run = (fn: () => Promise<unknown>) => {
  chain = chain.then(fn).then(() => undefined).catch((e) => console.error('[cmd]', (e as Error).message));
};

mq.on('message', (topic, buf) => {
  const payload = buf.toString();
  if (topic === TOPICS.echo) run(() => onAck(payload));
  else if (topic === TOPICS.telemetry && inflight.size) run(() => onTelemetry(payload));
});

await sql.listen(COMMANDS_NOTIFY, () => run(dispatch));
setInterval(() => run(async () => {
  await checkDeadlines();
  await dispatch();
}), TICK_MS);
setInterval(() => {
  console.log(`[cmd] in flight ${inflight.size} · ${JSON.stringify(stats)}`);
  void redis.set('cl:cmd:stats', JSON.stringify({ ...stats, inflight: inflight.size, at: Date.now() })).catch(() => undefined);
}, 30_000);

async function shutdown() {
  await chain;
  await mq.endAsync();
  lockConn.release();
  await sql.end({ timeout: 5 });
  redis.disconnect();
  process.exit(0);
}
process.on('unhandledRejection', (e) => console.error('[cmd] unhandled', (e as Error)?.message ?? e));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
