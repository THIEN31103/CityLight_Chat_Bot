// Spoken / typed cabinet references -> search terms for /search (>= 2 characters, name / code / address ILIKE).
// The model passes what the user said: "tủ demo số mười", "demo10", "DM10", "tủ 3 Lý Thường Kiệt".
// Nothing here guesses a single cabinet: the caller searches every candidate and asks back when several match.

/**
 * "tủ" (cabinet) marked as "tucab" before folding: it folds to "tu" like "từ" (from) and "tư" (four). Speech
 * recognition also writes it "tổ" or "tụ" (2026-11-21: "điều khiển tổ ở khu vực quận 1", "39 tụ mất kết nối");
 * those count too, except in "tổ đội", "tổ trưởng", "tổ bảo trì", "tụ bù", "tụ điện".
 */
export const markCabinetWord = (raw: string) =>
  raw.replace(/(^|[^\p{L}])[tT](?:[ủỦ]|[ổỔụỤ](?!\s+(?:đội|trưởng|bảo|kỹ|công|chức|bù|điện)))(?=[^\p{L}]|$)/gu, '$1tucab');

/** lower case, no Vietnamese diacritics, đ -> d, single spaces */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const UNITS: Record<string, number> = {
  khong: 0, mot: 1, mott: 1, hai: 2, ba: 3, bon: 4, tu: 4, nam: 5, lam: 5, sau: 6, bay: 7, tam: 8, chin: 9,
};

/**
 * Vietnamese number words in folded text -> digits: "muoi" 10, "muoi mot" 11, "hai muoi lam" 25, "mot tram linh hai" 102.
 * Words that are not part of a number stay as they are. Handles 0..9999, enough for cabinet numbers.
 */
export function wordsToDigits(folded: string): string {
  const words = folded.split(' ');
  // a full stop or comma after the last word ("số mười sáu.") is not part of it: it made "16" into "10 sau." (2026-11-21)
  const cores = words.map((w) => w.replace(/[.,!?;:]+$/, ''));
  // ...and ends the number: "nhánh hai, tủ" is 2, not 2 + 4 ("tủ" folds to "tư")
  const ends = words.map((w, k) => w !== cores[k]);
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    const r = readNumber(cores, i, cores[i - 1], ends);
    if (r) {
      out.push(String(r.value) + words[r.next - 1]!.slice(cores[r.next - 1]!.length));
      i = r.next;
    } else {
      out.push(words[i]!);
      i++;
    }
  }
  return out.join(' ');
}

/**
 * CityLight cabinet codes as speech recognition writes them -> the real form "tl01.0016" (folded text in, folded out).
 * Heard on 2026-11-21 for TL01.0009 / TL01.0016: "TL1 số 9", "TL1 số 16", "TL1.0009", "TL01.00016", "H1TL1.0009",
 * "TL1009". A code glued to other letters gets a space in front so word boundaries work. "TL1009" is ambiguous
 * (TL01.0009 or TL10.0009): the one-digit district is written here, codeAlternatives() gives the other.
 */
