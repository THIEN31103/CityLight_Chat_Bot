// D7-lite command signing (decision S59, workspace plan "CityLight D7 Signing"). Node only (node:crypto): not
// re-exported from the package index, which the web mock imports. Import from '@citylight/coreif/sign'.
//
// Wire format, shared with the LTE firmware (BOARD_LTE_KEY Mylib/dev_sign.c) through test/sign-vectors.json:
//   cabinet key  = HMAC-SHA256(master 32 B, "CLK1" || chip UID 12 B)
//   LKFP         = first 8 hex of SHA-256("CLFP" || cabinet key)          (shown on UART2 SHOW and on the web)
//   command      = *#LTID'<id>&CSEQ'<boot 8 hex>.<m>&CEXP'<unix s>&<command keys>&CSIG'<32 hex>$
//   CSIG         = first 32 hex of HMAC(cabinet key, "CL1C" || every frame byte before "&CSIG'")
//   identity     = telemetry ...&LUID'<24 hex>&LSEQ'<boot 8 hex>&LSIG'<32 hex>$
//   LSIG         = first 32 hex of HMAC(cabinet key, "CL1H" + LTID upper-cased + "|" + LUID + "|" + LSEQ)
// Hex is lower case everywhere. The device runs a command only when CSIG matches, the boot equals its own,
// m is above the last m it accepted since boot, and CEXP has not passed (checked when its clock is trusted).
// It acks the command keys only (not CSEQ/CEXP/CSIG, like LTID); a rejected frame is acked {"k":"CSIG","rc":-3}.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { FrameError } from './frame';
export { RC_SIGNATURE, SIGN_KEYS } from './commands';

/** Signature length in hex chars (128 bit, decision K5). */
export const SIG_HEX = 32;
/** CEXP = signing time + this. */
export const CMD_TTL_S = 90;
/** The device drops payloads over 255 chars; keep a margin. */
export const MAX_SIGNED_FRAME = 250;

const HEX_UID = /^[0-9a-f]{24}$/;
const HEX_BOOT = /^[0-9a-f]{8}$/;
const HEX_SIG = /^[0-9a-f]{32}$/;
const MAX_U32 = 0xffff_ffff;

/** DEVICE_MASTER_KEY (64 hex) -> 32 bytes; unset/empty -> null (signing off). Malformed throws: a typo must not
 *  silently disable signing. */
export function parseMasterKey(hex: string | undefined): Buffer | null {
  const s = (hex ?? '').trim();
  if (!s) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error('DEVICE_MASTER_KEY phải là 64 ký tự hex (32 byte)');
  return Buffer.from(s, 'hex');
}

/** Chip UID as 24 lower-case hex, or null. */
export function normUid(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().toLowerCase();
  return HEX_UID.test(s) ? s : null;
}

export const bootHex = (boot: number) => boot.toString(16).padStart(8, '0');

function hmac(key: Buffer, ...parts: (string | Buffer)[]): Buffer {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
}

const sig = (key: Buffer, ...parts: (string | Buffer)[]) => hmac(key, ...parts).toString('hex').slice(0, SIG_HEX);

function sameHex(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function cabinetKey(master: Buffer, uid: string): Buffer {
  const u = normUid(uid);
  if (!u) throw new Error(`UID không hợp lệ: ${uid}`);
  return hmac(master, 'CLK1', Buffer.from(u, 'hex'));
}

export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update('CLFP').update(key).digest('hex').slice(0, 8);
}

export interface CommandSeq {
  /** device boot counter (telemetry LSEQ) */
  boot: number;
  /** per-cabinet message number, strictly increasing within one boot */
  m: number;
}

/**
 * Unsigned frame from buildCommandFrames (*#LTID'..&keys$) -> signed frame. CSEQ/CEXP go right after LTID, CSIG last.
 */
