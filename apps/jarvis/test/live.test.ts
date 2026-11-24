// The live feed (spec 7 / 11): socket.io over the built-in WebSocket, with a fake socket. Then end to end on the
// console: sign in opens the feed with the CityLight cookie, an alarm event tells the console's GET /api/live stream
// to look now, signing out closes both.
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LiveFeed, RETRY_MIN_MS, type WsLike } from '../src/api/live';
import { AuditLog } from '../src/audit/log';
import { FakeLlm } from '../src/brain/providers/fake';
import { loadConfig } from '../src/config';
import { createConsoleServer } from '../src/console/server';
import { openDb } from '../src/store/db';
import { startStubApi, type StubApi } from './stub-api';

class FakeWs implements WsLike {
  sent: string[] = [];
  closed = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  /** a packet from the server */
  push(p: string) {
    this.onmessage?.({ data: p });
  }
  /** the server opens, the client joins, the server accepts */
  connect() {
    this.push('0{"sid":"e1","pingInterval":25000,"pingTimeout":20000}');
    this.push('40{"sid":"s1"}');
  }
}

function feed(cookie = 'cl_sid=abc') {
  const sockets: FakeWs[] = [];
  const events: [string, unknown][] = [];
  const ups: boolean[] = [];
  const f = new LiveFeed({
    apiBase: 'http://localhost:3000/api/v1', cookie: () => cookie,
    onEvent: (n, d) => events.push([n, d]), onUp: (u) => ups.push(u),
    ws: (url, headers) => {
      const w = new FakeWs(url, headers);
      sockets.push(w);
      return w;
    },
  });
  return { f, sockets, events, ups };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveFeed: socket.io over WebSocket', () => {
  it('the address: the API host, /socket.io, Engine.IO 4 over WebSocket', () => {
    expect(LiveFeed.urlOf('http://localhost:3000/api/v1')).toBe('ws://localhost:3000/socket.io/?EIO=4&transport=websocket');
    expect(LiveFeed.urlOf('https://citylight.example.vn/api/v1/')).toBe('wss://citylight.example.vn/socket.io/?EIO=4&transport=websocket');
  });

  it('connects with the session cookie, joins the namespace, answers pings, passes events on', () => {
    const { f, sockets, events, ups } = feed();
    f.start();
    const ws = sockets[0]!;
    expect(ws.headers).toEqual({ cookie: 'cl_sid=abc' });
    ws.push('0{"sid":"e1","pingInterval":25000,"pingTimeout":20000}');
    expect(ws.sent).toEqual(['40']);
    expect(f.up).toBe(false);
    ws.push('40{"sid":"s1"}');
    expect(f.up).toBe(true);
    expect(ups).toEqual([true]);
    ws.push('2');
    expect(ws.sent).toEqual(['40', '3']);
    ws.push('42["alarm.raised",{"id":"a1","code":"E204"}]');
    ws.push('42["cabinet.state",{"cabinetId":"c1"}]');
    ws.push('42not json');
    expect(events).toEqual([['alarm.raised', { id: 'a1', code: 'E204' }], ['cabinet.state', { cabinetId: 'c1' }]]);
    f.stop();
    expect(ws.closed).toBe(true);
    expect(ups).toEqual([true, false]);
  });

  it('signed out (no cookie): no connection, tries again later', () => {
    vi.useFakeTimers();
    const { f, sockets } = feed('');
    f.start();
    vi.advanceTimersByTime(RETRY_MIN_MS * 4);
    expect(sockets).toHaveLength(0);
    f.stop();
  });

  it('a closed line, a refused join or "unauthenticated": reconnects after 2 s, then 4 s, …', () => {
    vi.useFakeTimers();
    const { f, sockets, ups } = feed();
    f.start();
    sockets[0]!.connect();
    sockets[0]!.onclose?.();
    expect(f.up).toBe(false);
    expect(ups).toEqual([true, false]);
    vi.advanceTimersByTime(RETRY_MIN_MS - 1);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.push('0{}');
    sockets[1]!.push('44{"message":"refused"}');
    expect(sockets[1]!.closed).toBe(true);
    vi.advanceTimersByTime(RETRY_MIN_MS * 2);
    expect(sockets).toHaveLength(3);
    sockets[2]!.push('42["error",{"code":"unauthenticated"}]');
    expect(sockets[2]!.closed).toBe(true);
    // a join that works starts the waits from 2 s again
    vi.advanceTimersByTime(RETRY_MIN_MS * 4);
    sockets[3]!.connect();
    sockets[3]!.onclose?.();
    vi.advanceTimersByTime(RETRY_MIN_MS);
    expect(sockets).toHaveLength(5);
    f.stop();
  });

  it('no ping for pingInterval + pingTimeout: the line is dead, reconnect', () => {
    vi.useFakeTimers();
    const { f, sockets } = feed();
    f.start();
    sockets[0]!.connect();
    vi.advanceTimersByTime(44_000);
    sockets[0]!.push('2');
    vi.advanceTimersByTime(44_000);
    expect(f.up).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(f.up).toBe(false);
    expect(sockets[0]!.closed).toBe(true);
    vi.advanceTimersByTime(RETRY_MIN_MS);
    expect(sockets).toHaveLength(2);
    f.stop();
  });

  it('waitFor ends early on an event about that id, else at the time; stop ends every wait and reconnects nothing', async () => {
    const { f, sockets } = feed();
    f.start();
    sockets[0]!.connect();
    const t0 = Date.now();
    const early = f.waitFor('cmd-1', 5_000);
    sockets[0]!.push('42["command.updated",{"id":"cmd-1","status":"confirmed"}]');
    await early;
    expect(Date.now() - t0).toBeLessThan(1_000);
    const t1 = Date.now();
    await f.waitFor('cmd-2', 50);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(45);
    const hanging = f.waitFor('cmd-3', 60_000);
    f.stop();
    await hanging;
    sockets[0]!.onclose?.();
    expect(sockets).toHaveLength(1);
  });
});

