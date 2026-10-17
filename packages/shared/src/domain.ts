// Domain types shared by api, workers, web and simulator.
// Field meanings follow docs/spec.md sections 5-7.

export type CabinetStatus = 'offline' | 'fault' | 'dimming' | 'on' | 'off' | 'unknown';

export const CABINET_STATUSES: CabinetStatus[] = ['offline', 'fault', 'dimming', 'on', 'off', 'unknown'];

export type FwProfile = 'v2-1307ebc' | 'v2-current' | 'v3';

export type Capability =
  | 'telemetry.basic'
  | 'branch_state'
  | 'manual_control'
  | 'schedule_write'
  | 'schedule_readback'
  | 'ltid_filter'
  | 'door'
  | 'contactor_fault'
  | 'energy_counters'
  | 'power_full'
  | 'sim_info'
  | 'dimming'
  | 'smart_lamps'
  | 'per_cabinet_topic';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Area {
  id: string;
  name: string;
  parentId: string | null;
  kind: 'unit' | 'district' | 'ward';
  cabinetCount: number;
}

export interface Zone {
  id: string;
  name: string;
  center: GeoPoint;
  cabinetCount: number;
}

export interface ManagementUnit {
  id: string;
  name: string;
}

export interface Cabinet {
  id: string;
  ltid: string;
  code: string;
  name: string;
  address: string;
  street: string;
  wardId: string | null;
  districtId: string | null;
  managementUnitId: string | null;
  zone1Id: string | null;
  zone2Id: string | null;
  location: GeoPoint;
  fwProfile: FwProfile;
  imei: string;
  simIccid: string | null;
  photoUrl: string | null;
  installedAt: string;
  routeCount: number;
  poleCount: number;
  lampCount: number;
}

/** Latest known values; null = not reported (CoreIF `X`) or unsupported by firmware. */
export interface CabinetState {
  cabinetId: string;
  status: CabinetStatus;
  online: boolean;
  lastSeenAt: string | null;
  branch1On: boolean | null;
  branch2On: boolean | null;
  manualMode: boolean | null;
  plcOnline: boolean | null;
  pmOnline: boolean | null;
  busStatus: string | null;
  vL1: number | null;
  vL2: number | null;
  vL3: number | null;
  iL1: number | null;
  iL2: number | null;
  iL3: number | null;
  pfL1: number | null;
  pfL2: number | null;
  pfL3: number | null;
  pfTotal: number | null;
  pTotalKw: number | null;
  leakMa: number | null;
  tempC: number | null;
  batteryMv: number | null;
  gpsDevice: GeoPoint | null;
  deviceTime: string | null;
  doorOpen: boolean | null;
  contactorFault: boolean | null;
  // Not on current firmware (spec 4.2); kept so the UI shows "—" until they arrive.
  energyKwh: number | null;
  sTotalKva: number | null;
  qTotalKvar: number | null;
  freqHz: number | null;
  simSignal: number | null;
  simOperator: string | null;
  activeAlarmCount: number;
}

export interface CabinetSummary {
  id: string;
  ltid: string;
  code: string;
  name: string;
  location: GeoPoint;
  status: CabinetStatus;
  districtId: string | null;
  wardId: string | null;
  branch1On: boolean | null;
  branch2On: boolean | null;
  connectedType: 'central' | 'standalone';
}

export interface CabinetDetail {
  cabinet: Cabinet;
  state: CabinetState;
  capabilities: Capability[];
  schedule: Schedule;
  thresholds: Thresholds;
}

export interface TelemetryPoint {
  ts: string;
  [metric: string]: number | string | null;
}

export type TelemetryMetric =
  | 'vL1' | 'vL2' | 'vL3'
  | 'iL1' | 'iL2' | 'iL3'
  | 'pTotalKw' | 'pfTotal' | 'leakMa' | 'tempC';

// ---------- Schedules / thresholds / dimming ----------

export interface Schedule {
  mode: 1 | 2;
  source: 'manual' | 'astronomical';
  on1: string; // HH:MM
  off1: string;
  on2: string;
  off2: string;
  branch1Enabled: boolean;
  branch2Enabled: boolean;
  offsetOnMin: number;
  offsetOffMin: number;
  appliedAt: string | null;
  inheritedFromZone: boolean;
}

export interface ThresholdValue {
  enabled: boolean;
  value: number;
}

export interface Thresholds {
  voltageHigh: ThresholdValue;
  voltageLow: ThresholdValue;
  voltageSwing: ThresholdValue;
  currentHigh: ThresholdValue;
  currentLow: ThresholdValue;
  currentSwing: ThresholdValue;
  currentNoLoad: ThresholdValue;
  leakMa: ThresholdValue;
  tempC: ThresholdValue;
  batteryLowMv: ThresholdValue;
}

export type LampGroup = 0 | 1 | 2 | 3;

export const LAMP_GROUP_LABELS: Record<LampGroup, string> = {
  0: 'Đèn chính',
  1: 'Đèn giao lộ',
  2: 'Đèn trên cầu',
  3: 'Nhóm mở rộng',
};

export interface DimmingSegment {
  enabled: boolean;
  startMin: number; // minutes from 00:00 of the switch-on day, may exceed 1440
  endMin: number;
  levelPct: number;
}

export interface DimmingProfile {
  lampGroup: LampGroup;
  segments: DimmingSegment[];
  inheritedFromZone: boolean;
}

