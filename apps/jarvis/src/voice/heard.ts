// What speech recognition wrote -> what the operator said, before the text is shown, logged or answered.
// Only fixes seen in real recordings; anything else is left as heard.
import { fold } from '../tools/names';
import { editDistance } from '../tools/read';

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

/** words after which a place name is expected, so a name two letters off is still taken */
const PLACE_CUES = new Set(['quan', 'phuong', 'huyen', 'tp', 'pho', 'vuc', 'duong', 'o', 'tai', 'tren']);
const PLACE_PREFIX = /^(phuong|quan|huyen|xa|thi tran|tp|thanh pho) /;
const NAME_PREFIX = /^(Phường|Quận|Huyện|Xã|Thị trấn|TP|Thành phố) /;
const bare = (w: string) => fold(w).replace(/[^a-z0-9]/g, '');

/**
 * Misheard place names -> the real ones, from the areas and streets the user can see ("Cộng Hoà" said, "công hòa"
 * heard; "thủ đích" for Thủ Đức). Names of two words or more only: one word is too easy to mistake. A name is taken
 * when it is one letter off, or two letters off right after "quận", "phường", "khu vực", "đường", "ở"…, or only its
 * accents are wrong ("thảo diễn"); when two names fit as well, nothing changes.
 */
export function snapPlaces(text: string, names: readonly string[]): string {
  const words = text.split(' ');
  const folded = words.map(bare);
  const targets = [...new Set(names)]
    .map((name) => ({ name, f: fold(name).replace(PLACE_PREFIX, '').replace(/[^a-z0-9 ]/g, '').trim() }))
    .filter((t) => t.f.includes(' ') && !/\d/.test(t.f) && t.f.length >= 6);
  const plain = (name: string) => name.replace(NAME_PREFIX, '');
  // the words as written, for the accents ("thảo diễn" folds like "Thảo Điền" but is written wrong)
  const said = words.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    const fits: { name: string; f: string; n: number; d: number }[] = [];
    for (const t of targets) {
      const n = t.f.split(' ').length;
      if (i + n > words.length) continue;
      const window = folded.slice(i, i + n).join(' ');
      if (window.split(' ').some((w) => !w)) continue;
      const d = editDistance(window, t.f);
      const cue = PLACE_CUES.has(folded[i - 1] ?? '');
      if (d <= (cue ? (t.f.length >= 7 ? 2 : 1) : t.f.length >= 8 ? 1 : 0)) fits.push({ ...t, n, d });
    }
    const least = Math.min(...fits.map((x) => x.d));
    const best = fits.filter((x) => x.d === least);
    const n = best[0]?.n ?? 0;
    const asSaid = said.slice(i, i + n).join(' ');
    // already written right, or two different names fit as well: left as heard
    const right = best.some((x) => plain(x.name).toLowerCase() === asSaid);
    const one = new Set(best.map((x) => plain(x.name))).size === 1;
    if (best.length && !right && one) {
      const tail = words[i + n - 1]!.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? '';
      // the name without its "Quận" / "Phường": the word before already says it
      out.push(plain(best[0]!.name) + tail);
      i += n;
    } else {
      out.push(words[i]!);
      i++;
    }
  }
  return out.join(' ');
}

/** all fixes, in the order they apply */
export function tidyHeard(text: string): string {
  return fixCabinetWord(fixPlaceNames(collapseRepeats(text.trim())));
}
