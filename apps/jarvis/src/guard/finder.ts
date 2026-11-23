// Finding the cabinet of an order without its code (user request 2026-11-21: "tôi chỉ nhớ mang máng, ở Thủ Đức có
// rất nhiều tủ"). The user says what they remember: an area, a street (even half of it or misheard), a state. Code
// narrows the cabinets Jarvis may switch down to at most five, read with numbers ("số 1 … số 2 …"), and the user
// picks one ("số 2"). The model is not involved: the list, the question and the pick are all decided here, and the
// result is an ordinary order that still needs the usual confirmation.
import type { CabinetSummary } from '@citylight/shared';
import type { AreaNode } from '../api/read';
import { editDistance, MATCHES, STATE_WORDS_VI, type StateFilter } from '../tools/read';
import { fold, markCabinetWord, normalizeCodes, wordsToDigits } from '../tools/names';
import type { ActionCommand } from './policy';

/** what the user said about the cabinet; every part is optional */
export interface FindFilter {
  /** districts / wards named ("Thủ Đức", "phường 1": several wards share that name) */
  area?: { name: string; ids: string[] };
  /** "ngoài khu vực Thủ Đức": every area but these (2026-11-21: it was read as "ở Thủ Đức") */
  except?: { name: string; ids: string[] };
  /** a street, folded ("ly thuong kiet"), and the house number when one was said */
  street?: { name: string; folded: string[]; number?: string };
  state?: StateFilter;
}

export interface Finding {
  /** null: the user wants to control a cabinet but has not said what to do yet */
  command: ActionCommand | null;
  filter: FindFilter;
  /** the numbered choices read to the user (empty while Jarvis asks for more) */
  choices: { id: string; code: string; name: string }[];
  at: number;
}

/** at most this many cabinets are read out to pick from */
export const MAX_CHOICES = 5;

const PREFIX = /^(phuong|quan|huyen|xa|thi tran|tp|thanh pho) /;
const textOf = (raw: string) => normalizeCodes(wordsToDigits(fold(markCabinetWord(raw))));
const tokens = (f: string) => f.replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(Boolean);
const streetOf = (name: string) => fold(name).replace(/\s+\d+[a-z]?$/, '');

/** a token heard close enough: exact for short words, one letter off for longer ones */
const close = (a: string, b: string) => a === b || (a.length >= 3 && b.length >= 3 && editDistance(a, b) <= 1);

/** The areas a sentence names: "quận 1", "Thủ Đức", "khu vực khu đức" (misheard), "phường 5". */
export function areaIn(raw: string, areas: AreaNode[]): FindFilter['area'] {
  const f = ` ${tokens(textOf(raw)).join(' ')} `;
  const named = (a: AreaNode) => fold(a.name).replace(PREFIX, '');
  const found = areas.filter((a) => {
    if (a.kind === 'unit') return false;
    const n = named(a);
    // "1", "10": only with its word in front ("quận 1"), never a bare number
    if (/^\d+$/.test(n)) return a.kind === 'ward' ? f.includes(` phuong ${n} `) : f.includes(` quan ${n} `) || f.includes(` q ${n} `);
    return f.includes(` ${n} `);
  });
  if (!found.length) {
    // misheard names: the words after "ở", "khu vực", "quận"… within two letters of one area name
    const words = tokens(textOf(raw));
    const near = new Set<AreaNode>();
    for (const a of areas) {
      if (a.kind === 'unit') continue;
      const n = named(a);
      if (/^\d+$/.test(n) || n.length < 4) continue;
      const len = n.split(' ').length;
      for (let i = 0; i + len <= words.length; i++) if (editDistance(words.slice(i, i + len).join(' '), n) <= 2) near.add(a);
    }
    if (near.size === 1) found.push(...near);
  }
  if (!found.length) return undefined;
  // the most precise level said: wards when a ward was named
  const wards = found.filter((a) => a.kind === 'ward');
  const pick = wards.length ? wards : found;
  const name = [...new Set(pick.map((a) => a.name))].join(', ');
  return { name, ids: pick.map((a) => a.id) };
}

/**
 * The street a sentence names, among the streets of the cabinets that are left: "đường Lý Thường Kiệt", "Lý Thường
 * gì đó" (half of it), "Lý Thường Kiệc" (one letter off), with the house number when it follows ("Lý Thường Kiệt 6").
 */
