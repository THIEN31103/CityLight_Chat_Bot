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

/** words that make a switching sentence a question about the state ("tủ đó đã bật đèn chưa?") */
const QUESTION = /(\?|\bchua\b|\bkhong\b|\bda\b|\bdang\b|co phai|bao gio|luc nao|may gio)/;

/**
 * An order to switch lights ("Bật đèn tủ TL01.0009 lên", "tắt hết đèn quận 1 đi"), not a question about them. Jarvis
 * cannot switch yet (milestone 4): the answer is a fixed sentence. The model used to report the cabinet's state
 * instead, which reads as if the order was carried out (2026-11-14 test C20).
 */
export function isSwitchOrder(raw: string): boolean {
  const f = wordsToDigits(fold(raw));
  if (!ACTION.test(f.replace(/\bbat (va )?tat\b/g, ' '))) return false;
  if (/\b(xac nhan|dong y|huy)\b/.test(f) && !/\b(bat|tat)\b/.test(f)) return false;
  return !QUESTION.test(f);
}
export const SWITCH_ANSWER = 'Tôi chưa được phép bật hay tắt đèn. Bạn thao tác trên web CityLight giúp tôi nhé.';

const CONTROL = /(dieu khien|bat tat|bat den|tat den|bat tu|tat tu|bat nhanh|tat nhanh|gui lenh|ra lenh)/;

/**
 * A question about what Jarvis can do with the lights ("bạn có thể điều khiển đèn chưa", "bạn có tính năng điều khiển
 * tủ chưa"). The model used to look something up instead (the overdue incidents of the question before) and answer
 * about that (user report, 2026-11-14). A question about one cabinet's state has no "bạn" / "Jarvis" in it.
 */
export function isControlCapabilityQuestion(raw: string): boolean {
  const f = fold(raw);
  if (!CONTROL.test(f)) return false;
  const aboutJarvis = /\b(ban|jarvis|gia vit)\b/.test(f) || /(tinh nang|chuc nang)/.test(f);
  const capability = /(co the|duoc (khong|chua|ko)|tinh nang|chuc nang|lam duoc|ho tro|\bbiet\b)/.test(f) || /\bco\b.*\b(chua|khong|ko)\b/.test(f);
  return aboutJarvis && capability;
}
export const CONTROL_CAPABILITY_ANSWER =
  'Chưa. Hiện tôi chỉ xem được dữ liệu: tình trạng tủ, cảnh báo, lịch bật tắt và sự cố. Muốn bật hay tắt đèn, bạn thao tác trên web CityLight giúp tôi nhé.';

/** "tui là ai", "biết tôi là ai không": the answer is the signed-in account, never "tôi không biết" */
export const isWhoAmI = (raw: string) => /\b(tui|toi|minh|tao)\s+la\s+ai\b|\bbiet\s+(tui|toi|minh)\s+(la ai|khong|ko)\b/.test(fold(raw));

const SEVERITY: [RegExp, string][] = [[/nghiem trong/, 'critical'], [/quan trong/, 'major'], [/\bnhe\b/, 'minor']];

/** "các tủ trên đường Lý Thường Kiệt" -> "Lý Thường Kiệt" (the user's own spelling, for the search) */
function streetQuery(raw: string): string | null {
  const m = /(?:đường|phố|duong|pho)\s+([^?.!,;]{2,60})/i.exec(raw);
  return m ? m[1]!.replace(/\s+(không|nhé|nha|với|đi|giúp tôi)\s*$/i, '').trim() || null : null;
}

export function route(raw: string, focus: Focus = {}): Routed | null {
  const folded = fold(raw);
  // codes are read digit by digit: catch them before number words are joined into one number
  const spokenCode = spokenAlarmCode(folded);
  const f = wordsToDigits(folded);
  // "lịch bật tắt tủ đó" talks about the schedule, it does not ask to switch the cabinet off
  // an order is never routed; "tủ đó đã bật đèn chưa?" is a question about the state and is
  if (ACTION.test(f.replace(/\bbat (va )?tat\b/g, ' ')) && !QUESTION.test(f)) return null;
  const code = CODE.exec(f)?.[1]?.toUpperCase() ?? spokenCode;
  if (code && /(nghia|la gi|la loi gi|ma |giai thich|y nghia)/.test(f)) return { name: 'explain_alarm_code', input: { code } };

  const cab = cabinetArg(raw, wordsToDigits(fold(markCabinetWord(raw))), focus);
  if (cab) {
    if (/(toi qua|hom qua|dem qua|sang nay|luc may gio|may gio bat|may gio tat|\d+\s?(gio|h) qua|lich su|bat thuong|ro .*qua)/.test(f))
      return { name: 'get_cabinet_history', input: { cabinet: cab, hours: /tuan/.test(f) ? 168 : 24 } };
    if (/\blich\b/.test(f)) return { name: 'get_schedule', input: { cabinet: cab } };
    // the cabinet answer carries its open alarms too ("tủ đó có cảnh báo gì không")
    if (/(bi gi|the nao|sao roi|tinh trang|trang thai|co sang|co tat|dang sang|dang tat|sang khong|tat khong|loi gi|kiem tra|ra sao|ok khong|on khong|canh bao|bao dong|co loi|bi loi|da bat|da tat|bat (den )?chua|tat (den )?chua|sang chua)/.test(f)) return { name: 'get_cabinet', input: { cabinet: cab } };
  }
  if (/(su co|qua han|phieu)/.test(f)) return { name: 'list_incidents', input: { filter: /qua han/.test(f) ? 'overdue' : 'open' } };
  if (!cab && (/canh bao/.test(f) || (/(dang loi|co loi|bi loi|loi o dau|loi gi)/.test(f) && /(quan|phuong|khu vuc|o dau|nhieu nhat|nao|dang co|hien co)/.test(f)))) {
    const severity = SEVERITY.find(([re]) => re.test(f))?.[1];
    return { name: 'list_alarms', input: severity ? { severity } : {} };
  }
  if (!cab) {
    const street = streetQuery(raw);
    if (street && /\btucab\b|\btim\b/.test(wordsToDigits(fold(markCabinetWord(raw))))) return { name: 'find_cabinets', input: { query: street } };
  }
  if (/(nhung|cac|danh sach|bao nhieu|may) (khu vuc|quan|phuong)\b|\b(khu vuc|quan|phuong) nao\b/.test(f) && !cab) return { name: 'list_areas', input: {} };
  if (/(he thong|tinh hinh|tong quan|bao cao|toan bo|tat ca cac tu)/.test(f) && !cab) return { name: 'get_system_overview', input: {} };
  return null;
}
