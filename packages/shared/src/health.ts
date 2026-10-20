// Device-health rules shared by the ingest worker (alarms) and the API (diagnostics tab).
// Inputs are what the LTE firmware reports (see errors.ts header); thresholds-based alarms are M5.
import type { AlarmType, CabinetStatus, DiagnosticItem, FwProfile, GeoPoint } from './domain';
import { LOCALE, defineDict, plural, type Lang } from './i18n';

export interface HealthInput {
  online: boolean;
  lastSeenAt: string | null;
  busStatus: string | null;
  plcOnline: boolean | null;
  pmOnline: boolean | null;
  branch1On: boolean | null;
  branch2On: boolean | null;
  vL1: number | null;
  vL2: number | null;
  vL3: number | null;
  iL1: number | null;
  iL2: number | null;
  iL3: number | null;
  leakMa: number | null;
  tempC: number | null;
  tempSensorFault: boolean;
  gpsDevice: GeoPoint | null;
  batteryMv: number | null;
  deviceTime: string | null;
  /** Server time PTIM last changed (null = never seen). */
  deviceTimeChangedAt: string | null;
  lastBootAt: string | null;
  bootsLastHour: number;
  bootsLast24h: number;
  fwProfile: FwProfile;
}

export const OFFLINE_AFTER_MS = 60_000;
export const PTIM_STALE_MS = 5 * 60_000;
export const GPS_GRACE_MS = 10 * 60_000;
export const FLAPPING_BOOTS_PER_HOUR = 3;

const n = (v: number | null) => v ?? 0;

export function ptimStale(h: HealthInput, now = Date.now()): boolean {
  if (!h.online || h.plcOnline !== true || !h.deviceTimeChangedAt) return false;
  return now - Date.parse(h.deviceTimeChangedAt) > PTIM_STALE_MS;
}

export function dhMeterLost(h: HealthInput): boolean {
  return h.online && h.pmOnline === true && [h.vL1, h.vL2, h.vL3, h.iL1, h.iL2, h.iL3].every((v) => v !== null && v === 0);
}

export function phaseLoss(h: HealthInput): boolean {
  if (!h.online || h.pmOnline !== true || dhMeterLost(h)) return false;
  const v = [n(h.vL1), n(h.vL2), n(h.vL3)];
  return v.some((x) => x < 50) && v.some((x) => x > 150);
}

const ctLost = (b: string | null) => b === '3' || b === 'X' || b === '4';

/** Alarm messages of activeHealthAlarms (the ingest worker stores the Vietnamese ones in alarms.message). */
export const HEALTH_ALARM_TEXT = defineDict(
  {
    offline: (s: number) => `Không nhận frame telemetry quá ${s} s`,
    flapping: (n: number) => `${n} lần khởi động lại trong 1 giờ`,
    plcLost: 'LCLI=1, PCON=0: LTE không đọc được PLC_KEY',
    pmLost: 'LCLI=2, MCON=0: LTE không đọc được PM_KEY',
    ctLost: 'LCLI=3: LTE không đọc được CT_KEY',
    busDown: 'LCLI=4: PLC_KEY, PM_KEY, CT_KEY cùng không trả lời',
    multiSlave: (pcon: number, mcon: number) => `LCLI=X: PCON=${pcon}, MCON=${mcon} — hai slave không trả lời`,
    logoLost: (since: string) => `PCON=1 nhưng PTIM không đổi từ ${since}`,
    dhMeterLost: 'MCON=1 nhưng U/I/P đều = 0',
    phaseLoss: (v1: number, v2: number, v3: number) => `U pha: L1 ${v1} V · L2 ${v2} V · L3 ${v3} V`,
    tempSensor: 'CTTE=1000: CT_KEY không đọc được DS18B20',
    gpsNofix: 'LGPS=X quá 10 phút sau khởi động',
    fwUnsafe: 'Firmware 1307ebc (frame không có LQ2/LQ3/PMAN): web chặn điều khiển',
  },
  {
    offline: (s: number) => `No telemetry frame for more than ${s} s`,
    flapping: (n: number) => `${plural(n, 'restart', 'restarts')} within 1 hour`,
    plcLost: 'LCLI=1, PCON=0: LTE cannot read PLC_KEY',
    pmLost: 'LCLI=2, MCON=0: LTE cannot read PM_KEY',
    ctLost: 'LCLI=3: LTE cannot read CT_KEY',
    busDown: 'LCLI=4: PLC_KEY, PM_KEY and CT_KEY all not responding',
    multiSlave: (pcon: number, mcon: number) => `LCLI=X: PCON=${pcon}, MCON=${mcon} — two slaves not responding`,
    logoLost: (since: string) => `PCON=1 but PTIM unchanged since ${since}`,
    dhMeterLost: 'MCON=1 but U/I/P all = 0',
    phaseLoss: (v1: number, v2: number, v3: number) => `Phase U: L1 ${v1} V · L2 ${v2} V · L3 ${v3} V`,
    tempSensor: 'CTTE=1000: CT_KEY cannot read the DS18B20',
    gpsNofix: 'LGPS=X for more than 10 min after boot',
    fwUnsafe: 'Firmware 1307ebc (frames without LQ2/LQ3/PMAN): control blocked on the web',
  },
);

