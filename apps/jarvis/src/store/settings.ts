// Jarvis settings (G8, spec 8.3): kept in SQLite, .env gives the defaults. The hard daily token cap
// (JARVIS_DAILY_TOKEN_CAP_MAX) can never be exceeded from the console; JARVIS_ACTIONS_ENABLED=false in .env cannot be
// switched back on from the console.
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from './db';

export interface Settings {
  actionsEnabled: boolean;
  perUserPerMin: number;
  /** 0 = no cap of its own (the hard cap still applies) */
  dailyTokenCap: number;
  historyDays: number;
}

type Limits = Pick<Config, 'actionsEnabled' | 'perUserPerMin' | 'dailyTokenCap' | 'dailyTokenCapMax' | 'historyDays'>;

const KEY = 'settings';

export function defaults(cfg: Limits): Settings {
  return { actionsEnabled: cfg.actionsEnabled, perUserPerMin: cfg.perUserPerMin, dailyTokenCap: cfg.dailyTokenCap, historyDays: cfg.historyDays };
}

export function getSettings(db: Db, cfg: Limits): Settings {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  const s = { ...defaults(cfg), ...(r ? (JSON.parse(r.value) as Partial<Settings>) : {}) };
  if (!cfg.actionsEnabled) s.actionsEnabled = false;
  return s;
}

/** Cap actually applied today: min(cap or MAX, MAX); 0 = unlimited (no cap anywhere). */
export function effectiveTokenCap(s: Settings, cfg: Pick<Config, 'dailyTokenCapMax'>): number {
  const max = cfg.dailyTokenCapMax;
  if (max > 0) return Math.min(s.dailyTokenCap || max, max);
  return s.dailyTokenCap;
}

export class SettingsError extends Error {}

export function validateSettings(next: Settings, cfg: Limits): Settings {
  const parsed = z
    .object({
      actionsEnabled: z.boolean(),
      perUserPerMin: z.number().int().min(1).max(60),
      dailyTokenCap: z.number().int().min(0),
      historyDays: z.number().int().min(7).max(365),
    })
    .safeParse(next);
  if (!parsed.success) throw new SettingsError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const s = parsed.data;
  if (cfg.dailyTokenCapMax > 0 && (s.dailyTokenCap < 1 || s.dailyTokenCap > cfg.dailyTokenCapMax))
    throw new SettingsError(`Trần token / ngày phải trong 1..${cfg.dailyTokenCapMax} (trần cứng của máy chủ)`);
  if (s.actionsEnabled && !cfg.actionsEnabled) throw new SettingsError('Chức năng điều khiển đang bị tắt trong .env (JARVIS_ACTIONS_ENABLED=false), không bật lại từ console được');
  return s;
}

/** Saves a change; returns before / after for the audit. */
export function updateSettings(db: Db, cfg: Limits, patch: Partial<Settings>, by: string) {
  const before = getSettings(db, cfg);
  const after = validateSettings({ ...before, ...patch }, cfg);
  db.prepare(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(KEY, JSON.stringify(after), by, new Date().toISOString());
  return { before, after };
}
