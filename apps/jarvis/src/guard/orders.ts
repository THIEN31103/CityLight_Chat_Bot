// Orders to a cabinet, recognised in code (milestone 4). The model never turns a sentence into a command: an order is
// parsed here, checked by the policy, shown as a pending action with a fixed summary, and sent only after the user
// confirms (pending.ts). A question about the state ("tủ đó đã bật chưa?") is not an order.
import { cabinetRefOf } from '../brain/router';
import type { Focus } from '../tools/registry';
import { fold, wordsToDigits } from '../tools/names';
import type { ActionCommand } from './policy';

export type Order =
  | { kind: 'cabinet'; command: ActionCommand; cabinet: string }
  /** an order without a cabinet ("bật đèn lên") */
  | { kind: 'which_cabinet'; command: ActionCommand }
  /** several cabinets at once ("tắt hết đèn quận 1"): a batch, which needs OTP on the web */
  | { kind: 'many'; command: ActionCommand };

const QUESTION = /(\?|\bchua\b|\bkhong\b|\bko\b|\bda\b|\bdang\b|co phai|bao gio|luc nao|may gio|the nao|ra sao|\bco\s.*\bkhong\b)/;
const MANY = /\b(het|tat ca|toan bo|ca quan|ca phuong|khu vuc|cac tu|nhieu tu|moi tu|quan \d+|phuong \d+)\b/;

function commandOf(f: string): ActionCommand | null {
  if (/\btra\b.*\bve\b.*\blich\b|chay (theo|lai) lich|ve (che do )?(tu dong|lich)|che do tu dong|\bauto\b/.test(f)) return { type: 'AUTO', params: {} };
  if (/xung bat|bat xung|\bxung\b|bat 15 phut/.test(f)) return { type: 'PULSE_ON', params: {} };
  // DIAG is CityLight's "tự kiểm tra RS485" (LDIA'1), not a general diagnosis: only when asked as an order
  if ((/chan doan/.test(f) && /\b(gui|chay|lam|lenh)\b/.test(f)) || /tu kiem tra|kiem tra rs ?485/.test(f)) return { type: 'DIAG', params: {} };
  const on = /\bbat\b/.test(f);
  const off = /\btat\b/.test(f);
  if (on === off) return null;
  if (!/\b(den|tucab|nhanh|tay|len|di)\b/.test(f)) return null;
  const branch = /\bnhanh (1|2)\b/.exec(f)?.[1];
  return branch ? { type: 'MANUAL_BRANCH', params: { branch: Number(branch) as 1 | 2, on } } : { type: 'MANUAL_ALL', params: { on } };
}

export function parseOrder(raw: string, focus: Focus = {}): Order | null {
  const marked = raw.replace(/(^|[^\p{L}])[tT][ủỦ](?=[^\p{L}]|$)/gu, '$1tucab');
  // "lịch bật tắt" is the schedule, not an order
  const f = wordsToDigits(fold(marked)).replace(/\bbat (va |\/ ?)?tat\b/g, ' ');
  if (QUESTION.test(f)) return null;
  const command = commandOf(f);
  if (!command) return null;
  if (MANY.test(f)) return { kind: 'many', command };
  const cabinet = cabinetRefOf(raw, focus);
  if (cabinet) return { kind: 'cabinet', command, cabinet };
  // "tắt nó đi", "bật lại đi" right after talking about a cabinet
  if (focus.cabinet && /\b(no|lai|luon)\b/.test(f)) return { kind: 'cabinet', command, cabinet: 'tủ đó' };
  return { kind: 'which_cabinet', command };
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
  }
}

/**
 * "cho tui một mã tủ để điều khiển", "tủ nào điều khiển được", "bạn bật tắt được những tủ nào": the answer is the
 * allowlist, from code. The model had no tool for it and the question ended in "Tôi chưa tra được…" (2026-11-17).
 */
export function isAllowedCabinetsQuestion(raw: string): boolean {
  const f = fold(raw.replace(/(^|[^\p{L}])[tT][ủỦ](?=[^\p{L}]|$)/gu, '$1tucab'));
  // "tủ nào đang bật đèn" asks about the state: "bật / tắt" counts only with "được"
  const control = /(dieu khien|ra lenh|gui lenh)/.test(f) || /\b(bat|tat)\b.*\bduoc\b/.test(f);
  const which = /(ma tucab|tucab nao|nhung tucab|cac tucab|danh sach tucab|tucab gi|may tucab|tucab duoc phep|tucab de)/.test(f);
  return control && which;
}
