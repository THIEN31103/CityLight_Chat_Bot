// Orders to a cabinet, recognised in code (milestone 4). The model never turns a sentence into a command: an order is
// parsed here, checked by the policy, shown as a pending action with a fixed summary, and sent only after the user
// confirms (pending.ts). A question about the state ("tủ đó đã bật chưa?") is not an order.
import { cabinetRefOf } from '../brain/router';
import type { Focus } from '../tools/registry';
import { fold, markCabinetWord, normalizeCodes, wordsToDigits } from '../tools/names';
import type { ActionCommand } from './policy';

export type Order =
  | { kind: 'cabinet'; command: ActionCommand; cabinet: string }
  /** an order without a cabinet ("bật đèn lên") */
  | { kind: 'which_cabinet'; command: ActionCommand; heard?: string }
  /** several cabinets at once ("tắt hết đèn quận 1"): a batch, which needs OTP on the web */
  | { kind: 'many'; command: ActionCommand };

// "tủ nào lẽ ra phải tắt mà vẫn sáng" asks about the schedule (2026-11-23): it was read as "tắt đèn, ở tủ nào?"
const QUESTION = /(\?|\bchua\b|\bkhong\b|\bko\b|\bda\b|\bdang\b|co phai|bao gio|luc nao|may gio|the nao|ra sao|\bco\s.*\bkhong\b|\ble ra\b|\bdang (le|ra)\b|lech lich|sai lich|ngoai gio|trong gio)/;
const MANY = /\b(het|tat ca|toan bo|ca quan|ca phuong|cac tu|cac tucab|nhieu tu|nhieu tucab|moi tu|moi tucab)\b/;
/** "tắt đèn quận 1" is every cabinet there; "tắt đèn một tủ ở quận 1" is one cabinet to find (2026-11-21) */
const MANY_AREA = /\b(khu vuc|quan \d+|phuong \d+)\b/;
const isMany = (g: string) => MANY.test(g) || (MANY_AREA.test(g) && !/\btucab\b/.test(g));

function commandOf(f: string): ActionCommand | null {
  if (/\btra\b.*\bve\b.*\blich\b|chay (theo|lai) lich|ve (che do )?(tu dong|lich)|che do tu dong|\bauto\b/.test(f)) return { type: 'AUTO', params: {} };
  if (/xung bat|bat xung|\bxung\b|bat 15 phut/.test(f)) return { type: 'PULSE_ON', params: {} };
  // DIAG is CityLight's "tự kiểm tra RS485" (LDIA'1), not a general diagnosis: only when asked as an order
  if ((/chan doan/.test(f) && /\b(gui|chay|lam|lenh)\b/.test(f)) || /tu kiem tra|kiem tra rs ?485/.test(f)) return { type: 'DIAG', params: {} };
  const on = /\bbat\b/.test(f);
  const off = /\btat\b/.test(f);
  if (on === off) return null;
  if (!/\b(den|tucab|nhanh|tay|len|di)\b/.test(f)) return null;
  const branch = branchOf(f);
  return branch ? { type: 'MANUAL_BRANCH', params: { branch, on } } : { type: 'MANUAL_ALL', params: { on } };
}

/**
 * "nhánh một" / "nhánh 2" -> that branch; "cả hai nhánh", "nhánh một và nhánh hai" -> null (both). A lone "một"
 * stays a word after wordsToDigits ("tắt nhánh một tủ TL1 số 9" was read as both branches, 2026-11-21).
 */
export const namesBothBranches = (f: string) => /\b(ca )?(hai|2) nhanh\b|\bnhanh (1|mot)\b.*\b(2|hai)\b|\bca hai\b/.test(f);
export function branchOf(f: string): 1 | 2 | null {
  if (namesBothBranches(f)) return null;
  const b = /\bnhanh (1|2|mot|hai)\b/.exec(f)?.[1];
  return b === '1' || b === 'mot' ? 1 : b === '2' || b === 'hai' ? 2 : null;
}

