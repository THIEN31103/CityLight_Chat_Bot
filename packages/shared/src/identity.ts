// Cabinet identity on the anonymous broker (owner decision 2026-10-20, S42): until devices log in with a
// user/pass, a frame is only trusted when its IMEI (LIME) matches the one the cabinet first reported.
// Anyone on the Internet can publish an LTID; few know the IMEI (telemetry is not readable anonymously).

/** E805 stays open this long after the last frame with a foreign IMEI. */
export const SPOOF_HOLD_MS = 10 * 60_000;

export type ImeiVerdict = 'ok' | 'learn' | 'mismatch';

/** Normalised IMEI or null (LIME'X, empty, junk). */
export function normImei(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return /^\d{14,17}$/.test(s) ? s : null;
}

/**
 * registered = cabinets.imei. No IMEI yet: the first frame that carries one is learned (trust on first use).
 * Afterwards a different or missing IMEI is a mismatch: the frame is not applied (a spoofer would just omit it).
 */
export function checkImei(registered: string | null, frame: string | null): ImeiVerdict {
  const reg = normImei(registered);
  const got = normImei(frame);
  if (!reg) return got ? 'learn' : 'ok';
  return got === reg ? 'ok' : 'mismatch';
}

/** A lower boot counter is accepted (chip erased / re-flashed) after this many valid identities in a row carry it. */
export const BOOT_RESET_FRAMES = 3;

export type IdentVerdict = 'learn' | 'same' | 'advance' | 'stale' | 'reset' | 'foreign';

/**
 * A validly signed telemetry identity (D7-lite, S59) against the cabinet's recorded UID and boot.
 * learn = no UID yet (trust on first valid signature); foreign = another board (E805, decision K7);
 * advance = boot went up (normal reboot); stale = lower boot, ignored until it repeats BOOT_RESET_FRAMES times
 * in a row (reset). A replayed old identity can only delay commands: the device rejects a boot it is past.
 * `lower` is the caller's running count of the lower boot (null after anything else).
 */
export function judgeIdent(
  reg: { uid: string | null; boot: number | null },
  got: { uid: string; boot: number },
  lower: { boot: number; n: number } | null,
): { verdict: IdentVerdict; lower: { boot: number; n: number } | null } {
  if (!reg.uid) return { verdict: 'learn', lower: null };
  if (got.uid !== reg.uid) return { verdict: 'foreign', lower };
  if (reg.boot === null || got.boot > reg.boot) return { verdict: 'advance', lower: null };
  if (got.boot === reg.boot) return { verdict: 'same', lower: null };
  const n = lower?.boot === got.boot ? lower.n + 1 : 1;
  return n >= BOOT_RESET_FRAMES ? { verdict: 'reset', lower: null } : { verdict: 'stale', lower: { boot: got.boot, n } };
}

/**
 * Per-key token bucket: `burst` frames at once, then `perSec`. Firmware sends at most one telemetry frame per
 * second (10 s period, 0.5 s coalesce on change, 1 s minimum gap), so a cabinet never hits the default.
 */
export class FrameBudget {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly burst = 5,
    private readonly perSec = 1,
    private readonly maxKeys = 50_000,
  ) {}

  take(key: string, now = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      b = { tokens: this.burst, at: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSec);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Forget keys that are full again (idle long enough): bounded memory under a flood of random LTIDs. */
  prune(now = Date.now()) {
    const full = (this.burst / this.perSec) * 1000;
    for (const [k, b] of this.buckets) if (now - b.at >= full) this.buckets.delete(k);
  }
}
