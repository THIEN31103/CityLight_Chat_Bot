// Deterministic fake data for M1-UI. Replaced by the real API from M1 on.
import type {
  ActivityLog,
  Alarm,
  AlarmType,
  Area,
  Cabinet,
  CabinetState,
  FwProfile,
  Incident,
  IncidentStatus,
  ManagementUnit,
  Schedule,
  Thresholds,
  User,
  Zone,
} from '@citylight/shared';
import { errorOf } from '@citylight/shared';

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r = rng(20261017);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(r() * arr.length)]!;
const between = (a: number, b: number) => a + r() * (b - a);

export const CABINET_COUNT = 600;

const DISTRICTS: { name: string; lat: number; lng: number; spread: number }[] = [
  { name: 'Quận 1', lat: 10.7769, lng: 106.7009, spread: 0.012 },
  { name: 'Quận 3', lat: 10.7843, lng: 106.6844, spread: 0.01 },
  { name: 'Quận 4', lat: 10.7578, lng: 106.7043, spread: 0.008 },
  { name: 'Quận 5', lat: 10.754, lng: 106.6634, spread: 0.01 },
  { name: 'Quận 7', lat: 10.734, lng: 106.7218, spread: 0.02 },
  { name: 'Quận 8', lat: 10.724, lng: 106.6286, spread: 0.018 },
  { name: 'Quận 10', lat: 10.7746, lng: 106.667, spread: 0.009 },
  { name: 'Bình Thạnh', lat: 10.8106, lng: 106.7091, spread: 0.015 },
  { name: 'Phú Nhuận', lat: 10.7992, lng: 106.6803, spread: 0.008 },
  { name: 'Gò Vấp', lat: 10.8387, lng: 106.6653, spread: 0.016 },
  { name: 'Tân Bình', lat: 10.8015, lng: 106.6527, spread: 0.015 },
  { name: 'TP Thủ Đức', lat: 10.8494, lng: 106.7537, spread: 0.035 },
];

const STREETS = [
  'Nguyễn Huệ', 'Lê Lợi', 'Hai Bà Trưng', 'Điện Biên Phủ', 'Cách Mạng Tháng 8', 'Võ Văn Kiệt',
  'Nguyễn Văn Linh', 'Phạm Văn Đồng', 'Xô Viết Nghệ Tĩnh', 'Nguyễn Thị Minh Khai', 'Lý Thường Kiệt',
  '3 Tháng 2', 'Trường Chinh', 'Cộng Hòa', 'Quang Trung', 'Nguyễn Oanh', 'Huỳnh Tấn Phát', 'Kha Vạn Cân',
  'Võ Văn Ngân', 'Lê Văn Việt', 'Đinh Tiên Hoàng', 'Nguyễn Trãi', 'Trần Hưng Đạo', 'Hoàng Văn Thụ',
];

export const managementUnits: ManagementUnit[] = [1, 2, 3, 4].map((n) => ({
  id: `mu${n}`,
  name: `Khu quản lý ${n}`,
}));

export const zones: Zone[] = [
  { id: 'z1', name: 'Vùng trung tâm', center: { lat: 10.777, lng: 106.695 }, cabinetCount: 0 },
  { id: 'z2', name: 'Vùng Thủ Đức', center: { lat: 10.849, lng: 106.754 }, cabinetCount: 0 },
  { id: 'z3', name: 'Vùng Nam', center: { lat: 10.73, lng: 106.68 }, cabinetCount: 0 },
  { id: 'z4', name: 'Vùng Bắc', center: { lat: 10.82, lng: 106.665 }, cabinetCount: 0 },
  { id: 'z5', name: 'Tuyến trục chính', center: { lat: 10.79, lng: 106.7 }, cabinetCount: 0 },
];

export const areas: Area[] = [{ id: 'org', name: 'Đơn vị vận hành CityLight', parentId: null, kind: 'unit', cabinetCount: 0 }];

DISTRICTS.forEach((d, i) => {
  const did = `d${i + 1}`;
  areas.push({ id: did, name: d.name, parentId: 'org', kind: 'district', cabinetCount: 0 });
  const wardCount = 4 + Math.floor(r() * 5);
  for (let w = 1; w <= wardCount; w++) {
    areas.push({ id: `${did}w${w}`, name: `Phường ${w}`, parentId: did, kind: 'ward', cabinetCount: 0 });
  }
});

const areaById = new Map(areas.map((a) => [a.id, a]));

