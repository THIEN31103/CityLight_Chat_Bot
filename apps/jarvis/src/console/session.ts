// One browser = one console session = one CityLight session (spec 10). The CityLight cookies stay inside the
// ApiClient (memory only); the browser only holds jv_sid (HttpOnly, SameSite=Strict) and a CSRF value.
import { randomBytes } from 'node:crypto';
import type { User } from '@citylight/shared';
import { ApiClient } from '../api/client';
import { CityLightReads } from '../api/read';
import { ShiftContext } from '../brain/context';
import { PendingSlot } from '../guard/pending';
import type { Finding } from '../guard/finder';
import { NoticeState } from './notices';
import type { LiveFeed } from '../api/live';
import { LateResults } from './late';

export const SESSION_IDLE_MS = 12 * 3_600_000;

export class ConsoleSession {
  readonly id = randomBytes(24).toString('base64url');
  readonly csrf = randomBytes(24).toString('base64url');
  readonly api: ApiClient;
  readonly reads: CityLightReads;
  user: User | null = null;
  pending2fa = false;
  readonly ctx = new ShiftContext();
  conversationId: string | null = null;
  busy: AbortController | null = null;
  lastSeen = Date.now();
  /** the action waiting for confirmation (milestone 4): one at a time */
  readonly pending = new PendingSlot();
  /** the user's last question or click: an action proposed after 10 minutes without one needs the button (T2) */
  lastInteraction = Date.now();
  /** Jarvis asked "tủ nào?" or read numbered cabinets for this order: the reply completes it (2026-11-21) */
  finding: Finding | null = null;
  /** where the allowed cabinets are, by area, for the system prompt (read at most once a minute) */
  allowedByArea: { at: number; text: string | null } | null = null;
  /** real area and street names the user can see, to fix misheard ones in voice turns (read at most every 5 minutes) */
  places: { at: number; names: string[]; districts: string[] } | null = null;
  /** what Jarvis already said on its own, the P0 repeats and the 15-minute mute (spec 7, 2026-11-23/24) */
  readonly notices = new NoticeState();
  /** the server's live events for this user (api/live.ts), while signed in */
  live: LiveFeed | null = null;
  /** this session's commands still without a result when Jarvis stopped following them (late.ts) */
  readonly late = new LateResults();
  /** the console's open GET /api/live streams: told "look now" when an alarm starts or ends */
  readonly listeners = new Set<(event: string) => void>();

  constructor(apiBase: string, timeoutMs: number, fetchImpl?: typeof fetch) {
    this.api = new ApiClient({ baseUrl: apiBase, timeoutMs, fetch: fetchImpl });
    this.reads = new CityLightReads(this.api);
  }

  /** signed out or gone: no more live events, the console's streams end */
  endLive() {
    this.live?.stop();
    this.live = null;
    for (const l of [...this.listeners]) l('end');
    this.listeners.clear();
  }

  newConversation() {
    this.busy?.abort();
    this.pending.clear();
    this.finding = null;
    this.ctx.reset();
    this.conversationId = null;
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, ConsoleSession>();

  constructor(private readonly make: () => ConsoleSession) {}

  get(id: string | undefined): ConsoleSession | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (Date.now() - s.lastSeen > SESSION_IDLE_MS) {
      this.drop(s);
      return null;
    }
    s.lastSeen = Date.now();
    return s;
  }

  create(): ConsoleSession {
    const s = this.make();
    this.sessions.set(s.id, s);
    return s;
  }

  drop(s: ConsoleSession) {
    s.busy?.abort();
    s.endLive();
    this.sessions.delete(s.id);
    void s.api.logout().catch(() => undefined);
  }

  all() {
    return [...this.sessions.values()];
  }
}

/** Sliding one-minute window per user (settings.perUserPerMin). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  allow(userId: string, perMin: number, now = Date.now()): boolean {
    return this.allowAll([{ key: userId, max: perMin }], now) === null;
  }

  /**
   * Several windows at once (2026-11-23: one user per minute, one user per day, the whole system per minute, speech
   * per minute): every one must have room, and the hit is counted in all of them only then. Returns null when allowed,
   * else the first full window with how long until it has room. max 0 = no limit.
   */
  allowAll(limits: { key: string; max: number; windowMs?: number }[], now = Date.now()): { key: string; waitMs: number } | null {
    const live = limits.filter((l) => l.max > 0);
    for (const l of live) {
      const w = l.windowMs ?? 60_000;
      const recent = (this.hits.get(l.key) ?? []).filter((t) => now - t < w);
      this.hits.set(l.key, recent);
      if (recent.length >= l.max) return { key: l.key, waitMs: Math.max(1000, w - (now - recent[0]!)) };
    }
    for (const l of live) this.hits.get(l.key)!.push(now);
    return null;
  }
}
