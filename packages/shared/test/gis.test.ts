import { describe, expect, it } from 'vitest';
import { directionsUrl, distanceM, lineLengthM, normHeader, parseImportRows, poleCode, pointsAlong, routeCode, type LngLat } from '../src';

// ~111 m per 0.001° of latitude
const north = (m: number): LngLat => [106.7, 10.77 + m / 111_195];

describe('codes', () => {
  it('route and pole codes', () => {
    expect(routeCode('TL01.0001', 2)).toBe('TL01.0001_N2');
    expect(poleCode('TL01.0001', 1, 7)).toBe('TL01.0001_N1_7');
  });
});

describe('pointsAlong', () => {
  it('every 30 m along a straight 300 m line: 11 poles, last one at the end', () => {
    const line = [north(0), north(300)];
    expect(Math.round(lineLengthM(line))).toBe(300);
    const p = pointsAlong(line, 30);
    expect(p).toHaveLength(11);
    for (let i = 1; i < p.length; i++) expect(distanceM({ lat: p[i - 1]![1], lng: p[i - 1]![0] }, { lat: p[i]![1], lng: p[i]![0] })).toBeCloseTo(30, 0);
  });

  it('measures along the bends, not straight across', () => {
    const corner: LngLat = [106.7 + 100 / 109_400, 10.77]; // ~100 m east
    const line: LngLat[] = [north(0), corner, [corner[0], 10.77 + 100 / 111_195]];
    expect(Math.round(lineLengthM(line))).toBe(200);
    expect(pointsAlong(line, 50)).toHaveLength(5); // 0, 50, 100 (corner), 150, 200
  });

  it('adds the end pole only when the remainder is long enough', () => {
    expect(pointsAlong([north(0), north(65)], 30)).toHaveLength(3); // 0, 30, 60 (5 m left: no extra pole)
    expect(pointsAlong([north(0), north(80)], 30)).toHaveLength(4); // 0, 30, 60, 80
  });
});

describe('parseImportRows', () => {
  it('reads the template headers with or without accents', () => {
    expect(normHeader('Công suất (W)')).toBe('cong_suat_w');
    expect(normHeader('Thứ tự trụ')).toBe('thu_tu_tru');
    const { poles, errors } = parseImportRows([
      { 'Mã tủ': 'TL01.0001', 'Nhánh': 'N1', 'Thứ tự trụ': 1, 'Vĩ độ': 10.77, 'Kinh độ': 106.7, 'Số đèn': 2, 'Công suất (W)': 150, 'Nhóm đèn': 1 },
      { ma_tu: 'TL01.0001', nhanh: '2', thu_tu: '3', lat: '10,771', lng: '106.701' },
      { 'Mã tủ': '', 'Nhánh': '' },
    ]);
    expect(errors).toEqual([]);
    expect(poles).toHaveLength(2);
    expect(poles[0]).toMatchObject({ row: 2, branch: 1, seq: 1, lampCount: 2, ratedPowerW: 150, lampGroup: 1 });
    expect(poles[1]).toMatchObject({ row: 3, branch: 2, seq: 3, lat: 10.771, lampCount: 1, ratedPowerW: null });
  });

  it('reports bad rows with their sheet row number', () => {
    const { poles, errors } = parseImportRows([
      { ma_tu: 'A', nhanh: '3', thu_tu: 1, lat: 10.7, lng: 106.7 },
      { ma_tu: 'A', nhanh: '1', thu_tu: 1, lat: 106.7, lng: 10.7 },
      { ma_tu: 'A', nhanh: '1', thu_tu: 0, lat: 10.7, lng: 106.7 },
      { ma_tu: 'A', nhanh: '1', thu_tu: 1, lat: 10.7, lng: 106.7 },
      { ma_tu: 'A', nhanh: '1', thu_tu: 1, lat: 10.7, lng: 106.7 },
      { ma_tu: 'A', nhanh: '1', thu_tu: 2, lat: 10.7, lng: 106.7, nhom_den: 7 },
    ]);
    expect(poles).toHaveLength(1);
    expect(errors.map((e) => e.row)).toEqual([2, 3, 4, 6, 7]);
    expect(errors[1]!.message).toContain('ngoài Việt Nam');
    expect(errors[3]!.message).toContain('Trùng');
  });
});

describe('directionsUrl', () => {
  it('builds a Google Maps directions link from coordinates only', () => {
    expect(directionsUrl({ lat: 10.7769, lng: 106.7009 })).toBe('https://www.google.com/maps/dir/?api=1&destination=10.776900,106.700900');
  });
  it('rejects unset or invalid points', () => {
    expect(directionsUrl({ lat: 0, lng: 0 })).toBeNull();
    expect(directionsUrl({ lat: 95, lng: 106 })).toBeNull();
    expect(directionsUrl({ lat: Number.NaN, lng: 106 })).toBeNull();
    expect(directionsUrl(null)).toBeNull();
  });
});
