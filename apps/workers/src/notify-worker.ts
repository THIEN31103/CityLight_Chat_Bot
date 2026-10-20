// Notify worker (spec 8, M5): alarm events from Redis -> users' channels (Telegram now; Zalo OA and
// e-mail are classes waiting for an approved OA / an SMTP server).
//  - recipients: enabled subscription, severity >= the user's minimum, active user, cabinet in the
//    user's area scope (same rule as the web)
//  - raised alarms of every severity; cleared alarms only for critical / major
//  - per-user batching: the first alarm waits GATHER_MS (catches a burst), later ones are grouped
//    every BATCH_MS; more than SUMMARY_OVER alarms in one message -> a summary by type and area
//  - Telegram linking: the web gives a one-time code, the user sends "/start <code>" to the bot;
//    this worker long-polls getUpdates (no public URL / webhook needed) and stores the chat id
//  - one active instance (Postgres advisory lock): Telegram allows a single getUpdates poller
import { Redis } from 'ioredis';
import { createSql } from '@citylight/db';
import { EVENTS_CHANNEL } from '@citylight/db/commands';
import { NOTIFY_CHANGED_CHANNEL, TG_BOT_KEY, TG_LINK_PREFIX } from '@citylight/db/notify';
import { DEFAULT_LANG, SECURITY_SELF_KINDS, isLang, roleSeesAll, type AlarmSeverity, type GeoPoint, type Lang, type RoleKey, type SecurityEvent } from '@citylight/shared';
import {
  botText, botTextBoth, formatBatch, formatIncident, formatLinked, formatSecurity, type AlarmEvent, type IncidentEvent, type Item,
} from './notify-format';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TG_API = (process.env.TELEGRAM_API_URL ?? 'https://api.telegram.org').replace(/\/$/, '');
const GATHER_MS = Number(process.env.NOTIFY_GATHER_MS ?? 3000);
const BATCH_MS = Number(process.env.NOTIFY_BATCH_MS ?? 30_000);
const SUMMARY_OVER = Number(process.env.NOTIFY_SUMMARY_OVER ?? 5);
const WEB_URL = process.env.WEB_URL ?? '';
const LOCK = `cl-notify-worker${process.env.NOTIFY_INSTANCE ? `-${process.env.NOTIFY_INSTANCE}` : ''}`;
const REFRESH_MS = 60_000;

const sql = createSql(process.env.DATABASE_URL, 4);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 2 });

const RANK: Record<AlarmSeverity, number> = { minor: 1, major: 2, critical: 3 };
const stats = { events: 0, queued: 0, messages: 0, failed: 0, linked: 0 };

// ---------------- channels ----------------

export interface NotificationChannel {
  readonly name: 'telegram' | 'zalo' | 'email';
  /** throws ChannelGone when the address can never receive again (user blocked the bot…) */
  send(address: string, text: string): Promise<void>;
}

class ChannelGone extends Error {}

