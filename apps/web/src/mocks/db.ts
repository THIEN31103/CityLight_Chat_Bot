// In-browser mock backend state + behaviour (status derivation, command lifecycle, batches, ticks).
// Mirrors docs/spec.md sections 4, 6, 8, 12 so the UI can be built before the real API exists.
import type {
  Cabinet,
  CabinetState,
  CabinetStatus,
  CabinetSummary,
  Capability,
  Command,
  CommandBatch,
  CommandType,
  DimmingProfile,
  GeoPoint,
  LampGroup,
  MapStats,
  Schedule,
  TelemetryPoint,
  Thresholds,
} from '@citylight/shared';
import { decodeRs485SelfTest, describeCommand } from '@citylight/shared';
import type { CabinetDiagnostics, DiagnosticItem, Rs485SelfTest } from '@citylight/shared';
import {
  activityLogs,
  addLog,
  alarms,
  cabinets,
  defaultSchedule,
  defaultThresholds,
  incidents,
  bootInfo,
  isNightNow,
  newAlarm,
  scenarios,
  rng,
  states,
} from './seed';

type Listener = (event: string, payload: unknown) => void;
const listeners = new Set<Listener>();
export function onMockEvent(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(event: string, payload: unknown) {
  listeners.forEach((l) => l(event, payload));
}

export const cabinetById = new Map(cabinets.map((c) => [c.id, c]));

// ---------- Status (spec 6) ----------

export function deriveStatus(s: CabinetState): CabinetStatus {
  if (!s.online) return 'offline';
  const critical = alarms.some((a) => a.active && a.cabinetId === s.cabinetId && a.severity === 'critical');
  if (critical) return 'fault';
  if (s.plcOnline === false || s.branch1On === null) return 'unknown';
  if (s.branch1On || s.branch2On) return 'on';
  return 'off';
}

export function refreshState(id: string) {
  const s = states.get(id)!;
  s.activeAlarmCount = alarms.filter((a) => a.active && a.cabinetId === id).length;
  s.status = deriveStatus(s);
  return s;
}
cabinets.forEach((c) => refreshState(c.id));

export function capabilitiesOf(c: Cabinet): Capability[] {
  const base: Capability[] = ['telemetry.basic', 'schedule_write'];
  if (c.fwProfile === 'v2-1307ebc') return base;
  return [...base, 'branch_state', 'manual_control', 'ltid_filter'];
}

export function summary(c: Cabinet): CabinetSummary {
  const s = states.get(c.id)!;
  return {
    id: c.id,
    ltid: c.ltid,
    code: c.code,
    name: c.name,
    location: c.location,
    status: s.status,
    districtId: c.districtId,
    wardId: c.wardId,
    branch1On: s.branch1On,
    branch2On: s.branch2On,
    connectedType: 'central',
  };
}

export function mapStats(): MapStats {
  const counts = { offline: 0, fault: 0, dimming: 0, on: 0, off: 0, unknown: 0, total: cabinets.length };
  let online = 0;
  for (const c of cabinets) {
    const s = states.get(c.id)!;
    counts[s.status]++;
    if (s.online) online++;
  }
  return {
    cabinets: counts,
    onlinePct: (online / cabinets.length) * 100,
    energyTodayKwh: null,
    energyYesterdayKwh: null,
    overdueIncidents: incidents.filter((i) => i.status === 'assigned' && i.deadline && Date.parse(i.deadline) < Date.now()).length,
  };
}

// ---------- Per-cabinet config ----------

export const schedules = new Map<string, Schedule>();
export const thresholds = new Map<string, Thresholds>();
export const dimming = new Map<string, DimmingProfile>();
export const zoneSchedules = new Map<string, Schedule>();

export function scheduleOf(id: string): Schedule {
  if (!schedules.has(id)) schedules.set(id, defaultSchedule());
  return schedules.get(id)!;
}
export function thresholdsOf(id: string): Thresholds {
  if (!thresholds.has(id)) thresholds.set(id, defaultThresholds());
  return thresholds.get(id)!;
}
export function defaultDimming(group: LampGroup): DimmingProfile {
  return {
    lampGroup: group,
    inheritedFromZone: true,
    segments: [
      { enabled: true, startMin: 1080, endMin: 1320, levelPct: 100 },
      { enabled: true, startMin: 1320, endMin: 1440, levelPct: 75 },
      { enabled: true, startMin: 1440, endMin: 1560, levelPct: 50 },
      { enabled: true, startMin: 1560, endMin: 1680, levelPct: 75 },
      { enabled: true, startMin: 1680, endMin: 1785, levelPct: 100 },
    ],
  };
}
export const groupDimming = new Map<LampGroup, DimmingProfile>(
  ([0, 1, 2, 3] as LampGroup[]).map((g) => [g, defaultDimming(g)]),
);

// ---------- Telemetry series ----------

const METRIC_BASE: Record<string, (on: boolean, r: () => number) => number> = {
  vL1: (_o, r) => 222 + (r() - 0.5) * 8,
  vL2: (_o, r) => 223 + (r() - 0.5) * 8,
  vL3: (_o, r) => 221 + (r() - 0.5) * 8,
  iL1: (o, r) => (o ? 18 + (r() - 0.5) * 6 : 0.2 * r()),
  iL2: (o, r) => (o ? 17 + (r() - 0.5) * 6 : 0.2 * r()),
  iL3: (o, r) => (o ? 19 + (r() - 0.5) * 6 : 0.2 * r()),
  pTotalKw: (o, r) => (o ? 11 + (r() - 0.5) * 3 : 0.1),
  pfTotal: (o, r) => (o ? 0.93 + (r() - 0.5) * 0.05 : 0),
  leakMa: (_o, r) => 12 + r() * 10,
  tempC: (o, r) => (o ? 38 : 33) + r() * 4,
};

export function telemetrySeries(id: string, metrics: string[], fromMs: number, toMs: number, points = 240): TelemetryPoint[] {
  const out: TelemetryPoint[] = [];
  const step = Math.max(60000, Math.floor((toMs - fromMs) / points));
  const seed = Number(id.replace(/\D/g, '')) || 1;
  for (let t = fromMs; t <= toMs; t += step) {
    const r = rng(seed * 100003 + Math.floor(t / step));
    const on = isNightNow(new Date(t));
    const p: TelemetryPoint = { ts: new Date(t).toISOString() };
    for (const m of metrics) {
      const f = METRIC_BASE[m];
      p[m] = f ? +f(on, r).toFixed(2) : null;
    }
    out.push(p);
  }
  return out;
}

export function energyEstimate(id: string, range: 'day' | '30d') {
  const seed = Number(id.replace(/\D/g, '')) || 1;
  const r = rng(seed);
  if (range === 'day') {
    return Array.from({ length: 24 }, (_, h) => ({
      label: `${String(h).padStart(2, '0')}h`,
      kwh: h >= 18 || h < 6 ? +(9 + r() * 4).toFixed(1) : 0.1,
    }));
  }
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.now() - (29 - i) * 86400000);
    return { label: `${d.getDate()}/${d.getMonth() + 1}`, kwh: +(120 + r() * 30).toFixed(0) };
  });
}