function zoneFor(districtIdx: number): string {
  if (districtIdx === 11) return 'z2';
  if ([0, 1, 2, 6, 8].includes(districtIdx)) return 'z1';
  if ([3, 4, 5].includes(districtIdx)) return 'z3';
  return 'z4';
}

export const cabinets: Cabinet[] = [];
export const states = new Map<string, CabinetState>();

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

export function isNightNow(d = new Date()): boolean {
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= 18 * 60 || m < 5 * 60 + 45;
}

for (let i = 0; i < CABINET_COUNT; i++) {
  const dIdx = Math.floor(r() * DISTRICTS.length);
  const d = DISTRICTS[dIdx]!;
  const did = `d${dIdx + 1}`;
  const wards = areas.filter((a) => a.parentId === did);
  // ~2% of cabinets are not assigned to an area yet (must show as "Chưa phân khu vực").
  const unassigned = r() < 0.02;
  const ward = unassigned ? null : pick(wards);
  const street = pick(STREETS);
  const id = `cab${String(i + 1).padStart(5, '0')}`;
  const ltid = `CTY${String(i + 1).padStart(4, '0')}`;
  const fwRoll = r();
  const fwProfile: FwProfile = fwRoll < 0.05 ? 'v2-1307ebc' : 'v2-current';
  const location = {
    lat: d.lat + between(-d.spread, d.spread),
    lng: d.lng + between(-d.spread, d.spread),
  };
  const lampCount = 20 + Math.floor(r() * 60);
  cabinets.push({
    id,
    ltid,
    code: `TL${String(dIdx + 1).padStart(2, '0')}.${String(i + 1).padStart(3, '0')}`,
    name: `${street} ${1 + Math.floor(r() * 9)}`,
    address: `${Math.floor(between(1, 500))} ${street}`,
    street,
    wardId: ward?.id ?? null,
    districtId: unassigned ? null : did,
    managementUnitId: unassigned ? null : managementUnits[dIdx % 4]!.id,
    zone1Id: unassigned ? null : zoneFor(dIdx),
    zone2Id: r() < 0.15 ? 'z5' : null,
    location,
    fwProfile,
    imei: `86${Math.floor(between(1e12, 9e12))}`,
    simIccid: null,
    photoUrl: null,
    installedAt: iso(now - between(30, 900) * 86400000),
    routeCount: 2,
    poleCount: Math.ceil(lampCount / 1.5),
    lampCount,
  });

  const night = isNightNow();
  const offline = r() < 0.04;
  const plcLost = !offline && r() < 0.015;
  const v = () => +between(216, 231).toFixed(1);
  const iOn = () => +between(8, 32).toFixed(1);
  const iOff = () => +between(0, 0.4).toFixed(1);
  const lit = night;
  states.set(id, {
    cabinetId: id,
    status: 'off',
    online: !offline,
    lastSeenAt: iso(offline ? now - between(5, 600) * 60000 : now - between(0, 9) * 1000),
    branch1On: plcLost ? null : lit,
    branch2On: plcLost ? null : lit && r() > 0.05,
    manualMode: plcLost ? null : r() < 0.03,
    plcOnline: !plcLost,
    pmOnline: true,
    busStatus: plcLost ? '1' : '0',
    vL1: v(),
    vL2: v(),
    vL3: v(),
    iL1: lit ? iOn() : iOff(),
    iL2: lit ? iOn() : iOff(),
    iL3: lit ? iOn() : iOff(),
    pfL1: lit ? +between(0.88, 0.98).toFixed(2) : 0,
    pfL2: lit ? +between(0.88, 0.98).toFixed(2) : 0,
    pfL3: lit ? +between(0.88, 0.98).toFixed(2) : 0,
    pfTotal: lit ? +between(0.9, 0.97).toFixed(2) : 0,
    pTotalKw: lit ? +between(4, 18).toFixed(1) : 0.1,
    leakMa: Math.floor(between(3, 28)),
    tempC: Math.floor(between(29, 44)),
    batteryMv: Math.floor(between(3700, 4150)),
    gpsDevice: r() < 0.9 ? { lat: location.lat + between(-0.0003, 0.0003), lng: location.lng + between(-0.0003, 0.0003) } : null,
    deviceTime: plcLost ? null : iso(Math.floor(now / 60000) * 60000),
    doorOpen: null,
    contactorFault: null,
    energyKwh: null,
    sTotalKva: null,
    qTotalKvar: null,
    freqHz: null,
    simSignal: null,
    simOperator: null,
    activeAlarmCount: 0,
  });
}