export function normalizeCodes(folded: string): string {
  const pad = (d: string, n: string) => (Number(n) > 9999 ? null : `${d.padStart(2, '0')}.${String(Number(n)).padStart(4, '0')}`);
  return folded
    // "tl1.0009", "tl01.00016", "tl 01 . 0016", "h1tl1.0009"
    .replace(/(?<![a-z])(tl)\s?-?(\d{1,2})\s?[.,]\s?(\d{1,5})(?!\d)/g, (m, p: string, d: string, n: string) => (pad(d, n) ? ` ${p}${pad(d, n)}` : m))
    // "tl01 so 9.0009" (heard 2026-11-21): the number said twice, the written one wins
    .replace(/(?<![a-z])(tl)\s?(\d{1,2})\s(?:so\s)?\d{1,4}[.,](\d{3,5})(?!\d)/g, (m, p: string, d: string, n: string) => (pad(d, n) ? ` ${p}${pad(d, n)}` : m))
    // "tl1 so 9", "tl01 0016", "tl 1 so 16"
    .replace(/(?<![a-z])(tl)\s?(\d{1,2})\s(?:so\s)?(\d{1,4})(?!\d|\.\d)/g, (m, p: string, d: string, n: string) => (pad(d, n) ? ` ${p}${pad(d, n)}` : m))
    // "tl1009", "tl010016": glued digits
    .replace(/(?<![a-z])(tl)(\d{4,6})(?!\d|\.\d)/g, (m, p: string, ds: string) => {
      const d = ds.length === 6 || ds.startsWith('0') ? ds.slice(0, 2) : ds.slice(0, 1);
      return pad(d, ds.slice(d.length)) ? ` ${p}${pad(d, ds.slice(d.length))}` : m;
    })
    // "nhánh một" came back as "H1" twice in the 2026-11-21 recordings ("H1 tủ TL01.00016", "H1TL1.0009")
    .replace(/(?<![a-z0-9])h([12])(?![0-9])/g, 'nhanh $1')
    // "quận một" heard as "quận mộng", "Quân mong" (2026-11-23): one after quận / phường
    .replace(/\b(quan|phuong) (mong|mon|mo|mot)\b/g, '$1 1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** the other reading of glued digits ("tl1009" -> TL10.0009 next to TL01.0009); empty when there is none */
export function codeAlternatives(folded: string): string[] {
  const m = /(?<![a-z])tl(\d{4,5})(?!\d|\.\d)/.exec(folded);
  if (!m || m[1]!.startsWith('0')) return [];
  const ds = m[1]!;
  return [`TL${ds.slice(0, 2)}.${String(Number(ds.slice(2))).padStart(4, '0')}`];
}

/** after these words a lone "một" / "năm" / "tư" is a number ("số một", "demo năm") */
// "quận một", "phường năm", "nhánh một" too (the cabinet finder, 2026-11-21)
const NUMBER_CUE = new Set(['so', 'demo', 'thu', 'quan', 'phuong', 'nhanh']);

/** number words that are also ordinary words: a number only next to another number word or after "số" */
const LONE_WORDS = new Set(['tu', 'nam', 'lam', 'mot', 'khong', 'sau', 'bay', 'ba', 'tam', 'chin', 'bon']);

function readNumber(w: string[], start: number, prev: string | undefined, ends: boolean[] = []): { value: number; next: number } | null {
  let i = start;
  let total = 0;
  let current = 0;
  let any = false;
  const unit = (s: string | undefined) => (s !== undefined && s in UNITS ? UNITS[s]! : null);
  while (i < w.length) {
    if (i > start && ends[i - 1]) break;
    const s = w[i]!;
    const u = unit(s);
    if (u !== null) {
      // "tu" / "nam" / "bon" alone are also ordinary words ("tư", "năm" = year): only a number next to another number word
      // same for "không" (no), "sáu"/"sau" (after), "bảy" (fly), "ba", "tám", "chín": "có sáng không." stays a question
      if (!any && LONE_WORDS.has(s) && !isNumberWord(w[i + 1]) && !(prev && NUMBER_CUE.has(prev))) return null;
      current += u;
      any = true;
      i++;
      continue;
    }
    if (s === 'muoi' || s === 'chuc') {
      current = (current || 1) * 10;
      any = true;
      i++;
      continue;
    }
    if (s === 'linh' || s === 'le') {
      if (!any) return null;
      i++;
      continue;
    }
    if (s === 'tram') {
      current = (current || 1) * 100;
      total += current;
      current = 0;
      any = true;
      i++;
      continue;
    }
    if (s === 'nghin' || s === 'ngan') {
      total = (total + (current || 1)) * 1000;
      current = 0;
      any = true;
      i++;
      continue;
    }
    break;
  }
  return any ? { value: total + current, next: i } : null;
}

function isNumberWord(s: string | undefined) {
  return s !== undefined && (s in UNITS || ['muoi', 'chuc', 'tram', 'nghin', 'ngan', 'linh', 'le'].includes(s));
}

const FILLER = /\b(tu|cai|so|ma|cua|o|la|nhe|a|oi|di|vay|the|nao|bi|gi)\b/g;

/** Search terms to try, most specific first, all >= 2 characters, deduplicated. */
export function cabinetSearchTerms(raw: string): string[] {
  const terms: string[] = [];
  const add = (t: string | undefined) => {
    const s = t?.replace(/\s+/g, ' ').trim();
    if (s && s.length >= 2 && !terms.includes(s)) terms.push(s);
  };
  const original = raw.trim();
  const folded = normalizeCodes(wordsToDigits(fold(original)));

  // a code written out: "DM0010", "tl01.0009", "DM 10", "dm10"
  const code = /\b([a-z]{2,4})[\s.-]?(\d{2})\.(\d{1,4})\b/.exec(folded);
  if (code) add(`${code[1]!.toUpperCase()}${code[2]}.${code[3]!.padStart(4, '0')}`);
  for (const alt of codeAlternatives(wordsToDigits(fold(original)))) add(alt);
  const short = /\b([a-z]{2,3})\s?(\d{1,4})\b/.exec(folded);
  // not when a full code was found ("tl01.0016" gave a useless "TL0001" from "tl1" too)
  if (!code && short && !['so', 'tu', 'cai', 'ma', 'thu', 'lo', 'mo'].includes(short[1]!)) {
    const prefix = short[1] === 'demo' ? 'DM' : short[1]!.toUpperCase();
    add(`${prefix}${short[2]!.padStart(4, '0')}`);
  }
  // "demo 10" / "demo10" / "tu demo so 10": demo cabinets are DM0001..DM0010, named "Tủ demo N" on the trial
  const demo = /\bdemo\s?(?:so\s)?(\d{1,4})\b/.exec(folded);
  if (demo) {
    add(`DM${demo[1]!.padStart(4, '0')}`);
    add(`demo ${Number(demo[1])}`);
  }
  add(original);
  const cleaned = folded.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  add(cleaned);
  return terms.slice(0, 5);
}