/** Alarm types that must be active right now for this cabinet (offline handled by the sweep too). */
export function activeHealthAlarms(h: HealthInput, now = Date.now(), lang: Lang = 'vi'): Map<AlarmType, string> {
  const T = HEALTH_ALARM_TEXT[lang];
  const out = new Map<AlarmType, string>();
  if (!h.online) {
    out.set('offline', T.offline(OFFLINE_AFTER_MS / 1000));
    return out; // no device-side rules while offline (avoid alarm storms on stale data)
  }
  if (h.bootsLastHour >= FLAPPING_BOOTS_PER_HOUR) out.set('flapping', T.flapping(h.bootsLastHour));
  switch (h.busStatus) {
    case '1':
      out.set('plc_lost', T.plcLost);
      break;
    case '2':
      out.set('pm_lost', T.pmLost);
      break;
    case '3':
      out.set('ct_lost', T.ctLost);
      break;
    case '4':
      out.set('bus_down', T.busDown);
      break;
    case 'X':
      out.set('multi_slave_lost', T.multiSlave(h.plcOnline ? 1 : 0, h.pmOnline ? 1 : 0));
      break;
  }
  if (ptimStale(h, now)) out.set('logo_lost', T.logoLost(new Date(h.deviceTimeChangedAt!).toISOString()));
  if (dhMeterLost(h)) out.set('dh_meter_lost', T.dhMeterLost);
  if (phaseLoss(h)) out.set('phase_loss', T.phaseLoss(n(h.vL1), n(h.vL2), n(h.vL3)));
  if (h.tempSensorFault && !ctLost(h.busStatus)) out.set('temp_sensor_fault', T.tempSensor);
  if (!h.gpsDevice && h.lastBootAt && now - Date.parse(h.lastBootAt) > GPS_GRACE_MS) out.set('gps_nofix', T.gpsNofix);
  if (h.fwProfile === 'v2-1307ebc') out.set('fw_unsafe', T.fwUnsafe);
  return out;
}

/** Spec section 6. `criticalActive` = any critical alarm open for this cabinet. */
export function deriveCabinetStatus(h: Pick<HealthInput, 'online' | 'plcOnline' | 'branch1On' | 'branch2On'>, criticalActive: boolean): CabinetStatus {
  if (!h.online) return 'offline';
  if (criticalActive) return 'fault';
  if (h.plcOnline === false || h.branch1On === null) return 'unknown';
  return h.branch1On || h.branch2On ? 'on' : 'off';
}