describe('the console with the live feed', () => {
  let stub: StubApi;
  let base: string;
  let close: () => void;
  const sockets: FakeWs[] = [];

  beforeAll(async () => {
    stub = await startStubApi([{ id: 'adm', email: 'admin@demo.vn', password: 'mat-khau-admin-1', role: 'admin', totp: '111111' }]);
    const cfg = loadConfig({ CITYLIGHT_API_BASE: stub.base, LLM_PROVIDER: 'fake', JARVIS_DAILY_TOKEN_CAP_MAX: '0' });
    const { server } = createConsoleServer({
      cfg, db: openDb(':memory:'), llm: new FakeLlm(), audit: new AuditLog(mkdtempSync(path.join(tmpdir(), 'jv-live-'))), voice: null,
      liveWs: (url, headers) => {
        const w = new FakeWs(url, headers);
        sockets.push(w);
        return w;
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(async () => {
    close();
    await stub.close();
  });

  it('sign in opens the feed as the user; an alarm event says "look" on /api/live; signing out ends both', async () => {
    let cookie = '';
    let csrf = '';
    const call = async (method: string, p: string, body?: unknown) => {
      const headers: Record<string, string> = { cookie };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (method !== 'GET') headers['x-jarvis-csrf'] = csrf;
      const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.getSetCookie().find((c) => c.startsWith('jv_sid='));
      if (set) cookie = set.split(';')[0]!;
      const data = (await res.json().catch(() => null)) as { csrf?: string } | null;
      if (data?.csrf) csrf = data.csrf;
      return { status: res.status, data };
    };
    await call('GET', '/api/session');
    expect((await call('GET', '/api/live')).status).toBe(401);
    await call('POST', '/api/login', { email: 'admin@demo.vn', password: 'mat-khau-admin-1' });
    await call('POST', '/api/2fa', { code: '111111' });
    expect(sockets).toHaveLength(1);
    const ws = sockets[0]!;
    expect(ws.url).toBe(LiveFeed.urlOf(stub.base));
    expect(ws.headers.cookie).toMatch(/(^|; )cl_sid=/);
    ws.connect();

    const ac = new AbortController();
    const res = await fetch(`${base}/api/live`, { headers: { cookie }, signal: ac.signal });
    expect(res.headers.get('content-type')).toMatch(/event-stream/);
    const reader = res.body!.getReader();
    let got = '';
    const until = async (re: RegExp) => {
      while (!re.test(got)) {
        const { value, done } = await reader.read();
        if (done) return false;
        got += new TextDecoder().decode(value);
      }
      return true;
    };
    expect(await until(/event: live/)).toBe(true);
    ws.push('42["cabinet.state",{"cabinetId":"c1"}]');
    ws.push('42["alarm.raised",{"id":"a9","cabinetId":"c1"}]');
    expect(await until(/event: look/)).toBe(true);
    expect(got).not.toMatch(/cabinet/);

    await call('POST', '/api/logout', {});
    expect(await until(/$^/)).toBe(false);
    expect(ws.closed).toBe(true);
    ac.abort();
  });
});

describe('following a command with the live feed', () => {
  it('each wait between reads goes through the feed, keyed by the command id', async () => {
    const { sendAndFollow } = await import('../src/guard/pending');
    const reads = ['acked', 'confirmed'];
    const api = {
      post: async () => ({ id: 'cmd-7', status: 'sent' }),
      get: async () => ({ id: 'cmd-7', status: reads.shift() }),
    } as unknown as Parameters<typeof sendAndFollow>[0];
    const waits: [string, number][] = [];
    const p = { id: 'jv-1', command: { type: 'ON', params: {} }, cabinet: { id: 'c1', code: 'DM0001', name: 'x' }, summary: 's', tier: 'T1', createdAt: 0, expiresAt: 1 } as unknown as Parameters<typeof sendAndFollow>[1];
    const out = await sendAndFollow(api, p, { pollMs: 6_000, wait: async (id, ms) => void waits.push([id, ms]) });
    expect(out.status).toBe('confirmed');
    expect(waits).toEqual([['cmd-7', 6_000], ['cmd-7', 6_000]]);
  });
});