export function streetIn(raw: string, cabinets: CabinetSummary[]): FindFilter['street'] {
  const words = tokens(textOf(raw));
  const streets = new Map<string, string>();
  for (const c of cabinets) streets.set(streetOf(c.name), c.name.replace(/\s+\d+[A-Za-z]?$/, ''));
  let best: { folded: string; score: number; end: number } | null = null;
  const tied: string[] = [];
  for (const folded of streets.keys()) {
    const st = folded.split(' ');
    for (let i = 0; i < words.length; i++) {
      let hit = 0;
      let j = 0;
      while (j < st.length && i + j < words.length && close(words[i + j]!, st[j]!)) {
        hit++;
        j++;
      }
      // all of it, or a long name without its last word ("Lý Thường gì đó"), never one short word alone
      const ok = hit === st.length ? st.length >= 2 || st[0]!.length >= 4 : hit >= 2 && hit >= st.length - 1;
      if (!ok) continue;
      const score = hit / st.length;
      if (!best || score > best.score) {
        best = { folded, score, end: i + hit };
        tied.length = 0;
        tied.push(folded);
      } else if (score === best.score && !tied.includes(folded)) tied.push(folded);
    }
  }
  if (!best) return undefined;
  const number = /^\d+$/.test(words[best.end] ?? '') ? words[best.end] : undefined;
  return { name: tied.map((t) => streets.get(t)!).join(' / '), folded: tied, number };
}

/**
 * "đang sáng", "mất kết nối"… in the sentence. Not the router's list: there "bật đèn" means lit, here it is the order
 * itself ("bật đèn tủ ở Thủ Đức" asks for no state).
 */
const STATES: [RegExp, StateFilter][] = [
  [/binh thuong|on dinh|hoat dong (tot|on)/, 'binh_thuong'],
  [/mat ket noi|offline|mat song|mat lien lac/, 'mat_ket_noi'],
  [/dang (bi )?loi|co loi|bi loi/, 'co_loi'],
  [/dang sang|dang bat|den (dang )?sang/, 'dang_sang'],
  [/dang tat|den (dang )?tat/, 'dang_tat'],
];
export function stateIn(raw: string): StateFilter | undefined {
  const f = textOf(raw);
  return STATES.find(([re]) => re.test(f))?.[1];
}

/** "số 2", "cái thứ hai", "tủ số ba", "thứ nhất", "cái cuối": the number picked from a list of `count` */
// The order may come with the number: "bật đèn tủ số 2" (2026-11-23, it was searched as a cabinet called "số 2")
export function pickIn(raw: string, count: number): number | null {
  // "số hai" heard as "số hệ" (2026-11-23)
  const t = tokens(textOf(raw).replace(/\b(so|thu) (he|hay)\b/g, '$1 2')).filter((w) => !COURTESY.has(w));
  if (t.length > 9) return null;
  const f = t.join(' ');
  if (/\b(dau tien|thu nhat)\b/.test(f)) return 1;
  if (/\b(cuoi cung|cai cuoi|tucab cuoi)\b/.test(f)) return count;
  if (!/^\d{1,2}$/.test(t[t.length - 1] ?? '')) return null;
  let i = t.length - 1;
  if (['so', 'thu'].includes(t[i - 1]!)) i--;
  if (['cai', 'tucab'].includes(t[i - 1]!)) i--;
  const before = t.slice(0, i);
  // "bật nhánh 2" names a branch: a bare number only after "chọn", "lấy", "bật", "tắt"
  const ok = i < t.length - 1 ? before.every((w) => ORDER_WORDS.has(w)) : before.every((w) => BARE_PICK.has(w));
  const n = Number(t[t.length - 1]);
  return ok && n >= 1 && n <= count ? n : null;
}
const COURTESY = new Set(['nhe', 'nha', 'di', 'a', 'oi', 'jarvis']);
const BARE_PICK = new Set(['chon', 'lay', 'la', 'bat', 'tat']);
/** what an order says before "tủ số 2": "bật đèn", "tắt tay cả hai nhánh", "bật nhánh 1 cho tôi" */
const ORDER_WORDS = new Set([...BARE_PICK, 'mo', 'den', 'tay', 'nhanh', 'ca', '1', '2', 'cho', 'toi', 'lai', 'len', 'o', 'cua', 'tucab', 'cai']);

export const describes = (f: FindFilter) => !!(f.area || f.street || f.state);

/** "ở TP Thủ Đức trên đường Lý Thường Kiệt 6 đang sáng" */
export function describe(f: FindFilter): string {
  return [
    f.street ? `trên đường ${f.street.name}${f.street.number ? ` ${f.street.number}` : ''}` : '',
    f.area ? `ở ${f.area.name}` : '',
    f.except ? `ngoài ${f.except.name}` : '',
    f.state ? STATE_WORDS_VI[f.state] : '',
  ].filter(Boolean).join(' ');
}

