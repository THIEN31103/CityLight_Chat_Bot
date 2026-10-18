// Stored schedules -> the window each cabinet should run (M6). Shared by apps/api (batches, cabinet
// detail) and the scheduler worker (reconcile).
import type postgres from 'postgres';
import { desiredSchedule, type GeoPoint, type Schedule, type ScheduleSource, type ScheduleWindow } from '@citylight/shared';

type Sql = postgres.Sql;

export interface ScheduleRow {
  zone_id: string | null; cabinet_id: string | null; mode: number; source: string; on1: string; off1: string; on2: string | null; off2: string | null;
  branch1_enabled: boolean; branch2_enabled: boolean; offset_on_min: number; offset_off_min: number;
}

export function scheduleFromRow(r: ScheduleRow, inherited = false): Schedule {
  return {
    mode: Number(r.mode) as 1 | 2, source: r.source as Schedule['source'], on1: r.on1, off1: r.off1, on2: r.on2 ?? '18:15', off2: r.off2 ?? '23:00',
    branch1Enabled: r.branch1_enabled, branch2Enabled: r.branch2_enabled, offsetOnMin: Number(r.offset_on_min), offsetOffMin: Number(r.offset_off_min),
    appliedAt: null, inheritedFromZone: inherited,
  };
}

export interface Desired {
  cabinetId: string;
  ltid: string;
  window: ScheduleWindow;
  source: ScheduleSource;
}

/**
 * Desired window for the given cabinets (all when `cabinetIds` is null). Astronomical zone schedules
 * use the zone centre (same minutes as the web preview); a cabinet's own astronomical schedule uses
 * the cabinet position.
 */
export async function loadDesired(sql: Sql, cabinetIds: string[] | null, now = Date.now()): Promise<Desired[]> {
  const rows = await sql<ScheduleRow[]>`SELECT * FROM schedules`;
  const byZone = new Map<string, Schedule>();
  const byCab = new Map<string, Schedule>();
  for (const r of rows) {
    if (r.cabinet_id) byCab.set(r.cabinet_id, scheduleFromRow(r));
    else if (r.zone_id) byZone.set(r.zone_id, scheduleFromRow(r, true));
  }
  const zones = await sql<{ id: string; lat: number; lng: number }[]>`SELECT id, ST_Y(center) AS lat, ST_X(center) AS lng FROM zones`;
  const centre = new Map<string, GeoPoint>(zones.map((z) => [z.id, { lat: Number(z.lat), lng: Number(z.lng) }]));
  const cabs = await sql<{ id: string; ltid: string; zone1_id: string | null; lat: number; lng: number }[]>`
    SELECT id, ltid, zone1_id, ST_Y(location) AS lat, ST_X(location) AS lng FROM cabinets
    ${cabinetIds ? sql`WHERE id = ANY(${cabinetIds}::uuid[])` : sql``}`;
  return cabs.map((c) => {
    const own = byCab.get(c.id) ?? null;
    const zone = c.zone1_id ? byZone.get(c.zone1_id) ?? null : null;
    const at = own ? { lat: Number(c.lat), lng: Number(c.lng) } : c.zone1_id ? centre.get(c.zone1_id) ?? null : null;
    const d = desiredSchedule(own, zone, at, now);
    return { cabinetId: c.id, ltid: c.ltid, window: d.window, source: d.source };
  });
}
