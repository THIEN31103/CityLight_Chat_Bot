// One browser = one console session = one CityLight session (spec 10). The CityLight cookies stay inside the
// ApiClient (memory only); the browser only holds jv_sid (HttpOnly, SameSite=Strict) and a CSRF value.
import { randomBytes } from 'node:crypto';
import type { User } from '@citylight/shared';
import { ApiClient } from '../api/client';
import { CityLightReads } from '../api/read';
import { ShiftContext } from '../brain/context';
import { PendingSlot } from '../guard/pending';
import type { Finding } from '../guard/finder';

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

  constructor(apiBase: string, timeoutMs: number, fetchImpl?: typeof fetch) {
    this.api = new ApiClient({ baseUrl: apiBase, timeoutMs, fetch: fetchImpl });
    this.reads = new CityLightReads(this.api);
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
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMin) {
      this.hits.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(userId, recent);
    return true;
  }
}