// ---------- Commands ----------

export type CommandType =
  | 'MANUAL_ALL'
  | 'MANUAL_BRANCH'
  | 'AUTO'
  | 'SET_SCHEDULE'
  | 'SET_TIME'
  | 'PULSE_ON'
  | 'DIAG'
  | 'SET_DIMMING'
  | 'LAMP_CONTROL';

export type CommandStatus =
  | 'queued'
  | 'sent'
  | 'acked'
  | 'confirmed'
  | 'acked_unconfirmed'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export interface Command {
  id: string;
  cabinetId: string;
  cabinetName: string;
  type: CommandType;
  params: Record<string, unknown>;
  // The raw device frame stays on the server (command log); it is never sent to browsers.
  batchId: string | null;
  status: CommandStatus;
  requestedBy: string;
  queuedAt: string;
  sentAt: string | null;
  ackedAt: string | null;
  confirmedAt: string | null;
  error: string | null;
}

export interface CommandBatch {
  id: string;
  kind: 'schedule' | 'dimming' | 'time';
  scope: string;
  total: number;
  succeeded: number;
  failed: number;
  offline: number;
  pending: number;
  requestedBy: string;
  createdAt: string;
  finishedAt: string | null;
}

// ---------- Alarms / incidents / logs ----------

export type AlarmSeverity = 'critical' | 'major' | 'minor';

export type AlarmType =
  | 'offline'
  | 'reboot'
  | 'flapping'
  | 'plc_lost'
  | 'pm_lost'
  | 'ct_lost'
  | 'bus_down'
  | 'multi_slave_lost'
  | 'rs485_selftest_fail'
  | 'logo_lost'
  | 'clock_drift'
  | 'schedule_mismatch'
  | 'contactor_fault'
  | 'door_open'
  | 'dh_meter_lost'
  | 'phase_loss'
  | 'over_voltage'
  | 'under_voltage'
  | 'phase_unbalance'
  | 'low_pf'
  | 'leak_current'
  | 'over_temp'
  | 'temp_sensor_fault'
  | 'no_load'
  | 'over_current'
  | 'cmd_rejected'
  | 'cmd_unconfirmed'
  | 'cmd_timeout'
  | 'gps_nofix'
  | 'gps_drift'
  | 'battery_low'
  | 'fw_unsafe';

export interface Alarm {
  id: string;
  /** Error catalog code (E101…), see errors.ts. */
  code: string;
  cabinetId: string;
  cabinetName: string;
  cabinetCode: string;
  districtName: string;
  type: AlarmType;
  severity: AlarmSeverity;
  message: string;
  value: number | null;
  startedAt: string;
  endedAt: string | null;
  active: boolean;
  ackedBy: string | null;
  ackedAt: string | null;
}

export type IncidentStatus = 'new' | 'assigned' | 'deferred' | 'resolved' | 'closed';

export interface IncidentEvent {
  at: string;
  by: string;
  action: string;
  note: string | null;
}

export interface Incident {
  id: string;
  code: string;
  cabinetId: string;
  cabinetName: string;
  districtName: string;
  wardName: string;
  source: 'alarm' | 'manual';
  category: string;
  content: string;
  location: GeoPoint;
  reportedBy: string;
  reportedAt: string;
  status: IncidentStatus;
  assignee: string | null;
  deadline: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  photos: string[];
  events: IncidentEvent[];
}

export interface ActivityLog {
  id: string;
  userEmail: string;
  action: string;
  targetType: string;
  targetName: string;
  oldValue: string | null;
  newValue: string | null;
  ip: string;
  ts: string;
}

// ---------- Users ----------

export type RoleKey = 'admin' | 'operator' | 'viewer' | 'maintenance';

export const ROLE_LABELS: Record<RoleKey, string> = {
  admin: 'Quản trị',
  operator: 'Điều hành',
  viewer: 'Giám sát',
  maintenance: 'Đội duy tu',
};

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: RoleKey;
  /** true = every cabinet; false = only cabinets under scopeAreaIds (empty = none). */
  scopeAll: boolean;
  scopeAreaIds: string[];
  totpEnabled: boolean;
  /** Role needs 2FA (permission cabinet.control) and the server enforces it: setup is forced until enabled. */
  totpRequired: boolean;
  /** Admin-issued temporary password: the user must change it before anything else. */
  passwordChangeRequired: boolean;
  active: boolean;
  lastLoginAt: string | null;
}

export interface MapStats {
  cabinets: Record<CabinetStatus, number> & { total: number };
  onlinePct: number;
  energyTodayKwh: number | null;
  energyYesterdayKwh: number | null;
  overdueIncidents: number;
}

// ---------- Diagnostics ----------

export type DiagStatus = 'ok' | 'warn' | 'fault' | 'unknown' | 'unsupported';

export interface DiagnosticItem {
  subsystem: string;
  /** Short role of the subsystem, e.g. "LTE ↔ broker". */
  role: string;
  status: DiagStatus;
  code: string | null;
  /** Raw evidence from telemetry, e.g. "LCLI=1, PCON=0". */
  evidence: string;
  detail: string;
}

export interface Rs485SelfTest {
  at: string;
  summary: string;
  rx: string;
  de: string;
  tx: string;
  fail: boolean;
}

export interface CabinetDiagnostics {
  items: DiagnosticItem[];
  lastBootAt: string | null;
  bootsLast24h: number;
  selfTest: Rs485SelfTest | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}