export function parseOrder(raw: string, focus: Focus = {}): Order | null {
  const marked = markCabinetWord(raw);
  // "lịch bật tắt" is the schedule, not an order
  const f = normalizeCodes(wordsToDigits(fold(marked))).replace(/\bbat (va |\/ ?)?tat\b/g, ' ');
  // "tắt hai nhánh của tủ vừa mới bật": the reference is not the command
  const g = f.replace(/tucab (vua (moi )?|moi )(bat|tat)( len| xong)?/g, 'tucab vua');
  if (QUESTION.test(g)) return null;
  const command = commandOf(g);
  if (!command) return null;
  if (isMany(g)) return { kind: 'many', command };
  const cabinet = cabinetRefOf(raw, focus);
  if (cabinet) return { kind: 'cabinet', command, cabinet };
  // "tắt nó đi", "bật lại đi" right after talking about a cabinet
  if (focus.cabinet && /\b(no|lai|luon)\b/.test(g)) return { kind: 'cabinet', command, cabinet: 'tủ đó' };
  // a code that could not be read ("TL166", 2026-11-21): say what was heard instead of only "ở tủ nào?"
  const odd = /(?<![a-z])tl\s?[0-9][0-9.]*/.exec(g)?.[0];
  return odd ? { kind: 'which_cabinet', command, heard: odd.replace(/\s+/g, '').replace(/\.$/, '').toUpperCase() } : { kind: 'which_cabinet', command };
}

/** "Bật tay cả hai nhánh" ... the action in words, for the summary and the result */
export function describeCommand(c: ActionCommand): string {
  switch (c.type) {
    case 'MANUAL_ALL':
      return c.params.on ? 'Bật tay cả hai nhánh đèn' : 'Tắt tay cả hai nhánh đèn';
    case 'MANUAL_BRANCH':
      return `${c.params.on ? 'Bật' : 'Tắt'} tay nhánh ${c.params.branch}`;
    case 'AUTO':
      return 'Trả về chạy theo lịch';
    case 'PULSE_ON':
      return 'Bật tạm cả hai nhánh 15 phút (xung)';
    case 'DIAG':
      return 'Gửi lệnh tự kiểm tra RS485';
    case 'ACK_ALARM':
      return `Xác nhận đã xem cảnh báo ${c.params.alarmCode ?? ''}`.trim();
  }
}

/**
 * "Xác nhận đã xem cảnh báo E201 tủ TL01.0026", "đánh dấu đã xem lỗi đó", "ack cảnh báo E202" (spec 5.3, 2026-11-23):
 * the alarm code and the cabinet words if said; null when the text is no such request (a question about it is not one).
 */
export function parseAck(raw: string): { code?: string; cabinet?: string } | null {
  const f = wordsToDigits(fold(markCabinetWord(raw)));
  if (!/\b(ack|(xac nhan|danh dau|ghi nhan) (la )?(da (xem|biet|nhan) )?(canh bao|loi)|da xem (canh bao|loi))\b/.test(f)) return null;
  if (/(\?|\bchua\b|\bkhong\b|\bai\b|bao gio|luc nao)/.test(f)) return null;
  const code = /\b(e\d{3})\b/.exec(f)?.[1]?.toUpperCase();
  const cab = /\b([a-z]{2,4}\d{2}\.\d{1,4}|[a-z]{2}\d{4})\b/.exec(normalizeCodes(f))?.[1]?.toUpperCase();
  return { ...(code ? { code } : {}), ...(cab ? { cabinet: cab } : /\btucab (do|nay)\b|\bloi (do|nay)\b|\bcanh bao (do|nay)\b/.test(f) ? { cabinet: 'tủ đó' } : {}) };
}

/**
 * "cho tui một mã tủ để điều khiển", "tủ nào điều khiển được", "bạn bật tắt được những tủ nào": the answer is the
 * allowlist, from code. The model had no tool for it and the question ended in "Tôi chưa tra được…" (2026-11-17).
 */
export function isAllowedCabinetsQuestion(raw: string): boolean {
  const f = fold(markCabinetWord(raw));
  // "tủ nào đang bật đèn" asks about the state: "bật / tắt" counts only with "được"
  const control = /(dieu khien|ra lenh|gui lenh)/.test(f) || /\b(bat|tat)\b.*\bduoc\b/.test(f);
  // "cho tôi một tủ khác để điều khiển" (2026-11-21)
  // "khu vực nào có tủ … điều khiển được" (2026-11-21)
  const which = /(ma tucab|tucab nao|nhung tucab|cac tucab|danh sach tucab|tucab gi|may tucab|tucab duoc phep|tucab de|tucab khac|khu vuc nao|quan nao|phuong nao)/.test(f);
  return control && which;
}