for (const c of cabinets) {
  if (c.districtId) areaById.get(c.districtId)!.cabinetCount++;
  if (c.wardId) areaById.get(c.wardId)!.cabinetCount++;
  areaById.get('org')!.cabinetCount++;
  for (const z of zones) if (c.zone1Id === z.id || c.zone2Id === z.id) z.cabinetCount++;
}

// ---------- Alarms (codes from packages/shared/src/errors.ts) ----------

type Seed = { type: AlarmType; msg: (v: number) => string; v: () => number };
const ALARM_SEED: Seed[] = [
  { type: 'over_voltage', msg: (v) => `Điện áp pha L2 = ${v} V vượt ngưỡng 240 V`, v: () => +between(241, 252).toFixed(1) },
  { type: 'under_voltage', msg: (v) => `Điện áp pha L1 = ${v} V dưới ngưỡng 200 V`, v: () => +between(185, 199).toFixed(1) },
  { type: 'leak_current', msg: (v) => `Dòng rò ${v} mA vượt ngưỡng 30 mA`, v: () => Math.floor(between(31, 90)) },
  { type: 'over_temp', msg: (v) => `Nhiệt độ tủ ${v} °C vượt ngưỡng 55 °C`, v: () => Math.floor(between(56, 66)) },
  { type: 'no_load', msg: () => 'Nhánh 2 đang sáng nhưng dòng pha L2 < 0,5 A', v: () => 0.2 },
  { type: 'clock_drift', msg: (v) => `Giờ LOGO lệch ${v} phút so với máy chủ`, v: () => Math.floor(between(6, 40)) },
  { type: 'battery_low', msg: (v) => `Pin dự phòng ${v} mV dưới ngưỡng 3600 mV`, v: () => Math.floor(between(3300, 3550)) },
  { type: 'phase_unbalance', msg: (v) => `Chênh lệch dòng giữa các pha ${v} %`, v: () => Math.floor(between(31, 60)) },
  { type: 'low_pf', msg: (v) => `cosφ tổng ${v} khi đèn sáng`, v: () => +between(0.7, 0.84).toFixed(2) },
  { type: 'gps_nofix', msg: () => 'LGPS=X sau 10 phút từ khi khởi động', v: () => 0 },
  { type: 'gps_drift', msg: (v) => `GPS thiết bị cách vị trí khai báo ${v} m`, v: () => Math.floor(between(220, 900)) },
  { type: 'spoof_suspect', msg: () => 'Frame mang LTID của tủ với IMEI 869999000123456 khác IMEI đã ghi nhận: frame bị bỏ qua', v: () => 0 },
  { type: 'schedule_mismatch', msg: () => 'Nhánh 1 tắt trong giờ lịch (18:00–05:45) quá 10 phút', v: () => 0 },
];
const HISTORY_ONLY: Seed[] = [
  { type: 'reboot', msg: () => 'Nhận frame stm32/ec25/boot', v: () => 0 },
  { type: 'flapping', msg: (v) => `${v} lần mất / có lại kết nối trong 1 giờ`, v: () => Math.floor(between(3, 8)) },
  { type: 'cmd_unconfirmed', msg: () => 'Bật nhánh 1: ack rc=0 nhưng LQ2 không đổi sau 60 s', v: () => 0 },
  { type: 'cmd_timeout', msg: () => 'Đặt lịch: không nhận ack sau 30 s', v: () => 0 },
  { type: 'cmd_rejected', msg: () => 'Bật toàn tủ: ack rc=-1 (ghi Modbus xuống PLC_KEY lỗi)', v: () => -1 },
  { type: 'rs485_selftest_fail', msg: () => 'LDIA: A0D0B1C1 — RO mức thấp lúc rảnh', v: () => 0 },
];

export const alarms: Alarm[] = [];
let alarmSeq = 1;

export function districtName(c: Cabinet): string {
  return c.districtId ? areaById.get(c.districtId)!.name : 'Chưa phân khu vực';
}
export function wardName(c: Cabinet): string {
  return c.wardId ? areaById.get(c.wardId)!.name : '—';
}

export function newAlarm(c: Cabinet, type: AlarmType, message: string, value: number | null, startedMs: number, active: boolean): Alarm {
  const def = errorOf(type);
  const a: Alarm = {
    id: `al${alarmSeq++}`,
    code: def?.code ?? 'E000',
    cabinetId: c.id,
    cabinetName: c.name,
    cabinetCode: c.code,
    districtName: districtName(c),
    type,
    severity: def?.severity ?? 'minor',
    message,
    value,
    startedAt: iso(startedMs),
    endedAt: active ? null : iso(startedMs + between(5, 240) * 60000),
    active,
    ackedBy: null,
    ackedAt: null,
  };
  alarms.push(a);
  return a;
}

