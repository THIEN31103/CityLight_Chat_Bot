// Audit trail (spec 6.9): one JSON line per event in data/audit/YYYY-MM-DD.jsonl (Vietnam day).
// Sign-ins, what people asked, what Jarvis answered, tool calls, access / settings changes, reading someone else's chat.
// Never audio, OTP, passwords, cookies or keys: every string goes through sanitizeText and secret-looking keys are dropped.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { sanitizeForLlm } from '../sanitize/llm';
import { vnDay } from '../store/db';

export type AuditKind =
  | 'login' | 'login_failed' | 'logout' | 'access_denied' | 'bootstrap_admin'
  | 'user_text' | 'assistant_text' | 'tool_call'
  | 'access_change' | 'settings_change' | 'view_chat' | 'delete_chat'
  | 'delete_all_chats'
  | 'rename_chat' | 'token_cap_hit' | 'rate_limited' | 'reauth' | 'proactive'
  | 'jarvis_2fa_asked' | 'jarvis_2fa_setup' | 'jarvis_2fa_wrong' | 'jarvis_2fa_reset'
  // milestone 4: every pending action, who confirmed it how, and what the command did
  | 'pending_created' | 'pending_confirmed' | 'pending_cancelled' | 'pending_refused' | 'action_refused' | 'command_result';

export interface AuditEvent {
  kind: AuditKind;
  userId?: string;
  role?: string;
  [k: string]: unknown;
}

const NEVER = /password|otp|code|cookie|token$|secret|csrf/i;

export class AuditLog {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  write(ev: AuditEvent, at: Date = new Date()) {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ev)) if (!NEVER.test(k) || k === 'kind') clean[k] = v;
    const line = JSON.stringify({ at: at.toISOString(), ...(sanitizeForLlm(clean) as object) });
    appendFileSync(path.join(this.dir, `${vnDay(at)}.jsonl`), `${line}\n`, 'utf8');
  }
}
