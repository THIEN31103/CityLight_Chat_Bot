// Confirm / cancel words (spec 6.4). Code decides, never the model: the reply is folded (no diacritics, lower case,
// no punctuation) and matched against fixed lists. Only used while a pending action is waiting.
import { fold } from '../tools/names';

export type Reply = 'confirm' | 'cancel' | 'unclear';

// "đúng" (yes), "đừng" (don't) and "dừng" (stop) all fold to "dung": they are told apart before folding.
// A bare "dung" typed without diacritics stays ambiguous and confirms nothing.
const mark = (s: string) => s.toLowerCase().normalize('NFC').replace(/đừng/g, ' dungx ').replace(/dừng/g, ' dungy ').replace(/đúng/g, ' dungv ');

// filler words around the answer ("ừ xác nhận nhé", "ok làm đi Jarvis")
const FILLER = new Set(['uh', 'um', 'a', 'oi', 'nhe', 'nha', 'nhen', 'di', 'luon', 'jarvis', 'gia', 'vit', 'ban', 'em', 'anh', 'chi', 'cho', 'toi', 'tui', 'minh', 'voi', 'giup', 'dum', 'lenh', 'do', 'nay', 'the', 'ay', 'nao']);

const CONFIRM = [
  'xac nhan', 'dong y', 'lam', 'lam di', 'lam luon', 'gui di', 'gui lenh', 'gui', 'thuc hien', 'tien hanh', 'chap nhan', 'ok', 'oke', 'okay', 'oki',
  'duoc', 'dungv', 'dungv roi', 'chinh xac', 'co', 'u', 'yes', 'chot',
];
const CANCEL = [
  'huy', 'huy bo', 'thoi', 'khong', 'ko', 'dungx', 'dungx lam', 'dungy', 'dungy lai', 'dung lai', 'bo qua', 'bo di', 'khoi', 'khong can',
  'thoi khoi', 'cancel', 'no', 'chua',
  // a lone spoken "Hủy." comes back from speech recognition as "Hồi." / "Huy" (2026-11-15): cancelling sends nothing,
  // so the near misses may cancel; they never confirm
  'hoi', 'hui', 'huy huy',
];
// a negation in front of a confirm word turns it into a cancel: "không xác nhận", "đừng làm", "chưa đồng ý"
const NEGATION = /\b(khong|ko|dungx|chua)\s+(xac nhan|dong y|lam|gui|thuc hien|bat|tat|can)/;

const norm = (s: string) => fold(mark(s)).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** What a short reply means while a pending action waits; null = not a reply at all (a new question, an order...). */
export function classifyReply(text: string): Reply | null {
  const f = norm(text);
  if (!f) return null;
  if (NEGATION.test(f)) return 'cancel';
  const words = f.split(' ').filter((w) => !FILLER.has(w));
  // a long sentence is a new request, not a yes / no (at most 4 meaningful words)
  if (words.length > 4) return null;
  const core = ` ${words.join(' ')} `;
  const has = (list: string[]) => list.some((p) => core.includes(` ${p} `));
  const yes = has(CONFIRM);
  const no = has(CANCEL);
  if (yes && no) return 'unclear';
  if (yes) return 'confirm';
  if (no) return 'cancel';
  return null;
}

/**
 * The words that may confirm switching off (T2) without the button: "xác nhận" / "đồng ý", with fillers only
 * ("xác nhận nhé", "đồng ý tắt"). The user asked to confirm by voice (2026-11-21); "ok", "có", "được" still do not.
 */
export function isExplicitConfirm(text: string): boolean {
  const f = norm(text);
  if (!f || NEGATION.test(f)) return false;
  const words = f.split(" ").filter((w) => !FILLER.has(w));
  const core = words.join(" ");
  return /^(xac nhan|dong y)( (tat|lenh|tat den|gui))?$/.test(core);
}
