// Languages (S49): the UI, Telegram messages and exports exist in Vietnamese and English, chosen per user.
// Dictionaries are plain objects: the Vietnamese one is the source of truth, the English one must have the
// same shape (checked by TypeScript), so a missing translation is a type error, not a mixed-language screen.
// Entries are strings with {name} placeholders, or functions when the wording depends on a value (plurals).

export type Lang = 'vi' | 'en';
export const LANGS: readonly Lang[] = ['vi', 'en'];
export const LANG_NAMES: Record<Lang, string> = { vi: 'Tiếng Việt', en: 'English' };
export const DEFAULT_LANG: Lang = 'vi';

export const isLang = (v: unknown): v is Lang => v === 'vi' || v === 'en';

/** The type a translation must have: same keys, strings for strings, same signature for functions. */
export type DictShape<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends (...a: infer A) => string ? (...a: A) => string : DictShape<T[K]>;
};

/** One dictionary in both languages; `en` is checked against `vi`. */
export function defineDict<T>(vi: T, en: DictShape<T>): Record<Lang, T> {
  return { vi, en: en as T };
}

/** "{n} tủ" + { n: 3 } -> "3 tủ"; unknown placeholders are kept as they are. */
export function fill(s: string, vars: Record<string, string | number | null | undefined> = {}): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

/** English plural for a count ("1 cabinet" / "3 cabinets"). */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Locale for dates and numbers. */
export const LOCALE: Record<Lang, string> = { vi: 'vi-VN', en: 'en-GB' };
