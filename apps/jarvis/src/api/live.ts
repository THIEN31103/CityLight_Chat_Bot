// Live events from CityLight (spec 7 and 11): the server's socket.io gateway (apps/api/src/realtime.ts) sends
// alarm.raised / alarm.cleared / command.updated / batch.progress / cabinet.state to signed-in users, only for the
// cabinets of their areas, with the same session cookie as REST. Spoken here over Node's built-in WebSocket
// (Engine.IO 4 / Socket.IO 5, text packets only), so Jarvis needs no new library.
// The feed only says "look now": what is said and what a command ended as are still read over REST. A feed that
// drops reconnects with a growing wait; nothing missed is replayed (the next REST look catches up, spec 7).

export interface WsLike {
  send(data: string): void;
  close(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
}
export type WsFactory = (url: string, headers: Record<string, string>) => WsLike;

/** Node's WebSocket (undici) takes request headers as a non-standard option: the cookie goes there */
export const nodeWs: WsFactory = (url, headers) => new (WebSocket as unknown as new (u: string, o: unknown) => WsLike)(url, { headers });

export const RETRY_MIN_MS = 2_000;
export const RETRY_MAX_MS = 60_000;

const timer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
};

export class LiveFeed {
  private ws: WsLike | null = null;
  private stopped = false;
  private retry = RETRY_MIN_MS;
  private again: ReturnType<typeof setTimeout> | null = null;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  /** ping interval + ping timeout from the handshake: no ping for that long = the line is dead */
  private aliveMs = 45_000;
  private readonly waiters = new Map<string, Set<() => void>>();
  /** connected to the namespace: events arrive */
  up = false;

  constructor(private readonly o: {
    apiBase: string;
    /** the CityLight session cookie header ('' when signed out: no connection) */
    cookie: () => string;
    onEvent: (name: string, data: unknown) => void;
    onUp?: (up: boolean) => void;
    ws?: WsFactory;
  }) {}

  static urlOf(apiBase: string): string {
    const u = new URL(apiBase);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/socket.io/';
    u.search = '?EIO=4&transport=websocket';
    return u.toString();
  }

  start() {
    if (this.ws || this.stopped) return;
    this.again = null;
    const cookie = this.o.cookie();
    if (!cookie) return this.later();
    let ws: WsLike;
    try {
      ws = (this.o.ws ?? nodeWs)(LiveFeed.urlOf(this.o.apiBase), { cookie });
    } catch {
      return this.later();
    }
    this.ws = ws;
    ws.onmessage = (e) => {
      if (this.ws === ws) this.packet(String(e.data));
    };
    ws.onclose = () => {
      if (this.ws === ws) this.dropped();
    };
    ws.onerror = () => undefined; // a close follows
  }

  /** for good: signed out or the console session ended */
  stop() {
    this.stopped = true;
    if (this.again) clearTimeout(this.again);
    this.cut();
    for (const set of this.waiters.values()) for (const f of set) f();
    this.waiters.clear();
  }

  /**
   * Waits up to ms, less when an event about this command / batch id comes first. Used between the REST reads that
   * follow a sent command.
   */
  waitFor(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      const done = () => {
        clearTimeout(t);
        set.delete(done);
        if (!set.size) this.waiters.delete(id);
        resolve();
      };
      const t = timer(done, ms);
      set.add(done);
      this.waiters.set(id, set);
    });
  }

  private packet(p: string) {
    switch (p[0]) {
      case '0': {
        // open: {"sid", "pingInterval", "pingTimeout", ...}; then join the default namespace
        try {
          const h = JSON.parse(p.slice(1)) as { pingInterval?: number; pingTimeout?: number };
          this.aliveMs = (h.pingInterval ?? 25_000) + (h.pingTimeout ?? 20_000);
        } catch {
          // keep the default
        }
        this.watch();
        this.ws?.send('40');
        return;
      }
      case '2': // ping from the server
        this.ws?.send('3');
        this.watch();
        return;
      case '1': // the server closes
        return this.dropped();
      case '4':
        return this.message(p.slice(1));
    }
  }

  private message(m: string) {
    if (m[0] === '0') {
      this.up = true;
      this.retry = RETRY_MIN_MS;
      this.o.onUp?.(true);
      return;
    }
    // 4 = connect refused, 1 = disconnected by the server
    if (m[0] === '4' || m[0] === '1') return this.dropped();
    if (m[0] !== '2') return;
    let ev: unknown;
    try {
      ev = JSON.parse(m.slice(m.indexOf('[')));
    } catch {
      return;
    }
    if (!Array.isArray(ev) || typeof ev[0] !== 'string') return;
    const [name, data] = ev as [string, unknown];
    // the gateway says "error" { code: 'unauthenticated' } and then closes
    if (name === 'error') return this.dropped();
    this.o.onEvent(name, data);
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id === 'string') for (const f of [...(this.waiters.get(id) ?? [])]) f();
  }

  /** no ping for too long: the line is dead even if no close came */
  private watch() {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = timer(() => this.dropped(), this.aliveMs);
  }

  private cut() {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    if (this.up) {
      this.up = false;
      this.o.onUp?.(false);
    }
  }

  private dropped() {
    this.cut();
    this.later();
  }

  private later() {
    if (this.stopped || this.again) return;
    this.again = timer(() => this.start(), this.retry);
    this.retry = Math.min(this.retry * 2, RETRY_MAX_MS);
  }
}
