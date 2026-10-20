// UI language (S49). Each screen owns a dictionary (i18n/dict/<area>.ts, defineDict(vi, en)) and reads its half
// with useDict(); TypeScript makes the English half complete. The language is per user (saved on the server,
// users.lang) and remembered in this browser for the login page.
import { create } from 'zustand';
import dayjs from 'dayjs';
import 'dayjs/locale/vi';
import 'dayjs/locale/en-gb';
import { DEFAULT_LANG, LABELS, LOCALE, fill, isLang, type Lang } from '@citylight/shared';

const KEY = 'cl.lang';

function readLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (isLang(v)) return v;
  } catch {
    /* storage blocked */
  }
  return DEFAULT_LANG;
}

function apply(lang: Lang) {
  document.documentElement.lang = lang;
  dayjs.locale(lang === 'vi' ? 'vi' : 'en-gb');
}

interface LangState {
  lang: Lang;
  /** switch the UI (and remember it in this browser); saving it for the user is the caller's job */
  setLang: (l: Lang) => void;
}

export const useLang = create<LangState>((set) => {
  const initial = readLang();
  apply(initial);
  return {
    lang: initial,
    setLang: (lang) => {
      try {
        localStorage.setItem(KEY, lang);
      } catch {
        /* storage blocked */
      }
      apply(lang);
      set({ lang });
    },
  };
});

export const getLang = (): Lang => useLang.getState().lang;

/** This language's half of a dictionary; re-renders when the language changes. */
export function useDict<T>(d: Record<Lang, T>): T {
  return d[useLang((s) => s.lang)];
}

/** Same outside React (toasts in callbacks, module-level helpers). */
export function dictNow<T>(d: Record<Lang, T>): T {
  return d[getLang()];
}

/** Enum labels (status, severity, command, incident status, role) in the current language. */
export const useLabels = () => useDict(LABELS);

/** Locale string for toLocaleString / Intl in the current language. */
export const locale = () => LOCALE[getLang()];

export { fill };
