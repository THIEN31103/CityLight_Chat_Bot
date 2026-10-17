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

/** CSRF double-submit (spec 13): the API sets a readable cl_csrf cookie; state-changing calls echo it. */
function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)cl_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** Fired when the session is gone (expired, revoked by an admin) or a forced step appears; the session store listens. */
export const AUTH_EVENT = 'cl:auth';

async function req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const csrf = method !== 'GET' ? csrfToken() : null;
  const request = new Request(new URL(`/api/v1${path}`, window.location.origin), {
    method,
    credentials: 'include',
    // Content-Type only with a body: Fastify answers 400 to an empty body declared as JSON
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await transport(request);
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = data?.code ?? 'error';
    if (!path.startsWith('/auth/') && (res.status === 401 || code === 'totp_setup_required' || code === 'password_change_required')) {
      window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: code }));
    }
    throw new ApiError(res.status, code, data?.detail ?? `Lỗi ${res.status}`);
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

/** User row in the admin screen: adds the temporary lockout end. */
export type AdminUser = User & { lockedUntil?: string | null };

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
  login: (email: string, password: string, remember = true) => req<{ requires2fa: boolean; user?: User }>('POST', '/auth/login', { email, password, remember }),
  verify2fa: (v: { code: string } | { recoveryCode: string }) => req<{ user: User }>('POST', '/auth/2fa/verify', v),
  logout: () => req<void>('POST', '/auth/logout'),
  me: () => req<User>('GET', '/auth/me'),
  changePassword: (oldPassword: string, newPassword: string) => req<void>('POST', '/me/password', { oldPassword, newPassword }),
  setup2fa: () => req<{ otpauthUrl: string; secret: string }>('POST', '/auth/2fa/setup'),
  enable2fa: (code: string) => req<{ user: User; recoveryCodes: string[] }>('POST', '/auth/2fa/enable', { code }),
  disable2fa: (password: string) => req<User>('POST', '/auth/2fa/disable', { password }),
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
  users: () => req<AdminUser[]>('GET', '/users'),
  createUser: (u: Pick<User, 'email' | 'fullName' | 'role' | 'scopeAll' | 'scopeAreaIds'>) => req<{ user: AdminUser; tempPassword: string }>('POST', '/users', u),
  updateUser: (id: string, u: Partial<Pick<User, 'fullName' | 'role' | 'active' | 'scopeAll' | 'scopeAreaIds'>>) => req<AdminUser>('PATCH', `/users/${id}`, u),
  resetUserPassword: (id: string) => req<{ user: AdminUser; tempPassword: string }>('POST', `/users/${id}/reset-password`),
  unlockUser: (id: string) => req<AdminUser>('POST', `/users/${id}/unlock`),
  resetUser2fa: (id: string) => req<AdminUser>('POST', `/users/${id}/reset-2fa`),
  unknownDevices: () => req<UnknownDevice[]>('GET', '/devices/unknown'),
  fieldMap: () => req<FieldMapEntry[]>('GET', '/field-map'),
  alarmRules: () => req<AlarmRule[]>('GET', '/alarm-rules'),
  systemStats: () => req<SystemStats>('GET', '/system/stats'),
};
