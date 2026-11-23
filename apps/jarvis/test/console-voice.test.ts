// /api/voice end to end with a fake speech engine: PCM in -> transcript -> routed tool -> spoken sentences out.
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit/log';
import { FakeLlm } from '../src/brain/providers/fake';
import { loadConfig } from '../src/config';
import { createConsoleServer } from '../src/console/server';
import { openDb } from '../src/store/db';
import type { SttProvider, TtsProvider } from '../src/voice/client';
import { startStubApi, type StubApi } from './stub-api';

let stub: StubApi;
let base: string;
let close: () => void;
const heard: { text: string } = { text: '' };
const spoken: string[] = [];
const voice: SttProvider & TtsProvider = {
  transcribe: async (pcm) => ({ text: heard.text, ms: 50, audioMs: pcm.length / 32 }),
  synth: async (text) => {
    spoken.push(text);
    return { audio: new TextEncoder().encode(text), mime: 'audio/wav' };
  },
};

beforeAll(async () => {
  stub = await startStubApi([{ id: 'adm', email: 'admin@demo.vn', password: 'mat-khau-admin-1', role: 'admin' }]);
  const cfg = loadConfig({ CITYLIGHT_API_BASE: stub.base, LLM_PROVIDER: 'fake' });
  const { server } = createConsoleServer({ cfg, db: openDb(':memory:'), llm: new FakeLlm(), audit: new AuditLog(mkdtempSync(path.join(tmpdir(), 'jv-'))), voice });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(async () => {
  close();
  await stub.close();
});

let cookie = '';
let csrf = '';
async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(`${base}${p}`, { method, headers: { cookie, 'content-type': 'application/json', ...(method !== 'GET' ? { 'x-jarvis-csrf': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie().find((c) => c.startsWith('jv_sid='));
  if (set) cookie = set.split(';')[0]!;
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.csrf === 'string') csrf = data.csrf;
  return { status: res.status, data };
}

async function speak(seconds: number) {
  const pcm = new Uint8Array(Math.round(seconds * 32_000));
  const res = await fetch(`${base}/api/voice`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-jarvis-csrf': csrf }, body: pcm });
  const raw = await res.text();
  return {
    status: res.status,
    events: raw.split('\n\n').filter((b) => b && !b.startsWith(':')).map((b) => ({ event: /event: (.*)/.exec(b)?.[1], data: JSON.parse(/data: (.*)/.exec(b)?.[1] ?? 'null') as Record<string, unknown> })),
    raw,
  };
}

describe('voice turn', () => {
  it('signs in and reports voice as available', async () => {
    await call('GET', '/api/session');
    const r = await call('POST', '/api/login', { email: 'admin@demo.vn', password: 'mat-khau-admin-1' });
    expect(r.data.voice).toBe(true);
    expect((await call('GET', '/api/voice/status')).data).toMatchObject({ enabled: true, ready: true });
  });

  it('a spoken data question: transcript, routed tool, answer spoken sentence by sentence', async () => {
    // the scripted answer sits in the question the router reads: no state words in it (they would route a cabinet list)
    heard.text = '[[fake:{"text":"Hệ thống có 10 tủ. Có 1 tủ lỗi từ 17:05.","chunks":4}]] Hệ thống thế nào rồi?';
    spoken.length = 0;
    const { status, events } = await speak(2);
    expect(status).toBe(200);
    expect(events[0]).toMatchObject({ event: 'status', data: { state: 'transcribing' } });
    expect(events.find((e) => e.event === 'transcript')!.data.text).toContain('Hệ thống thế nào rồi?');
    const audio = events.filter((e) => e.event === 'audio').map((e) => e.data);
    expect(audio.map((a) => a.seq)).toEqual([1, 2, 3]);
    expect(audio[0]!.mime).toBe('audio/wav');
    // the filler covers the tool, then the two sentences, said the way they are spoken
    expect(spoken).toEqual(['Để tôi kiểm tra.', 'Hệ thống có 10 tủ.', 'Có 1 tủ lỗi từ 5 giờ 5 phút chiều.']);
    const done = events.find((e) => e.event === 'done')!.data;
    expect(done).toMatchObject({ tools: ['get_system_overview'], sttMs: 50 });
    expect(done.firstAudioMs).not.toBeNull();
    // every audio event comes before done
    const idx = (n: string) => events.findIndex((e) => e.event === n);
    expect(events.map((e) => e.event).lastIndexOf('audio')).toBeLessThan(idx('done'));
  });

  it('silence or noise: nothing heard, no answer', async () => {
    heard.text = '';
    const { events } = await speak(1);
    expect(events.find((e) => e.event === 'done')!.data).toMatchObject({ heard: false });
    expect(events.some((e) => e.event === 'audio')).toBe(false);
  });

  it('too short audio is refused before any work', async () => {
    const r = await speak(0.05);
    expect(r.status).toBe(422);
  });
});
