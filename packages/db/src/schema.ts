// PostgreSQL 16 + TimescaleDB + PostGIS schema (docs/spec.md section 7).
// Hypertables, compression, retention and continuous aggregates live in the custom SQL migration
// (migrations/*_timescale.sql) because drizzle-kit does not model them.
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  doublePrecision,
  geometry,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const tsz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => tsz('created_at').notNull().defaultNow();
const point = (name: string) => geometry(name, { type: 'point', mode: 'xy', srid: 4326 });
/** drizzle's geometry() only models points; routes need a LineString (WKT/GeoJSON handled in queries). */
const lineString = customType<{ data: string; driverData: string }>({ dataType: () => 'geometry(LineString, 4326)' });

// ---------- enums ----------
export const roleEnum = pgEnum('role', ['admin', 'operator', 'viewer', 'maintenance']);
export const fwProfileEnum = pgEnum('fw_profile', ['v2-1307ebc', 'v2-current', 'v3']);
export const cabinetStatusEnum = pgEnum('cabinet_status', ['offline', 'fault', 'dimming', 'on', 'off', 'unknown']);
export const commandStatusEnum = pgEnum('command_status', ['queued', 'sent', 'acked', 'confirmed', 'acked_unconfirmed', 'failed', 'timeout', 'cancelled']);
export const severityEnum = pgEnum('severity', ['critical', 'major', 'minor']);
export const incidentStatusEnum = pgEnum('incident_status', ['new', 'assigned', 'deferred', 'resolved', 'closed']);
export const batchKindEnum = pgEnum('batch_kind', ['schedule', 'dimming', 'time']);
export const batchResultEnum = pgEnum('batch_result', ['pending', 'ok', 'failed', 'offline']);

// ---------- organisation ----------
export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const managementUnits = pgTable('management_units', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
});

export const areas = pgTable(
  'areas',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    parentId: uuid('parent_id'),
    kind: text('kind', { enum: ['unit', 'district', 'ward'] }).notNull(),
    name: text('name').notNull(),
  },
  (t) => [index('areas_parent_idx').on(t.parentId)],
);

export const zones = pgTable('zones', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  center: point('center').notNull(),
});

// ---------- assets ----------
export const cabinets = pgTable(
  'cabinets',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    ltid: text('ltid').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    address: text('address'),
    street: text('street'),
    wardId: uuid('ward_id').references(() => areas.id),
    districtId: uuid('district_id').references(() => areas.id),
    managementUnitId: uuid('management_unit_id').references(() => managementUnits.id),
    zone1Id: uuid('zone1_id').references(() => zones.id),
    zone2Id: uuid('zone2_id').references(() => zones.id),
    location: point('location').notNull(),
    fwProfile: fwProfileEnum('fw_profile').notNull().default('v2-current'),
    imei: text('imei'),
    simIccid: text('sim_iccid'),
    photoUrl: text('photo_url'),
    installedAt: tsz('installed_at'),
    statusOverride: text('status_override'),
    notes: text('notes'),
    createdAt: createdAt(),
    /** false = decommissioned (M8): hidden from map, lists and workers, history kept */
    active: boolean('active').notNull().default(true),
    decommissionedAt: tsz('decommissioned_at'),
    /** optimistic lock for map edits / admin changes */
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cabinets_ltid_uq').on(t.ltid),
    uniqueIndex('cabinets_code_uq').on(t.code),
    index('cabinets_location_gix').using('gist', t.location),
    index('cabinets_district_idx').on(t.districtId),
  ],
);