// ---------- Poles / routes (GIS mock) ----------

export interface MockPole {
  id: string;
  code: string;
  cabinetId: string;
  routeCode: string;
  branch: 'N1' | 'N2';
  location: GeoPoint;
  lampCount: number;
}

const polesByCabinet = new Map<string, MockPole[]>();
export function polesOf(id: string): MockPole[] {
  if (polesByCabinet.has(id)) return polesByCabinet.get(id)!;
  const c = cabinetById.get(id)!;
  const r = rng(Number(id.replace(/\D/g, '')) * 7);
  const list: MockPole[] = [];
  (['N1', 'N2'] as const).forEach((branch, bi) => {
    const angle = r() * Math.PI * 2 + bi * Math.PI;
    const n = 6 + Math.floor(r() * 6);
    for (let k = 1; k <= n; k++) {
      const dist = 0.00035 * k;
      list.push({
        id: `${id}-${branch}-${k}`,
        code: `${c.code}_${branch}_${k}`,
        cabinetId: id,
        routeCode: `${c.code}_${branch}`,
        branch,
        location: { lat: c.location.lat + Math.sin(angle) * dist, lng: c.location.lng + Math.cos(angle) * dist },
        lampCount: r() < 0.2 ? 2 : 1,
      });
    }
  });
  polesByCabinet.set(id, list);
  return list;
}