class TelegramChannel implements NotificationChannel {
  readonly name = 'telegram' as const;
  async call<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const res = await fetch(`${TG_API}/bot${TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    if (res.status === 403) throw new ChannelGone(j.description ?? 'forbidden');
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, (j.parameters?.retry_after ?? 3) * 1000));
      throw new Error('rate limited');
    }
    if (!j.ok) throw new Error(`${method}: ${res.status} ${j.description ?? ''}`);
    return j.result as T;
  }
  async send(chatId: string, text: string) {
    await this.call('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
  }
}

const telegram = TOKEN ? new TelegramChannel() : null;
const channels: Partial<Record<string, NotificationChannel>> = telegram ? { telegram } : {};

// ---------------- recipients ----------------

interface Sub { userId: string; email: string; role: string; lang: Lang; channel: string; address: string; min: AlarmSeverity; all: boolean; areas: Set<string> }
let subs: Sub[] = [];
let cabinetAreas = new Map<string, { district: string | null; ward: string | null; districtName: string | null; location: GeoPoint }>();

async function refresh() {
  const rows = await sql<{ user_id: string; email: string; channel: string; address: string; min_severity: AlarmSeverity; scope_all: boolean; role: string; lang: string }[]>`
    SELECT s.user_id, u.email, s.channel, s.address, s.min_severity, u.scope_all, u.role, u.lang
    FROM notification_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.enabled AND u.active`;
  const areas = await sql<{ user_id: string; id: string }[]>`
    WITH RECURSIVE t AS (
      SELECT s.user_id, a.id FROM user_scopes s JOIN areas a ON a.id = s.area_id
      UNION SELECT t.user_id, a.id FROM areas a JOIN t ON a.parent_id = t.id
    ) SELECT user_id, id FROM t`;
  const byUser = new Map<string, Set<string>>();
  for (const a of areas) (byUser.get(a.user_id) ?? byUser.set(a.user_id, new Set()).get(a.user_id)!).add(a.id);
  subs = rows.map((r) => ({
    userId: r.user_id, email: r.email, role: r.role, lang: isLang(r.lang) ? r.lang : DEFAULT_LANG, channel: r.channel, address: r.address, min: r.min_severity,
    all: roleSeesAll(r.role as RoleKey) || r.scope_all, areas: byUser.get(r.user_id) ?? new Set(),
  }));
  const cabs = await sql<{ id: string; district_id: string | null; ward_id: string | null; district: string | null; lat: number; lng: number }[]>`
    SELECT c.id, c.district_id, c.ward_id, d.name AS district, ST_Y(c.location) AS lat, ST_X(c.location) AS lng
    FROM cabinets c LEFT JOIN areas d ON d.id = c.district_id WHERE c.active`;
  cabinetAreas = new Map(cabs.map((c) => [c.id, { district: c.district_id, ward: c.ward_id, districtName: c.district, location: { lat: c.lat, lng: c.lng } }]));
}

function recipients(a: AlarmEvent): Sub[] {
  const where = cabinetAreas.get(a.cabinetId);
  return subs.filter((s) => {
    if (RANK[a.severity] < RANK[s.min] || !channels[s.channel]) return false;
    if (s.all) return true;
    return !!where && ((!!where.district && s.areas.has(where.district)) || (!!where.ward && s.areas.has(where.ward)));
  });
}

// ---------------- batching ----------------

interface Box { sub: Sub; items: Item[]; timer: NodeJS.Timeout | null; lastSent: number }
const boxes = new Map<string, Box>(); // key: user + channel

function enqueue(sub: Sub, item: Item) {
  const key = `${sub.userId}:${sub.channel}`;
  const box = boxes.get(key) ?? { sub, items: [], timer: null, lastSent: 0 };
  box.sub = sub;
  box.items.push(item);
  boxes.set(key, box);
  stats.queued++;
  if (!box.timer) {
    const wait = Math.max(GATHER_MS, box.lastSent + BATCH_MS - Date.now());
    box.timer = setTimeout(() => void flush(key), wait);
  }
}

async function flush(key: string) {
  const box = boxes.get(key);
  if (!box) return;
  box.timer = null;
  const items = box.items.splice(0, box.items.length);
  if (!items.length) return;
  const ch = channels[box.sub.channel];
  if (!ch) return;
  const text = formatBatch(
    items, (id) => cabinetAreas.get(id)?.districtName ?? null, SUMMARY_OVER, WEB_URL, (id) => cabinetAreas.get(id)?.location ?? null, box.sub.lang,
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ch.send(box.sub.address, text);
      box.lastSent = Date.now();
      stats.messages++;
      return;
    } catch (e) {
      if (e instanceof ChannelGone) {
        // the user blocked the bot / deleted the chat: stop sending until they link again
        await sql`UPDATE notification_subscriptions SET enabled = false WHERE user_id = ${box.sub.userId} AND channel = ${box.sub.channel}`;
        subs = subs.filter((s) => !(s.userId === box.sub.userId && s.channel === box.sub.channel));
        console.warn(`[notify] ${box.sub.email} ${box.sub.channel}: ${(e as Error).message}, subscription disabled`);
        return;
      }
      if (attempt === 3) {
        stats.failed++;
        console.error(`[notify] send to ${box.sub.email} failed: ${(e as Error).message}`);
      } else await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// ---------------- incidents (M7): straight to the assignee, not batched, any severity ----------------

async function notifyAssignee(kind: 'assigned' | 'overdue', i: IncidentEvent) {
  // the incident's own point (where the fault is), for the technician's route
  const at = await sql<{ lat: number; lng: number }[]>`SELECT ST_Y(location) AS lat, ST_X(location) AS lng FROM incidents WHERE id = ${i.id}`.catch(() => []);
  for (const s of subs.filter((x) => x.userId === i.assigneeId)) {
    const ch = channels[s.channel];
    if (!ch) continue;
    try {
      await ch.send(s.address, formatIncident(kind, i, at[0], WEB_URL, s.lang));
      stats.messages++;
    } catch (e) {
      stats.failed++;
      console.error(`[notify] incident ${i.code} -> ${s.email}: ${(e as Error).message}`);
    }
  }
}

// ---------------- security alerts (A6): provider + manager + the account owner for sign-in events, not batched, any severity ----------------

async function notifySecurity(e: SecurityEvent) {
  const self = SECURITY_SELF_KINDS.includes(e.kind);
  const seen = new Set<string>();
  for (const s of subs) {
    const ch = channels[s.channel];
    // provider + the customer's manager (S47), and the account owner for sign-in events
    if (!ch || !(roleSeesAll(s.role as RoleKey) || (self && s.userId === e.userId))) continue;
    const key = `${s.userId}:${s.channel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await ch.send(s.address, formatSecurity(e, WEB_URL, s.lang));
      stats.messages++;
    } catch (err) {
      stats.failed++;
      console.error(`[notify] security ${e.kind} -> ${s.email}: ${(err as Error).message}`);
    }
  }
}

