import { describe, expect, it } from 'vitest';
import { astroPreview, astroWindow, defaultSchedule, desiredSchedule, sameSchedule, vnDate, vnHhmm, type Schedule } from '../src';

const HCM = { lat: 10.7769, lng: 106.7009 };
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

describe('time helpers', () => {
  it('VN date and HH:MM', () => {
    expect(vnDate(Date.parse('2026-10-18T17:30:00Z'))).toBe('2026-10-19'); // 00:30 next day in VN
    expect(vnHhmm(Date.parse('2026-10-18T10:41:31Z'))).toBe('17:42'); // rounded
  });
});

describe('astronomical window (Hồ Chí Minh)', () => {
  it('sunset ~17:3x, sunrise ~05:4x in mid October, offsets applied', () => {
    const w = astroWindow(HCM, '2026-10-18', 10, -10);
    expect(toMin(w.sunset)).toBeGreaterThanOrEqual(17 * 60 + 25);
    expect(toMin(w.sunset)).toBeLessThanOrEqual(17 * 60 + 45);
    expect(toMin(w.sunrise)).toBeGreaterThanOrEqual(5 * 60 + 35);
    expect(toMin(w.sunrise)).toBeLessThanOrEqual(5 * 60 + 55);
    expect(toMin(w.on) - toMin(w.sunset)).toBe(10);
    expect(toMin(w.sunrise) - toMin(w.off)).toBe(10);
  });

  it('changes by about a minute a day at most', () => {
    const p = astroPreview(HCM, '2026-10-18', 30, 10, -10);
    expect(p).toHaveLength(30);
    expect(p[0]!.date).toBe('2026-10-18');
    expect(p[29]!.date).toBe('2026-11-16');
    for (let i = 1; i < p.length; i++) expect(Math.abs(toMin(p[i]!.on) - toMin(p[i - 1]!.on))).toBeLessThanOrEqual(1);
  });
});

describe('desiredSchedule', () => {
  const zone: Schedule = { ...defaultSchedule(), on1: '18:05', off1: '05:40', inheritedFromZone: false };
  const own: Schedule = { ...zone, mode: 2, on1: '18:30', on2: '18:30', off2: '23:00', branch2Enabled: true };
  const now = Date.parse('2026-10-18T05:00:00Z');

  it('cabinet override > zone > default', () => {
    expect(desiredSchedule(own, zone, HCM, now).source).toBe('cabinet');
    expect(desiredSchedule(null, zone, HCM, now)).toMatchObject({ source: 'zone', window: { on1: '18:05', off1: '05:40' } });
    expect(desiredSchedule(null, null, HCM, now)).toMatchObject({ source: 'default', window: { on1: '18:00', off1: '05:45' } });
  });

  it('astronomical replaces branch 1 window only', () => {
    const astro: Schedule = { ...own, source: 'astronomical' };
    const w = desiredSchedule(astro, null, HCM, now).window;
    const a = astroWindow(HCM, '2026-10-18', own.offsetOnMin, own.offsetOffMin);
    expect([w.on1, w.off1]).toEqual([a.on, a.off]);
    expect([w.on2, w.off2]).toEqual(['18:30', '23:00']);
  });
});

describe('sameSchedule', () => {
  const s = desiredSchedule(null, null, null).window;
  it('Chế độ 1 ignores branch 2 fields, Chế độ 2 compares everything', () => {
    expect(sameSchedule(s, { ...s, on2: '19:00', branch2Enabled: false })).toBe(true);
    expect(sameSchedule(s, { ...s, off1: '05:46' })).toBe(false);
    const m2 = { ...s, mode: 2 as const };
    expect(sameSchedule(m2, { ...m2, on2: '19:00' })).toBe(false);
    expect(sameSchedule(s, null)).toBe(false);
  });
});
