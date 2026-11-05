// Typed client for /api/v1 (spec 11). Same calls work against MSW (M1-UI) and the real API.
import type {
  ActivityLog,
  Alarm,
  AlarmSeverity,
  IncidentPhoto,
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
  GpsDriftItem,
  GpsSuggestion,
  Incident,
  LampGroup,
  ManagementUnit,
  MapStats,
  Page,
  RegionView,
  Schedule,
  TelemetryPoint,
  Thresholds,
  User,
  Zone,
} from '@citylight/shared';
import { fill, type Lang } from '@citylight/shared';
import { dictNow } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { ERRORS } from '@/i18n/dict/errors';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** The user's-language text of an API error (S49): i18n/dict/errors.ts by code, else the server's detail. */
function errorText(status: number, data: { code?: string; detail?: string; params?: Record<string, string | number> } | null): string {
  const known = data?.code ? dictNow(ERRORS)[data.code] : undefined;
  if (known) return fill(known, data?.params);
  return data?.detail ?? fill(dictNow(COMMON).httpError, { status });
}

const apiError = (status: number, data: { code?: string; detail?: string; params?: Record<string, string | number> } | null) =>
  new ApiError(status, data?.code ?? 'error', errorText(status, data));

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

/**
 * A4 (S45): asks the user for the current 2FA code (ReauthHost dialog, which calls api.reauth itself).
 * true = re-authenticated, the blocked request is sent once more; false = cancelled.
 */
let reauthPrompt: (() => Promise<boolean>) | null = null;
export function setReauthPrompt(p: (() => Promise<boolean>) | null) {
  reauthPrompt = p;
}

async function req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  try {
    return await send<T>(method, path, body, headers);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'reauth_required' && reauthPrompt && (await reauthPrompt())) return send<T>(method, path, body, headers);
    throw e;
  }
}

async function send<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
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
    throw apiError(res.status, data);
  }
  return data as T;
}

/**
 * Download a server-generated file (Excel export, M7). Returns false when the route does not exist
 * (Cloudflare demo = mock only) so the page can fall back to a client-side export.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<boolean> {
  const res = await transport(new Request(new URL(`/api/v1${path}`, window.location.origin), { credentials: 'include' }));
  if (res.status === 404) return false;
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw apiError(res.status, data);
  }
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = m ? decodeURIComponent(m[1]!) : fallbackName;
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}

/** multipart upload with the CSRF header (incident photos). */
async function upload<T>(path: string, form: FormData): Promise<T> {
  const csrf = csrfToken();
  const res = await transport(new Request(new URL(`/api/v1${path}`, window.location.origin), {
    method: 'POST', credentials: 'include', headers: csrf ? { 'X-CSRF-Token': csrf } : {}, body: form,
  }));
  const data = await res.json().catch(() => null);
  if (!res.ok) throw apiError(res.status, data);
  return data as T;
}

/** Export period (ISO instants, `to` exclusive) and data step (S55). */
export interface ExportRange {
  from: string;
  to: string;
  step: 'auto' | 'raw' | '5m' | '1h' | '1d';
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
  routeId?: string;
  seq?: number;
  updatedAt?: string;
}

export interface RouteAsset {
  id: string;
  cabinetId: string;
  code: string;
  branch: 'N1' | 'N2';
  path: [number, number][];
  updatedAt: string;
}

export interface MapAssets {
  routes: RouteAsset[];
  poles: PoleAsset[];
  truncated: boolean;
}

/** One step of the map editor's draft; saved together in one transaction (POST /map/edits). */
export type MapEditOp =
  | { op: 'moveCabinet'; cabinetId: string; lat: number; lng: number }
  | { op: 'upsertRoute'; cabinetId: string; branch: 1 | 2; path: [number, number][]; expectedUpdatedAt?: string }
  | { op: 'deleteRoute'; routeId: string; expectedUpdatedAt?: string }
  | { op: 'addPole'; cabinetId: string; branch: 1 | 2; lat: number; lng: number; lampCount?: number; ratedPowerW?: number | null; lampGroup?: number }
  | { op: 'movePole'; poleId: string; lat: number; lng: number; expectedUpdatedAt?: string }
  | { op: 'deletePole'; poleId: string; expectedUpdatedAt?: string }
  | { op: 'setPoleLamps'; poleId: string; lampCount: number; ratedPowerW: number | null; lampGroup: number };