function onEvent(raw: string) {
  let ev: { type: string; alarm?: AlarmEvent; incident?: IncidentEvent; security?: SecurityEvent };
  try {
    ev = JSON.parse(raw);
  } catch {
    return;
  }
  if (ev.type === 'security' && ev.security) {
    stats.events++;
    void notifySecurity(ev.security);
    return;
  }
  if (ev.incident && (ev.type === 'incident.assigned' || ev.type === 'incident.overdue')) {
    stats.events++;
    void notifyAssignee(ev.type === 'incident.assigned' ? 'assigned' : 'overdue', ev.incident);
    return;
  }
  if (!ev.alarm || (ev.type !== 'alarm.raised' && ev.type !== 'alarm.cleared')) return;
  const kind = ev.type === 'alarm.raised' ? 'raised' : 'cleared';
  // "back to normal" is worth a message only for alarms someone had to act on
  if (kind === 'cleared' && RANK[ev.alarm.severity] < RANK.major) return;
  stats.events++;
  for (const s of recipients(ev.alarm)) enqueue(s, { kind, a: ev.alarm });
}

// ---------------- Telegram linking (getUpdates long poll) ----------------

interface Update { update_id: number; message?: { chat: { id: number }; text?: string; from?: { username?: string } } }

async function pollTelegram(tg: TelegramChannel) {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg.call<Update[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35_000);
      for (const u of updates) {
        offset = u.update_id + 1;
        const chat = u.message?.chat.id;
        const text = u.message?.text?.trim() ?? '';
        if (!chat) continue;
        const start = /^\/start(?:@\w+)?\s+(\S+)$/.exec(text);
        if (start) {
          const userId = await redis.getdel(`${TG_LINK_PREFIX}${start[1]}`);
          if (!userId) {
            await tg.send(String(chat), botTextBoth('badLink')); // the chat's user is not known
            continue;
          }
          const u2 = await sql<{ email: string; lang: string }[]>`
            WITH s AS (
              INSERT INTO notification_subscriptions (user_id, channel, address, min_severity, enabled)
              VALUES (${userId}, 'telegram', ${String(chat)}, 'major', true)
              ON CONFLICT (user_id, channel) DO UPDATE SET address = excluded.address, enabled = true RETURNING user_id
            ) SELECT u.email, u.lang FROM users u JOIN s ON s.user_id = u.id`;
          stats.linked++;
          await refresh();
          const lang = u2[0]?.lang;
          await tg.send(String(chat), formatLinked(u2[0]?.email ?? '', isLang(lang) ? lang : DEFAULT_LANG));
        } else if (/^\/stop/.test(text)) {
          const off = await sql<{ lang: string }[]>`
            WITH s AS (UPDATE notification_subscriptions SET enabled = false WHERE channel = 'telegram' AND address = ${String(chat)} RETURNING user_id)
            SELECT u.lang FROM users u JOIN s ON s.user_id = u.id`;
          await refresh();
          // one user on this chat: their language; none or several: both
          const langs = [...new Set(off.map((r) => r.lang))];
          const lang = langs.length === 1 ? langs[0] : undefined;
          await tg.send(String(chat), isLang(lang) ? botText('stopped', lang) : botTextBoth('stopped'));
        } else if (text.startsWith('/start')) {
          await tg.send(String(chat), botTextBoth('howTo'));
        }
      }
    } catch (e) {
      console.error('[notify] getUpdates', (e as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---------------- main ----------------

async function main() {
  const lockConn = await sql.reserve();
  const got = await lockConn<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${LOCK})) AS ok`;
  if (!got[0]?.ok) {
    console.log('[notify] another notify-worker is active, waiting as standby');
    await lockConn`SELECT pg_advisory_lock(hashtext(${LOCK}))`;
  }
  await refresh();
  setInterval(() => void refresh().catch((e) => console.error('[notify] refresh', (e as Error).message)), REFRESH_MS);

  if (telegram) {
    try {
      const me = await telegram.call<{ username: string }>('getMe');
      const announce = () => redis.set(TG_BOT_KEY, JSON.stringify({ username: me.username }), 'EX', 120).catch(() => undefined);
      await announce();
      setInterval(() => void announce(), 60_000); // expires if this worker stops: the web hides "Liên kết"
      console.log(`[notify] Telegram bot @${me.username}`);
      void pollTelegram(telegram);
    } catch (e) {
      console.error(`[notify] Telegram disabled: getMe failed (${(e as Error).message}), check TELEGRAM_BOT_TOKEN`);
      delete channels.telegram;
    }
  } else console.log('[notify] TELEGRAM_BOT_TOKEN not set: no channel, events are dropped');

  const sub = redis.duplicate();
  await sub.subscribe(EVENTS_CHANNEL, NOTIFY_CHANGED_CHANNEL);
  sub.on('message', (ch, msg) => {
    // settings saved in the web: reload recipients now, not at the next 60 s refresh
    if (ch === NOTIFY_CHANGED_CHANNEL) void refresh().catch((e) => console.error('[notify] refresh', (e as Error).message));
    else onEvent(msg);
  });
  console.log(`[notify] active (gather ${GATHER_MS} ms, batch ${BATCH_MS} ms, summary over ${SUMMARY_OVER})`);
  setInterval(() => {
    void redis.set('cl:notify:stats', JSON.stringify({ ...stats, subscriptions: subs.length, at: Date.now() })).catch(() => undefined);
  }, 30_000);

  const shutdown = async () => {
    for (const key of boxes.keys()) await flush(key);
    lockConn.release();
    await sql.end({ timeout: 5 });
    redis.disconnect();
    sub.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

process.on('unhandledRejection', (e) => console.error('[notify] unhandled', (e as Error)?.message ?? e));
await main();
