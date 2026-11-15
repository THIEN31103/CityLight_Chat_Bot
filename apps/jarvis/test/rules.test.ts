import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RoleKey } from '@citylight/shared';
import { loadConfig } from '../src/config';
import { bootstrapAdmin, canEditSettings, canGrant, canViewChatsOf, rights, setAccess, getAccess, type Access, type Actor, type Flag } from '../src/store/access';
import { openDb } from '../src/store/db';
import { effectiveTokenCap, getSettings, updateSettings } from '../src/store/settings';
import { cabinetSearchTerms, fold, wordsToDigits } from '../src/tools/names';

const acc = (p: Partial<Access> = {}): Access => ({
  userId: 'x', email: 'x@a.vn', roleAtGrant: 'manager', canUse: true, canGrant: false, canViewChats: false, grantedBy: 'a', grantedAt: '', ...p,
});
const admin: Actor = { id: 'adm', role: 'admin', access: null };
const mgrGrant: Actor = { id: 'm1', role: 'manager', access: acc({ userId: 'm1', canGrant: true }) };
const mgrView: Actor = { id: 'm2', role: 'manager', access: acc({ userId: 'm2', canViewChats: true }) };
const mgrPlain: Actor = { id: 'm3', role: 'manager', access: acc({ userId: 'm3' }) };
const mgrRevoked: Actor = { id: 'm4', role: 'manager', access: acc({ userId: 'm4', canUse: false, canGrant: true, canViewChats: true }) };
const op: Actor = { id: 'o1', role: 'operator', access: acc({ userId: 'o1', roleAtGrant: 'operator' }) };
const t = (id: string, role: RoleKey) => ({ id, role });

describe('access rules (G4)', () => {
  it('admin always uses Jarvis and has every right', () => {
    expect(rights(admin)).toEqual({ canUse: true, canGrant: true, canViewChats: true });
  });

  it('admin grants can_use to anyone, can_grant / can_view_chats only to managers', () => {
    for (const r of ['manager', 'operator', 'viewer', 'maintenance'] as RoleKey[]) expect(canGrant(admin, t('u', r), 'canUse')).toBe(true);
    expect(canGrant(admin, t('u', 'manager'), 'canGrant')).toBe(true);
    expect(canGrant(admin, t('u', 'manager'), 'canViewChats')).toBe(true);
    for (const f of ['canGrant', 'canViewChats'] as Flag[]) {
      expect(canGrant(admin, t('u', 'operator'), f)).toBe(false);
      expect(canGrant(admin, t('u', 'viewer'), f)).toBe(false);
    }
  });

  it('a granting manager hands can_use to roles below only, never to itself, admin or another manager', () => {
    for (const r of ['operator', 'viewer', 'maintenance'] as RoleKey[]) expect(canGrant(mgrGrant, t('u', r), 'canUse')).toBe(true);
    expect(canGrant(mgrGrant, t('m1', 'manager'), 'canUse')).toBe(false);
    expect(canGrant(mgrGrant, t('m9', 'manager'), 'canUse')).toBe(false);
    expect(canGrant(mgrGrant, t('a9', 'admin'), 'canUse')).toBe(false);
    expect(canGrant(mgrGrant, t('u', 'operator'), 'canGrant')).toBe(false);
    expect(canGrant(mgrGrant, t('u', 'operator'), 'canViewChats')).toBe(false);
  });

  it('a manager without can_grant, a revoked manager and an operator grant nothing', () => {
    for (const a of [mgrPlain, mgrRevoked, op, mgrView]) expect(canGrant(a, t('u', 'viewer'), 'canUse')).toBe(false);
  });

  it('chat visibility: own always; admin all; viewing manager only roles below; others nothing', () => {
    expect(canViewChatsOf(op, t('o1', 'operator'))).toBe(true);
    expect(canViewChatsOf(op, t('o2', 'operator'))).toBe(false);
    expect(canViewChatsOf(admin, t('m1', 'manager'))).toBe(true);
    expect(canViewChatsOf(mgrView, t('o1', 'operator'))).toBe(true);
    expect(canViewChatsOf(mgrView, t('v', 'viewer'))).toBe(true);
    expect(canViewChatsOf(mgrView, t('m1', 'manager'))).toBe(false);
    expect(canViewChatsOf(mgrView, t('adm', 'admin'))).toBe(false);
    expect(canViewChatsOf(mgrPlain, t('o1', 'operator'))).toBe(false);
    expect(canViewChatsOf(mgrRevoked, t('o1', 'operator'))).toBe(false);
  });

  it('settings: admin or a granting manager', () => {
    expect(canEditSettings(admin)).toBe(true);
    expect(canEditSettings(mgrGrant)).toBe(true);
    expect(canEditSettings(mgrView)).toBe(false);
    expect(canEditSettings(op)).toBe(false);
  });

  it('the first admin to sign in is recorded once; later grants keep flags they do not touch', () => {
    const db = openDb(':memory:');
    expect(bootstrapAdmin(db, { id: 'adm', email: 'a@a.vn', role: 'admin' })).toBe(true);
    expect(bootstrapAdmin(db, { id: 'adm2', email: 'b@a.vn', role: 'admin' })).toBe(false);
    expect(bootstrapAdmin(db, { id: 'm', email: 'm@a.vn', role: 'manager' })).toBe(false);
    setAccess(db, { id: 'm', email: 'm@a.vn', role: 'manager' }, { canUse: true, canGrant: true }, 'adm');
    setAccess(db, { id: 'm', email: 'm@a.vn', role: 'manager' }, { canUse: false }, 'adm');
    expect(getAccess(db, 'm')).toMatchObject({ canUse: false, canGrant: true, canViewChats: false });
  });
});

