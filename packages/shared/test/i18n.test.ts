import { describe, expect, it } from 'vitest';
import { LABELS, defineDict, describeCommand, fill, isLang, plural } from '../src';

describe('i18n core (S49)', () => {
  it('fill puts values into {placeholders} and keeps unknown ones', () => {
    expect(fill('Khóa tới {time} ({n} lần)', { time: '16:05', n: 5 })).toBe('Khóa tới 16:05 (5 lần)');
    expect(fill('{a} {b}', { a: 1 })).toBe('1 {b}');
  });
  it('plural (English)', () => {
    expect(plural(1, 'cabinet', 'cabinets')).toBe('1 cabinet');
    expect(plural(3, 'cabinet', 'cabinets')).toBe('3 cabinets');
  });
  it('defineDict keeps both halves', () => {
    const d = defineDict({ a: 'xin chào', n: (x: number) => `${x} tủ` }, { a: 'hello', n: (x: number) => plural(x, 'cabinet', 'cabinets') });
    expect(d.vi.a).toBe('xin chào');
    expect(d.en.n(2)).toBe('2 cabinets');
  });
  it('isLang', () => {
    expect(isLang('en')).toBe(true);
    expect(isLang('fr')).toBe(false);
  });
});

describe('bilingual labels', () => {
  it('every enum label exists in both languages', () => {
    for (const group of Object.keys(LABELS.vi) as (keyof typeof LABELS.vi)[]) {
      expect(Object.keys(LABELS.en[group]).sort()).toEqual(Object.keys(LABELS.vi[group]).sort());
    }
  });
  it('describeCommand: Vietnamese unchanged, English', () => {
    expect(describeCommand('MANUAL_BRANCH', { on: true, branch: 2 })).toBe('Bật nhánh 2 (thủ công)');
    expect(describeCommand('MANUAL_BRANCH', { on: true, branch: 2 }, 'en')).toBe('Branch 2 on (manual)');
    expect(describeCommand('SET_SCHEDULE', { mode: 2, on1: '18:00', off1: '05:30', on2: '18:30', off2: '23:00' }, 'en')).toBe('Schedule mode 2: B1 18:00–05:30, B2 18:30–23:00');
  });
});