/** Texts of the diagnostics tab (subsystem, role, evidence, detail). */
export const DIAGNOSTICS_TEXT = defineDict(
  {
    sub: {
      net: 'Kết nối 4G / máy chủ',
      bus: 'Bus RS485',
      plc: 'PLC_KEY (slave 4)',
      logo: 'LOGO (qua module ETH)',
      pm: 'PM_KEY (slave 3)',
      dh: 'Đồng hồ điện DH',
      ct: 'CT_KEY (slave 2)',
      temp: 'Cảm biến nhiệt DS18B20',
      gps: 'GPS',
      battery: 'Pin dự phòng',
      fw: 'Firmware LTE',
      door: 'Cửa tủ / contactor',
    },
    role: {
      net: 'LTE ↔ broker MQTT',
      bus: 'LTE ↔ PLC / PM / CT',
      plc: 'Cầu nối LTE ↔ LOGO',
      logo: 'PLC_KEY ↔ LOGO, Modbus TCP',
      pm: 'Cầu nối LTE ↔ đồng hồ DH',
      dh: 'Đo U / I / P 3 pha',
      ct: 'Dòng rò + nhiệt độ tủ',
      temp: 'Nhiệt độ trong tủ',
      gps: 'Định vị GNSS của EC25',
      battery: 'Nguồn dự phòng bộ điều khiển',
      fw: 'Phiên bản / an toàn lệnh',
      door: 'PDOR / PFLT từ LOGO',
    },
    offlineEvidence: 'Tủ mất kết nối',
    offlineDetail: 'Hiển thị lại khi tủ có kết nối.',
    lastFrame: (t: string) => `Frame cuối ${t}`,
    noTelemetry: 'Không nhận telemetry quá 60 s.',
    boots: (n: number) => `${n} lần khởi động / 1 h`,
    flapping: 'Kết nối chập chờn hoặc nguồn không ổn định.',
    netOk: 'Đang gửi telemetry bình thường.',
    busDown: 'Cả 3 slave không trả lời — nghi lỗi bus phía LTE. Chạy tự kiểm tra RS485.',
    busTwo: 'Hai slave không trả lời.',
    busOk: 'Cả 3 slave đều trả lời.',
    busOne: 'Bus chạy nhưng có 1 slave không trả lời.',
    busNone: 'Chưa nhận LCLI.',
    plcFault: 'Không biết trạng thái nhánh, không gửi được lệnh.',
    responding: 'Đang trả lời.',
    needPlc: 'Cần PLC_KEY trả lời mới đánh giá được.',
    ptimStuck: (t: string) => `PTIM đứng ở ${t}`,
    logoFault: 'PLC_KEY không đọc được LOGO; LQ2/LQ3 là giá trị cũ.',
    logoOk: 'Giờ LOGO đang cập nhật.',
    pmFault: 'Không có số liệu điện năng.',
    needPm: 'Cần PM_KEY trả lời mới đánh giá được.',
    dhFault: 'PM_KEY không đọc được đồng hồ DH hoặc mất điện lưới.',
    phaseLoss: 'Mất pha.',
    dhOk: 'Số liệu hợp lệ.',
    ctFault: 'Không có dòng rò và nhiệt độ tủ.',
    needCt: 'Cần CT_KEY trả lời mới đánh giá được.',
    tempFault: 'Đứt dây OneWire hoặc cảm biến hỏng.',
    tempOk: 'Đang đọc được.',
    gpsNoFix: 'Chưa có fix GNSS.',
    gpsOk: 'Có fix.',
    batteryLow: 'Pin yếu.',
    noData: 'Chưa có số liệu.',
    normal: 'Bình thường.',
    fwOld: 'Không lọc LTID — web chặn điều khiển.',
    fwOk: 'Có lọc LTID, hỗ trợ PMAN/PLN.',
    doorUnsupported: 'Firmware chưa gửi — sẽ có khi bật cờ.',
  },
  {
    sub: {
      net: '4G / server connection',
      bus: 'RS485 bus',
      plc: 'PLC_KEY (slave 4)',
      logo: 'LOGO (via ETH module)',
      pm: 'PM_KEY (slave 3)',
      dh: 'DH power meter',
      ct: 'CT_KEY (slave 2)',
      temp: 'DS18B20 temperature sensor',
      gps: 'GPS',
      battery: 'Backup battery',
      fw: 'LTE firmware',
      door: 'Cabinet door / contactor',
    },
    role: {
      net: 'LTE ↔ MQTT broker',
      bus: 'LTE ↔ PLC / PM / CT',
      plc: 'LTE ↔ LOGO bridge',
      logo: 'PLC_KEY ↔ LOGO, Modbus TCP',
      pm: 'LTE ↔ DH meter bridge',
      dh: '3-phase U / I / P metering',
      ct: 'Leakage current + cabinet temperature',
      temp: 'Temperature inside the cabinet',
      gps: 'EC25 GNSS positioning',
      battery: 'Controller backup supply',
      fw: 'Version / command safety',
      door: 'PDOR / PFLT from the LOGO',
    },
    offlineEvidence: 'Cabinet offline',
    offlineDetail: 'Shown again once the cabinet is back online.',
    lastFrame: (t: string) => `Last frame ${t}`,
    noTelemetry: 'No telemetry for more than 60 s.',
    boots: (n: number) => `${plural(n, 'restart', 'restarts')} / 1 h`,
    flapping: 'Unstable connection or power supply.',
    netOk: 'Sending telemetry normally.',
    busDown: 'None of the 3 slaves respond — suspect a bus fault on the LTE side. Run the RS485 self-test.',
    busTwo: 'Two slaves not responding.',
    busOk: 'All 3 slaves respond.',
    busOne: 'Bus works but 1 slave does not respond.',
    busNone: 'No LCLI received yet.',
    plcFault: 'Branch states unknown, commands cannot be sent.',
    responding: 'Responding.',
    needPlc: 'Can be assessed only when PLC_KEY responds.',
    ptimStuck: (t: string) => `PTIM stuck at ${t}`,
    logoFault: 'PLC_KEY cannot read the LOGO; LQ2/LQ3 are stale values.',
    logoOk: 'LOGO clock is updating.',
    pmFault: 'No power data.',
    needPm: 'Can be assessed only when PM_KEY responds.',
    dhFault: 'PM_KEY cannot read the DH meter, or mains power is lost.',
    phaseLoss: 'Phase loss.',
    dhOk: 'Values are valid.',
    ctFault: 'No leakage current or cabinet temperature.',
    needCt: 'Can be assessed only when CT_KEY responds.',
    tempFault: 'OneWire wire broken or sensor faulty.',
    tempOk: 'Reading normally.',
    gpsNoFix: 'No GNSS fix yet.',
    gpsOk: 'Fix acquired.',
    batteryLow: 'Battery low.',
    noData: 'No data yet.',
    normal: 'Normal.',
    fwOld: 'No LTID filter — control blocked on the web.',
    fwOk: 'LTID filter present, PMAN/PLN supported.',
    doorUnsupported: 'Not sent by the firmware yet — available once the flag is enabled.',
  },
);

