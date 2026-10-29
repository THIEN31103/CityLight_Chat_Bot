import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCommandFrames, expectedAckKeys, isSignatureReject, parseTelemetry } from '../src';
import {
  MAX_SIGNED_FRAME, bootHex, cabinetKey, identPairs, keyFingerprint, normUid, parseMasterKey, signCommand, verifyCommand, verifyIdent,
} from '../src/sign';
import { encodeFrame } from '../src/frame';
import { TELE_OK } from './fixtures';
import V from './sign-vectors.json';

const master = Buffer.from(V.master, 'hex');
const key = Buffer.from(V.cabinetKey, 'hex');

describe('shared vectors (firmware uses the same file)', () => {
  it('primitives', () => {
    expect(createHash('sha256').update('abc').digest('hex')).toBe(V.primitives.sha256_abc);
    const h = V.primitives.hmac_rfc4231_2;
    expect(createHmac('sha256', h.key).update(h.data).digest('hex')).toBe(h.mac);
    expect(h.mac).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('cabinet key and fingerprint', () => {
    expect(cabinetKey(master, V.uid).toString('hex')).toBe(V.cabinetKey);
    expect(cabinetKey(master, V.uid.toUpperCase()).toString('hex')).toBe(V.cabinetKey);
    expect(keyFingerprint(key)).toBe(V.fingerprint);
  });

  it('commands sign to the same bytes', () => {
    for (const c of V.commands) {
      expect(signCommand(c.unsigned, key, { boot: c.boot, m: c.m }, c.nowMs)).toBe(c.signed);
      const v = verifyCommand(c.signed, key, { boot: c.boot, lastM: c.m - 1, nowMs: c.nowMs });
      expect(v).toMatchObject({ ok: true, boot: c.boot, m: c.m, frame: c.unsigned });
    }
  });

  it('the longest command fits the device buffer', () => {
    const longest = Math.max(...V.commands.map((c) => c.signed.length));
    expect(longest).toBeLessThanOrEqual(MAX_SIGNED_FRAME);
  });

  it('reject cases', () => {
    for (const r of V.rejects) expect(verifyCommand(r.frame, key, r.dev)).toEqual({ ok: false, reason: r.expect });
  });

  it('identity blocks', () => {
    for (const i of V.ident) {
      const v = verifyIdent(master, i.ltid, { uid: V.uid, seq: i.seq, sig: i.sig });
      expect(v).toMatchObject({ ok: true, uid: V.uid, boot: i.boot, fingerprint: V.fingerprint });
    }
  });
});

describe('signCommand', () => {
  const now = Date.UTC(2026, 9, 29, 11, 0, 0);
  const frame = buildCommandFrames('CTY0005', 'AUTO', {})[0]!;

  it('puts CSEQ/CEXP after LTID and CSIG last; CEXP = now + 90 s', () => {
    const s = signCommand(frame, key, { boot: 0x2a, m: 7 }, now);
    expect(s).toMatch(/^\*#LTID'CTY0005&CSEQ'0000002a\.7&CEXP'(\d+)&PMAN'0&CSIG'[0-9a-f]{32}\$$/);
    expect(Number(/CEXP'(\d+)/.exec(s)![1])).toBe(now / 1000 + 90);
  });

  it('acks expected without the signing keys', () => {
    expect(expectedAckKeys(signCommand(frame, key, { boot: 1, m: 1 }, now))).toEqual(['PMAN']);
  });

  it('refuses bad input', () => {
    expect(() => signCommand(signCommand(frame, key, { boot: 1, m: 1 }), key, { boot: 1, m: 2 })).toThrow(/đã được ký/);
    expect(() => signCommand("*#PMAN'0$", key, { boot: 1, m: 1 })).toThrow(/LTID/);
    expect(() => signCommand(frame, key, { boot: 1, m: 0 })).toThrow();
    expect(() => signCommand(frame, key, { boot: -1, m: 1 })).toThrow();
  });

  it('expiry is not checked while the device clock is untrusted', () => {
    const s = signCommand(frame, key, { boot: 3, m: 1 }, now);
    expect(verifyCommand(s, key, { boot: 3, lastM: 0, nowMs: null }).ok).toBe(true);
    expect(verifyCommand(s, key, { boot: 3, lastM: 0, nowMs: now + 90_000 }).ok).toBe(true);
  });
});

describe('identity block', () => {
  it('telemetry parser picks LUID/LSEQ/LSIG, verifyIdent accepts it', () => {
    const raw = TELE_OK.replace(/\$$/, '&' + identPairs(key, 'CTY0005', V.uid, 42).map(([k, v]) => `${k}'${v}`).join('&') + '$');
    const t = parseTelemetry(raw.replace(/LTID'[^&]+/, "LTID'CTY0005"));
    expect(t.ident).toEqual({ uid: V.uid, seq: bootHex(42), sig: V.ident[0]!.sig });
    expect(t.unknownKeys).not.toHaveProperty('LUID');
    expect(verifyIdent(master, t.ltid, t.ident!)).toMatchObject({ ok: true, boot: 42 });
  });

  it('malformed or partial block = null', () => {
    expect(parseTelemetry(encodeFrame([['LTID', 'A'], ['LUID', V.uid], ['LSEQ', '0000002a']])).ident).toBeNull();
    expect(parseTelemetry(encodeFrame([['LTID', 'A'], ['LUID', 'xyz'], ['LSEQ', '0000002a'], ['LSIG', '0'.repeat(32)]])).ident).toBeNull();
  });

  it('rejects another LTID, another boot, another master', () => {
    const p = Object.fromEntries(identPairs(key, 'CTY0005', V.uid, 42));
    const seq = p.LSEQ!;
    const sig = p.LSIG!;
    expect(verifyIdent(master, 'CTY0006', { uid: V.uid, seq, sig }).ok).toBe(false);
    expect(verifyIdent(master, 'CTY0005', { uid: V.uid, seq: bootHex(43), sig }).ok).toBe(false);
    expect(verifyIdent(Buffer.alloc(32, 7), 'CTY0005', { uid: V.uid, seq, sig }).ok).toBe(false);
  });
});

describe('helpers', () => {
  it('parseMasterKey', () => {
    expect(parseMasterKey(undefined)).toBeNull();
    expect(parseMasterKey('  ')).toBeNull();
    expect(parseMasterKey(V.master)!.equals(master)).toBe(true);
    expect(() => parseMasterKey('abc')).toThrow(/64/);
  });

  it('normUid', () => {
    expect(normUid(V.uid.toUpperCase())).toBe(V.uid);
    expect(normUid('12')).toBeNull();
    expect(normUid(null)).toBeNull();
  });

  it('isSignatureReject', () => {
    expect(isSignatureReject({ ltid: 'A', acks: [{ key: 'CSIG', rc: -3 }], deviceTick: null })).toBe(true);
    expect(isSignatureReject({ ltid: 'A', acks: [{ key: 'PMAN', rc: -3 }], deviceTick: null })).toBe(false);
  });
});
