import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import dayjs from 'dayjs';
import { dictNow, locale } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// day/month order is the same in Vietnamese and British English
export const DATE_TIME = 'DD/MM/YYYY HH:mm:ss';
export const DATE_TIME_SHORT = 'DD/MM/YYYY HH:mm';

export function fmtTime(iso: string | null | undefined, format = DATE_TIME): string {
  return iso ? dayjs(iso).format(format) : '—';
}

/** Number or "—" when the value is missing (CoreIF X / not supported yet). */
export function fmtNum(v: number | null | undefined, digits = 1, unit = ''): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })}${unit ? ' ' + unit : ''}`;
}

export function fmtDuration(fromIso: string, toIso: string | null): string {
  const c = dictNow(COMMON);
  const ms = dayjs(toIso ?? undefined).diff(dayjs(fromIso));
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return c.minutes(min);
  const h = Math.floor(min / 60);
  if (h < 24) return c.hoursMinutes(h, min % 60);
  return c.daysHours(Math.floor(h / 24), h % 24);
}

export function fmtBool(v: boolean | null | undefined, yes?: string, no?: string): string {
  if (v === null || v === undefined) return '—';
  const c = dictNow(COMMON);
  return v ? (yes ?? c.yes) : (no ?? c.no);
}
