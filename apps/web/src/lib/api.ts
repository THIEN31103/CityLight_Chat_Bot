// Typed client for /api/v1 (spec 11). Same calls work against MSW (M1-UI) and the real API.
import type {
  ActivityLog,
  Alarm,
  Area,
  CabinetDetail,
  CabinetDiagnostics,
  CabinetSummary,
  Command,
  CommandBatch,
  CommandType,
  DimmingProfile,
  FieldMapEntry,
  GeoPoint,
  Incident,
  LampGroup,
  ManagementUnit,
  MapStats,
  Page,
  Schedule,
  TelemetryPoint,
  Thresholds,
  User,
  Zone,
} from '@citylight/shared';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// Transport is swappable: real network by default, in-page mock handlers in M1-UI (see mocks/browser.ts).
type Transport = (request: Request) => Promise<Response>;
let transport: Transport = (request) => fetch(request);
export function setTransport(t: Transport) {
  transport = t;
}

async function req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const request = new Request(new URL(`/api/v1${path}`, window.location.origin), {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await transport(request);
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.code ?? 'error', data?.detail ?? `Lỗi ${res.status}`);
  }
  return data as T;
}

const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface PoleAsset {
  id: string;
  code: string;
  cabinetId: string;
  cabinetName: string;
  routeCode: string;
  branch: 'N1' | 'N2';
  location: GeoPoint;
  lampCount: number;
}

export interface Favorite {
  id: string;
  name: string;
  center: GeoPoint;
  zoom: number;
}

export interface CabinetListItem extends CabinetSummary {
  districtName: string;
  fwProfile: string;
  lastSeenAt: string | null;
}

export interface LampItem {
  id: string;
  code: string;
  poleCode: string;
  routeCode: string;
  branch: 'N1' | 'N2';
  lampGroup: LampGroup;
  ratedPowerW: number;
  isSmart: boolean;
  location: GeoPoint;
}

export interface BatchItem {
  cabinetId: string;
  cabinetName: string;
  result: 'pending' | 'ok' | 'failed' | 'offline';
  error: string | null;
}

export interface IncidentReport {
  month: string;
  total: number;
  byDay: { day: number; new: number; assigned: number; done: number; deferred: number }[];
  byDistrict: Record<string, number>;
  byCategory: Record<string, number>;
  avgResolveHours: number;
  overdue: number;
}

export interface AlarmRule {
  type: string;
  severity: string;
  condition: string;
  enabled: boolean;
}

export interface SystemStats {
  cabinetsOnline: number;
  cabinetsTotal: number;
  msgPerSec: number;
  ingestLagMs: number;
  commandQueue: number;
  ackErrors24h: number;
  dbSizeGb: number;
  brokerConnections: number;
  uptimeHours: number;
}

export interface UnknownDevice {
  ltid: string;
  imei: string;
  firstSeenAt: string;
  lastSeenAt: string;
  frames: number;
}