/** One row per cabinet, updated by ingest; the single source for map, counters and alarm consistency. */
export const cabinetState = pgTable('cabinet_state', {
  cabinetId: uuid('cabinet_id').primaryKey().references(() => cabinets.id, { onDelete: 'cascade' }),
  // a row nobody has heard from yet is offline; 'unknown' = online but PLC lost (spec 6)
  status: cabinetStatusEnum('status').notNull().default('offline'),
  online: boolean('online').notNull().default(false),
  lastSeenAt: tsz('last_seen_at'),
  lastBootAt: tsz('last_boot_at'),
  busStatus: text('bus_status'),
  branch1On: boolean('branch1_on'),
  branch2On: boolean('branch2_on'),
  manualMode: boolean('manual_mode'),
  plcOnline: boolean('plc_online'),
  pmOnline: boolean('pm_online'),
  vL1: real('v_l1'),
  vL2: real('v_l2'),
  vL3: real('v_l3'),
  iL1: real('i_l1'),
  iL2: real('i_l2'),
  iL3: real('i_l3'),
  pfTotal: real('pf_total'),
  pTotalKw: real('p_total_kw'),
  leakMa: real('leak_ma'),
  tempC: real('temp_c'),
  tempSensorFault: boolean('temp_sensor_fault').notNull().default(false),
  batteryMv: integer('battery_mv'),
  gpsDevice: point('gps_device'),
  gpsSats: smallint('gps_sats'),
  deviceTime: tsz('device_time'),
  /** Server time when PTIM last changed: PTIM frozen > 5 min while PCON=1 -> E301 (LOGO lost). */
  deviceTimeChangedAt: tsz('device_time_changed_at'),
  doorOpen: boolean('door_open'),
  contactorFault: boolean('contactor_fault'),
  extra: jsonb('extra').$type<Record<string, string>>().notNull().default({}),
  activeAlarmCount: integer('active_alarm_count').notNull().default(0),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
});

