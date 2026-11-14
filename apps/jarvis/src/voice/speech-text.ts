// Text Jarvis shows -> text the voice reads (spec 4.2). Times, units, alarm codes and cabinet codes are said the
// way an operator says them; URLs, ids and markup are dropped. Numbers stay digits: the Vietnamese voice reads them.

const DIGIT_WORDS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

/** "17:05" -> "5 giờ 5 phút chiều", "18:00" -> "6 giờ tối", "06:30" -> "6 giờ 30 phút sáng" */
export function sayTime(hh: number, mm: number): string {
  const part = hh < 11 ? 'sáng' : hh < 13 ? 'trưa' : hh < 18 ? 'chiều' : 'tối';
  const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
  return `${h12} giờ${mm ? ` ${mm} phút` : ''} ${part}`;
}

/** "E201" -> "E hai không một" */
export const sayAlarmCode = (letter: string, digits: string) => `${letter.toUpperCase()} ${[...digits].map((d) => DIGIT_WORDS[Number(d)]).join(' ')}`;

/** Latin letters by their Vietnamese names, so "PLC" is said "pê lờ xê" instead of an English-sounding guess. */
const LETTER: Record<string, string> = {
  A: 'a', B: 'bê', C: 'xê', D: 'dê', E: 'e', F: 'ép', G: 'giê', H: 'hát', I: 'i', J: 'gi', K: 'ca', L: 'lờ', M: 'mờ',
  N: 'nờ', O: 'o', P: 'pê', Q: 'quy', R: 'rờ', S: 'ét', T: 'tê', U: 'u', V: 'vê', W: 'vê kép', X: 'ích', Y: 'i dài', Z: 'dét',
};
export const spellLetters = (s: string) => [...s.toUpperCase()].map((c) => LETTER[c] ?? c).join(' ');

/** "DM0010" -> "dê mờ 10", "TL01.0009" -> "tê lờ 1, số 9" */
export function sayCabinetCode(code: string): string {
  const m = /^([A-Za-z]{2,4})(\d{1,4})(?:\.(\d{1,4}))?$/.exec(code);
  if (!m) return code;
  const letters = spellLetters(m[1]!);
  return m[3] ? `${letters} ${Number(m[2])}, số ${Number(m[3])}` : `${letters} ${Number(m[2])}`;
}

/**
 * English and technical words the model or the API data use, said in Vietnamese (the Vietnamese voice reads English
 * badly: "offline", "telemetry" were the complaints). Whole words, any case. Acronyms not listed here are spelled.
 */
const WORDS: [RegExp, string][] = [
  [/\boffline\b/gi, 'mất kết nối'],
  [/\bonline\b/gi, 'trực tuyến'],
  [/(dữ liệu |data )?\btelemetry\b/gi, 'dữ liệu đo'],
  [/\bfirmware\b/gi, 'phần mềm thiết bị'],
  [/\bdimming\b/gi, 'tiết giảm'],
  [/\bschedule\b/gi, 'lịch'],
  [/\bmodule\b/gi, 'mô đun'],
  [/\bmodbus\b/gi, 'mốt bớt'],
  [/\bethernet\b/gi, 'ê tơ nét'],
  [/\bcitylight\b/gi, 'xi ti lai'],
  [/\bjarvis\b/gi, 'gia vít'],
  [/\bLOGO\b/g, 'lô gô'],
  [/\bSIM\b/g, 'sim'],
  [/\bOK\b/gi, 'ô kê'],
  [/\b4G\b/gi, 'bốn giê'],
  [/\bAI\b/g, 'a i'],
];

const UNITS: [RegExp, string][] = [
  [/(\d)\s?kWh\b/g, '$1 ki lô oát giờ'],
  [/(\d)\s?kW\b/g, '$1 ki lô oát'],
  [/(\d)\s?mA\b/g, '$1 mi li am pe'],
  [/(\d)\s?A\b/g, '$1 am pe'],
  [/(\d)\s?V\b/g, '$1 vôn'],
  [/(\d)\s?°C\b/g, '$1 độ C'],
  [/(\d)\s?%/g, '$1 phần trăm'],
  [/(\d)\s?ms\b/g, '$1 mili giây'],
];

export function toSpeech(text: string): string {
  let s = text
    // never read these out
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/[{}[\]`*_#>|]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '');
  // dates before times: 14/11/2026, 14/11
  s = s.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (_, d, m, y) => `ngày ${Number(d)} tháng ${Number(m)} năm ${y}`);
  s = s.replace(/\b(\d{1,2})\/(\d{1,2})\b/g, (_, d, m) => `ngày ${Number(d)} tháng ${Number(m)}`);
  s = s.replace(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/g, (_, h, m) => sayTime(Number(h), Number(m)));
  // codes
  s = s.replace(/\b([A-Za-z]{2,4}\d{2}\.\d{1,4}|[A-Za-z]{2}\d{4})\b/g, (c) => sayCabinetCode(c));
  s = s.replace(/\b([EeWw])(\d{3})\b/g, (_, l, d) => sayAlarmCode(l, d));
  s = s.replace(/\bPLGO\s?=?\s?(\d)/g, `${spellLetters('PLGO')} bằng $1`);
  for (const [re, by] of UNITS) s = s.replace(re, by);
  for (const [re, by] of WORDS) s = s.replace(re, by);
  // any other acronym (PLC, ETH, LTE, GPS, LTID...): letter by letter, Vietnamese names
  s = s.replace(/\b[A-Z]{2,6}\b/g, (w) => spellLetters(w));
  // 12.5 / 229,5 -> "12 phẩy 5"
  s = s.replace(/(\d)[.,](\d)/g, '$1 phẩy $2');
  s = s.replace(/\s+([,.!?;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return s;
}

/**
 * Cuts streamed text into pieces to speak as soon as each one is complete, so the voice starts while the model is
 * still writing. A sentence end always cuts; a comma / colon / semicolon cuts a long sentence too (the first piece
 * once it has FIRST_MIN characters, later ones at LATER_MIN): a long first sentence used to keep the voice silent
 * for seconds while its text was already on screen. A dot or comma inside a number or code ("12.5", "12,5",
 * "TL01.0009") never cuts.
 */
export class SentenceSplitter {
  static readonly FIRST_MIN = 18;
  static readonly LATER_MIN = 45;
  private buf = '';
  private pieces = 0;

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const m = /[.!?…]+(?=\s)|\n+/.exec(this.buf);
      let end = m ? m.index + m[0].length : -1;
      if (end < 0) {
        // no sentence end yet: a clause of a long sentence, cut after its punctuation
        const min = this.pieces === 0 ? SentenceSplitter.FIRST_MIN : SentenceSplitter.LATER_MIN;
        const clause = /[,;:](?=\s)/g;
        let c: RegExpExecArray | null;
        while ((c = clause.exec(this.buf))) {
          if (c.index + 1 >= min) {
            end = c.index + 1;
            break;
          }
        }
      }
      if (end < 0) break;
      const piece = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end);
      if (piece) {
        out.push(piece);
        this.pieces++;
      }
    }
    return out;
  }

  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) this.pieces++;
    return rest ? [rest] : [];
  }
}