export const api = {
  // auth
  login: (email: string, password: string) => req<{ requires2fa: boolean; user?: User }>('POST', '/auth/login', { email, password }),
  verify2fa: (code: string) => req<{ user: User }>('POST', '/auth/2fa/verify', { code }),
  logout: () => req<void>('POST', '/auth/logout'),
  me: () => req<User>('GET', '/auth/me'),
  changePassword: (oldPassword: string, newPassword: string) => req<void>('POST', '/me/password', { oldPassword, newPassword }),
  setup2fa: () => req<{ otpauthUrl: string; recoveryCodes: string[] }>('POST', '/auth/2fa/setup'),
  enable2fa: () => req<User>('POST', '/auth/2fa/enable'),
  disable2fa: () => req<User>('POST', '/auth/2fa/disable'),
  serverTime: () => req<{ now: string }>('GET', '/server-time'),

  // map
  mapStats: () => req<MapStats>('GET', '/map/stats'),
  mapCabinets: () => req<CabinetSummary[]>('GET', '/map/cabinets'),
  mapAssets: (bbox: [number, number, number, number]) => req<PoleAsset[]>('GET', `/map/assets${qs({ bbox: bbox.join(','), layers: 'poles' })}`),
  search: (q: string) => req<CabinetSummary[]>('GET', `/search${qs({ q })}`),
  favorites: () => req<Favorite[]>('GET', '/favorites'),
  addFavorite: (f: Omit<Favorite, 'id'>) => req<Favorite>('POST', '/favorites', f),
  deleteFavorite: (id: string) => req<void>('DELETE', `/favorites/${id}`),
  saveMapEdits: (moves: { cabinetId: string; lat: number; lng: number }[]) => req<{ saved: number }>('POST', '/map/edits', { moves }),

  // hierarchy
  areaTree: () => req<{ areas: Area[]; unassigned: number }>('GET', '/areas/tree'),
  areaCabinets: (id: string) => req<CabinetSummary[]>('GET', `/areas/${id}/cabinets`),
  nearby: (c: GeoPoint, radius = 2000) => req<(CabinetSummary & { distanceM: number })[]>('GET', `/cabinets/nearby${qs({ lat: c.lat, lng: c.lng, radius })}`),
  zones: () => req<Zone[]>('GET', '/zones'),
  managementUnits: () => req<ManagementUnit[]>('GET', '/management-units'),

  // cabinets
  cabinets: (p: { page?: number; size?: number; status?: string; q?: string }) => req<Page<CabinetListItem>>('GET', `/cabinets${qs(p)}`),
  cabinet: (id: string) => req<CabinetDetail & { cabinet: { districtName: string; wardName: string } }>('GET', `/cabinets/${id}`),
  updateCabinet: (id: string, patch: Record<string, unknown>) => req<unknown>('PATCH', `/cabinets/${id}`, patch),
  telemetry: (id: string, metrics: string[], from: string, to: string) => req<TelemetryPoint[]>('GET', `/cabinets/${id}/telemetry${qs({ metrics: metrics.join(','), from, to, interval: 'auto' })}`),
  energy: (id: string, range: 'day' | '30d') => req<{ estimated: boolean; points: { label: string; kwh: number }[] }>('GET', `/cabinets/${id}/energy${qs({ range })}`),
  setSchedule: (id: string, s: Schedule) => req<Command>('PUT', `/cabinets/${id}/schedule`, s),
  setThresholds: (id: string, t: Thresholds) => req<Thresholds>('PUT', `/cabinets/${id}/thresholds`, t),
  cabinetDimming: (id: string, group: LampGroup) => req<DimmingProfile>('GET', `/cabinets/${id}/dimming${qs({ group })}`),
  setCabinetDimming: (id: string, p: DimmingProfile) => req<DimmingProfile>('PUT', `/cabinets/${id}/dimming`, p),
  cabinetAlarms: (id: string, limit = 20) => req<Alarm[]>('GET', `/cabinets/${id}/alarms${qs({ limit })}`),
  cabinetCommands: (id: string) => req<Command[]>('GET', `/cabinets/${id}/commands`),
  cabinetLamps: (id: string) => req<LampItem[]>('GET', `/cabinets/${id}/lamps`),
  diagnostics: (id: string) => req<CabinetDiagnostics>('GET', `/cabinets/${id}/diagnostics`),

  // commands
  sendCommand: (id: string, type: CommandType, params: Record<string, unknown> = {}, opts: { queueIfOffline?: boolean } = {}) =>
    req<Command>('POST', `/cabinets/${id}/commands`, { type, params, ...opts }, { 'Idempotency-Key': crypto.randomUUID() }),
  command: (id: string) => req<Command>('GET', `/commands/${id}`),
  batches: () => req<CommandBatch[]>('GET', '/command-batches'),
  batch: (id: string) => req<{ batch: CommandBatch; items: BatchItem[] }>('GET', `/command-batches/${id}`),
  previewBatch: (zoneIds: string[]) => req<{ total: number; offline: number }>('POST', '/command-batches/preview', { zoneIds }),
  createBatch: (kind: CommandBatch['kind'], zoneIds: string[]) => req<CommandBatch>('POST', '/command-batches', { kind, zoneIds }),
  retryBatch: (id: string) => req<CommandBatch>('POST', `/command-batches/${id}/retry-failed`),

  // alarms
  alarms: (p: { active?: boolean; type?: string; severity?: string; district?: string; from?: string; to?: string; page?: number; size?: number }) =>
    req<Page<Alarm>>('GET', `/alarms${qs(p)}`),
  ackAlarm: (id: string) => req<Alarm>('POST', `/alarms/${id}/ack`),

  // incidents
  incidents: (p: { q?: string; district?: string; from?: string; to?: string; page?: number; size?: number }) => req<Page<Incident>>('GET', `/incidents${qs(p)}`),
  incident: (id: string) => req<Incident>('GET', `/incidents/${id}`),
  createIncident: (b: { cabinetId: string; category: string; content: string }) => req<Incident>('POST', '/incidents', b),
  transitionIncident: (id: string, b: { to: Incident['status']; note?: string; assignee?: string; deadline?: string; resolution?: string }) =>
    req<Incident>('POST', `/incidents/${id}/transition`, b),
  incidentReport: (month: string) => req<IncidentReport>('GET', `/incidents/report${qs({ month })}`),

  // schedules / dimming
  zoneSchedule: (id: string) => req<Schedule>('GET', `/zones/${id}/schedule`),
  setZoneSchedule: (id: string, s: Schedule) => req<Schedule>('PUT', `/zones/${id}/schedule`, s),
  groupDimming: (g: LampGroup) => req<DimmingProfile>('GET', `/dimming-profiles/${g}`),
  setGroupDimming: (g: LampGroup, p: DimmingProfile) => req<DimmingProfile>('PUT', `/dimming-profiles/${g}`, p),

  // logs
  activityLogs: (p: { user?: string; q?: string; from?: string; to?: string; page?: number; size?: number }) => req<Page<ActivityLog>>('GET', `/logs/activity${qs(p)}`),

  // admin
  users: () => req<User[]>('GET', '/users'),
  createUser: (u: Partial<User>) => req<User>('POST', '/users', u),
  updateUser: (id: string, u: Partial<User>) => req<User>('PATCH', `/users/${id}`, u),
  unknownDevices: () => req<UnknownDevice[]>('GET', '/devices/unknown'),
  fieldMap: () => req<FieldMapEntry[]>('GET', '/field-map'),
  alarmRules: () => req<AlarmRule[]>('GET', '/alarm-rules'),
  systemStats: () => req<SystemStats>('GET', '/system/stats'),
};
