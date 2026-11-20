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

/** The cabinet a sentence names, as words for the resolver ("tủ đó" = the one in focus); null = none named. */
export const cabinetRefOf = (raw: string, focus: Focus): string | null => cabinetArg(raw, wordsToDigits(fold(markCabinetWord(raw))), focus);

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
// An order the parser in guard/orders.ts did not understand reaches the agent: say how to give it, never "cannot"
// (Jarvis switches cabinets since milestone 4; when control is off the console says why, from guard/policy.ts)
export const SWITCH_ANSWER = 'Tôi chưa hiểu lệnh này. Bạn nói rõ tủ và việc cần làm, ví dụ "bật đèn tủ TL01.0016" hoặc "tắt nhánh 2 tủ đó", tôi sẽ hỏi lại để bạn xác nhận.';

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
/** only when the agent runs without the console (scripts): the console answers from the guard state */
export const CONTROL_CAPABILITY_ANSWER =
  'Tôi bật, tắt, trả về lịch, bật xung hoặc gửi lệnh tự kiểm tra cho từng tủ được phép, và chỉ gửi sau khi bạn xác nhận.';

/** "tui là ai", "biết tôi là ai không": the answer is the signed-in account, never "tôi không biết" */
export const isWhoAmI = (raw: string) => /\b(tui|toi|minh|tao)\s+la\s+ai\b|\bbiet\s+(tui|toi|minh)\s+(la ai|khong|ko)\b/.test(fold(raw));

const SEVERITY: [RegExp, string][] = [[/nghiem trong/, 'critical'], [/quan trong/, 'major'], [/\bnhe\b/, 'minor']];

/** "các tủ trên đường Lý Thường Kiệt" -> "Lý Thường Kiệt" (the user's own spelling, for the search) */
function streetQuery(raw: string): string | null {
  const m = /(?:đường|phố|duong|pho)\s+([^?.!,;]{2,60})/i.exec(raw);
  return m ? m[1]!.replace(/\s+(không|nhé|nha|với|đi|giúp tôi)\s*$/i, '').trim() || null : null;
}

/** "bạn có thể liệt kê các tủ như nào": asks HOW, not for a list (2026-11-20: the model listed the cabinets of the question before) */
const LIST_HOW = /(nhu nao|the nao|cach nao|bang cach|lam sao|ra sao|nhung gi|kieu gi)/;
export function isListHowQuestion(raw: string): boolean {
  const m = wordsToDigits(fold(markCabinetWord(raw)));
  return /(liet ke|danh sach)/.test(m) && /\btucab\b/.test(m) && LIST_HOW.test(m) && !/\d/.test(m) && !STATE_WORDS.some(([re]) => re.test(m));
}
export const LIST_HOW_ANSWER =
  'Tôi liệt kê được các tủ theo trạng thái: bình thường, đang sáng, đang tắt, có lỗi hoặc mất kết nối, trên toàn hệ thống hoặc theo quận, phường. Bạn nói ví dụ "liệt kê 10 tủ mất kết nối ở quận 1".';

const STATE_WORDS: [RegExp, string][] = [
  [/binh thuong|on dinh|hoat dong (tot|on)|khong (co )?loi/, 'binh_thuong'],
  [/mat ket noi|offline|mat song|mat lien lac/, 'mat_ket_noi'],
  [/dang (bi )?loi|co loi|bi loi|\bhong\b/, 'co_loi'],
  [/dang sang|dang bat|bat den|den sang/, 'dang_sang'],
  [/dang tat|tat den/, 'dang_tat'],
];

/**
 * "liệt kê 10 mã tủ đang hoạt động bình thường", "tủ nào mất kết nối": a list of cabinets over the whole system,
 * optionally by state. The model used to ask which area first (user report 2026-11-20). Counts ("bao nhiêu") stay
 * with the overview; a named area is left to the model, which passes it.
 */
function cabinetList(m: string): { state?: string; limit?: number } | null {
  if (/bao nhieu|\b(quan|phuong|khu vuc|huyen)\b/.test(m) || LIST_HOW.test(m)) return null;
  const state = STATE_WORDS.find(([re]) => re.test(m))?.[1];
  const strong = /(liet ke|danh sach)/.test(m) && /\btucab\b/.test(m);
  const weak = /(\btucab nao\b|nhung tucab|cac tucab|ma tucab|\d+ (ma )?tucab)/.test(m);
  if (!strong && !(weak && state)) return null;
  const n = /\b(\d+) (ma )?tucab\b/.exec(m)?.[1];
  const limit = n ? Math.min(30, Math.max(1, Number(n))) : undefined;
  return { ...(state ? { state } : {}), ...(limit ? { limit } : {}) };
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
  if (!cab) {
    const listed = cabinetList(wordsToDigits(fold(markCabinetWord(raw))));
    if (listed) return { name: 'get_area_cabinets', input: listed };
  }
  // "khu vực nào cũng được" answers a question, it does not ask for the list of areas
  if (/(nhung|cac|danh sach|bao nhieu|may) (khu vuc|quan|phuong)\b|\b(khu vuc|quan|phuong) nao\b/.test(f) && !/\bnao cung\b/.test(f) && !cab) return { name: 'list_areas', input: {} };
  if (/(he thong|tinh hinh|tong quan|bao cao|toan bo|tat ca cac tu)/.test(f) && !cab) return { name: 'get_system_overview', input: {} };
  return null;
}