/** Per-cabinet device fault scenario, so telemetry and alarms tell the same story. */
export type Scenario = 'bus_down' | 'multi_slave_lost' | 'pm_lost' | 'ct_lost' | 'dh_meter_lost' | 'phase_loss' | 'temp_sensor_fault' | 'logo_lost';
export const scenarios = new Map<string, Scenario>();
export const bootInfo = new Map<string, { lastBootAt: string; bootsLast24h: number }>();

function applyScenario(c: Cabinet, s: CabinetState, sc: Scenario) {
  scenarios.set(c.id, sc);
  const clearPm = () => {
    s.pmOnline = false;
    s.vL1 = s.vL2 = s.vL3 = s.iL1 = s.iL2 = s.iL3 = s.pfL1 = s.pfL2 = s.pfL3 = s.pfTotal = s.pTotalKw = null;
  };
  const clearCt = () => {
    s.leakMa = null;
    s.tempC = null;
  };
  const started = now - between(3, 240) * 60000;
  switch (sc) {
    case 'bus_down':
      s.busStatus = '4';
      s.plcOnline = false;
      s.branch1On = s.branch2On = s.manualMode = null;
      s.deviceTime = null;
      clearPm();
      clearCt();
      newAlarm(c, 'bus_down', 'LCLI=4: PLC_KEY, PM_KEY, CT_KEY cùng không trả lời', null, started, true);
      break;
    case 'multi_slave_lost':
      s.busStatus = 'X';
      clearPm();
      clearCt();
      newAlarm(c, 'multi_slave_lost', 'LCLI=X: PM_KEY và CT_KEY không trả lời (PLC_KEY vẫn trả lời)', null, started, true);
      break;
    case 'pm_lost':
      s.busStatus = '2';
      clearPm();
      newAlarm(c, 'pm_lost', 'LCLI=2, MCON=0: LTE không đọc được PM_KEY', null, started, true);
      break;
    case 'ct_lost':
      s.busStatus = '3';
      clearCt();
      newAlarm(c, 'ct_lost', 'LCLI=3: LTE không đọc được CT_KEY', null, started, true);
      break;
    case 'dh_meter_lost':
      s.vL1 = s.vL2 = s.vL3 = s.iL1 = s.iL2 = s.iL3 = s.pTotalKw = s.pfTotal = s.pfL1 = s.pfL2 = s.pfL3 = 0;
      newAlarm(c, 'dh_meter_lost', 'MCON=1 nhưng U/I/P = 0: PM_KEY không đọc được đồng hồ DH', null, started, true);
      break;
    case 'phase_loss':
      s.vL3 = 0;
      s.iL3 = 0;
      newAlarm(c, 'phase_loss', 'Pha L3 = 0 V, L1/L2 bình thường', 0, started, true);
      break;
    case 'temp_sensor_fault':
      s.tempC = null;
      newAlarm(c, 'temp_sensor_fault', 'CTTE=1000: CT_KEY không đọc được DS18B20', 1000, started, true);
      break;
    case 'logo_lost':
      s.deviceTime = iso(Math.floor((now - 14 * 60000) / 60000) * 60000);
      newAlarm(c, 'logo_lost', 'PCON=1 nhưng PTIM không đổi 14 phút: PLC_KEY không đọc được LOGO', null, now - 14 * 60000, true);
      break;
  }
}

const SCENARIO_ROLL: [Scenario, number][] = [
  ['bus_down', 0.004],
  ['multi_slave_lost', 0.004],
  ['pm_lost', 0.006],
  ['ct_lost', 0.006],
  ['dh_meter_lost', 0.008],
  ['phase_loss', 0.004],
  ['temp_sensor_fault', 0.008],
  ['logo_lost', 0.006],
];

