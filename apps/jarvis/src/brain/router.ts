// Keyword router: for questions whose intent is plain, code picks the read tool instead of hoping the model does.
// Measured on qwen3:4b-instruct: with chat history the model often answered from imagination or picked the wrong tool
// ("E201 là gì" -> list_alarms). The router runs the tool first; the model only has to put the result into words.
// Only read tools; returns null when the intent is not clear, and the model decides as usual.
import type { Focus } from '../tools/registry';
import { fold, wordsToDigits } from '../tools/names';

export interface Routed {
  name: string;
  input: Record<string, unknown>;
}

const CODE = /\b(e\d{3})\b/;
const CABINET_REF = /\b([a-z]{2,4}\d{2}\.\d{1,4}|[a-z]{2}\d{4}|dm\s?\d{1,4}|demo\s?(so\s)?\d{1,4})\b|\btu\s(so\s)?\d{1,4}\b|\btu (do|nay)\b/;

/** The cabinet words of the question, for the cabinet argument ("" = the cabinet in focus). */
function cabinetArg(raw: string, f: string, focus: Focus): string | null {
  const m = CABINET_REF.exec(f);
  if (!m) return null;
  if (/\btu (do|nay)\b/.test(m[0])) return focus.cabinet ? 'tủ đó' : null;
  // keep the user's own words around the match so the resolver can still use names
  return m[0].startsWith('tu ') ? raw : m[0];
}

export function route(raw: string, focus: Focus = {}): Routed | null {
  const f = wordsToDigits(fold(raw));
  const code = CODE.exec(f);
  if (code && /(nghia|la gi|la loi gi|ma |giai thich|y nghia)/.test(f)) return { name: 'explain_alarm_code', input: { code: code[1]!.toUpperCase() } };

  const cab = cabinetArg(raw, f, focus);
  if (cab) {
    if (/(toi qua|hom qua|dem qua|sang nay|luc may gio|may gio bat|may gio tat|\d+\s?(gio|h) qua|lich su|bat thuong|ro .*qua)/.test(f))
      return { name: 'get_cabinet_history', input: { cabinet: cab, hours: /tuan/.test(f) ? 168 : 24 } };
    if (/\blich\b/.test(f)) return { name: 'get_schedule', input: { cabinet: cab } };
    if (/(bi gi|the nao|sao roi|tinh trang|trang thai|co sang|co tat|loi gi|kiem tra|ra sao|ok khong|on khong)/.test(f)) return { name: 'get_cabinet', input: { cabinet: cab } };
  }
  if (/(su co|qua han|phieu)/.test(f)) return { name: 'list_incidents', input: { filter: /qua han/.test(f) ? 'overdue' : 'open' } };
  if (/(canh bao|dang loi|co loi|bi loi|loi o dau|loi gi)/.test(f) && /(quan|phuong|khu vuc|o dau|nhieu nhat|nao|dang co|hien co)/.test(f)) return { name: 'list_alarms', input: {} };
  if (/(he thong|tinh hinh|tong quan|bao cao|toan bo|tat ca cac tu)/.test(f) && !cab) return { name: 'get_system_overview', input: {} };
  return null;
}
