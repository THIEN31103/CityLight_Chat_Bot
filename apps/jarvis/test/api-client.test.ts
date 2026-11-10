import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, ApiProblem } from '../src/api/client';
import { CityLightReads } from '../src/api/read';
import { sanitizeForLlm } from '../src/sanitize/llm';
import { CABINET, startStubApi, type StubApi } from './stub-api';

let stub: StubApi;
const newClient = () => new ApiClient({ baseUrl: stub.base, timeoutMs: 2000 });

beforeAll(async () => {
  stub = await startStubApi([
    { id: 'u-op', email: 'op@demo.vn', password: 'mat-khau-dai-1', role: 'operator', totp: '123456' },
    { id: 'u-view', email: 'view@demo.vn', password: 'mat-khau-dai-2', role: 'viewer' },
    { id: 'u-admin', email: 'admin@demo.vn', password: 'mat-khau-dai-3', role: 'admin' },
  ]);
});
afterAll(() => stub.close());

describe('ApiClient auth', () => {
  it('signs in without 2FA and reads /auth/me with the session cookie', async () => {
    const c = newClient();
    const r = await c.login('view@demo.vn', 'mat-khau-dai-2');
    expect(r.kind).toBe('session');
    expect(c.signedIn).toBe(true);
    expect((await c.me()).role).toBe('viewer');
  });

  it('2FA: login returns a challenge, verify2fa sends the cl_2fa cookie and opens the session', async () => {
    const c = newClient();
    expect(await c.login('op@demo.vn', 'mat-khau-dai-1')).toEqual({ kind: 'challenge' });
    expect(c.signedIn).toBe(false);
    const u = await c.verify2fa({ code: '123456' });
    expect(u.role).toBe('operator');
    expect(c.signedIn).toBe(true);
    const verify = stub.seen.filter((s) => s.path === '/auth/2fa/verify').at(-1)!;
    expect(String(verify.headers.cookie)).toContain('cl_2fa=');
  });

  it('a wrong 2FA code is an RFC 9457 problem with the API code', async () => {
    const c = newClient();
    await c.login('op@demo.vn', 'mat-khau-dai-1');
    await expect(c.verify2fa({ code: '000000' })).rejects.toMatchObject({ status: 401, code: 'invalid_totp' });
  });

  it('wrong password: invalid_credentials, still signed out', async () => {
    const c = newClient();
    await expect(c.login('view@demo.vn', 'sai')).rejects.toBeInstanceOf(ApiProblem);
    expect(c.signedIn).toBe(false);
  });

  it('sends the CSRF header on POST, never on GET; the API refuses a POST without it', async () => {
    const c = newClient();
    await c.login('view@demo.vn', 'mat-khau-dai-2');
    await c.me();
    expect(stub.seen.at(-1)!.headers['x-csrf-token']).toBeUndefined();
    await c.post('echo', {});
    expect(stub.seen.at(-1)!.headers['x-csrf-token']).toMatch(/^[\w-]{20,}$/);

    const raw = await fetch(`${stub.base}/echo`, { method: 'POST', headers: { cookie: String(stub.seen.at(-1)!.headers.cookie).split('; ').filter((x) => x.startsWith('cl_sid=')).join('') } });
    expect(raw.status).toBe(403);
  });

  it('Idempotency-Key is passed through and validated', async () => {
    const c = newClient();
    await c.login('view@demo.vn', 'mat-khau-dai-2');
    expect(await c.post('echo', {}, { idempotencyKey: 'pending-abc123' })).toEqual({ ok: true, idem: 'pending-abc123' });
    await expect(c.post('echo', {}, { idempotencyKey: 'x' })).rejects.toThrow(/Idempotency-Key/);
  });

  it('logout clears the session; the next read is 401 unauthenticated', async () => {
    const c = newClient();
    await c.login('view@demo.vn', 'mat-khau-dai-2');
    await c.logout();
    expect(c.signedIn).toBe(false);
    await expect(c.me()).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  it('an unreachable server becomes a problem, not a crash', async () => {
    const c = new ApiClient({ baseUrl: 'http://127.0.0.1:1/api/v1', timeoutMs: 1000 });
    await expect(c.me()).rejects.toMatchObject({ code: 'unreachable' });
  });
});

describe('reads + sanitize (G6)', () => {
  it('search needs 2 characters and finds the cabinet', async () => {
    const c = newClient();
    await c.login('view@demo.vn', 'mat-khau-dai-2');
    const reads = new CityLightReads(c);
    expect(await reads.search('d')).toEqual([]);
    expect((await reads.search('DM0010'))[0]?.code).toBe('DM0010');
  });

  it('a provider (admin) session gets LTID and IMEI from the API; after sanitize none of it is left', async () => {
    const c = newClient();
    await c.login('admin@demo.vn', 'mat-khau-dai-3');
    const raw = await new CityLightReads(c).cabinet(CABINET.id);
    const rawText = JSON.stringify(raw);
    expect(rawText).toContain(CABINET.ltid);
    expect(rawText).toContain(CABINET.imei);

    const clean = JSON.stringify(sanitizeForLlm(raw));
    for (const secret of [CABINET.ltid, CABINET.imei, '8984012345678901234', '0912345678']) expect(clean).not.toContain(secret);
    expect(clean).toContain('DM0010');
    expect(clean).toContain('10.777');
  });

  it('unknown cabinet: 404 not_found problem', async () => {
    const c = newClient();
    await c.login('view@demo.vn', 'mat-khau-dai-2');
    await expect(new CityLightReads(c).cabinet('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