// ---------- Commands (spec 12) ----------

export const commands: Command[] = [];
/** Server-side only: raw CoreIF frame per command (never returned by the API). */
export const commandFrames = new Map<string, string>();
let cmdSeq = 1;
const idempotency = new Map<string, Command>();

export class MockApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const TYPE_CAPABILITY: Partial<Record<CommandType, Capability>> = {
  MANUAL_ALL: 'manual_control',
  MANUAL_BRANCH: 'manual_control',
  AUTO: 'manual_control',
  SET_DIMMING: 'dimming',
  LAMP_CONTROL: 'smart_lamps',
};

function buildFrame(c: Cabinet, type: CommandType, p: Record<string, unknown>): string {
  const kv: string[] = [`LTID'${c.ltid}`];
  switch (type) {
    case 'MANUAL_ALL':
      kv.push(`PLN1'${p.on ? 1 : 0}`, `PLN2'${p.on ? 1 : 0}`, `PMAN'1`);
      break;
    case 'MANUAL_BRANCH':
      kv.push(`PLN${p.branch}'${p.on ? 1 : 0}`, `PMAN'1`);
      break;
    case 'AUTO':
      kv.push(`PMAN'0`);
      break;
    case 'SET_TIME':
      kv.push(`LTIM'${new Date().toISOString().slice(0, 19)}+07:00`);
      break;
    case 'SET_SCHEDULE': {
      const s = p as unknown as Schedule;
      const t = (hhmm: string) => `2026-01-01T${hhmm}:00+07:00`;
      if (s.mode === 1) kv.push(`PI50'0`, `T10'${t(s.on1)}`, `T20'${t(s.off1)}`);
      else
        kv.push(`PI50'1`, `LINE1'${s.branch1Enabled ? 1 : 0}`, `LINE2'${s.branch2Enabled ? 1 : 0}`, `T10'${t(s.on1)}`, `T20'${t(s.off1)}`, `T11'${t(s.on2)}`, `T21'${t(s.off2)}`);
      break;
    }
    case 'PULSE_ON':
      kv.push(`PI2O'1`);
      break;
    case 'DIAG':
      kv.push(`LDIA'1`);
      break;
    default:
      break;
  }
  return `*#${kv.join('&')}$`;
}

export function createCommand(
  cabinetId: string,
  type: CommandType,
  params: Record<string, unknown>,
  user: string,
  opts: { idempotencyKey?: string; batchId?: string; queueIfOffline?: boolean } = {},
): Command {
  if (opts.idempotencyKey && idempotency.has(opts.idempotencyKey)) return idempotency.get(opts.idempotencyKey)!;
  const c = cabinetById.get(cabinetId);
  if (!c) throw new MockApiError(404, 'not_found', 'Không tìm thấy tủ');
  const s = states.get(cabinetId)!;
  const need = TYPE_CAPABILITY[type];
  if (c.fwProfile === 'v2-1307ebc' && type !== 'SET_SCHEDULE')
    throw new MockApiError(409, 'cabinet_unsafe_firmware', 'Firmware cũ không lọc LTID, chặn điều khiển để tránh ảnh hưởng tủ khác');
  if (need && !capabilitiesOf(c).includes(need))
    throw new MockApiError(409, 'capability_unsupported', 'Thiết bị chưa hỗ trợ chức năng này');
  if (!s.online && !opts.queueIfOffline) throw new MockApiError(409, 'cabinet_offline', 'Tủ đang mất kết nối');

  const cmd: Command = {
    id: `cmd${cmdSeq++}`,
    cabinetId,
    cabinetName: `${c.code} - ${c.name}`,
    type,
    params,
    batchId: opts.batchId ?? null,
    status: 'queued',
    requestedBy: user,
    queuedAt: new Date().toISOString(),
    sentAt: null,
    ackedAt: null,
    confirmedAt: null,
    error: null,
  };
  commands.unshift(cmd);
  commandFrames.set(cmd.id, buildFrame(c, type, params));
  if (opts.idempotencyKey) idempotency.set(opts.idempotencyKey, cmd);
  addLog(user, 'Gửi lệnh', 'cabinet', cmd.cabinetName, null, describeCommand(type, params));
  runLifecycle(cmd);
  return cmd;
}

