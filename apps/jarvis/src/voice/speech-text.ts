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

/** "DM0010" -> "D M 10", "TL01.0009" -> "T L 1, số 9" */
export function sayCabinetCode(code: string): string {
  const m = /^([A-Za-z]{2,4})(\d{1,4})(?:\.(\d{1,4}))?$/.exec(code);
  if (!m) return code;
  const letters = [...m[1]!.toUpperCase()].join(' ');
  return m[3] ? `${letters} ${Number(m[2])}, số ${Number(m[3])}` : `${letters} ${Number(m[2])}`;
}

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
  s = s.replace(/\bPLGO\s?=?\s?(\d)/g, 'P L G O bằng $1').replace(/\bPLGO\b/g, 'P L G O');
  for (const [re, by] of UNITS) s = s.replace(re, by);
  // 12.5 / 229,5 -> "12 phẩy 5"
  s = s.replace(/(\d)[.,](\d)/g, '$1 phẩy $2');
  s = s.replace(/\s+([,.!?;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return s;
}

/**
 * Cuts streamed text into sentences as soon as each one ends, so the first sentence can be spoken while the model
 * is still writing the rest. A dot inside a number or code ("12.5", "TL01.0009") does not end a sentence.
 */
export class SentenceSplitter {
  private buf = '';

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const m = /[.!?…]+(?=\s)|\n+/.exec(this.buf);
      if (!m) break;
      const end = m.index + m[0].length;
      const sentence = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}
