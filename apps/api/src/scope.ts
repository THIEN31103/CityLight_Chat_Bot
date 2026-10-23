// Area scope (spec 13): which cabinets a user may see. Provider, manager (roleSeesAll) and scope_all users see every cabinet;
// others see cabinets whose district or ward is one of their areas or a descendant of one.
// Cabinets without a district ("Chưa phân khu vực") are visible to scope_all users only.
import { roleSeesAll, type RoleKey } from '@citylight/shared';
import type { Sql } from './infra';

export interface Scope {
  all: boolean;
  /** user_scopes areas plus all descendants (unit -> district -> ward). */
  areaIds: string[];
}

export async function loadScope(sql: Sql, userId: string, role: RoleKey, scopeAll: boolean): Promise<Scope> {
  if (roleSeesAll(role) || scopeAll) return { all: true, areaIds: [] };
  const rows = await sql<{ id: string }[]>`
    WITH RECURSIVE t AS (
      SELECT a.id FROM areas a JOIN user_scopes s ON s.area_id = a.id WHERE s.user_id = ${userId}
      UNION SELECT a.id FROM areas a JOIN t ON a.parent_id = t.id
    ) SELECT id FROM t`;
  return { all: false, areaIds: rows.map((r) => r.id) };
}

/** SQL condition on a query that aliases cabinets as `c`. */
/**
 * Cabinets (alias c) the user may see. Also hides decommissioned cabinets (M8): every list, map and
 * counter goes through here, so a decommissioned cabinet disappears everywhere at once.
 */
export function scopeWhere(sql: Sql, scope: Scope) {
  if (scope.all) return sql`c.active`;
  if (!scope.areaIds.length) return sql`FALSE`;
  const ids = sql.array(scope.areaIds);
  return sql`(c.active AND (c.district_id = ANY(${ids}::uuid[]) OR c.ward_id = ANY(${ids}::uuid[])))`;
}

export function inScope(scope: Scope, districtId: string | null | undefined, wardId: string | null | undefined): boolean {
  if (scope.all) return true;
  return (!!districtId && scope.areaIds.includes(districtId)) || (!!wardId && scope.areaIds.includes(wardId));
}

/** Cabinet codes as typed (comma / semicolon / space / newline separated), at most `max`. */
export function parseCodes(text: string | undefined, max: number): string[] {
  return (text ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, max);
}

/**
 * Cabinets (alias c) in these zones (zone 1 or 2) and / or with these codes, case-insensitive; "TM01.*" = every code
 * starting with TM01. Shared by reports (S55) and command batches (S56); combine with scopeWhere.
 */
export function pickWhere(sql: Sql, zoneIds: string[], codes: string[]) {
  const exact = codes.filter((c) => !c.endsWith('*')).map((c) => c.toUpperCase());
  const prefixes = codes.filter((c) => c.endsWith('*')).map((c) => `${c.slice(0, -1).replace(/[\\%_]/g, '\\$&').toUpperCase()}%`);
  return sql`(c.zone1_id = ANY(${zoneIds}::uuid[]) OR c.zone2_id = ANY(${zoneIds}::uuid[])
    OR upper(c.code) = ANY(${exact}::text[]) OR upper(c.code) LIKE ANY(${prefixes}::text[]))`;
}
