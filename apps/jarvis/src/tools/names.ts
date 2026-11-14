// Spoken / typed cabinet references -> search terms for /search (>= 2 characters, name / code / address ILIKE).
// The model passes what the user said: "tủ demo số mười", "demo10", "DM10", "tủ 3 Lý Thường Kiệt".
// Nothing here guesses a single cabinet: the caller searches every candidate and asks back when several match.

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
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    const r = readNumber(words, i, words[i - 1]);
    if (r) {
      out.push(String(r.value));
      i = r.next;
    } else {
      out.push(words[i]!);
      i++;
    }
  }
  return out.join(' ');
}

/** after these words a lone "một" / "năm" / "tư" is a number ("số một", "demo năm") */
const NUMBER_CUE = new Set(['so', 'demo', 'thu']);

function readNumber(w: string[], start: number, prev: string | undefined): { value: number; next: number } | null {
  let i = start;
  let total = 0;
  let current = 0;
  let any = false;
  const unit = (s: string | undefined) => (s !== undefined && s in UNITS ? UNITS[s]! : null);
  while (i < w.length) {
    const s = w[i]!;
    const u = unit(s);
    if (u !== null) {
      // "tu" / "nam" / "bon" alone are also ordinary words ("tư", "năm" = year): only a number next to another number word
      if (!any && (s === 'tu' || s === 'nam' || s === 'lam' || s === 'mot') && !isNumberWord(w[i + 1]) && !(prev && NUMBER_CUE.has(prev))) return null;
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
  const folded = wordsToDigits(fold(original));

  // a code written out: "DM0010", "tl01.0009", "DM 10", "dm10"
  const code = /\b([a-z]{2,4})[\s.-]?(\d{2})\.(\d{1,4})\b/.exec(folded);
  if (code) add(`${code[1]!.toUpperCase()}${code[2]}.${code[3]!.padStart(4, '0')}`);
  const short = /\b([a-z]{2,3})\s?(\d{1,4})\b/.exec(folded);
  if (short && !['so', 'tu', 'cai', 'ma', 'thu', 'lo', 'mo'].includes(short[1]!)) {
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
