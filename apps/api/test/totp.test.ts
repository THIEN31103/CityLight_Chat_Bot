import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base32Decode, base32Encode, decryptSecret, encryptSecret, hotp, newRecoveryCodes, normalizeRecoveryCode, otpauthUrl, parseEncKey, totpStep, verifyTotp,
} from '../src/totp';

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('hotp / totp', () => {
  it('matches RFC 4226 HOTP vectors', () => {
    const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    want.forEach((w, i) => expect(hotp(RFC_SECRET, i)).toBe(w));
  });

  it('matches RFC 6238 SHA-1 TOTP vectors (8 digits)', () => {
    const vectors: [number, string][] = [
      [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
    ];
    for (const [t, w] of vectors) expect(hotp(RFC_SECRET, totpStep(t * 1000), 8)).toBe(w);
  });

  it('accepts +/-1 step, rejects reuse and older steps', () => {
    const now = 1_760_000_000_000;
    const step = totpStep(now);
    const code = hotp(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, null, now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, code, step, now)).toBeNull(); // replay
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), null, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12a456', null, now)).toBeNull();
  });
});

describe('base32 / otpauth', () => {
  it('round-trips and matches RFC 4648', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });

  it('builds an otpauth URL with issuer', () => {
    const url = otpauthUrl('a@b.vn', RFC_SECRET);
    expect(url).toMatch(/^otpauth:\/\/totp\/CityLight%3Aa%40b\.vn\?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=CityLight/);
  });
});

describe('secret encryption', () => {
  const key = randomBytes(32);
  it('round-trips and detects tampering', () => {
    const s = randomBytes(20);
    const enc = encryptSecret(s, key);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(decryptSecret(enc, key).equals(s)).toBe(true);
    const parts = enc.split(':');
    parts[3] = Buffer.from('x'.repeat(20)).toString('base64');
    expect(() => decryptSecret(parts.join(':'), key)).toThrow();
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow();
  });

  it('parses hex and base64 keys, rejects bad ones', () => {
    expect(parseEncKey(key.toString('hex')).equals(key)).toBe(true);
    expect(parseEncKey(key.toString('base64')).equals(key)).toBe(true);
    expect(() => parseEncKey(undefined)).toThrow();
    expect(() => parseEncKey('abcd')).toThrow();
  });
});

describe('recovery codes', () => {
  it('generates 8 distinct XXXX-XXXX codes and normalizes input', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(normalizeRecoveryCode(' k7qx-m2pa ')).toBe('K7QXM2PA');
  });
});
