// Jarvis's own storage (never the CityLight database, spec 5.4): who may use Jarvis, chat history, settings, token use.
// node:sqlite (built into Node 22, no native build step on Windows) instead of better-sqlite3; the API is synchronous,
// which is fine for one console at a time. Node prints an ExperimentalWarning for it; scripts pass
// --disable-warning=ExperimentalWarning.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';

// loaded at run time: Vite (vitest 2) does not know node:sqlite and rewrites a static import to "sqlite"
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** Ordered migrations; index + 1 = schema version. Never edit one that has shipped, add a new one. */
const MIGRATIONS: string[] = [
  `CREATE TABLE access (
     user_id        TEXT PRIMARY KEY,
     email          TEXT NOT NULL,
     role_at_grant  TEXT NOT NULL,
     can_use        INTEGER NOT NULL DEFAULT 0,
     can_grant      INTEGER NOT NULL DEFAULT 0,
     can_view_chats INTEGER NOT NULL DEFAULT 0,
     granted_by     TEXT,
     granted_at     TEXT NOT NULL
   );
   CREATE TABLE conversations (
     id         TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL,
     user_role  TEXT NOT NULL,
     title      TEXT,
     started_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX conversations_user ON conversations (user_id, updated_at);
   CREATE TABLE messages (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
     role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
     content         TEXT NOT NULL,
     tool_calls      TEXT,
     tokens_in       INTEGER NOT NULL DEFAULT 0,
     tokens_out      INTEGER NOT NULL DEFAULT 0,
     created_at      TEXT NOT NULL
   );
   CREATE INDEX messages_conversation ON messages (conversation_id, id);
   CREATE INDEX messages_created ON messages (created_at);
   CREATE TABLE settings (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_by TEXT,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE token_usage (
     user_id    TEXT NOT NULL,
     day        TEXT NOT NULL,
     tokens_in  INTEGER NOT NULL DEFAULT 0,
     tokens_out INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, day)
   );`,
  // 2: who has signed in to Jarvis (names for the admin pages; never sent to the model)
  `CREATE TABLE users_seen (
     user_id   TEXT PRIMARY KEY,
     email     TEXT NOT NULL,
     full_name TEXT NOT NULL,
     role      TEXT NOT NULL,
     last_seen TEXT NOT NULL
   );`,
  // 3: Jarvis's own second factor for accounts without CityLight 2FA (2026-11-25); the secret is AES-GCM encrypted
  `CREATE TABLE jarvis_totp (
     user_id      TEXT PRIMARY KEY,
     secret       TEXT NOT NULL,
     enabled      INTEGER NOT NULL DEFAULT 0,
     last_step    INTEGER,
     fails        INTEGER NOT NULL DEFAULT 0,
     locked_until INTEGER,
     created_at   TEXT NOT NULL
   );`,
];

export type Db = DatabaseSyncT;

/** Opens (creating if needed) data/jarvis.db, or an in-memory database for tests. */
export function openDb(file: string | ':memory:'): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

function migrate(db: Db) {
  for (let v = schemaVersion(db); v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Calendar day in Vietnam time (token caps reset at local midnight, spec 8.3). */
export function vnDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function addTokenUsage(db: Db, userId: string, tokensIn: number, tokensOut: number, at: Date = new Date()) {
  db.prepare(
    `INSERT INTO token_usage (user_id, day, tokens_in, tokens_out) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, day) DO UPDATE SET tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out`,
  ).run(userId, vnDay(at), Math.max(0, Math.round(tokensIn)), Math.max(0, Math.round(tokensOut)));
}

/** Tokens used today (Vietnam day), all users together: what the daily cap counts. */
export function tokensToday(db: Db, at: Date = new Date()): number {
  const r = db.prepare('SELECT coalesce(sum(tokens_in + tokens_out), 0) AS n FROM token_usage WHERE day = ?').get(vnDay(at)) as { n: number };
  return Number(r.n);
}

/** Retention job (spec 8.2): conversations untouched for `days` go, with their messages. Returns how many. */
export function purgeHistory(db: Db, days: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return Number(db.prepare('DELETE FROM conversations WHERE updated_at < ?').run(cutoff).changes);
}