describe('settings + token caps (G8, spec 11 numbers)', () => {
  const cfg = (max: number, extra: Record<string, string> = {}) => loadConfig({ JARVIS_DAILY_TOKEN_CAP_MAX: String(max), ...extra });

  it('MAX = 100000: cap 0 and 200000 are refused, 50000 is kept', () => {
    const db = openDb(':memory:');
    const c = cfg(100_000);
    expect(() => updateSettings(db, c, { dailyTokenCap: 0 }, 'a')).toThrow(/1\.\.100000/);
    expect(() => updateSettings(db, c, { dailyTokenCap: 200_000 }, 'a')).toThrow(/1\.\.100000/);
    expect(updateSettings(db, c, { dailyTokenCap: 50_000 }, 'a').after.dailyTokenCap).toBe(50_000);
    expect(effectiveTokenCap(getSettings(db, c), c)).toBe(50_000);
  });

  it('80000 saved, then the hard cap lowered to 60000 in .env: 60000 applies', () => {
    const db = openDb(':memory:');
    updateSettings(db, cfg(100_000), { dailyTokenCap: 80_000 }, 'a');
    const lowered = cfg(60_000);
    expect(effectiveTokenCap(getSettings(db, lowered), lowered)).toBe(60_000);
  });

  it('no hard cap: 0 means unlimited', () => {
    const db = openDb(':memory:');
    expect(effectiveTokenCap(getSettings(db, cfg(0)), cfg(0))).toBe(0);
  });

  it('actions switched off in .env cannot be switched on from the console', () => {
    const db = openDb(':memory:');
    const off = cfg(0, { JARVIS_ACTIONS_ENABLED: 'false' });
    expect(getSettings(db, off).actionsEnabled).toBe(false);
    expect(() => updateSettings(db, off, { actionsEnabled: true }, 'a')).toThrow(/JARVIS_ACTIONS_ENABLED/);
    expect(updateSettings(db, cfg(0), { actionsEnabled: false }, 'a').after.actionsEnabled).toBe(false);
  });

  it('per-minute and history limits are validated', () => {
    const db = openDb(':memory:');
    expect(() => updateSettings(db, cfg(0), { perUserPerMin: 0 }, 'a')).toThrow();
    expect(() => updateSettings(db, cfg(0), { historyDays: 400 }, 'a')).toThrow();
    expect(updateSettings(db, cfg(0), { perUserPerMin: 30, historyDays: 30 }, 'a').before.historyDays).toBe(90);
  });
});

describe('spoken cabinet names', () => {
  it('folds Vietnamese', () => {
    expect(fold('Tủ Demo SỐ Mười  Đông')).toBe('tu demo so muoi dong');
  });

  it.each([
    ['muoi', '10'], ['muoi mot', '11'], ['hai muoi lam', '25'], ['ba muoi tu', '34'], ['mot tram linh hai', '102'], ['so mot', 'so 1'], ['demo nam', 'demo 5'],
    ['nam nay', 'nam nay'], ['tu dien', 'tu dien'],
  ])('%s -> %s', (words, digits) => {
    expect(wordsToDigits(words)).toBe(digits);
  });

  it.each([
    ['tủ demo số mười', 'DM0010'], ['demo10', 'DM0010'], ['DM10', 'DM0010'], ['dm0010', 'DM0010'], ['tủ demo số ba', 'DM0003'], ['TL01.9', 'TL01.0009'],
  ])('%s -> first term %s', (spoken, code) => {
    expect(cabinetSearchTerms(spoken)[0]).toBe(code);
  });

  it('keeps names and addresses as search terms, every term at least 2 characters', () => {
    const terms = cabinetSearchTerms('tủ Lý Thường Kiệt 9');
    expect(terms).toContain('tủ Lý Thường Kiệt 9');
    expect(terms.every((x) => x.length >= 2)).toBe(true);
    expect(terms.some((x) => x.startsWith('TU'))).toBe(false);
  });
});

describe('static guard (spec 6.10)', () => {
  const src = (f: string) => readFileSync(path.resolve(__dirname, '../src', f), 'utf8');
  it.each(['tools/read.ts', 'tools/registry.ts', 'tools/names.ts', 'brain/agent.ts', 'brain/router.ts', 'brain/context.ts', 'brain/system-prompt.ts', 'brain/llm.ts', 'api/read.ts'])(
    '%s never reaches a command endpoint',
    (f) => {
      const text = src(f);
      // reading the command history (GET cabinets/:id/commands) is fine; sending is not
      expect(text).not.toMatch(/command-batches/);
      expect(text).not.toMatch(/\.post\s*[<(]|\.put\s*[<(]|['"]POST['"]|['"]PUT['"]|['"]DELETE['"]/);
      expect(text).not.toMatch(/alarms\/[^'"`]*\/ack/);
      expect(text).not.toMatch(/idempotencyKey/);
    },
  );

  // milestone 4: guard/pending.ts is the only file that sends a command; everything else reaches it through the guard
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []));
  it('only guard/pending.ts posts to a command endpoint', () => {
    const root = path.resolve(__dirname, '../src');
    const senders = walk(root).filter((f) => /\/commands['"`]|commands`,|command-batches|idempotencyKey:/.test(readFileSync(f, 'utf8')) && /\.post\s*[<(]|['"]POST['"]/.test(readFileSync(f, 'utf8')));
    expect(senders.map((f) => path.relative(root, f).replace(/\\/g, '/'))).toEqual(['guard/pending.ts']);
  });
});