export const routes = pgTable(
  'routes',
  {
    id: id(),
    cabinetId: uuid('cabinet_id').notNull().references(() => cabinets.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    branch: smallint('branch').notNull(),
    path: lineString('path'),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('routes_cabinet_branch_uq').on(t.cabinetId, t.branch), index('routes_path_gix').using('gist', t.path)],
);

export const poles = pgTable(
  'poles',
  {
    id: id(),
    routeId: uuid('route_id').notNull().references(() => routes.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    legacyCode: text('legacy_code'),
    location: point('location').notNull(),
    lampCount: smallint('lamp_count').notNull().default(1),
    /** position along the route (1 = nearest the cabinet) */
    seq: integer('seq').notNull().default(0),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [index('poles_location_gix').using('gist', t.location), uniqueIndex('poles_code_uq').on(t.code), index('poles_route_idx').on(t.routeId, t.seq)],
);

export const lamps = pgTable(
  'lamps',
  {
    id: id(),
    poleId: uuid('pole_id').notNull().references(() => poles.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    lampGroup: smallint('lamp_group').notNull().default(0),
    ratedPowerW: integer('rated_power_w'),
    isSmart: boolean('is_smart').notNull().default(false),
  },
  (t) => [index('lamps_pole_idx').on(t.poleId)],
);

/** Editable system settings (M8): offline_after_s, lamp_group_labels… */
export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

// ---------- configuration ----------
export const schedules = pgTable(
  'schedules',
  {
    id: id(),
    zoneId: uuid('zone_id').references(() => zones.id),
    cabinetId: uuid('cabinet_id').references(() => cabinets.id, { onDelete: 'cascade' }),
    mode: smallint('mode').notNull().default(1),
    source: text('source', { enum: ['manual', 'astronomical'] }).notNull().default('manual'),
    on1: text('on1').notNull(),
    off1: text('off1').notNull(),
    on2: text('on2'),
    off2: text('off2'),
    branch1Enabled: boolean('branch1_enabled').notNull().default(true),
    branch2Enabled: boolean('branch2_enabled').notNull().default(true),
    offsetOnMin: integer('offset_on_min').notNull().default(10),
    offsetOffMin: integer('offset_off_min').notNull().default(-10),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('schedules_zone_uq').on(t.zoneId), uniqueIndex('schedules_cabinet_uq').on(t.cabinetId)],
);

/** What the server last sent successfully (cabinets cannot report their running schedule yet). */
export const scheduleApplied = pgTable('schedule_applied', {
  cabinetId: uuid('cabinet_id').primaryKey().references(() => cabinets.id, { onDelete: 'cascade' }),
  values: jsonb('values').notNull(),
  appliedAt: tsz('applied_at').notNull(),
  commandId: uuid('command_id'),
});

export const thresholds = pgTable(
  'thresholds',
  {
    id: id(),
    zoneId: uuid('zone_id').references(() => zones.id),
    cabinetId: uuid('cabinet_id').references(() => cabinets.id, { onDelete: 'cascade' }),
    values: jsonb('values').notNull(),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('thresholds_cabinet_uq').on(t.cabinetId), uniqueIndex('thresholds_zone_uq').on(t.zoneId)],
);

/** One profile per lamp group at three levels (M9): cabinet > zone > system (zone + cabinet null). */
export const dimmingProfiles = pgTable(
  'dimming_profiles',
  {
    id: id(),
    lampGroup: smallint('lamp_group').notNull(),
    zoneId: uuid('zone_id').references(() => zones.id, { onDelete: 'cascade' }),
    cabinetId: uuid('cabinet_id').references(() => cabinets.id, { onDelete: 'cascade' }),
    segments: jsonb('segments').notNull(),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dimming_cabinet_uq').on(t.cabinetId, t.lampGroup).where(sql`cabinet_id is not null`),
    uniqueIndex('dimming_zone_uq').on(t.zoneId, t.lampGroup).where(sql`cabinet_id is null and zone_id is not null`),
    uniqueIndex('dimming_system_uq').on(t.lampGroup).where(sql`cabinet_id is null and zone_id is null`),
  ],
);

export const deviceFieldMap = pgTable('device_field_map', {
  key: text('key').primaryKey(),
  field: text('field').notNull(),
  type: text('type').notNull(),
  scale: doublePrecision('scale'),
  unit: text('unit'),
  note: text('note'),
  supported: boolean('supported').notNull().default(true),
});

// ---------- commands ----------
export const commandBatches = pgTable('command_batches', {
  id: id(),
  kind: batchKindEnum('kind').notNull(),
  scope: text('scope').notNull(),
  total: integer('total').notNull(),
  requestedBy: uuid('requested_by').notNull(),
  createdAt: createdAt(),
  finishedAt: tsz('finished_at'),
});

export const commands = pgTable(
  'commands',
  {
    id: id(),
    cabinetId: uuid('cabinet_id').notNull().references(() => cabinets.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    params: jsonb('params').notNull().default({}),
    /** Raw CoreIF frame(s), newline-separated (PULSE_ON = 2): server-side only, never returned to browsers. */
    frame: text('frame').notNull(),
    /** Index of the frame being sent / acked. */
    step: smallint('step').notNull().default(0),
    /** Sends of the current frame (1 retry for idempotent commands). */
    attempts: smallint('attempts').notNull().default(0),
    /** Set while the command-worker waits (ack or telemetry confirmation); null = queued or finished. */
    deadlineAt: tsz('deadline_at'),
    batchId: uuid('batch_id').references(() => commandBatches.id),
    idempotencyKey: text('idempotency_key'),
    status: commandStatusEnum('status').notNull().default('queued'),
    ackRc: jsonb('ack_rc').$type<Record<string, number>>(),
    requestedBy: uuid('requested_by').notNull(),
    queuedAt: tsz('queued_at').notNull().defaultNow(),
    sentAt: tsz('sent_at'),
    ackedAt: tsz('acked_at'),
    confirmedAt: tsz('confirmed_at'),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('commands_idem_uq').on(t.idempotencyKey),
    index('commands_cabinet_idx').on(t.cabinetId, t.queuedAt),
    index('commands_open_idx').on(t.status).where(sql`status in ('queued','sent','acked')`),
    index('commands_waiting_idx').on(t.cabinetId).where(sql`deadline_at is not null`),
  ],
);

export const commandBatchItems = pgTable(
  'command_batch_items',
  {
    batchId: uuid('batch_id').notNull().references(() => commandBatches.id, { onDelete: 'cascade' }),
    cabinetId: uuid('cabinet_id').notNull().references(() => cabinets.id, { onDelete: 'cascade' }),
    commandId: uuid('command_id').references(() => commands.id),
    result: batchResultEnum('result').notNull().default('pending'),
    error: text('error'),
  },
  (t) => [primaryKey({ columns: [t.batchId, t.cabinetId] })],
);

// ---------- time series (hypertables, see timescale migration) ----------
/** Keyed on SERVER receive time, not PTIM (PTIM has minute resolution + ms jitter; using it as a key caused duplicate-key rejects on the old server). */
export const telemetry = pgTable(
  'telemetry',
  {
    ts: tsz('ts').notNull(),
    cabinetId: uuid('cabinet_id').notNull(),
    online: boolean('online'),
    busStatus: text('bus_status'),
    branch1On: boolean('branch1_on'),
    branch2On: boolean('branch2_on'),
    manualMode: boolean('manual_mode'),
    vL1: real('v_l1'),
    vL2: real('v_l2'),
    vL3: real('v_l3'),
    iL1: real('i_l1'),
    iL2: real('i_l2'),
    iL3: real('i_l3'),
    pfL1: real('pf_l1'),
    pfL2: real('pf_l2'),
    pfL3: real('pf_l3'),
    pfTotal: real('pf_total'),
    pTotalKw: real('p_total_kw'),
    leakMa: real('leak_ma'),
    tempC: real('temp_c'),
    batteryMv: integer('battery_mv'),
    // LGPS of this frame (null = no fix): history for "update location from GPS" (median of recent fixes)
    gpsLat: doublePrecision('gps_lat'),
    gpsLng: doublePrecision('gps_lng'),
    extra: jsonb('extra').$type<Record<string, string>>(),
  },
  (t) => [primaryKey({ columns: [t.cabinetId, t.ts] })],
);

/** Raw uplinks for debugging, 7-day retention. */
export const framesRaw = pgTable(
  'frames_raw',
  {
    ts: tsz('ts').notNull(),
    topic: text('topic').notNull(),
    ltid: text('ltid'),
    payload: text('payload').notNull(),
    parseError: text('parse_error'),
  },
  (t) => [index('frames_raw_ltid_ts_idx').on(t.ltid, t.ts)],
);

/** Boot, LDIA self-test, time-sync log, connect/disconnect. */
export const deviceEvents = pgTable(
  'device_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: tsz('ts').notNull().defaultNow(),
    cabinetId: uuid('cabinet_id').notNull().references(() => cabinets.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['boot', 'selftest', 'timesync', 'connect', 'disconnect'] }).notNull(),
    data: jsonb('data').notNull().default({}),
  },
  (t) => [index('device_events_cabinet_idx').on(t.cabinetId, t.ts)],
);

export const unknownDevices = pgTable('unknown_devices', {
  ltid: text('ltid').primaryKey(),
  imei: text('imei'),
  firstSeenAt: tsz('first_seen_at').notNull().defaultNow(),
  lastSeenAt: tsz('last_seen_at').notNull().defaultNow(),
  frames: integer('frames').notNull().default(1),
  // last GPS fix the device sent: pre-fills the register form
  gps: point('gps'),
});

// ---------- alarms / incidents / logs ----------
export const alarms = pgTable(
  'alarms',
  {
    id: id(),
    cabinetId: uuid('cabinet_id').notNull().references(() => cabinets.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    type: text('type').notNull(),
    severity: severityEnum('severity').notNull(),
    message: text('message').notNull(),
    value: doublePrecision('value'),
    startedAt: tsz('started_at').notNull(),
    endedAt: tsz('ended_at'),
    active: boolean('active').notNull().default(true),
    ackedBy: uuid('acked_by'),
    ackedAt: tsz('acked_at'),
  },
  (t) => [
    index('alarms_active_idx').on(t.active, t.severity),
    index('alarms_cabinet_idx').on(t.cabinetId, t.startedAt),
    uniqueIndex('alarms_one_active_uq').on(t.cabinetId, t.type).where(sql`active`),
  ],
);

export const incidents = pgTable(
  'incidents',
  {
    id: id(),
    code: text('code').notNull(),
    cabinetId: uuid('cabinet_id').references(() => cabinets.id),
    alarmId: uuid('alarm_id').references(() => alarms.id),
    source: text('source', { enum: ['alarm', 'manual'] }).notNull(),
    category: text('category').notNull(),
    content: text('content').notNull(),
    location: point('location'),
    reportedBy: text('reported_by').notNull(),
    reportedAt: tsz('reported_at').notNull().defaultNow(),
    status: incidentStatusEnum('status').notNull().default('new'),
    /** Display name at assignment time; the user is assignee_id (M7). */
    assignee: text('assignee'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    deadline: tsz('deadline'),
    resolution: text('resolution'),
    resolvedAt: tsz('resolved_at'),
    /** unused since M7 (incident_photos) */
    photos: jsonb('photos').$type<string[]>().notNull().default([]),
    /** set when the assignee was reminded that the deadline passed (once per deadline) */
    overdueNotifiedAt: tsz('overdue_notified_at'),
  },
  (t) => [
    uniqueIndex('incidents_code_uq').on(t.code),
    index('incidents_status_idx').on(t.status, t.reportedAt),
    index('incidents_assignee_idx').on(t.assigneeId),
    index('incidents_cabinet_idx').on(t.cabinetId),
    // one open incident per alarm
    uniqueIndex('incidents_alarm_open_uq').on(t.alarmId).where(sql`status in ('new','assigned','deferred')`),
  ],
);

/** Photos of an incident (M7): files on disk (UPLOAD_DIR), served by the API after a scope check. */
export const incidentPhotos = pgTable(
  'incident_photos',
  {
    id: id(),
    incidentId: uuid('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['report', 'resolution'] }).notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    path: text('path').notNull(),
    uploadedBy: text('uploaded_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('incident_photos_incident_idx').on(t.incidentId)],
);

export const incidentEvents = pgTable('incident_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  incidentId: uuid('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  at: tsz('at').notNull().defaultNow(),
  by: text('by').notNull(),
  action: text('action').notNull(),
  note: text('note'),
});

export const activityLogs = pgTable(
  'activity_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: tsz('ts').notNull().defaultNow(),
    userId: uuid('user_id'),
    userEmail: text('user_email').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    targetName: text('target_name'),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    ip: text('ip'),
  },
  (t) => [index('activity_logs_ts_idx').on(t.ts), index('activity_logs_user_idx').on(t.userId, t.ts)],
);

// ---------- users ----------
export const users = pgTable(
  'users',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: roleEnum('role').notNull().default('viewer'),
    // AES-256-GCM ciphertext (apps/api totp.ts), never the raw base32 secret
    totpSecret: text('totp_secret'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    // last accepted 30 s step: a code is accepted once (replay protection)
    totpLastStep: integer('totp_last_step'),
    // true = every cabinet; false = only cabinets under user_scopes areas (none by default)
    scopeAll: boolean('scope_all').notNull().default(false),
    // set for admin-issued temporary passwords; API allows only /me/password until changed
    passwordChangeRequired: boolean('password_change_required').notNull().default(false),
    active: boolean('active').notNull().default(true),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: tsz('locked_until'),
    lastLoginAt: tsz('last_login_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)],
);

export const userScopes = pgTable(
  'user_scopes',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    areaId: uuid('area_id').notNull().references(() => areas.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.areaId] })],
);

/** Saved map views per user (map page "Vị trí đã lưu"). */
export const mapFavorites = pgTable(
  'map_favorites',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    zoom: real('zoom').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('map_favorites_user_idx').on(t.userId)],
);

/** 2FA recovery codes, argon2id hashed, single use. */
export const userRecoveryCodes = pgTable(
  'user_recovery_codes',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: tsz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('user_recovery_codes_user_idx').on(t.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: tsz('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const notificationSubscriptions = pgTable('notification_subscriptions', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  channel: text('channel', { enum: ['telegram', 'zalo', 'email'] }).notNull(),
  address: text('address').notNull(),
  minSeverity: severityEnum('min_severity').notNull().default('major'),
  enabled: boolean('enabled').notNull().default(true),
}, (t) => [uniqueIndex('notification_subscriptions_user_channel_uq').on(t.userId, t.channel)]);
