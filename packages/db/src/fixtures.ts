// Reference geography for seeding (HCMC districts used by the demo / simulator fleet).
export const DISTRICTS: { name: string; lat: number; lng: number; spread: number; wards: number }[] = [
  { name: 'Quận 1', lat: 10.7769, lng: 106.7009, spread: 0.012, wards: 8 },
  { name: 'Quận 3', lat: 10.7843, lng: 106.6844, spread: 0.01, wards: 7 },
  { name: 'Quận 4', lat: 10.7578, lng: 106.7043, spread: 0.008, wards: 6 },
  { name: 'Quận 5', lat: 10.754, lng: 106.6634, spread: 0.01, wards: 7 },
  { name: 'Quận 7', lat: 10.734, lng: 106.7218, spread: 0.02, wards: 8 },
  { name: 'Quận 8', lat: 10.724, lng: 106.6286, spread: 0.018, wards: 8 },
  { name: 'Quận 10', lat: 10.7746, lng: 106.667, spread: 0.009, wards: 7 },
  { name: 'Bình Thạnh', lat: 10.8106, lng: 106.7091, spread: 0.015, wards: 8 },
  { name: 'Phú Nhuận', lat: 10.7992, lng: 106.6803, spread: 0.008, wards: 6 },
  { name: 'Gò Vấp', lat: 10.8387, lng: 106.6653, spread: 0.016, wards: 8 },
  { name: 'Tân Bình', lat: 10.8015, lng: 106.6527, spread: 0.015, wards: 8 },
  { name: 'TP Thủ Đức', lat: 10.8494, lng: 106.7537, spread: 0.035, wards: 8 },
];

export const ZONES = [
  { name: 'Vùng trung tâm', lat: 10.777, lng: 106.695, districts: ['Quận 1', 'Quận 3', 'Quận 4', 'Quận 10', 'Phú Nhuận'] },
  { name: 'Vùng Thủ Đức', lat: 10.849, lng: 106.754, districts: ['TP Thủ Đức'] },
  { name: 'Vùng Nam', lat: 10.73, lng: 106.68, districts: ['Quận 5', 'Quận 7', 'Quận 8'] },
  { name: 'Vùng Bắc', lat: 10.82, lng: 106.665, districts: ['Bình Thạnh', 'Gò Vấp', 'Tân Bình'] },
];

export const MANAGEMENT_UNITS = ['Khu quản lý 1', 'Khu quản lý 2', 'Khu quản lý 3', 'Khu quản lý 4'];

/** Deterministic fleet position for simulator cabinet #i (shared by simulator and fleet registration). */
export function fleetLocation(i: number): { lat: number; lng: number; district: number } {
  let s = (i + 1) * 2654435761;
  const r = () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s / 4294967296;
  };
  const district = Math.floor(r() * DISTRICTS.length);
  const d = DISTRICTS[district]!;
  return { lat: d.lat + (r() * 2 - 1) * d.spread, lng: d.lng + (r() * 2 - 1) * d.spread, district };
}
