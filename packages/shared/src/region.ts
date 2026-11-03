// Service region (S62): the territory one deployment serves. Off by default (production); the trial sets
// SERVICE_REGION=hcm-2025 (packages/shared/regions/, TP. Hồ Chí Minh after the 2025 merger). With a region:
// cabinet / pole positions outside it are refused, a cabinet GPS fix outside it raises E807, the area tree is
// the region's ward list (locked) and the web map is held inside it.
import type { GeoPoint } from './domain';

type Ring = [number, number][]; // [lng, lat], closed

export interface ServiceRegion {
  id: string;
  name: string;
  note?: string;
  /** [minLng, minLat, maxLng, maxLat] */
  bbox: [number, number, number, number];
  /** MultiPolygon coordinates (outer ring + holes), used for the inside check */
  polygons: Ring[][];
  /** coarser outer rings, drawn on the web map */
  outline: Ring[];
  /** area tree: group (district level, former district) -> ward / commune names */
  groups: { name: string; wards: string[] }[];
}

/** What the web map gets (GET /map/region). */
export type RegionView = Pick<ServiceRegion, 'id' | 'name' | 'bbox' | 'outline'>;

/** A point this close outside the boundary still counts as inside (boundary simplification, GPS error). */
export const REGION_EDGE_M = 300;

const M_PER_DEG_LAT = 110_540;
const mPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

function inRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance in metres from p to the nearest boundary segment (local flat approximation). */
function edgeDistanceM(r: ServiceRegion, p: GeoPoint): number {
  const kx = mPerDegLng(p.lat);
  let best = Infinity;
  for (const poly of r.polygons)
    for (const ring of poly)
      for (let i = 1; i < ring.length; i++) {
        const ax = (ring[i - 1]![0] - p.lng) * kx, ay = (ring[i - 1]![1] - p.lat) * M_PER_DEG_LAT;
        const bx = (ring[i]![0] - p.lng) * kx, by = (ring[i]![1] - p.lat) * M_PER_DEG_LAT;
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
      }
  return best;
}

/** True when p is inside the region or within edgeM of its boundary. */
export function inRegion(r: ServiceRegion, p: GeoPoint, edgeM = REGION_EDGE_M): boolean {
  const padLat = edgeM / M_PER_DEG_LAT, padLng = edgeM / mPerDegLng(p.lat);
  const [x0, y0, x1, y1] = r.bbox;
  if (p.lng < x0 - padLng || p.lng > x1 + padLng || p.lat < y0 - padLat || p.lat > y1 + padLat) return false;
  for (const [outer, ...holes] of r.polygons)
    if (outer && inRing(outer, p.lng, p.lat) && !holes.some((h) => inRing(h, p.lng, p.lat))) return true;
  return edgeM > 0 && edgeDistanceM(r, p) <= edgeM;
}

export const regionView = (r: ServiceRegion): RegionView => ({ id: r.id, name: r.name, bbox: r.bbox, outline: r.outline });
