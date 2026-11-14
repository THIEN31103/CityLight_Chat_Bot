import { describe, expect, it } from 'vitest';
import { loadConfig, parseAllowlist } from '../src/config';
import { addTokenUsage, openDb, purgeHistory, schemaVersion, tokensToday, vnDay } from '../src/store/db';

describe('store (node:sqlite)', () => {
  it('migrates a fresh database to the latest schema', () => {
    const db = openDb(':memory:');
    expect(schemaVersion(db)).toBe(2);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['access', 'conversations', 'messages', 'settings', 'token_usage', 'users_seen']));
  });

  it('counts tokens per Vietnam day: 23:30 UTC is already the next day in Vietnam', () => {
    const db = openDb(':memory:');
    const lateUtc = new Date('2026-11-10T23:30:00Z');
    expect(vnDay(lateUtc)).toBe('2026-11-11');
    addTokenUsage(db, 'u1', 100, 20, lateUtc);
    addTokenUsage(db, 'u2', 50, 5, lateUtc);
    addTokenUsage(db, 'u1', 10, 1, new Date('2026-11-10T10:00:00Z'));
    expect(tokensToday(db, lateUtc)).toBe(175);
    expect(tokensToday(db, new Date('2026-11-10T10:00:00Z'))).toBe(11);
  });

  it('retention removes old conversations with their messages', () => {
    const db = openDb(':memory:');
    const ins = db.prepare('INSERT INTO conversations (id, user_id, user_role, started_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    ins.run('old', 'u1', 'operator', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    ins.run('new', 'u1', 'operator', '2026-11-09T00:00:00Z', '2026-11-09T00:00:00Z');
    db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES ('old', 'user', 'a', '2026-01-01T00:00:00Z')").run();
    expect(purgeHistory(db, 90, new Date('2026-11-10T00:00:00Z'))).toBe(1);
    expect((db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT id FROM conversations').all() as { id: string }[]).map((r) => r.id)).toEqual(['new']);
  });
});

describe('config', () => {
  it('expands the demo allowlist', () => {
    const a = parseAllowlist('DM0001..DM0010');
    expect(a).toHaveLength(10);
    expect(a[0]).toBe('DM0001');
    expect(a[9]).toBe('DM0010');
    expect(parseAllowlist('tm01.0001..TM01.0003, DM0005')).toEqual(['TM01.0001', 'TM01.0002', 'TM01.0003', 'DM0005']);
  });

  it('empty allowlist = nothing may be controlled', () => {
    expect(parseAllowlist('')).toEqual([]);
    expect(loadConfig({}).cabinetAllowlist).toEqual([]);
  });

  it('defaults: free local model, loopback console', () => {
    const c = loadConfig({});
    expect(c.llm).toMatchObject({ provider: 'ollama', model: 'qwen3:4b-instruct', numCtx: 4096, think: undefined });
    expect(c.console.host).toBe('127.0.0.1');
    expect(c.apiBase).toBe('http://localhost:3000/api/v1');
  });

  it('refuses a LAN console without a long token', () => {
    expect(() => loadConfig({ JARVIS_CONSOLE_HOST: '0.0.0.0' })).toThrow(/JARVIS_CONSOLE_TOKEN/);
    expect(() => loadConfig({ JARVIS_CONSOLE_HOST: '0.0.0.0', JARVIS_CONSOLE_TOKEN: 'short' })).toThrow(/24/);
    expect(loadConfig({ JARVIS_CONSOLE_HOST: '0.0.0.0', JARVIS_CONSOLE_TOKEN: 'x'.repeat(32) }).console.token).toHaveLength(32);
  });

  it('a daily cap above the hard cap is refused; bad numbers name the variable', () => {
    expect(() => loadConfig({ JARVIS_DAILY_TOKEN_CAP_MAX: '100000', JARVIS_DAILY_TOKEN_CAP: '200000' })).toThrow(/above/);
    expect(() => loadConfig({ JARVIS_PER_USER_PER_MIN: '0' })).toThrow(/JARVIS_PER_USER_PER_MIN/);
    expect(loadConfig({ JARVIS_ACTIONS_ENABLED: 'false' }).actionsEnabled).toBe(false);
  });
});
