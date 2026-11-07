// LTID is the address a board answers to on the shared broker, so it is provider-only: anyone else who knows it can
// aim frames at that cabinet. Everything here runs on the way out of the API, the realtime gateway and the exports.
import { hasPermission } from './permissions';
import type { RoleKey } from './domain';

export const canSeeLtid = (role: RoleKey | null | undefined): boolean => !!role && hasPermission(role, 'device.identity');

// a word that only starts with Latin letters ("LTID của", "LTID mới") is a sentence, not a value
const LTID_IN_TEXT = /\bLTID\s+(?!filter\b)[A-Za-z0-9_-]+(?![\p{L}\p{M}])/gu;
const LTID_IN_JSON = /"ltid"\s*:\s*"[^"]*"/gi;

/** Stored text (activity log, alarm message, incident content) with any LTID value blanked. */
export function scrubLtid(text: string): string {
  return /ltid/i.test(text) ? text.replace(LTID_IN_TEXT, 'LTID ***').replace(LTID_IN_JSON, '"ltid":"***"') : text;
}

/** A copy of a JSON response without any `ltid` field or LTID value in its text. Never mutates: rows may be cached. */
export function stripLtid<T>(value: T): T {
  return walk(value) as T;
}

function walk(v: unknown): unknown {
  if (typeof v === 'string') return scrubLtid(v);
  if (Array.isArray(v)) return Array.from(v, walk);
  if (v === null || typeof v !== 'object') return v;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v; // Date, Buffer, stream: nothing readable to strip
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (k.toLowerCase() !== 'ltid') out[k] = walk(x);
  return out;
}