export function signCommand(frame: string, key: Buffer, seq: CommandSeq, nowMs = Date.now()): string {
  const m = /^\*#(LTID'[^&$]+)((?:&[^$]*)?)\$$/.exec(frame);
  if (!m) throw new FrameError('Frame lệnh phải bắt đầu bằng LTID');
  if (/&(CSEQ|CEXP|CSIG)'/i.test(frame)) throw new FrameError('Frame đã được ký');
  if (!Number.isInteger(seq.boot) || seq.boot < 0 || seq.boot > MAX_U32) throw new FrameError(`BOOT không hợp lệ: ${seq.boot}`);
  if (!Number.isInteger(seq.m) || seq.m < 1 || seq.m > MAX_U32) throw new FrameError(`Số thứ tự lệnh không hợp lệ: ${seq.m}`);
  const exp = Math.floor(nowMs / 1000) + CMD_TTL_S;
  const body = `*#${m[1]}&CSEQ'${bootHex(seq.boot)}.${seq.m}&CEXP'${exp}${m[2]}`;
  const out = `${body}&CSIG'${sig(key, 'CL1C', body)}$`;
  if (out.length > MAX_SIGNED_FRAME) throw new FrameError(`Frame đã ký dài ${out.length} ký tự (tối đa ${MAX_SIGNED_FRAME})`);
  return out;
}

export type CommandVerdict =
  | { ok: true; ltid: string; boot: number; m: number; exp: number; frame: string }
  | { ok: false; reason: 'format' | 'signature' | 'boot' | 'sequence' | 'expired' };

/**
 * What the device does with a downlink frame (the simulator uses it; the firmware has its own C copy).
 * frame = the signed frame; on success `frame` is the unsigned frame the device then runs.
 */
export function verifyCommand(raw: string, key: Buffer, dev: { boot: number; lastM: number; nowMs: number | null }): CommandVerdict {
  const at = raw.lastIndexOf("&CSIG'");
  const m = at > 0 ? /^\*#LTID'([^&$]+)&CSEQ'([0-9a-f]{8})\.(\d{1,10})&CEXP'(\d{1,10})((?:&[^$]*)?)$/.exec(raw.slice(0, at)) : null;
  const tail = at > 0 ? /^&CSIG'([0-9a-f]{32})\$$/.exec(raw.slice(at)) : null;
  if (!m || !tail) return { ok: false, reason: 'format' };
  if (!sameHex(sig(key, 'CL1C', raw.slice(0, at)), tail[1]!)) return { ok: false, reason: 'signature' };
  const boot = parseInt(m[2]!, 16);
  const seqM = Number(m[3]);
  const exp = Number(m[4]);
  if (boot !== dev.boot) return { ok: false, reason: 'boot' };
  if (seqM <= dev.lastM || seqM > MAX_U32) return { ok: false, reason: 'sequence' };
  if (dev.nowMs !== null && Math.floor(dev.nowMs / 1000) > exp) return { ok: false, reason: 'expired' };
  return { ok: true, ltid: m[1]!.toUpperCase(), boot, m: seqM, exp, frame: `*#LTID'${m[1]}${m[5]}$` };
}

/** Telemetry identity block as sent (format-checked by the telemetry parser). */
export interface Ident {
  uid: string;
  /** LSEQ, 8 hex */
  seq: string;
  sig: string;
}

export function identSig(key: Buffer, ltid: string, uid: string, seq: string): string {
  return sig(key, 'CL1H', `${ltid.toUpperCase()}|${uid}|${seq}`);
}

/** The LUID/LSEQ/LSIG pairs a device appends to its telemetry. */
export function identPairs(key: Buffer, ltid: string, uid: string, boot: number): [string, string][] {
  const seq = bootHex(boot);
  return [['LUID', uid], ['LSEQ', seq], ['LSIG', identSig(key, ltid, uid, seq)]];
}

export type IdentVerdict = { ok: true; uid: string; boot: number; key: Buffer; fingerprint: string } | { ok: false };

/** Check a telemetry identity block against the master: a valid one proves "board <uid> is at boot <boot>". */
export function verifyIdent(master: Buffer, ltid: string, id: Ident): IdentVerdict {
  const uid = normUid(id.uid);
  if (!uid || !HEX_BOOT.test(id.seq) || !HEX_SIG.test(id.sig)) return { ok: false };
  const key = cabinetKey(master, uid);
  if (!sameHex(identSig(key, ltid, uid, id.seq), id.sig)) return { ok: false };
  return { ok: true, uid, boot: parseInt(id.seq, 16), key, fingerprint: keyFingerprint(key) };
}
