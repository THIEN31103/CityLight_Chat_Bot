// Jarvis's own second factor (user request 2026-11-25: "đăng nhập Jarvis phải xác thực riêng"). An account that has
// 2FA on CityLight answers CityLight's challenge as before; one without it gets a Jarvis entry in the authenticator app
// on its first sign-in and gives its code at every sign-in and for a batch. Wrong codes count: 5 in a row lock the
// account out of Jarvis for 15 minutes. The secret is encrypted with JARVIS_SECRET_KEY, or with a key Jarvis creates
// once in its data folder (never in git).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, newTotpSecret, verifyTotp } from '../auth/totp';
import type { Db } from './db';

export const MAX_FAILS = 5;
export const LOCK_MS = 15 * 60_000;

/** 32 bytes from JARVIS_SECRET_KEY (64 hex or base64), else from <dataDir>/jarvis-secret.key, created once (0600) */
export function secretKey(dataDir: string, fromEnv?: string): Buffer {
  const parse = (raw: string) => {
    const k = /^[0-9a-f]{64}$/i.test(raw.trim()) ? Buffer.from(raw.trim(), 'hex') : Buffer.from(raw.trim(), 'base64');
    if (k.length !== 32) throw new Error('JARVIS_SECRET_KEY: 32 bytes, as 64 hex characters or base64');
    return k;
  };
  if (fromEnv) return parse(fromEnv);
  const file = path.join(dataDir, 'jarvis-secret.key');
  if (existsSync(file)) return parse(readFileSync(file, 'utf8'));
  mkdirSync(dataDir, { recursive: true });
  const k = randomBytes(32);
  writeFileSync(file, k.toString('hex'), { mode: 0o600 });
  return k;
}

type Row = { user_id: string; secret: string; enabled: number; last_step: number | null; fails: number; locked_until: number | null };

export class Jarvis2fa {
  /** key: read or created only when a secret is stored or read */
  constructor(private readonly db: Db, private readonly key: () => Buffer) {}

  private row(userId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM jarvis_totp WHERE user_id = ?').get(userId) as Row | undefined;
  }

  enabled(userId: string): boolean {
    return this.row(userId)?.enabled === 1;
  }

  /** minutes left of a lock after too many wrong codes, 0 when not locked */
  lockedFor(userId: string, now = Date.now()): number {
    const r = this.row(userId);
    return r?.locked_until && r.locked_until > now ? Math.ceil((r.locked_until - now) / 60_000) : 0;
  }

  /** a new secret for a first sign-in (replaces one never confirmed); stored only once confirmed */
  newSecret(): Buffer {
    return newTotpSecret();
  }

  /** the first code from the app: right → the secret is kept and enabled */
  confirmSetup(userId: string, secret: Buffer, code: string, now = Date.now()): boolean {
    const step = verifyTotp(secret, code, null, now);
    if (step === null) return false;
    this.db.prepare(`INSERT INTO jarvis_totp (user_id, secret, enabled, last_step, fails, locked_until, created_at) VALUES (?, ?, 1, ?, 0, NULL, ?)
      ON CONFLICT (user_id) DO UPDATE SET secret = excluded.secret, enabled = 1, last_step = excluded.last_step, fails = 0, locked_until = NULL, created_at = excluded.created_at`)
      .run(userId, encryptSecret(secret, this.key()), step, new Date(now).toISOString());
    return true;
  }

  /**
   * A code at sign-in or for a batch. Each code works once; 5 wrong in a row lock for 15 minutes.
   * 'ok' | 'bad' | 'locked' | 'none' (no Jarvis 2FA for this account).
   */
  check(userId: string, code: string, now = Date.now()): 'ok' | 'bad' | 'locked' | 'none' {
    const r = this.row(userId);
    if (!r || r.enabled !== 1) return 'none';
    if (r.locked_until && r.locked_until > now) return 'locked';
    const step = verifyTotp(decryptSecret(r.secret, this.key()), code, r.last_step, now);
    if (step === null) {
      const fails = r.fails + 1;
      this.db.prepare('UPDATE jarvis_totp SET fails = ?, locked_until = ? WHERE user_id = ?').run(fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? now + LOCK_MS : null, userId);
      return fails >= MAX_FAILS ? 'locked' : 'bad';
    }
    this.db.prepare('UPDATE jarvis_totp SET last_step = ?, fails = 0, locked_until = NULL WHERE user_id = ?').run(step, userId);
    return 'ok';
  }

  /** lost phone: an administrator removes it, the next sign-in sets up a new one */
  reset(userId: string): boolean {
    return Number(this.db.prepare('DELETE FROM jarvis_totp WHERE user_id = ?').run(userId).changes) > 0;
  }
}
