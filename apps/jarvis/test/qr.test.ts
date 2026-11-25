// The QR encoder of the Jarvis 2FA setup (2026-11-25). Checked module by module against the "qrcode" package 1.5.4
// that the CityLight web uses (byte mode, level M, same version and mask: 56 / 56 identical on 2026-11-25); the
// fingerprints below come from that package, so this test needs no copy of it.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { qrMatrix, qrSvg } from '../src/auth/qr';

const URI = 'otpauth://totp/Jarvis%20CityLight%3Aadmin%40citylight.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Jarvis%20CityLight&algorithm=SHA1&digits=6&period=30';
const fp = (m: Uint8Array) => createHash('sha256').update(Buffer.from(m)).digest('hex').slice(0, 32);

describe('QR encoder', () => {
  it.each([
    ['hello', 0, 1, 21, '19cb2fb2c34525521105cbbf11589ad4'],
    [URI, 2, 9, 53, '96598252023fe0a147c2258b14cdc360'],
    ['z'.repeat(200), 5, 10, 57, '9a1669407082e67411c20e90bfb8c010'],
  ] as const)('the same modules as the qrcode package: %#', (text, mask, version, size, print) => {
    const q = qrMatrix(text, { mask });
    expect([q.version, q.size]).toEqual([version, size]);
    expect(fp(q.modules)).toBe(print);
  });

  it('picks the smallest version; too long is refused', () => {
    expect(qrMatrix('A').version).toBe(1);
    expect(qrMatrix(URI).version).toBe(9);
    expect(() => qrMatrix('x'.repeat(300))).toThrow(/do not fit/);
  });

  it('an SVG with a quiet zone, nothing but the modules', () => {
    const svg = qrSvg(URI);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 61 61"/);
    expect(svg).not.toContain('otpauth');
  });
});