for (const c of cabinets) {
  const s = states.get(c.id)!;
  const boots = r() < 0.06 ? 2 + Math.floor(r() * 4) : r() < 0.3 ? 1 : 0;
  bootInfo.set(c.id, { lastBootAt: iso(now - (boots ? between(0.2, 20) : between(30, 400)) * 3600000), bootsLast24h: boots });
  if (!s.online) newAlarm(c, 'offline', 'Không nhận frame telemetry quá 60 s', null, Date.parse(s.lastSeenAt!), true);
  if (s.plcOnline === false && s.online) newAlarm(c, 'plc_lost', 'LCLI=1, PCON=0: LTE không đọc được PLC_KEY', null, now - between(2, 120) * 60000, true);
  if (c.fwProfile === 'v2-1307ebc') newAlarm(c, 'fw_unsafe', 'Firmware 1307ebc: web chặn điều khiển tủ này', null, Date.parse(c.installedAt), true);
  if (boots >= 3) newAlarm(c, 'flapping', `${boots} lần khởi động lại trong 24 giờ`, boots, now - between(1, 8) * 3600000, true);
  if (s.online && s.plcOnline !== false) {
    let roll = r();
    for (const [sc, p] of SCENARIO_ROLL) {
      if (roll < p) {
        applyScenario(c, s, sc);
        break;
      }
      roll -= p;
    }
  }
  if (s.online && !scenarios.has(c.id) && r() < 0.035) {
    const t = pick(ALARM_SEED);
    const v = t.v();
    newAlarm(c, t.type, t.msg(v), v, now - between(1, 300) * 60000, true);
    if (t.type === 'leak_current') s.leakMa = v;
    // the device's fix really is v metres away (random direction), so the map line and the GPS dialog agree with E802
    if (t.type === 'gps_drift') {
      const a = r() * 2 * Math.PI;
      s.gpsDevice = {
        lat: c.location.lat + (v * Math.cos(a)) / 111_195,
        lng: c.location.lng + (v * Math.sin(a)) / (111_195 * Math.cos((c.location.lat * Math.PI) / 180)),
      };
    }
  }
  const hist = Math.floor(r() * 4);
  for (let k = 0; k < hist; k++) {
    const t = r() < 0.35 ? pick(HISTORY_ONLY) : pick(ALARM_SEED);
    const v = t.v();
    newAlarm(c, t.type, t.msg(v), v, now - between(1, 30) * 86400000, false);
  }
}

// ---------- Users ----------

export const users: User[] = [
  { id: 'u1', email: 'admin@citylight.local', fullName: 'Quản trị hệ thống', role: 'admin', scopeAll: true, totpRequired: true, passwordChangeRequired: false, scopeAreaIds: [], totpEnabled: true, active: true, lang: 'vi', lastLoginAt: iso(now - 3600000) },
  { id: 'u6', email: 'quanly@citylight.local', fullName: 'Võ Thị Quản', role: 'manager', scopeAll: true, totpRequired: true, passwordChangeRequired: false, scopeAreaIds: [], totpEnabled: true, active: true, lang: 'vi', lastLoginAt: iso(now - 5400000) },
  { id: 'u2', email: 'dieuhanh@citylight.local', fullName: 'Nguyễn Văn Điều', role: 'operator', scopeAll: true, totpRequired: true, passwordChangeRequired: false, scopeAreaIds: [], totpEnabled: true, active: true, lang: 'vi', lastLoginAt: iso(now - 7200000) },
  { id: 'u3', email: 'giamsat@citylight.local', fullName: 'Trần Thị Giám', role: 'viewer', scopeAll: false, totpRequired: false, passwordChangeRequired: false, scopeAreaIds: ['d1', 'd2'], totpEnabled: false, active: true, lang: 'vi', lastLoginAt: iso(now - 86400000) },
  { id: 'u4', email: 'duytu@citylight.local', fullName: 'Lê Văn Tu', role: 'maintenance', scopeAll: false, totpRequired: false, passwordChangeRequired: false, scopeAreaIds: ['d12'], totpEnabled: false, active: true, lang: 'vi', lastLoginAt: null },
  { id: 'u5', email: 'dieuhanh2@citylight.local', fullName: 'Phạm Minh Hành', role: 'operator', scopeAll: false, totpRequired: true, passwordChangeRequired: false, scopeAreaIds: ['d5', 'd6'], totpEnabled: false, active: false, lang: 'vi', lastLoginAt: iso(now - 40 * 86400000) },
];

// ---------- Incidents ----------

