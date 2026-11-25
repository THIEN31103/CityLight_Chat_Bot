// TOTP (RFC 6238, SHA-1, 6 digits, 30 s) on node:crypto, the same scheme as CityLight's own (apps/api/src/totp.ts), so
// any authenticator app works. Used for Jarvis's own second factor (2026-11-25): an account without CityLight 2FA
// signs in to Jarvis with a code from a Jarvis entry in the authenticator, and gives that code for a batch.
// Secrets are kept AES-256-GCM encrypted (a copy of the database alone does not reveal them).
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_MS = 30_000;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('invalid base32');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (nowMs: number) => Math.floor(nowMs / STEP_MS);

/**
 * The current step +/- 1 (clock drift), only if newer than lastStep (each code works once). Returns the matched step to
 * store as the new lastStep, or null.
 */
export function verifyTotp(secret: Buffer, code: string, lastStep: number | null, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export const newTotpSecret = () => randomBytes(20);

/** the link an authenticator app opens ("Jarvis CityLight: email") */
export function otpauthUrl(email: string, secret: Buffer, issuer = 'Jarvis CityLight') {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** the key as people type it: groups of 4 */
export const groupedKey = (secret: Buffer) => base32Encode(secret).replace(/(.{4})(?=.)/g, '$1 ');

export function encryptSecret(secret: Buffer, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(secret), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(stored: string, key: Buffer): Buffer {
  const [iv, tag, enc] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key, iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(enc!), d.final()]);
}
