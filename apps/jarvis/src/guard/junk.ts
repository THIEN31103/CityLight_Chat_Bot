// Text that is not a question (2026-11-23: "admin@citylight.test" typed into the chat was answered with the system
// overview). Caught in code before the model: an answer made of real numbers to a meaningless line reads as if Jarvis
// understood it. Also passwords and OTP codes typed by mistake: never sent to the model, stored masked.
import { fold } from '../tools/names';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL = /\bhttps?:\/\/\S+|\bwww\.\S+/i;
const all = (re: RegExp) => new RegExp(re.source, `${re.flags}g`);

/** one Vietnamese syllable without accents: optional initial, vowels, optional final */
const SYLLABLE = /^(ngh|ng|nh|ch|gh|gi|kh|ph|qu|th|tr|[bcdghklmnpqrstvxr])?[aeiouy]{1,3}(nh|ng|ch|[cmnpt])?$/;
/** words that are not Vietnamese syllables but belong in a question to Jarvis */
const KNOWN = new Set(['jarvis', 'plc', 'logo', 'lte', 'ok', 'oke', 'okay', 'hi', 'hello', 'alo', 'bye', 'thanks', 'thank', 'you', 'rs485', 'eth', 'gps', 'kwh', 'demo', 'admin']);
/** a cabinet or alarm code, a number, a time: "tl01.0009", "e201", "dm10", "18:00", "2" */
const CODE_LIKE = /^([a-z]{1,4}\d[\d.]*|\d[\d.:,/h-]*)$/;

/** the words after which a typed password or code would come */
const SECRET_WORD = /^(mat khau|password|passwd|pass|mk|otp|ma xac thuc|ma otp)$/;
/** a value that looks like a password or a code, not an ordinary word ("mật khẩu của tài khoản" is a question) */
const looksSecret = (v: string) => (/\d/.test(v) && v.length >= 4) || (v.length >= 6 && !SYLLABLE.test(fold(v)) && !KNOWN.has(fold(v)));

/** [start, end) of each secret value in the text: the token after "mật khẩu", "pass", "OTP"… (and "là", ":", "=") */
function secretSpans(text: string): [number, number][] {
  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ s: m.index!, e: m.index! + m[0].length, w: m[0] }));
  const spans: [number, number][] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (const n of [2, 3, 1]) {
      const key = fold(tokens.slice(i, i + n).map((t) => t.w).join(' ')).replace(/[:=]+$/, '');
      if (!SECRET_WORD.test(key)) continue;
      let j = i + n;
      if (tokens[j] && /^(la|:|=)$/.test(fold(tokens[j]!.w))) j++;
      const v = tokens[j];
      if (v && looksSecret(v.w.replace(/^[:=]/, ''))) spans.push([v.s, v.e]);
      break;
    }
  }
  return spans;
}

/** true when the text holds a typed password or code */
export const hasSecret = (text: string) => secretSpans(text).length > 0;

/** the text with emails and typed passwords / codes hidden: what the model, history and the audit log get */
export function maskSecrets(text: string): string {
  let out = text;
  for (const [s, e] of secretSpans(text).reverse()) out = `${out.slice(0, s)}***${out.slice(e)}`;
  return out.replace(all(EMAIL), '***@***');
}

/** only an email address or a link, nothing else to read */
export function onlyLinks(text: string): boolean {
  const t = text.trim();
  const rest = t.replace(all(EMAIL), ' ').replace(all(URL), ' ').trim();
  return rest !== t && !/\p{L}{2,}/u.test(rest);
}

const EXAMPLE = 'Bạn hỏi về tình trạng tủ, cảnh báo, lịch, khu vực, hoặc ra lệnh cho một tủ, ví dụ "Hệ thống hôm nay thế nào?".';

/** A fixed answer when the text is not something Jarvis can answer; null for anything that may be a real question. */
export function junkReply(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (secretSpans(t).length)
    return 'Bạn đừng gõ mật khẩu hay mã OTP vào ô chat: Jarvis không bao giờ cần chúng, và câu này không được gửi cho AI. Nếu đó là mật khẩu thật, bạn nên đổi mật khẩu trên web CityLight.';
  const rest = t.replace(all(EMAIL), ' ').replace(all(URL), ' ').trim();
  if (rest !== t && !/\p{L}{2,}/u.test(rest))
    return `Tôi không hiểu: đây là ${EMAIL.test(t) ? 'một địa chỉ email' : 'một đường dẫn'}, không phải câu hỏi. Bạn đã đăng nhập rồi, không cần gõ email. ${EXAMPLE}`;
  const words = fold(rest).replace(/[^a-z0-9.:,/ -]/g, ' ').split(/\s+/).map((w) => w.replace(/^[.,:/-]+|[.,:/-]+$/g, '')).filter(Boolean);
  if (!words.length) return `Tôi không hiểu câu này. ${EXAMPLE}`;
  // no word is a Vietnamese syllable, a known word or a code: keyboard noise ("asdfgh", "qwerty zxcv")
  if (!words.some((w) => SYLLABLE.test(w) || KNOWN.has(w) || CODE_LIKE.test(w))) {
    const shown = maskSecrets(t);
    return `Tôi không hiểu "${shown.length > 40 ? `${shown.slice(0, 40)}…` : shown}". ${EXAMPLE}`;
  }
  return null;
}