export interface PoleDetail extends PoleAsset {
  lamps: { id: string; code: string; lampGroup: LampGroup; ratedPowerW: number | null; isSmart: boolean }[];
}

export interface ImportReport {
  rows: number;
  poles: number;
  lamps: number;
  routes: number;
  cabinets: number;
  errors: { row: number; message: string }[];
  errorCount: number;
  dryRun: boolean;
}

export interface SystemSettings {
  offlineAfterS: number;
  lampGroupLabels: Record<string, string>;
  pricePerKwh?: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface CabinetInput {
  ltid: string;
  code: string;
  /** empty = the cabinet code */
  name?: string | null;
  /** empty = the device GPS, else a default position */
  location?: GeoPoint | null;
  address?: string | null;
  districtId?: string | null;
  wardId?: string | null;
  managementUnitId?: string | null;
  zone1Id?: string | null;
  notes?: string | null;
  /** DS18B20 fitted (S54), default false */
  hasTempSensor?: boolean;
  /** the IMEI to trust when the unknown device showed two (S42) */
  imei?: string | null;
  /** the code came from the QR label */
  scanned?: boolean;
}

/** Command signing state of a cabinet (D7-lite, S59). */
export interface CabinetSigning {
  signed: boolean;
  uid: string | null;
  /** another validly signed board UID waiting for the provider (E805) */
  uidPending: string | null;
  keyFp: string | null;
  boot: number | null;
  cmdSeq: number;
  lastInvalidAt: string | null;
}

export interface ImeiCandidates {
  registered: string | null;
  seen: { imei: string | null; frames: number; lastSeenAt: string; registered: boolean }[];
}

/** User row in the admin screen: adds the temporary lockout end. */
/** manageable: false = a role at or above the viewer's own (S47), shown read-only. */
export type AdminUser = User & { lockedUntil?: string | null; manageable?: boolean };

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

/** Cabinets of a batch (S56): zones and / or codes ("TM01.0001", "TM01.*"), as typed. */
export interface BatchTarget {
  zoneIds: string[];
  codes?: string;
}

export interface BatchPreview {
  total: number;
  offline: number;
  /** old firmware 1307ebc */
  blocked?: number;
  /** firmware without the capability the command needs */
  unsupported?: number;
  /** most cabinets a control batch may hold; null for schedule / time */
  max?: number | null;
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
  code?: string;
  title?: string;
  severity: string;
  condition: string;
  enabled: boolean;
}

export interface NotificationSettings {
  minSeverity: AlarmSeverity;
  telegram: { available: boolean; botUsername: string | null; linked: boolean; enabled: boolean };
  zalo: { available: boolean };
  email: { available: boolean };
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
  /** ingest <-> MQTT broker; null = ingest has not reported for 90 s (not running) */
  brokerLink: { connected: boolean; since: string | null } | null;
  uptimeHours: number;
}

/** S57: size of each time-series relation and its retention / compression (interval text, null = kept / never). */
export interface SystemStorage {
  items: { name: string; bytes: number; compressedBytes: number; keep: string | null; compressAfter: string | null }[];
  otherBytes: number;
  totalBytes: number;
}

export interface UnknownDevice {
  ltid: string;
  imei: string;
  firstSeenAt: string;
  lastSeenAt: string;
  frames: number;
  /** last GPS fix the device sent, pre-fills the register form */
  gps: GeoPoint | null;
  /** a second, different IMEI under the same LTID: the register form must pick one */
  otherImei: string | null;
  /** cabinet code the board reports (LCOD), null on older firmware */
  code: string | null;
  /** last identity block: valid, invalid, null when the board sends none (older firmware) */
  ident: 'valid' | 'invalid' | null;
  /** the registered cabinet that already has this code: this is its new board */
  replaces: { id: string; name: string } | null;
}

/** One approved cabinet in the registration history. */
export interface RegistrationRecord {
  at: string;
  code: string;
  name: string;
  /** null when the cabinet no longer exists */
  ltid: string | null;
  by: string;
  via: 'form' | 'qr' | 'replace';
  /** false = stopped or removed since */
  active: boolean;
}

export const api = {
  // auth
  login: (email: string, password: string, remember = true) => req<{ requires2fa: boolean; user?: User }>('POST', '/auth/login', { email, password, remember }),
  verify2fa: (v: { code: string } | { recoveryCode: string }) => req<{ user: User }>('POST', '/auth/2fa/verify', v),
  logout: () => req<void>('POST', '/auth/logout'),
  me: () => req<User>('GET', '/auth/me'),
  changePassword: (oldPassword: string, newPassword: string) => req<void>('POST', '/me/password', { oldPassword, newPassword }),
  setup2fa: () => req<{ otpauthUrl: string; secret: string }>('POST', '/auth/2fa/setup'),
  reauth: (code: string) => send<{ validForS: number }>('POST', '/auth/reauth', { code }),
  savePreferences: (p: { lang: Lang }) => req<User>('PATCH', '/me/preferences', p),
  enable2fa: (code: string) => req<{ user: User; recoveryCodes: string[] }>('POST', '/auth/2fa/enable', { code }),
  disable2fa: (password: string) => req<User>('POST', '/auth/2fa/disable', { password }),
  serverTime: () => req<{ now: string }>('GET', '/server-time'),

  // map
  mapStats: () => req<MapStats>('GET', '/map/stats'),
  mapCabinets: () => req<CabinetSummary[]>('GET', '/map/cabinets'),
  mapAssets: (bbox: [number, number, number, number], zoom: number) =>
    req<MapAssets>('GET', `/map/assets${qs({ bbox: bbox.join(','), zoom: Math.floor(zoom), layers: 'routes,poles' })}`),
  pole: (id: string) => req<PoleDetail>('GET', `/poles/${id}`),
  generatePoles: (routeId: string, b: { spacingM: number; lampCount: number; ratedPowerW: number | null; lampGroup: number }) =>
    req<{ poles: number }>('POST', `/routes/${routeId}/generate-poles`, b),
  importTemplate: () => downloadFile('/gis/import/template.xlsx', 'mau-nhap-tru.xlsx'),
  importPoles: (file: File, dryRun: boolean) => {
    const f = new FormData();
    f.append('file', file);
    return upload<ImportReport>(`/gis/import${qs({ dryRun })}`, f);
  },
  search: (q: string) => req<CabinetSummary[]>('GET', `/search${qs({ q })}`),
  favorites: () => req<Favorite[]>('GET', '/favorites'),
  addFavorite: (f: Omit<Favorite, 'id'>) => req<Favorite>('POST', '/favorites', f),
  deleteFavorite: (id: string) => req<void>('DELETE', `/favorites/${id}`),
  saveMapEdits: (ops: MapEditOp[]) => req<{ saved: number }>('POST', '/map/edits', { ops }),

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
  gpsSuggestion: (id: string) => req<GpsSuggestion>('GET', `/cabinets/${id}/gps-suggestion`),
  /** `expected` = the point the dialog showed; the server refuses when GPS moved since */
  relocateFromGps: (id: string, expected: GeoPoint) =>
    req<{ id: string; location: GeoPoint; movedM: number }>('POST', `/cabinets/${id}/location-from-gps`, { expected }),
  gpsDrift: () => req<GpsDriftItem[]>('GET', '/map/gps-drift'),
  mapRegion: () => req<{ region: RegionView | null }>('GET', '/map/region'),
  imeiCandidates: (id: string) => req<ImeiCandidates>('GET', `/cabinets/${id}/imei-candidates`),
  /** null = forget it, the next frame's IMEI is learned */
  setImei: (id: string, imei: string | null) => req<{ id: string; imei: string | null }>('PUT', `/cabinets/${id}/imei`, { imei }),
  signing: (id: string) => req<CabinetSigning>('GET', `/cabinets/${id}/signing`),
  acceptUid: (id: string, uid: string) => req<{ id: string; uid: string }>('PUT', `/cabinets/${id}/uid`, { uid }),
  disableSigning: (id: string) => req<{ id: string; signed: boolean }>('POST', `/cabinets/${id}/signing/disable`),
  telemetry: (id: string, metrics: string[], from: string, to: string) => req<TelemetryPoint[]>('GET', `/cabinets/${id}/telemetry${qs({ metrics: metrics.join(','), from, to, interval: 'auto' })}`),
  energy: (id: string, range: 'day' | '30d') => req<{ estimated: boolean; points: { label: string; kwh: number }[] }>('GET', `/cabinets/${id}/energy${qs({ range })}`),
  setSchedule: (id: string, s: Schedule) => req<Command>('PUT', `/cabinets/${id}/schedule`, s),
  setThresholds: (id: string, t: Thresholds) => req<Thresholds>('PUT', `/cabinets/${id}/thresholds`, t),
  cabinetDimming: (id: string, group: LampGroup) => req<DimmingProfile>('GET', `/cabinets/${id}/dimming${qs({ group })}`),
  setCabinetDimming: (id: string, p: DimmingProfile) => req<DimmingProfile>('PUT', `/cabinets/${id}/dimming`, { lampGroup: p.lampGroup, segments: p.segments }),
  dropCabinetDimming: (id: string, group: LampGroup) => req<void>('DELETE', `/cabinets/${id}/dimming${qs({ group })}`),
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
  previewBatch: (kind: CommandBatch['kind'], target: BatchTarget, command?: CommandBatch['command']) =>
    req<BatchPreview>('POST', '/command-batches/preview', { kind, ...target, command: command ?? undefined }),
  // mass actions need the current 2FA code (decision M6-E)
  createBatch: (kind: CommandBatch['kind'], target: BatchTarget, otp: string, command?: CommandBatch['command']) =>
    req<CommandBatch>('POST', '/command-batches', { kind, ...target, command: command ?? undefined, otp }),
  retryBatch: (id: string, otp: string) => req<CommandBatch>('POST', `/command-batches/${id}/retry-failed`, { otp }),
  zoneSchedulePreview: (id: string, offsetOnMin: number, offsetOffMin: number) =>
    req<{ date: string; on: string; off: string; sunset: string; sunrise: string }[]>('GET', `/zones/${id}/schedule/preview${qs({ days: 30, offsetOnMin, offsetOffMin })}`),
  dropCabinetSchedule: (id: string) => req<void>('DELETE', `/cabinets/${id}/schedule`),

  // alarms
  alarms: (p: { active?: boolean; type?: string; severity?: string; district?: string; from?: string; to?: string; page?: number; size?: number }) =>
    req<Page<Alarm>>('GET', `/alarms${qs(p)}`),
  ackAlarm: (id: string) => req<Alarm>('POST', `/alarms/${id}/ack`),
  myNotifications: () => req<NotificationSettings>('GET', '/me/notifications'),
  saveNotifications: (b: { minSeverity: AlarmSeverity; telegram: boolean }) => req<NotificationSettings>('PUT', '/me/notifications', b),
  linkTelegram: () => req<{ code: string; botUsername: string; url: string; expiresAt: string }>('POST', '/me/notifications/telegram/link'),
  unlinkTelegram: () => req<void>('DELETE', '/me/notifications/telegram'),

  // incidents
  incidents: (p: { q?: string; district?: string; from?: string; to?: string; page?: number; size?: number }) => req<Page<Incident>>('GET', `/incidents${qs(p)}`),
  incident: (id: string) => req<Incident>('GET', `/incidents/${id}`),
  createIncident: (b: { cabinetId?: string; alarmId?: string; category?: string; content?: string }) => req<Incident>('POST', '/incidents', b),
  transitionIncident: (id: string, b: { to: Incident['status']; note?: string; assigneeId?: string; deadline?: string; resolution?: string }) =>
    req<Incident>('POST', `/incidents/${id}/transition`, b),
  incidentAssignees: (cabinetId: string) => req<{ id: string; fullName: string; email: string; role: string }[]>('GET', `/incidents/assignees${qs({ cabinetId })}`),
  uploadIncidentPhoto: (id: string, kind: 'report' | 'resolution', file: File) => {
    const f = new FormData();
    f.append('file', file);
    return upload<IncidentPhoto>(`/incidents/${id}/photos${qs({ kind })}`, f);
  },
  exportIncidents: (p: { q?: string; district?: string; from?: string; to?: string }) => downloadFile(`/incidents/export.xlsx${qs(p)}`, 'su-co.xlsx'),
  exportAlarms: (p: { active?: boolean; type?: string; severity?: string; district?: string; from?: string; to?: string }) =>
    downloadFile(`/alarms/export.xlsx${qs(p)}`, 'canh-bao.xlsx'),
  /** S55: one cabinet, a sheet per drawer tab */
  exportCabinet: (id: string, p: ExportRange) => downloadFile(`/cabinets/${id}/export.xlsx${qs({ ...p })}`, 'du-lieu-tu.xlsx'),
  /** S55: several cabinets (zones and / or codes, "TM01.*" = prefix) */
  exportReport: (fmt: 'xlsx' | 'csv', p: ExportRange & { zoneIds?: string; codes?: string }) =>
    downloadFile(`/reports/telemetry.${fmt}${qs({ ...p })}`, `bao-cao-tu.${fmt}`),
  incidentReport: (month: string) => req<IncidentReport>('GET', `/incidents/report${qs({ month })}`),

  // schedules / dimming
  zoneSchedule: (id: string) => req<Schedule>('GET', `/zones/${id}/schedule`),
  setZoneSchedule: (id: string, s: Schedule) => req<Schedule>('PUT', `/zones/${id}/schedule`, s),
  // zoneId = zone level, none = whole system (M9)
  groupDimming: (g: LampGroup, zoneId?: string) => req<DimmingProfile>('GET', `/dimming-profiles/${g}${qs({ zoneId })}`),
  setGroupDimming: (g: LampGroup, p: DimmingProfile, zoneId?: string) => req<DimmingProfile>('PUT', `/dimming-profiles/${g}${qs({ zoneId })}`, { segments: p.segments }),
  dropGroupDimming: (g: LampGroup, zoneId: string) => req<void>('DELETE', `/dimming-profiles/${g}${qs({ zoneId })}`),

  // logs
  activityLogs: (p: { user?: string; q?: string; from?: string; to?: string; page?: number; size?: number }) => req<Page<ActivityLog>>('GET', `/logs/activity${qs(p)}`),

  // admin
  users: () => req<AdminUser[]>('GET', '/users'),
  createUser: (u: Pick<User, 'email' | 'fullName' | 'role' | 'scopeAll' | 'scopeAreaIds' | 'canEnroll'>) => req<{ user: AdminUser; tempPassword: string }>('POST', '/users', u),
  updateUser: (id: string, u: Partial<Pick<User, 'fullName' | 'role' | 'active' | 'scopeAll' | 'scopeAreaIds' | 'canEnroll'>>) => req<AdminUser>('PATCH', `/users/${id}`, u),
  resetUserPassword: (id: string) => req<{ user: AdminUser; tempPassword: string }>('POST', `/users/${id}/reset-password`),
  unlockUser: (id: string) => req<AdminUser>('POST', `/users/${id}/unlock`),
  resetUser2fa: (id: string) => req<AdminUser>('POST', `/users/${id}/reset-2fa`),
  unknownDevices: (code?: string) => req<UnknownDevice[]>('GET', code ? `/devices/unknown?code=${encodeURIComponent(code)}` : '/devices/unknown'),
  registrationHistory: () => req<RegistrationRecord[]>('GET', '/devices/registered'),
  replaceDevice: (code: string) => req<{ id: string }>('POST', '/devices/replace', { code }),
  fieldMap: () => req<{ entries: FieldMapEntry[]; unknownKeys: { key: string; cabinets: number; sample: string }[] }>('GET', '/field-map'),
  // admin catalog / devices / settings (M8)
  createArea: (b: { kind: 'district' | 'ward'; name: string; parentId: string }) => req<{ id: string }>('POST', '/areas', b),
  renameArea: (id: string, name: string) => req<{ id: string }>('PATCH', `/areas/${id}`, { name }),
  deleteArea: (id: string) => req<void>('DELETE', `/areas/${id}`),
  createUnit: (name: string) => req<ManagementUnit>('POST', '/management-units', { name }),
  renameUnit: (id: string, name: string) => req<ManagementUnit>('PATCH', `/management-units/${id}`, { name }),
  deleteUnit: (id: string) => req<void>('DELETE', `/management-units/${id}`),
  createZone: (b: { name: string; center: GeoPoint }) => req<Zone>('POST', '/zones', b),
  updateZone: (id: string, b: { name?: string; center?: GeoPoint }) => req<void>('PATCH', `/zones/${id}`, b),
  deleteZone: (id: string) => req<void>('DELETE', `/zones/${id}`),
  assignZone: (id: string, b: { areaIds?: string[]; cabinetIds?: string[] }) => req<{ assigned: number }>('POST', `/zones/${id}/assign`, b),
  registerCabinet: (b: CabinetInput) => req<{ id: string }>('POST', '/cabinets', b),
  decommissionCabinet: (id: string) => req<void>('POST', `/cabinets/${id}/decommission`),
  settings: () => req<SystemSettings>('GET', '/settings'),
  saveSettings: (b: { offlineAfterS: number; lampGroupLabels: Record<string, string>; pricePerKwh?: number }) => req<SystemSettings>('PUT', '/settings', b),
  alarmRules: () => req<AlarmRule[]>('GET', '/alarm-rules'),
  systemStats: () => req<SystemStats>('GET', '/system/stats'),
  systemStorage: () => req<SystemStorage>('GET', '/system/storage'),
};