const CATEGORIES = ['Đèn tắt', 'Đèn sáng ban ngày', 'Trụ nghiêng', 'Mất cáp', 'Tủ hư hỏng', 'Chập điện', 'Khác'];
const STATUSES: IncidentStatus[] = ['new', 'assigned', 'deferred', 'resolved', 'closed'];
export const incidents: Incident[] = [];
for (let i = 1; i <= 90; i++) {
  const c = pick(cabinets);
  const status = pick(STATUSES);
  const reportedMs = now - between(0, 45) * 86400000;
  const ev: Incident['events'] = [{ at: iso(reportedMs), by: 'Nguyễn Văn Điều', action: 'Tạo sự cố', note: null }];
  if (status !== 'new') ev.push({ at: iso(reportedMs + 3600000), by: 'Nguyễn Văn Điều', action: status === 'deferred' ? 'Chưa cần xử lý' : 'Giao xử lý', note: status === 'deferred' ? 'Theo dõi thêm' : 'Đội duy tu khu vực' });
  if (status === 'resolved' || status === 'closed') ev.push({ at: iso(reportedMs + 86400000), by: 'Lê Văn Tu', action: 'Đã xử lý', note: 'Thay bóng, kiểm tra cáp' });
  if (status === 'closed') ev.push({ at: iso(reportedMs + 90000000), by: 'Quản trị hệ thống', action: 'Đóng sự cố', note: null });
  incidents.push({
    id: `inc${i}`,
    code: `SC${String(i).padStart(5, '0')}`,
    cabinetId: c.id,
    cabinetName: c.name,
    districtName: districtName(c),
    wardName: wardName(c),
    source: r() < 0.4 ? 'alarm' : 'manual',
    category: pick(CATEGORIES),
    content: 'Người dân phản ánh tại khu vực gần tủ, cần kiểm tra hiện trường.',
    location: { lat: c.location.lat + between(-0.002, 0.002), lng: c.location.lng + between(-0.002, 0.002) },
    reportedBy: pick(['Tổng đài', 'Đội tuần tra', 'Nguyễn Văn Điều', 'Cảnh báo hệ thống']),
    reportedAt: iso(reportedMs),
    status,
    assignee: status === 'new' ? null : 'Lê Văn Tu',
    deadline: status === 'assigned' ? iso(reportedMs + between(1, 5) * 86400000) : null,
    resolution: status === 'resolved' || status === 'closed' ? 'Thay bóng, kiểm tra cáp' : null,
    resolvedAt: status === 'resolved' || status === 'closed' ? iso(reportedMs + 86400000) : null,
    photos: [],
    events: ev,
  });
}
incidents.sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));

// ---------- Activity logs ----------

export const activityLogs: ActivityLog[] = [];
let logSeq = 1;
export function addLog(userEmail: string, action: string, targetType: string, targetName: string, oldValue: string | null, newValue: string | null, ts = Date.now()) {
  activityLogs.unshift({ id: `log${logSeq++}`, userEmail, action, targetType, targetName, oldValue, newValue, ip: '10.0.0.15', ts: iso(ts) });
}
for (let i = 0; i < 120; i++) {
  const c = pick(cabinets);
  const u = pick(users);
  const kind = pick(['Bật nhánh 1', 'Tắt nhánh 2', 'Đặt lịch', 'Đồng bộ giờ', 'Sửa ngưỡng', 'Xác nhận cảnh báo', 'Cập nhật vị trí tủ']);
  addLog(u.email, kind, 'cabinet', `${c.code} - ${c.name}`, null, kind === 'Đặt lịch' ? 'Chế độ 1: 18:00 → 05:45' : null, now - i * between(10, 90) * 60000);
}
activityLogs.sort((a, b) => b.ts.localeCompare(a.ts));

// ---------- Defaults ----------

export function defaultSchedule(): Schedule {
  return {
    mode: 1,
    source: 'manual',
    on1: '18:00',
    off1: '05:45',
    on2: '18:15',
    off2: '23:00',
    branch1Enabled: true,
    branch2Enabled: true,
    offsetOnMin: 10,
    offsetOffMin: -10,
    appliedAt: iso(now - 3 * 86400000),
    inheritedFromZone: true,
  };
}

export function defaultThresholds(): Thresholds {
  return {
    voltageHigh: { enabled: true, value: 240 },
    voltageLow: { enabled: true, value: 200 },
    voltageSwing: { enabled: false, value: 15 },
    currentHigh: { enabled: true, value: 45 },
    currentLow: { enabled: false, value: 2 },
    currentSwing: { enabled: false, value: 10 },
    currentNoLoad: { enabled: true, value: 0.5 },
    leakMa: { enabled: true, value: 30 },
    tempC: { enabled: true, value: 55 },
    batteryLowMv: { enabled: true, value: 3600 },
  };
}
