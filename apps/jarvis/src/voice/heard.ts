// What speech recognition wrote -> what the operator said, before the text is shown, logged or answered.
// Only fixes seen in real recordings; anything else is left as heard.
import { fold } from '../tools/names';

/**
 * The same sentence written several times in a row, kept once. Groq's Whisper loops on a short greeting
 * ("Xin chào. Xin chào. Xin chào. Xin chào.", 2026-11-23); compared without case, accents or punctuation.
 */
export function collapseRepeats(text: string): string {
  const sentences = text.split(/(?<=[.!?…])\s+/);
  const key = (s: string) => fold(s).replace(/[^\p{L}\p{N} ]/gu, '').trim();
  const kept: string[] = [];
  for (const s of sentences) {
    if (kept.length && key(s) && key(s) === key(kept[kept.length - 1]!)) continue;
    kept.push(s);
  }
  return kept.join(' ');
}

/**
 * "Thủ Đức" as Groq heard it on 2026-11-21..23: "khẩu đức", "thủ đích". The answer then repeated the wrong name
 * ("Khu vực Khẩu Đức (TP Thủ Đức)"), so the transcript is corrected, not only the area search.
 */
const THU_DUC = /(?<![\p{L}])(?:khẩu|khấu|khẩy|khủ|thủ|thù|thú)\s+(?:đức|đích|đứt|đực|đúc|đất)(?![\p{L}])/giu;

export function fixPlaceNames(text: string): string {
  return text.replace(THU_DUC, 'Thủ Đức');
}

/**
 * "tủ" written "tổ" / "tụ" ("điều khiển tổ ở khu vực quận 1", 2026-11-21): the answer copied it. Same exceptions as
 * markCabinetWord in tools/names.ts ("tổ đội", "tổ trưởng", "tổ bảo trì", "tụ bù", "tụ điện").
 */
// "mã tố" (2026-11-23) too, but not "tố cáo", "tố giác", "tố chất", "tố tụng"
const CABINET = /(?<![\p{L}])([tT])(?:[ổỔụỤ](?!\s+(?:đội|trưởng|bảo|kỹ|công|chức|bù|điện))|[ốỐ](?!\s+(?:cáo|giác|chất|tụng)))(?![\p{L}])/gu;

export function fixCabinetWord(text: string): string {
  return text.replace(CABINET, (_m, t: string) => `${t}ủ`);
}

/** all fixes, in the order they apply */
export function tidyHeard(text: string): string {
  return fixCabinetWord(fixPlaceNames(collapseRepeats(text.trim())));
}
