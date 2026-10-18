import { describe, expect, it } from 'vitest';
import { defaultDimmingSegments, dimmingSavedPct, estimateDimming, validateDimming } from '../src';

describe('validateDimming', () => {
  it('default profile is valid', () => {
    expect(validateDimming(defaultDimmingSegments())).toEqual([]);
  });

  it('reports gaps, bad levels, reversed and out-of-range segments', () => {
    const s = defaultDimmingSegments();
    s[2]!.startMin = 1450; // gap after segment 2
    s[3]!.levelPct = 120;
    s[4]!.endMin = 1600; // before its start
    const e = validateDimming(s);
    expect(e.some((x) => x.startsWith('Thời đoạn 3: phải bắt đầu'))).toBe(true);
    expect(e.some((x) => x.startsWith('Thời đoạn 4: mức'))).toBe(true);
    expect(e.some((x) => x.startsWith('Thời đoạn 5: giờ kết thúc'))).toBe(true);
    expect(validateDimming([])).toHaveLength(1);
    expect(validateDimming([...defaultDimmingSegments(), { enabled: true, startMin: 1785, endMin: 1800, levelPct: 100 }])[0]).toContain('1 đến 5');
    expect(validateDimming([{ enabled: true, startMin: 1700, endMin: 3000, levelPct: 50 }])[0]).toContain('ngoài khoảng');
  });
});

describe('savings', () => {
  it('saved share: disabled segments count as full power', () => {
    const s = defaultDimmingSegments(); // 11.75 h: 4 h@100, 2 h@75, 2 h@50, 2 h@75, 1.75 h@100
    expect(dimmingSavedPct(s)).toBeCloseTo((2 * 25 + 2 * 50 + 2 * 25) / 11.75, 5);
    expect(dimmingSavedPct(s.map((x) => ({ ...x, enabled: false })))).toBe(0);
  });

  it('kWh from the real rated power, money only with a price', () => {
    const e = estimateDimming(defaultDimmingSegments(), 20, 3000, 2000); // 20 lamps × 150 W
    expect(e.ratedKw).toBe(3);
    expect(e.hours).toBe(11.8);
    expect(e.kwhPerNight).toBe(6); // 3 kW × 2 h saved-equivalent
    expect(e.kwhPerYear).toBe(2190);
    expect(e.vndPerYear).toBe(4_380_000);
    expect(estimateDimming(defaultDimmingSegments(), 0, 0, null)).toMatchObject({ kwhPerNight: 0, vndPerYear: null });
  });
});
