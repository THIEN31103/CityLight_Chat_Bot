import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import dayjs from 'dayjs';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const DATE_TIME = 'DD/MM/YYYY HH:mm:ss';
export const DATE_TIME_SHORT = 'DD/MM/YYYY HH:mm';

export function fmtTime(iso: string | null | undefined, format = DATE_TIME): string {
  return iso ? dayjs(iso).format(format) : '—';
}

/** Number or "—" when the value is missing (CoreIF X / not supported yet). */
export function fmtNum(v: number | null | undefined, digits = 1, unit = ''): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v.toLocaleString('vi-VN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}${unit ? ' ' + unit : ''}`;
}

export function fmtDuration(fromIso: string, toIso: string | null): string {
  const ms = dayjs(toIso ?? undefined).diff(dayjs(fromIso));
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} phút`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} giờ ${min % 60} phút`;
  return `${Math.floor(h / 24)} ngày ${h % 24} giờ`;
}

export function fmtBool(v: boolean | null | undefined, yes = 'Có', no = 'Không'): string {
  if (v === null || v === undefined) return '—';
  return v ? yes : no;
}