function update(cmd: Command, patch: Partial<Command>) {
  Object.assign(cmd, patch);
  emit('command.updated', { ...cmd });
}

function runLifecycle(cmd: Command) {
  const s = states.get(cmd.cabinetId)!;
  const r = Math.random();
  setTimeout(() => {
    if (!s.online) {
      update(cmd, { status: 'timeout', error: 'Tủ không phản hồi trong 30 s' });
      return;
    }
    update(cmd, { status: 'sent', sentAt: new Date().toISOString() });
    setTimeout(() => {
      if (r < 0.05) {
        update(cmd, { status: 'failed', error: 'rc:-1 (ghi Modbus xuống PLC_KEY thất bại)' });
        return;
      }
      update(cmd, { status: 'acked', ackedAt: new Date().toISOString() });
      setTimeout(() => {
        applyEffect(cmd);
        update(cmd, { status: 'confirmed', confirmedAt: new Date().toISOString() });
      }, 1500 + Math.random() * 1500);
    }, 800 + Math.random() * 800);
  }, 400);
}

function applyEffect(cmd: Command) {
  const s = states.get(cmd.cabinetId)!;
  const p = cmd.params;
  if (cmd.type === 'MANUAL_ALL') {
    s.manualMode = true;
    s.branch1On = !!p.on;
    s.branch2On = !!p.on;
  } else if (cmd.type === 'MANUAL_BRANCH') {
    s.manualMode = true;
    if (p.branch === 1) s.branch1On = !!p.on;
    else s.branch2On = !!p.on;
  } else if (cmd.type === 'AUTO') {
    s.manualMode = false;
    const lit = isNightNow();
    s.branch1On = lit;
    s.branch2On = lit;
  } else if (cmd.type === 'SET_TIME') {
    s.deviceTime = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  } else if (cmd.type === 'DIAG') {
    runSelfTest(cmd.cabinetId);
  } else if (cmd.type === 'SET_SCHEDULE') {
    const sc = scheduleOf(cmd.cabinetId);
    Object.assign(sc, p, { appliedAt: new Date().toISOString() });
  }
  const lit = !!(s.branch1On || s.branch2On);
  s.iL1 = lit ? 18 : 0.2;
  s.iL2 = lit ? 17 : 0.2;
  s.iL3 = lit ? 19 : 0.2;
  s.pTotalKw = lit ? 11.2 : 0.1;
  refreshState(cmd.cabinetId);
  emit('cabinet.state', { ...s });
}

// ---------- Batches ----------

export const batches: CommandBatch[] = [];
export const batchItems = new Map<string, { cabinetId: string; cabinetName: string; result: 'pending' | 'ok' | 'failed' | 'offline'; error: string | null }[]>();
let batchSeq = 1;

