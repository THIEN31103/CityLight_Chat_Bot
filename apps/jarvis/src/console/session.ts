// One browser = one console session = one CityLight session (spec 10). The CityLight cookies stay inside the
// ApiClient (memory only); the browser only holds jv_sid (HttpOnly, SameSite=Strict) and a CSRF value.
import { randomBytes } from 'node:crypto';
import type { User } from '@citylight/shared';
import { ApiClient } from '../api/client';
import { CityLightReads } from '../api/read';
import { ShiftContext } from '../brain/context';

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

  constructor(apiBase: string, timeoutMs: number, fetchImpl?: typeof fetch) {
    this.api = new ApiClient({ baseUrl: apiBase, timeoutMs, fetch: fetchImpl });
    this.reads = new CityLightReads(this.api);
  }

  newConversation() {
    this.busy?.abort();
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
