// Jarvis's own 2FA (2026-11-25): the TOTP math against the RFC vectors, the encrypted secret, the key file.
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, decryptSecret, encryptSecret, groupedKey, hotp, verifyTotp } from '../src/auth/totp';
import { openDb } from '../src/store/db';
import { Jarvis2fa, LOCK_MS, secretKey } from '../src/store/jarvis2fa';

describe('TOTP', () => {
  it('HOTP matches RFC 4226 appendix D', () => {
    const secret = Buffer.from('12345678901234567890');
    expect([0, 1, 2, 9].map((c) => hotp(secret, c))).toEqual(['755224', '287082', '359152', '520489']);
  });
  it('base32 round trip; the key is shown in groups of 4', () => {
    const s = Buffer.from('12345678901234567890');
    expect(base32Decode(base32Encode(s))).toEqual(s);
    expect(groupedKey(s)).toMatch(/^([A-Z2-7]{4} )+[A-Z2-7]{4}$/);
  });
  it('a code works once, the step before and after are accepted (clock drift)', () => {
    const s = Buffer.from('12345678901234567890');
    const now = 59_000; // step 1
    expect(verifyTotp(s, hotp(s, 1), null, now)).toBe(1);
    expect(verifyTotp(s, hotp(s, 1), 1, now)).toBeNull();
    expect(verifyTotp(s, hotp(s, 2), 1, now)).toBe(2);
    expect(verifyTotp(s, hotp(s, 5), null, now)).toBeNull();
  });
});

describe('Jarvis2fa store', () => {
  it('the secret is stored encrypted; 5 wrong codes lock it; a reset removes it', () => {
    const key = Buffer.alloc(32, 3);
    const db = openDb(':memory:');
    const t = new Jarvis2fa(db, () => key);
    const secret = t.newSecret();
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(t.enabled('u1')).toBe(false);
    expect(t.confirmSetup('u1', secret, '000000', now)).toBe(false);
    expect(t.confirmSetup('u1', secret, hotp(secret, step), now)).toBe(true);
    const stored = (db.prepare('SELECT secret FROM jarvis_totp').get() as { secret: string }).secret;
    expect(stored).not.toContain(base32Encode(secret));
    expect(decryptSecret(stored, key)).toEqual(secret);
    expect(t.check('u1', hotp(secret, step + 1), now)).toBe('ok');
    for (let k = 0; k < 4; k++) expect(t.check('u1', '000000', now)).toBe('bad');
    expect(t.check('u1', '000000', now)).toBe('locked');
    expect(t.check('u1', hotp(secret, step + 2), now + 1000)).toBe('locked');
    expect(t.lockedFor('u1', now)).toBe(15);
    expect(t.check('u1', hotp(secret, step + 1 + LOCK_MS / 30_000 + 1), now + LOCK_MS + 30_000)).toBe('ok');
    expect(t.reset('u1')).toBe(true);
    expect(t.check('u1', '123456', now)).toBe('none');
    expect(encryptSecret(secret, key)).not.toBe(encryptSecret(secret, key));
  });
  it('the key comes from JARVIS_SECRET_KEY, else from a file made once in the data folder', () => {
    expect(secretKey('/nowhere', 'ab'.repeat(32))).toEqual(Buffer.alloc(32, 0xab));
    expect(() => secretKey('/nowhere', 'short')).toThrow(/32 bytes/);
    const dir = mkdtempSync(path.join(tmpdir(), 'jv-key-'));
    const k1 = secretKey(dir);
    expect(secretKey(dir)).toEqual(k1);
    expect(readFileSync(path.join(dir, 'jarvis-secret.key'), 'utf8')).toBe(k1.toString('hex'));
    if (process.platform !== 'win32') expect(statSync(path.join(dir, 'jarvis-secret.key')).mode & 0o777).toBe(0o600);
  });
});