const fmt = (iso: string | null, lang: Lang) => (iso ? new Date(iso).toLocaleString(LOCALE[lang], { hour12: false, timeZone: 'Asia/Ho_Chi_Minh' }) : '—');

/** Per-subsystem view for the "Chẩn đoán lỗi" tab. */
export function buildDiagnostics(h: HealthInput, now = Date.now(), lang: Lang = 'vi'): DiagnosticItem[] {
  const T = DIAGNOSTICS_TEXT[lang];
  const S = T.sub;
  const R = T.role;
  const items: DiagnosticItem[] = [];
  const add = (subsystem: string, role: string, status: DiagnosticItem['status'], code: string | null, evidence: string, detail: string) =>
    items.push({ subsystem, role, status, code, evidence, detail });
  const stale = !h.online;
  const unknown = (subsystem: string, role: string) => add(subsystem, role, 'unknown', null, T.offlineEvidence, T.offlineDetail);

  if (!h.online) add(S.net, R.net, 'fault', 'E101', T.lastFrame(fmt(h.lastSeenAt, lang)), T.noTelemetry);
  else if (h.bootsLastHour >= FLAPPING_BOOTS_PER_HOUR) add(S.net, R.net, 'warn', 'E103', T.boots(h.bootsLastHour), T.flapping);
  else add(S.net, R.net, 'ok', null, T.lastFrame(fmt(h.lastSeenAt, lang)), T.netOk);

  if (stale) unknown(S.bus, R.bus);
  else if (h.busStatus === '4') add(S.bus, R.bus, 'fault', 'E204', 'LCLI=4', T.busDown);
  else if (h.busStatus === 'X') add(S.bus, R.bus, 'fault', 'E205', 'LCLI=X', T.busTwo);
  else if (h.busStatus === '0') add(S.bus, R.bus, 'ok', null, 'LCLI=0', T.busOk);
  else if (h.busStatus) add(S.bus, R.bus, 'warn', null, `LCLI=${h.busStatus}`, T.busOne);
  else add(S.bus, R.bus, 'unknown', null, 'LCLI=?', T.busNone);

  if (stale) unknown(S.plc, R.plc);
  else if (h.plcOnline === false) add(S.plc, R.plc, 'fault', 'E201', 'PCON=0', T.plcFault);
  else add(S.plc, R.plc, 'ok', null, 'PCON=1', T.responding);

  if (stale || h.plcOnline !== true) add(S.logo, R.logo, 'unknown', null, 'PTIM=X', T.needPlc);
  else if (ptimStale(h, now)) add(S.logo, R.logo, 'fault', 'E301', T.ptimStuck(fmt(h.deviceTime, lang)), T.logoFault);
  else add(S.logo, R.logo, 'ok', null, `PTIM ${fmt(h.deviceTime, lang)}`, T.logoOk);

  if (stale) unknown(S.pm, R.pm);
  else if (h.pmOnline === false) add(S.pm, R.pm, 'fault', 'E202', 'MCON=0', T.pmFault);
  else add(S.pm, R.pm, 'ok', null, 'MCON=1', T.responding);

  const volts = `L1 ${n(h.vL1)} V · L2 ${n(h.vL2)} V · L3 ${n(h.vL3)} V`;
  if (stale || h.pmOnline !== true) add(S.dh, R.dh, 'unknown', null, 'MCON=0', T.needPm);
  else if (dhMeterLost(h)) add(S.dh, R.dh, 'fault', 'E401', 'MCON=1, U=I=P=0', T.dhFault);
  else if (phaseLoss(h)) add(S.dh, R.dh, 'fault', 'E402', volts, T.phaseLoss);
  else add(S.dh, R.dh, 'ok', null, volts, T.dhOk);

  if (stale) unknown(S.ct, R.ct);
  else if (ctLost(h.busStatus)) add(S.ct, R.ct, 'fault', 'E203', `LCLI=${h.busStatus}`, T.ctFault);
  else add(S.ct, R.ct, 'ok', null, `CTVL=${h.leakMa ?? 'X'} mA`, T.responding);

  if (stale || ctLost(h.busStatus)) add(S.temp, R.temp, 'unknown', null, 'CTTE=X', T.needCt);
  else if (h.tempSensorFault) add(S.temp, R.temp, 'fault', 'E503', 'CTTE=1000', T.tempFault);
  else add(S.temp, R.temp, 'ok', null, `CTTE=${h.tempC ?? 'X'} °C`, T.tempOk);

  if (stale) unknown(S.gps, R.gps);
  else if (!h.gpsDevice) add(S.gps, R.gps, 'warn', 'E801', 'LGPS=X', T.gpsNoFix);
  else add(S.gps, R.gps, 'ok', null, `${h.gpsDevice.lat.toFixed(5)}, ${h.gpsDevice.lng.toFixed(5)}`, T.gpsOk);

  if (h.batteryMv !== null && h.batteryMv < 3600) add(S.battery, R.battery, 'warn', 'E803', `LBAT=${h.batteryMv} mV`, T.batteryLow);
  else add(S.battery, R.battery, h.batteryMv === null ? 'unknown' : 'ok', null, `LBAT=${h.batteryMv ?? 'X'} mV`, h.batteryMv === null ? T.noData : T.normal);

  if (h.fwProfile === 'v2-1307ebc') add(S.fw, R.fw, 'warn', 'E804', 'v2-1307ebc', T.fwOld);
  else add(S.fw, R.fw, 'ok', null, h.fwProfile, T.fwOk);

  add(S.door, R.door, 'unsupported', null, 'TELE_SEND_DOOR_FAULT 0', T.doorUnsupported);
  return items;
}