export function createBatch(kind: CommandBatch['kind'], scope: string, cabinetIds: string[], user: string): CommandBatch {
  const b: CommandBatch = {
    id: `b${batchSeq++}`,
    kind,
    scope,
    total: cabinetIds.length,
    succeeded: 0,
    failed: 0,
    offline: 0,
    pending: cabinetIds.length,
    requestedBy: user,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  batches.unshift(b);
  type Item = { cabinetId: string; cabinetName: string; result: 'pending' | 'ok' | 'failed' | 'offline'; error: string | null };
  const items: Item[] = cabinetIds.map((id) => {
    const c = cabinetById.get(id)!;
    return { cabinetId: id, cabinetName: `${c.code} - ${c.name}`, result: 'pending', error: null };
  });
  batchItems.set(b.id, items);
  addLog(user, `Đồng bộ hàng loạt (${kind})`, 'zone', scope, null, `${cabinetIds.length} tủ`);
  // Rate-limited progress: 20 cabinets / 500 ms (spec 3.1 default 20 cmd/s is per second; faster here for the demo).
  let idx = 0;
  const timer = setInterval(() => {
    for (let k = 0; k < 20 && idx < items.length; k++, idx++) {
      const it = items[idx]!;
      const s = states.get(it.cabinetId)!;
      if (!s.online) {
        Object.assign(it, { result: 'offline', error: 'Tủ mất kết nối' });
        b.offline++;
      } else if (Math.random() < 0.03) {
        Object.assign(it, { result: 'failed', error: 'Quá thời gian chờ ack' });
        b.failed++;
      } else {
        it.result = 'ok';
        b.succeeded++;
      }
      b.pending--;
    }
    if (idx >= items.length) {
      b.finishedAt = new Date().toISOString();
      clearInterval(timer);
    }
    emit('batch.progress', { ...b });
  }, 500);
  return b;
}

export function retryBatchFailed(id: string, user: string) {
  const items = batchItems.get(id) ?? [];
  const ids = items.filter((i) => i.result !== 'ok').map((i) => i.cabinetId);
  const b = batches.find((x) => x.id === id)!;
  return createBatch(b.kind, `${b.scope} (gửi lại)`, ids, user);
}


// ---------- Diagnostics (per subsystem, derived from telemetry like the real rules-worker) ----------

export const selfTests = new Map<string, Rs485SelfTest>();

const fmtT = (iso: string | null) => (iso ? new Date(iso).toLocaleString('vi-VN', { hour12: false }) : '—');

export function diagnosticsOf(id: string): CabinetDiagnostics {
  const c = cabinetById.get(id)!;
  const s = states.get(id)!;
  const sc = scenarios.get(id);
  const boot = bootInfo.get(id) ?? { lastBootAt: null, bootsLast24h: 0 };
  const items: DiagnosticItem[] = [];
  const add = (subsystem: string, role: string, status: DiagnosticItem['status'], code: string | null, evidence: string, detail: string) =>
    items.push({ subsystem, role, status, code, evidence, detail });

  if (!s.online) add('Kết nối 4G / máy chủ', 'LTE ↔ broker MQTT', 'fault', 'E101', `Frame cuối ${fmtT(s.lastSeenAt)}`, 'Không nhận telemetry quá 60 s.');
  else if (boot.bootsLast24h >= 3) add('Kết nối 4G / máy chủ', 'LTE ↔ broker MQTT', 'warn', 'E103', `${boot.bootsLast24h} lần khởi động lại / 24 h`, 'Kết nối chập chờn hoặc nguồn không ổn định.');
  else add('Kết nối 4G / máy chủ', 'LTE ↔ broker MQTT', 'ok', null, `Frame cuối ${fmtT(s.lastSeenAt)}`, 'Đang gửi telemetry bình thường.');

  const stale = !s.online;
  const unknownIfStale = (subsystem: string, role: string) => {
    add(subsystem, role, 'unknown', null, 'Tủ mất kết nối', 'Hiển thị lại khi tủ có kết nối.');
  };

  if (stale) unknownIfStale('Bus RS485', 'LTE ↔ PLC / PM / CT');
  else if (s.busStatus === '4') add('Bus RS485', 'LTE ↔ PLC / PM / CT', 'fault', 'E204', 'LCLI=4', 'Cả 3 slave không trả lời — nghi lỗi bus phía LTE. Chạy tự kiểm tra RS485.');
  else if (s.busStatus === 'X') add('Bus RS485', 'LTE ↔ PLC / PM / CT', 'fault', 'E205', 'LCLI=X', 'Hai slave không trả lời.');
  else if (s.busStatus === '0') add('Bus RS485', 'LTE ↔ PLC / PM / CT', 'ok', null, 'LCLI=0', 'Cả 3 slave đều trả lời.');
  else add('Bus RS485', 'LTE ↔ PLC / PM / CT', 'warn', null, `LCLI=${s.busStatus}`, 'Bus chạy nhưng có 1 slave không trả lời (xem dòng tương ứng).');

  if (stale) unknownIfStale('PLC_KEY (slave 4)', 'Cầu nối LTE ↔ LOGO');
  else if (s.plcOnline === false) add('PLC_KEY (slave 4)', 'Cầu nối LTE ↔ LOGO', 'fault', 'E201', 'PCON=0', 'Không biết trạng thái nhánh, không gửi được lệnh.');
  else add('PLC_KEY (slave 4)', 'Cầu nối LTE ↔ LOGO', 'ok', null, 'PCON=1', 'Đang trả lời.');

  if (stale || s.plcOnline === false) add('LOGO (qua module ETH)', 'PLC_KEY ↔ LOGO, Modbus TCP', 'unknown', null, 'PTIM=X', 'Cần PLC_KEY trả lời mới đánh giá được.');
  else if (sc === 'logo_lost') add('LOGO (qua module ETH)', 'PLC_KEY ↔ LOGO, Modbus TCP', 'fault', 'E301', `PTIM đứng ở ${fmtT(s.deviceTime)}`, 'PLC_KEY không đọc được LOGO; LQ2/LQ3 là giá trị cũ.');
  else add('LOGO (qua module ETH)', 'PLC_KEY ↔ LOGO, Modbus TCP', 'ok', null, `PTIM ${fmtT(s.deviceTime)}`, 'Giờ LOGO đang cập nhật.');

  if (stale) unknownIfStale('PM_KEY (slave 3)', 'Cầu nối LTE ↔ đồng hồ DH');
  else if (s.pmOnline === false) add('PM_KEY (slave 3)', 'Cầu nối LTE ↔ đồng hồ DH', 'fault', 'E202', 'MCON=0', 'Không có số liệu điện năng.');
  else add('PM_KEY (slave 3)', 'Cầu nối LTE ↔ đồng hồ DH', 'ok', null, 'MCON=1', 'Đang trả lời.');

  if (stale || s.pmOnline === false) add('Đồng hồ điện DH', 'Đo U / I / P 3 pha', 'unknown', null, 'MCON=0', 'Cần PM_KEY trả lời mới đánh giá được.');
  else if (sc === 'dh_meter_lost') add('Đồng hồ điện DH', 'Đo U / I / P 3 pha', 'fault', 'E401', 'MCON=1, U=I=P=0', 'PM_KEY không đọc được đồng hồ DH hoặc mất điện lưới.');
  else if (sc === 'phase_loss') add('Đồng hồ điện DH', 'Đo U / I / P 3 pha', 'fault', 'E402', `L1 ${s.vL1} V · L2 ${s.vL2} V · L3 0 V`, 'Mất pha L3.');
  else add('Đồng hồ điện DH', 'Đo U / I / P 3 pha', 'ok', null, `L1 ${s.vL1} V · L2 ${s.vL2} V · L3 ${s.vL3} V`, 'Số liệu hợp lệ.');

  const ctLost = s.busStatus === '3' || s.busStatus === 'X' || s.busStatus === '4';
  if (stale) unknownIfStale('CT_KEY (slave 2)', 'Dòng rò + nhiệt độ tủ');
  else if (ctLost) add('CT_KEY (slave 2)', 'Dòng rò + nhiệt độ tủ', 'fault', 'E203', `LCLI=${s.busStatus}`, 'Không có dòng rò và nhiệt độ tủ.');
  else add('CT_KEY (slave 2)', 'Dòng rò + nhiệt độ tủ', 'ok', null, `CTVL=${s.leakMa} mA`, 'Đang trả lời.');

  if (stale || ctLost) add('Cảm biến nhiệt DS18B20', 'Nhiệt độ trong tủ', 'unknown', null, 'CTTE=X', 'Cần CT_KEY trả lời mới đánh giá được.');
  else if (sc === 'temp_sensor_fault') add('Cảm biến nhiệt DS18B20', 'Nhiệt độ trong tủ', 'fault', 'E503', 'CTTE=1000', 'Đứt dây OneWire hoặc cảm biến hỏng.');
  else add('Cảm biến nhiệt DS18B20', 'Nhiệt độ trong tủ', 'ok', null, `CTTE=${s.tempC} °C`, 'Đang đọc được.');

  if (stale) unknownIfStale('GPS', 'Định vị GNSS của EC25');
  else if (!s.gpsDevice) add('GPS', 'Định vị GNSS của EC25', 'warn', 'E801', 'LGPS=X', 'Chưa có fix GNSS.');
  else add('GPS', 'Định vị GNSS của EC25', 'ok', null, `${s.gpsDevice.lat.toFixed(5)}, ${s.gpsDevice.lng.toFixed(5)}`, 'Có fix.');

  if (s.batteryMv !== null && s.batteryMv < 3600) add('Pin dự phòng', 'Nguồn dự phòng bộ điều khiển', 'warn', 'E803', `LBAT=${s.batteryMv} mV`, 'Pin yếu.');
  else add('Pin dự phòng', 'Nguồn dự phòng bộ điều khiển', s.batteryMv === null ? 'unknown' : 'ok', null, `LBAT=${s.batteryMv ?? 'X'} mV`, 'Bình thường.');

  if (c.fwProfile === 'v2-1307ebc') add('Firmware LTE', 'Phiên bản / an toàn lệnh', 'warn', 'E804', 'v2-1307ebc', 'Không lọc LTID — web chặn điều khiển.');
  else add('Firmware LTE', 'Phiên bản / an toàn lệnh', 'ok', null, 'v2-current', 'Có lọc LTID, hỗ trợ PMAN/PLN.');

  add('Cửa tủ / contactor', 'PDOR / PFLT từ LOGO', 'unsupported', null, 'TELE_SEND_DOOR_FAULT 0', 'Firmware chưa gửi — sẽ có khi bật cờ.');

  return { items, lastBootAt: boot.lastBootAt, bootsLast24h: boot.bootsLast24h, selfTest: selfTests.get(id) ?? null };
}

export function runSelfTest(id: string) {
  const summary = scenarios.get(id) === 'bus_down' ? 'A0D0B1C1' : 'A1D1B1C1';
  const d = decodeRs485SelfTest(summary);
  selfTests.set(id, { at: new Date().toISOString(), summary, ...d });
}

// ---------- Live ticks ----------

const tickRand = rng(99);
setInterval(() => {
  const changed: CabinetState[] = [];
  for (let k = 0; k < 25; k++) {
    const c = cabinets[Math.floor(tickRand() * cabinets.length)]!;
    const s = states.get(c.id)!;
    if (s.online) {
      s.lastSeenAt = new Date().toISOString();
      s.vL1 = +(222 + (tickRand() - 0.5) * 8).toFixed(1);
      s.vL2 = +(223 + (tickRand() - 0.5) * 8).toFixed(1);
      s.vL3 = +(221 + (tickRand() - 0.5) * 8).toFixed(1);
      s.leakMa = Math.max(0, Math.round((s.leakMa ?? 10) + (tickRand() - 0.5) * 4));
    }
    // rare connectivity flips so the KPI counters visibly move
    if (tickRand() < 0.02) {
      s.online = !s.online;
      if (!s.online) newAlarm(c, 'offline', 'Không nhận frame telemetry quá 60 s', null, Date.now(), true);
      else
        alarms
          .filter((a) => a.active && a.cabinetId === c.id && a.type === 'offline')
          .forEach((a) => {
            a.active = false;
            a.endedAt = new Date().toISOString();
            emit('alarm.cleared', { ...a });
          });
      if (!s.online) emit('alarm.raised', { ...alarms[alarms.length - 1] });
    }
    refreshState(c.id);
    changed.push({ ...s });
  }
  changed.forEach((s) => emit('cabinet.state', s));
}, 5000);

export { activityLogs, alarms, cabinets, incidents, states };