export function matching(cabinets: CabinetSummary[], f: FindFilter): CabinetSummary[] {
  return cabinets.filter((c) => {
    if (f.area && !f.area.ids.some((id) => id === c.districtId || id === c.wardId)) return false;
    if (f.except && f.except.ids.some((id) => id === c.districtId || id === c.wardId)) return false;
    if (f.street && !f.street.folded.includes(streetOf(c.name))) return false;
    if (f.street?.number && !new RegExp(`\\s${f.street.number}[a-z]?$`, 'i').test(c.name)) return false;
    if (f.state && !MATCHES[f.state](c)) return false;
    return true;
  });
}

export type FindResult =
  /** exactly one cabinet Jarvis may switch: the order goes on with it */
  | { kind: 'one'; cabinet: CabinetSummary }
  /** a sentence to say; choices are read with numbers (may be empty while Jarvis asks for more) */
  | { kind: 'ask'; say: string; choices: CabinetSummary[] };

/**
 * Narrows the cabinets the user may switch through Jarvis. Online cabinets come first, offline ones are marked
 * (a command to them is refused anyway). More than MAX_CHOICES: ask for what is missing (street, then state).
 */
export function narrow(all: CabinetSummary[], allowed: Set<string>, f: FindFilter, areaName: (id: string | null) => string): FindResult {
  const wardName = areaName;
  const what = describe(f);
  const found = matching(all, f);
  if (!found.length) return { kind: 'ask', say: `Tôi không thấy tủ nào ${what}. Bạn nói lại tên đường hoặc khu vực giúp tôi.`, choices: [] };
  const mine = found.filter((c) => allowed.has(c.code.toUpperCase()));
  if (!mine.length) {
    // where the allowed cabinets are, by area name (a list of codes made the model guess "TL12" = Quận 12, 2026-11-21)
    const areas = new Map<string, number>();
    for (const c of all) if (allowed.has(c.code.toUpperCase())) areas.set(areaName(c.districtId) || 'khu vực khác', (areas.get(areaName(c.districtId) || 'khu vực khác') ?? 0) + 1);
    const where = [...areas].map(([n, k]) => `${n} (${k} tủ)`).join(', ');
    return { kind: 'ask', say: `Có ${found.length} tủ ${what} nhưng chưa tủ nào được phép điều khiển qua Jarvis.${where ? ` Tủ được phép ở: ${where}.` : ''}`, choices: [] };
  }
  const online = mine.filter((c) => c.status !== 'offline');
  const ordered = [...online, ...mine.filter((c) => c.status === 'offline')];
  if (ordered.length === 1) return { kind: 'one', cabinet: ordered[0]! };
  if (!online.length && ordered.length > MAX_CHOICES)
    return { kind: 'ask', say: `${ordered.length} tủ ${what} đều đang mất kết nối, không gửi lệnh được.`, choices: [] };
  // many cabinets but only a few connected (42 in Thủ Đức, 3 online on 2026-11-21): those are the ones a command
  // can reach, read them at once
  if (ordered.length > MAX_CHOICES && online.length <= MAX_CHOICES) {
    const list = online.map((c, i) => `số ${i + 1}: ${c.name}, ${wardName(c.wardId)} (${c.code})`).join('; ');
    return { kind: 'ask', say: `Có ${ordered.length} tủ ${what}, chỉ ${online.length} tủ đang kết nối: ${list}. Các tủ còn lại mất kết nối, không gửi lệnh được. Bạn chọn số mấy?`, choices: online };
  }
  if (ordered.length > MAX_CHOICES && (!f.street || !f.state)) {
    const ask = !f.street ? 'Bạn nhớ tên đường không? Hoặc tủ đang sáng hay đang tắt?' : 'Bạn nhớ số nhà, phường, hoặc tủ đang sáng hay đang tắt không?';
    return { kind: 'ask', say: `Có ${ordered.length} tủ ${what} bạn điều khiển được. ${ask}`, choices: [] };
  }
  const choices = ordered.slice(0, MAX_CHOICES);
  const list = choices.map((c, i) => `số ${i + 1}: ${c.name}, ${wardName(c.wardId)} (${c.code})${c.status === 'offline' ? ', mất kết nối' : ''}`).join('; ');
  const more = ordered.length > choices.length ? ` Còn ${ordered.length - choices.length} tủ khác, nói thêm số nhà hoặc phường nếu không có trong số này.` : '';
  return { kind: 'ask', say: `Có ${ordered.length} tủ ${what}: ${list}.${more} Bạn chọn số mấy?`, choices };
}
