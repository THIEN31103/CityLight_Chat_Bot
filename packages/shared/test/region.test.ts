import { describe, expect, it } from 'vitest';
import { defaultThresholds, inRegion, measurementAlarms, regionView, type MeasureInput } from '../src';
import { loadServiceRegion } from '../src/region-node';

const R = loadServiceRegion('hcm-2025')!;

describe('service region hcm-2025 (S62)', () => {
  it('is TP. Hồ Chí Minh after the 2025 merger: 168 units in former-district groups', () => {
    const wards = R.groups.flatMap((g) => g.wards);
    expect(wards).toHaveLength(168);
    expect(new Set(wards).size).toBe(168);
    expect(wards.filter((w) => w.startsWith('Phường '))).toHaveLength(113);
    expect(wards.filter((w) => w.startsWith('Xã '))).toHaveLength(54);
    expect(wards).toContain('Đặc khu Côn Đảo');
    expect(R.groups.every((g) => g.name.endsWith(' (cũ)'))).toBe(true);
  });

  it.each([
    ['Bến Thành', 10.7725, 106.698],
    ['Thủ Dầu Một', 10.98, 106.652],
    ['Vũng Tàu', 10.346, 107.084],
    ['Cần Giờ', 10.411, 106.955],
    ['Côn Đảo', 8.682, 106.607],
  ])('%s is inside', (_, lat, lng) => expect(inRegion(R, { lat, lng })).toBe(true));

  it.each([
    ['Hà Nội', 21.028, 105.854],
    ['Tân An (Tây Ninh)', 10.535, 106.413],
    ['Mỹ Tho (Đồng Tháp)', 10.36, 106.36],
    ['Biển Đông', 9.5, 107.5],
  ])('%s is outside', (_, lat, lng) => expect(inRegion(R, { lat, lng })).toBe(false));

  it('a boundary vertex counts as inside', () => {
    const main = [...R.polygons].sort((a, b) => b[0]!.length - a[0]!.length)[0]!;
    const [lng, lat] = main[0]![10]!;
    expect(inRegion(R, { lat, lng })).toBe(true);
  });

  it('a point just outside the boundary is inside within REGION_EDGE_M only', () => {
    // walk west from a point inside along its latitude until the check flips, then 100 m / 2 km further out
    let lng = 106.6;
    const lat = 10.75;
    while (inRegion(R, { lat, lng }, 0)) lng -= 0.0005;
    const m = 1 / (111_320 * Math.cos((lat * Math.PI) / 180));
    expect(inRegion(R, { lat, lng: lng - 100 * m })).toBe(true);
    expect(inRegion(R, { lat, lng: lng - 100 * m }, 0)).toBe(false);
    expect(inRegion(R, { lat, lng: lng - 2000 * m })).toBe(false);
  });

  it('the web view carries no polygon', () => {
    expect(Object.keys(regionView(R)).sort()).toEqual(['bbox', 'id', 'name', 'outline']);
  });
});

describe('E807 gps_out_of_region', () => {
  const NOW = Date.parse('2026-11-03T05:00:00Z');
  const h = (gps: { lat: number; lng: number } | null) => ({
    online: true, lastSeenAt: '2026-11-03T04:59:55Z', busStatus: '0', plcOnline: true, pmOnline: true,
    branch1On: false, branch2On: false, manualMode: false, vL1: 222, vL2: 223, vL3: 221, iL1: 0, iL2: 0, iL3: 0,
    pfTotal: 0.95, leakMa: 12, tempC: 35, tempSensorFault: false, tempSensorInstalled: true, gpsDevice: gps,
    declaredLocation: gps, batteryMv: 4000, deviceTime: '2026-11-03T05:00:00Z', deviceTimeChangedAt: '2026-11-03T04:59:30Z',
    deviceTimeMissingSince: null, logoLink: null, lastBootAt: '2026-11-03T00:00:00Z', bootsLastHour: 0, bootsLast24h: 1, fwProfile: 'v2-current',
  }) as MeasureInput;
  const run = (gps: { lat: number; lng: number } | null, region = R) =>
    measurementAlarms(h(gps), defaultThresholds(), { samples: [], schedule: null, now: NOW, region });

  it('opens outside the region only', () => {
    expect(run({ lat: 21.028, lng: 105.854 }).get('gps_out_of_region')).toBe('GPS 21.02800, 105.85400 ngoài phạm vi TP. Hồ Chí Minh');
    expect(run({ lat: 10.7725, lng: 106.698 }).has('gps_out_of_region')).toBe(false);
    expect(run(null).has('gps_out_of_region')).toBe(false);
  });

  it('is off without a region (production)', () => {
    expect(measurementAlarms(h({ lat: 21.028, lng: 105.854 }), defaultThresholds(), { samples: [], schedule: null, now: NOW }).has('gps_out_of_region')).toBe(false);
  });
});
