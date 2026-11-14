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
// "tủ" (cabinet) and "từ" (from) both fold to "tu": the cabinet word is marked as "tucab" before folding
const CABINET_REF = /\b([a-z]{2,4}\d{2}\.\d{1,4}|[a-z]{2}\d{4}|dm\s?\d{1,4}|demo\s?(so\s)?\d{1,4})\b|\btucab\s(so\s)?\d{1,4}\b|\btucab (do|nay)\b/;
const markCabinetWord = (raw: string) => raw.replace(/(^|[^\p{L}])[tT][ủỦ](?=[^\p{L}]|$)/gu, '$1tucab');

/** The cabinet words of the question, for the cabinet argument ("" = the cabinet in focus). */
function cabinetArg(raw: string, marked: string, focus: Focus): string | null {
  const m = CABINET_REF.exec(marked);
  if (!m) return null;
  if (/\btucab (do|nay)\b/.test(m[0])) return focus.cabinet ? 'tủ đó' : null;
  // keep the user's own words around the match so the resolver can still use names
  return m[0].startsWith('tucab ') ? raw : m[0];
}

/** switching words: these are requests to act, never routed to a read tool (actions come in milestone 4) */
const ACTION = /\b(bat tay|bat nhanh|bat tu|bat den|bat het|tat tay|tat nhanh|tat tu|tat den|tat het|tra (tu|ve)|chay theo lich|xung bat|xac nhan|dong y|huy)\b/;

const DIGIT: Record<string, string> = { khong: '0', mot: '1', hai: '2', ba: '3', bon: '4', tu: '4', nam: '5', sau: '6', bay: '7', tam: '8', chin: '9' };
const DIGIT_WORD = `(?:${Object.keys(DIGIT).join('|')}|\\d)`;
const SPOKEN_CODE = new RegExp(`\\be\\s*((?:${DIGIT_WORD}[\\s,.-]*){3})`);

/** An alarm code read digit by digit ("E hai không một", "e 2 0 1", "e200 1") -> "E201"; null when there is none. */
export function spokenAlarmCode(folded: string): string | null {
  const m = SPOKEN_CODE.exec(folded);
  if (!m) return null;
  const digits = (m[1]!.match(new RegExp(DIGIT_WORD, 'g')) ?? []).map((w) => DIGIT[w] ?? w).join('');
  return digits.length >= 3 ? `E${digits.slice(0, 3)}` : null;
}

export function route(raw: string, focus: Focus = {}): Routed | null {
  const folded = fold(raw);
  // codes are read digit by digit: catch them before number words are joined into one number
  const spokenCode = spokenAlarmCode(folded);
  const f = wordsToDigits(folded);
  // "lịch bật tắt tủ đó" talks about the schedule, it does not ask to switch the cabinet off
  if (ACTION.test(f.replace(/\bbat (va )?tat\b/g, ' '))) return null;
  const code = CODE.exec(f)?.[1]?.toUpperCase() ?? spokenCode;
  if (code && /(nghia|la gi|la loi gi|ma |giai thich|y nghia)/.test(f)) return { name: 'explain_alarm_code', input: { code } };

  const cab = cabinetArg(raw, wordsToDigits(fold(markCabinetWord(raw))), focus);
  if (cab) {
    if (/(toi qua|hom qua|dem qua|sang nay|luc may gio|may gio bat|may gio tat|\d+\s?(gio|h) qua|lich su|bat thuong|ro .*qua)/.test(f))
      return { name: 'get_cabinet_history', input: { cabinet: cab, hours: /tuan/.test(f) ? 168 : 24 } };
    if (/\blich\b/.test(f)) return { name: 'get_schedule', input: { cabinet: cab } };
    if (/(bi gi|the nao|sao roi|tinh trang|trang thai|co sang|co tat|dang sang|dang tat|sang khong|tat khong|loi gi|kiem tra|ra sao|ok khong|on khong)/.test(f)) return { name: 'get_cabinet', input: { cabinet: cab } };
  }
  if (/(su co|qua han|phieu)/.test(f)) return { name: 'list_incidents', input: { filter: /qua han/.test(f) ? 'overdue' : 'open' } };
  if (/(canh bao|dang loi|co loi|bi loi|loi o dau|loi gi)/.test(f) && /(quan|phuong|khu vuc|o dau|nhieu nhat|nao|dang co|hien co)/.test(f)) return { name: 'list_alarms', input: {} };
  if (/(he thong|tinh hinh|tong quan|bao cao|toan bo|tat ca cac tu)/.test(f) && !cab) return { name: 'get_system_overview', input: {} };
  return null;
}
