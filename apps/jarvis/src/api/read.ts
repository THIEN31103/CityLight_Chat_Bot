// Read endpoints Jarvis uses, with the shapes verified in apps/api/src (README "API đã xác minh").
// Raw API data: the tool layer (milestone 2) shortens it and runs sanitizeForLlm() before the model sees it.
// Not here on purpose: /map/cabinets (10k cabinets ~3.4 MB) and every write endpoint.
import type { Alarm, CabinetSummary, Command, MapStats, Page, TelemetryPoint, User } from '@citylight/shared';
import type { ApiClient, RequestOptions } from './client';

/** Telemetry metrics the API accepts (apps/api/src/cabinets.ts METRIC); anything else is ignored there. */
export const TELEMETRY_METRICS = ['vL1', 'vL2', 'vL3', 'iL1', 'iL2', 'iL3', 'pTotalKw', 'pfTotal', 'leakMa', 'tempC'] as const;
export type TelemetryMetric = (typeof TELEMETRY_METRICS)[number];

export interface AlarmRule {
  type: string;
  code: string;
  title: string;
  severity: 'critical' | 'major' | 'minor';
  condition: string;
  enabled: boolean;
  thresholdDefault: unknown;
}

export interface AreaNode {
  id: string;
  name: string;
  parentId: string | null;
  kind: 'unit' | 'district' | 'ward';
  cabinetCount: number;
}

export interface DiagnosticsResult {
  items: { key: string; level: string; label: string; detail?: string; [k: string]: unknown }[];
  lastBootAt: string | null;
  bootsLast24h: number;
  selfTest: unknown;
}

export interface AlarmQuery {
  active?: boolean;
  type?: string;
  severity?: 'critical' | 'major' | 'minor';
  district?: string;
  from?: string;
  to?: string;
  page?: number;
  size?: number;
}

export class CityLightReads {
  constructor(private readonly api: ApiClient) {}

  me(o?: RequestOptions) {
    return this.api.get<User>('auth/me', undefined, o);
  }

  /** online / offline / on / off / fault counts in the user's scope (any signed-in role). */
  mapStats(o?: RequestOptions) {
    return this.api.get<MapStats>('map/stats', undefined, o);
  }

  /** Name, code or address; the API needs at least 2 characters and returns at most 10. */
  async search(q: string, o?: RequestOptions) {
    const t = q.trim();
    if (t.length < 2) return [];
    return this.api.get<CabinetSummary[]>('search', { q: t }, o);
  }

  /** 404 not_found, 403 forbidden_scope (outside the user's areas). */
  cabinet(id: string, o?: RequestOptions) {
    return this.api.get<Record<string, unknown>>(`cabinets/${encodeURIComponent(id)}`, undefined, o);
  }

  diagnostics(id: string, o?: RequestOptions) {
    return this.api.get<DiagnosticsResult>(`cabinets/${encodeURIComponent(id)}/diagnostics`, undefined, o);
  }

  /** Bucketed averages (~300 points); raw table up to 7 days, hourly beyond. Default window: last 6 h. */
  telemetry(id: string, metrics: TelemetryMetric[], from?: Date, to?: Date, o?: RequestOptions) {
    return this.api.get<TelemetryPoint[]>(`cabinets/${encodeURIComponent(id)}/telemetry`, {
      metrics: metrics.join(','),
      from: from?.toISOString(),
      to: to?.toISOString(),
    }, o);
  }

  cabinetAlarms(id: string, limit = 20, o?: RequestOptions) {
    return this.api.get<Alarm[]>(`cabinets/${encodeURIComponent(id)}/alarms`, { limit: Math.min(100, limit) }, o);
  }

  cabinetCommands(id: string, limit = 20, o?: RequestOptions) {
    return this.api.get<Command[]>(`cabinets/${encodeURIComponent(id)}/commands`, { limit: Math.min(200, limit) }, o);
  }

  /** Needs alarm.view (every role has it, packages/shared/src/permissions.ts); filtered to the user's areas. */
  alarms(q: AlarmQuery = {}, o?: RequestOptions) {
    return this.api.get<Page<Alarm>>('alarms', { ...q, active: q.active === undefined ? undefined : String(q.active) }, o);
  }

  /** Alarm codes in the user's language (needs alarm.view); the only source of code meanings, never hard-coded. */
  alarmRules(o?: RequestOptions) {
    return this.api.get<AlarmRule[]>('alarm-rules', undefined, o);
  }

  areaTree(o?: RequestOptions) {
    return this.api.get<{ areas: AreaNode[]; unassigned: number }>('areas/tree', undefined, o);
  }

  /** Cabinets of one ward (the API matches ward_id only). */
  areaCabinets(areaId: string, o?: RequestOptions) {
    return this.api.get<CabinetSummary[]>(`areas/${encodeURIComponent(areaId)}/cabinets`, undefined, o);
  }

  /** Zone schedule (needs map.view): by zone id, not area id. */
  zoneSchedule(zoneId: string, o?: RequestOptions) {
    return this.api.get<Record<string, unknown>>(`zones/${encodeURIComponent(zoneId)}/schedule`, undefined, o);
  }

  /** Needs incident.view. */
  incidents(query: Record<string, string | number | undefined> = {}, o?: RequestOptions) {
    return this.api.get<Page<Record<string, unknown>>>('incidents', query, o);
  }

  command(id: string, o?: RequestOptions) {
    return this.api.get<Command>(`commands/${encodeURIComponent(id)}`, undefined, o);
  }

  serverTime(o?: RequestOptions) {
    return this.api.get<{ now: string }>('server-time', undefined, o);
  }

  health(o?: RequestOptions) {
    return this.api.get<{ status: string; db: string; redis: string; at: string }>('health', undefined, o);
  }
}
