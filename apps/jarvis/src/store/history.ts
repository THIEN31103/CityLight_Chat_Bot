// Chat history (G7, spec 8.2): stored after sanitize, kept `historyDays`, own chats for everyone, others' chats only
// through canViewChatsOf (and every such read is audited by the caller).
import { randomUUID } from 'node:crypto';
import type { RoleKey } from '@citylight/shared';
import { sanitizeText } from '../sanitize/llm';
import type { Db } from './db';

export interface ConversationRow {
  id: string;
  userId: string;
  userRole: RoleKey;
  title: string | null;
  startedAt: string;
  updatedAt: string;
  messages: number;
  email?: string;
  fullName?: string;
}

export interface MessageRow {
  id: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls: unknown;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
}

export function createConversation(db: Db, user: { id: string; role: RoleKey }, firstText: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO conversations (id, user_id, user_role, title, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, user.id, user.role, sanitizeText(firstText).slice(0, 80), now, now,
  );
  return id;
}

export function addMessage(
  db: Db,
  conversationId: string,
  m: { role: MessageRow['role']; content: string; toolCalls?: unknown; tokensIn?: number; tokensOut?: number },
) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO messages (conversation_id, role, content, tool_calls, tokens_in, tokens_out, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    conversationId, m.role, sanitizeText(m.content), m.toolCalls === undefined ? null : sanitizeText(JSON.stringify(m.toolCalls)),
    Math.round(m.tokensIn ?? 0), Math.round(m.tokensOut ?? 0), now,
  );
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
}

interface ConvRow { id: string; user_id: string; user_role: RoleKey; title: string | null; started_at: string; updated_at: string; n: number; email: string | null; full_name: string | null }
const conv = (r: ConvRow): ConversationRow => ({
  id: r.id, userId: r.user_id, userRole: r.user_role, title: r.title, startedAt: r.started_at, updatedAt: r.updated_at, messages: r.n,
  email: r.email ?? undefined, fullName: r.full_name ?? undefined,
});
const CONV_SELECT = `SELECT c.*, (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user','assistant')) AS n,
                            u.email, u.full_name
                     FROM conversations c LEFT JOIN users_seen u ON u.user_id = c.user_id`;

export function listOwn(db: Db, userId: string, limit = 50): ConversationRow[] {
  return (db.prepare(`${CONV_SELECT} WHERE c.user_id = ? ORDER BY c.updated_at DESC LIMIT ?`).all(userId, limit) as unknown as ConvRow[]).map(conv);
}

/** Conversations of other people, newest first; the caller filters with canViewChatsOf. */
export function listAll(db: Db, f: { userId?: string; from?: string; to?: string; limit?: number } = {}): ConversationRow[] {
  const rows = db.prepare(
    `${CONV_SELECT} WHERE (? IS NULL OR c.user_id = ?) AND (? IS NULL OR c.updated_at >= ?) AND (? IS NULL OR c.started_at <= ?)
     ORDER BY c.updated_at DESC LIMIT ?`,
  ).all(f.userId ?? null, f.userId ?? null, f.from ?? null, f.from ?? null, f.to ?? null, f.to ?? null, f.limit ?? 200) as unknown as ConvRow[];
  return rows.map(conv);
}

export function getConversation(db: Db, id: string): ConversationRow | null {
  const r = db.prepare(`${CONV_SELECT} WHERE c.id = ?`).get(id) as ConvRow | undefined;
  return r ? conv(r) : null;
}

export function getMessages(db: Db, conversationId: string): MessageRow[] {
  const rows = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId) as {
    id: number; role: MessageRow['role']; content: string; tool_calls: string | null; tokens_in: number; tokens_out: number; created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id, role: r.role, content: r.content, toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : null, tokensIn: r.tokens_in, tokensOut: r.tokens_out, createdAt: r.created_at,
  }));
}

/** Deletes one of the user's own conversations; false when it is not theirs. */
export function deleteOwn(db: Db, userId: string, id: string): boolean {
  return Number(db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(id, userId).changes) === 1;
}

/** Deletes every conversation of the user (their messages go with them); returns how many. */
export function deleteAllOwn(db: Db, userId: string): number {
  return Number(db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userId).changes);
}

export const TITLE_MAX = 80;

/** Renames one of the user's own conversations; false when it is not theirs. The title is sanitized like messages. */
export function renameOwn(db: Db, userId: string, id: string, title: string): boolean {
  return Number(db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?').run(sanitizeText(title).slice(0, TITLE_MAX), id, userId).changes) === 1;
}

/** Tokens per user per Vietnam day, newest day first. */
export function tokenReport(db: Db, days: number) {
  return db.prepare(
    `SELECT t.day, t.user_id AS userId, u.email, u.full_name AS fullName, u.role, t.tokens_in AS tokensIn, t.tokens_out AS tokensOut
     FROM token_usage t LEFT JOIN users_seen u ON u.user_id = t.user_id
     WHERE t.day >= ? ORDER BY t.day DESC, (t.tokens_in + t.tokens_out) DESC`,
  ).all(new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)) as unknown as {
    day: string; userId: string; email: string | null; fullName: string | null; role: string | null; tokensIn: number; tokensOut: number;
  }[];
}
