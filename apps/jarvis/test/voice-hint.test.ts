// What Groq is told to expect in a voice turn (2026-11-23: "số hai" after a numbered list came back "số hệ"),
// and misheard place names fixed from the real map.
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
let heard = '';
const hints: (string | undefined)[] = [];
const voice: SttProvider & TtsProvider = {
  transcribe: async (pcm, _signal, hint) => {
    hints.push(hint);
    return { text: heard, ms: 50, audioMs: pcm.length / 32 };
  },
  synth: async (text) => ({ audio: new TextEncoder().encode(text), mime: 'audio/wav' }),
};

beforeAll(async () => {
  stub = await startStubApi([{ id: 'adm', email: 'admin@demo.vn', password: 'mat-khau-admin-1', role: 'admin', totp: '111111' }]);
  const cfg = loadConfig({ CITYLIGHT_API_BASE: stub.base, LLM_PROVIDER: 'fake', JARVIS_DAILY_TOKEN_CAP_MAX: '0', JARVIS_CABINET_ALLOWLIST: 'DM0001..DM0010', JARVIS_ACTIONS_ENABLED: 'true' });
  const { server } = createConsoleServer({ cfg, db: openDb(':memory:'), llm: new FakeLlm(), audit: new AuditLog(mkdtempSync(path.join(tmpdir(), 'jv-hint-'))), voice, commandPollMs: 20 });
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
  const text = await res.text();
  const data = res.headers.get('content-type')?.includes('json') ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (typeof data.csrf === 'string') csrf = data.csrf;
  return text;
}
/** one voice turn: what was heard after the fixes, and Jarvis' answer */
async function say(text: string) {
  heard = text;
  const res = await fetch(`${base}/api/voice`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-jarvis-csrf': csrf }, body: new Uint8Array(32_000) });
  const raw = await res.text();
  const events = raw.split('\n\n').filter((b) => b && !b.startsWith(':')).map((b) => ({ event: /event: (.*)/.exec(b)?.[1], data: JSON.parse(/data: (.*)/.exec(b)?.[1] ?? 'null') as Record<string, unknown> }));
  return {
    transcript: String(events.find((e) => e.event === 'transcript')?.data.text ?? ''),
    answer: String(events.find((e) => e.event === 'done')?.data.text ?? ''),
    pending: events.find((e) => e.event === 'pending')?.data,
  };
}

describe('voice hints and place names', () => {
  it('signs in', async () => {
    await call('GET', '/api/session');
    await call('POST', '/api/login', { email: 'admin@demo.vn', password: 'mat-khau-admin-1' });
    expect(await call('POST', '/api/2fa', { code: '111111' })).toContain('"signedIn":true');
  });

  it('no hint when nothing is waited for; "tủ nào?" hints the districts; a list hints its numbers', async () => {
    hints.length = 0;
    await say('tắt đèn đi');
    expect(hints[0]).toBeUndefined();
    await say('ở quận 1');
    expect(hints[1]).toMatch(/^Tủ nào\? Tên đường hoặc khu vực: .*Quận 1/);
    const r = await say('bật đèn một tủ ở quận một');
    expect(r.answer).toMatch(/Bạn chọn số mấy\?$/);
    await say('số hai');
    expect(hints.at(-1)).toBe('Bạn chọn số mấy? Số một. Số hai.');
  });

  it('no hint while an action waits for "xác nhận" (noise must never be written back as the word that sends)', async () => {
    await call('POST', '/api/chat/new');
    const r = await say('bật đèn tủ DM0010');
    expect(r.pending).toBeTruthy();
    hints.length = 0;
    await say('hủy lệnh');
    expect(hints[0]).toBeUndefined();
  });

  it('a street heard one letter off is written as the real one', async () => {
    await call('POST', '/api/chat/new');
    const r = await say('bật đèn tủ trên đường Lý Thường Kiệc');
    expect(r.transcript).toBe('bật đèn tủ trên đường Lý Thường Kiệt');
    await say('hủy lệnh');
  });
});
