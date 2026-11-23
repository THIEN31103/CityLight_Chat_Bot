// Account and security questions (user rule 2026-11-23: "tuyệt đối không được tiết lộ gì về tài khoản", "chặn toàn
// bộ những khả năng mà người có thể cố tình hỏi để biết bảo mật tài khoản"). Answered in code with one fixed sentence,
// before any order or tool and never by the model, whoever asks and however it is worded.
//
// This is the first of several layers; the others do not depend on it:
//  - the model holds no account data: no tool reads users, tool results drop person fields (sanitize/llm.ts), the
//    system prompt carries the role only, not the name;
//  - the model's answer is checked again before it is shown or spoken (leaksAccount below).
import { fold } from '../tools/names';

/** letters only, leetspeak undone: "p@ssw0rd", "m.ậ.t k-h-ẩ-u", "mật khẩu" all become "password" / "matkhau" */
function compact(raw: string): string {
  return fold(raw)
    .replace(/@/g, 'a').replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[$5]/g, 's').replace(/4/g, 'a').replace(/7/g, 't')
    .replace(/[^a-z]/g, '');
}

/** words that only appear in a question about accounts or security, written without spaces */
const SECRET_STEMS = [
  'matkhau', 'password', 'passwd', 'passcode', 'credential', 'apikey', 'khoaapi', 'secretkey', 'privatekey',
  'cookie', 'phiendangnhap', 'sessionid', 'bearer', 'maxacthuc', 'totp',
  'makhoiphuc', 'recoverycode', 'tendangnhap', 'username', 'thongtindangnhap', 'taikhoan', 'account', 'login',
  'systemprompt', 'bienmoitruong', 'envfile',
];

/**
 * The stems in the words as written: inside one word ("p@ssw0rd123"), or one word spread over 2-3 ("mật khẩu",
 * "m.ậ.t k-h-ẩ-u", "m a t k h a u"), never across unrelated words ("tại khoảng 6 giờ" is not "tài khoản").
 */
function hasStem(raw: string, stems: string[]): boolean {
  const words: string[] = [];
  let run = '';
  for (const w of raw.split(/\s+/).map(compact).filter(Boolean)) {
    // letters typed one by one ("m a t k h a u") are one word
    if (w.length === 1) {
      run += w;
      continue;
    }
    if (run) words.push(run);
    run = '';
    words.push(w);
  }
  if (run) words.push(run);
  return words.some((w, i) => {
    if (stems.some((s) => s.length >= 6 && w.includes(s))) return true;
    for (const n of [1, 2, 3]) if (i + n <= words.length && stems.includes(words.slice(i, i + n).join(''))) return true;
    return false;
  });
}

/** spaced phrases (folded): asking who someone is, who did what, or to break the rules */
const PHRASES = [
  /\b(mk|pass|pw|pwd|email|e mail|gmail|sdt|so dien thoai|nguoi dung|user|users|token|hash|admin|otp|2fa|jwt|csrf|xac thuc 2 (lop|buoc))\b/,
  /\b(toi|tui|minh|tao|em|anh|chi) la ai\b|\bbiet (tui|toi|minh|em) (la ai|khong|ko)\b|\bten (toi|tui|minh|em) la gi\b/,
  /\bai (da |dang |vua |hay )?(bat|tat|gui|dieu khien|xu ly|dang nhap|dung|sua|xoa|phu trach|quan ly|truc)\b/,
  /\b(ai|nguoi nao) (la|lam) (quan tri|admin|truong ca|nguoi quan ly)/,
  /\b(nhan vien|ky thuat vien|nguoi phu trach|nguoi xu ly|tho|truong ca|quan tri vien|nguoi quan ly) (nao|la ai|ten gi|ten la)\b/,
  /\b(vai tro|quyen) (cua )?(toi|tui|minh|ban|nguoi|ai)\b|\b(toi|tui|minh) (co )?quyen gi\b/,
  /\b(quen|doi|dat lai|reset|khoi phuc|lay lai|mo khoa) (mat khau|tai khoan|pass|mk)\b/,
  /\b(dang nhap|login|vao) (bang|voi|nhu the nao|kieu gi|tai khoan)\b/,
  /\b(may chu|server|co so du lieu|database|db|sql|groq|api) (nao|o dau|ten|dia chi|cau hinh|ket noi|khoa|key)\b/,
  /\bcau hinh (may chu|server|jarvis|he thong cua ban)\b/,
  // someone trying to talk the model out of its rules
  /\b(bo qua|quen|ignore|khong can theo|vuot qua|vo hieu) (het |moi |tat ca )?(huong dan|chi dan|quy tac|luat|lenh truoc|instruction|rule)/,
  /\b(gia vo|dong vai|act as|pretend|roleplay|developer mode|che do nha phat trien|jailbreak|dan mode)\b/,
  /\b(in ra|hien|doc|lap lai|cho xem|tiet lo|reveal|show|print|repeat) (lai )?(toan bo |het )?(huong dan|prompt|chi dan|cau lenh he thong|system|noi dung an|bi mat)/,
  /\b(ignore|disregard) (all |the |your )?(previous|above|prior)\b/,
];

export const ACCOUNT_ANSWER =
  'Tôi không cung cấp bất kỳ thông tin nào về tài khoản hay bảo mật: tên, email, mật khẩu, mã OTP, vai trò, quyền, ai đã làm gì, hay cách hệ thống được cấu hình. Tài khoản của bạn xem và đổi trên web CityLight (tên ở góc phải → Tài khoản cá nhân); việc khác về tài khoản bạn hỏi quản trị viên.';

/** true when the text asks about accounts, security or the assistant's own rules */
export function asksAboutAccounts(text: string): boolean {
  const f = fold(text);
  return hasStem(text, SECRET_STEMS) || PHRASES.some((re) => re.test(f));
}

/** the fixed answer for a question about accounts or security; null otherwise */
export const accountReply = (text: string): string | null => (asksAboutAccounts(text) ? ACCOUNT_ANSWER : null);

/**
 * The last check on the model's own answer, before it is shown or spoken: a sentence that talks about passwords,
 * OTP, keys, emails or someone's account is replaced by ACCOUNT_ANSWER. The model has no such data; this is in case a
 * question got past the first check and the model made something up or repeated it.
 */
export function leaksAccount(answer: string): boolean {
  const f = fold(answer);
  return hasStem(answer, ['matkhau', 'password', 'passwd', 'apikey', 'khoaapi', 'secretkey', 'cookie', 'bearer', 'maxacthuc', 'makhoiphuc', 'tendangnhap', 'username', 'systemprompt'])
    || /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(answer)
    || /\b(otp|2fa|totp|token cua|email cua|tai khoan cua)\b/.test(f);
}
