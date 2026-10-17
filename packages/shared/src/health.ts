// Device-health rules shared by the ingest worker (alarms) and the API (diagnostics tab).
// Inputs are what the LTE firmware reports (see errors.ts header); thresholds-based alarms are M5.
import type { AlarmType, CabinetStatus, DiagnosticItem, FwProfile, GeoPoint } from './domain';

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

/** Alarm types that must be active right now for this cabinet (offline handled by the sweep too). */
export function activeHealthAlarms(h: HealthInput, now = Date.now()): Map<AlarmType, string> {
  const out = new Map<AlarmType, string>();
  if (!h.online) {
    out.set('offline', `Không nhận frame telemetry quá ${OFFLINE_AFTER_MS / 1000} s`);
    return out; // no device-side rules while offline (avoid alarm storms on stale data)
  }
  if (h.bootsLastHour >= FLAPPING_BOOTS_PER_HOUR) out.set('flapping', `${h.bootsLastHour} lần khởi động lại trong 1 giờ`);
  switch (h.busStatus) {
    case '1':
      out.set('plc_lost', 'LCLI=1, PCON=0: LTE không đọc được PLC_KEY');
      break;
    case '2':
      out.set('pm_lost', 'LCLI=2, MCON=0: LTE không đọc được PM_KEY');
      break;
    case '3':
      out.set('ct_lost', 'LCLI=3: LTE không đọc được CT_KEY');
      break;
    case '4':
      out.set('bus_down', 'LCLI=4: PLC_KEY, PM_KEY, CT_KEY cùng không trả lời');
      break;
    case 'X':
      out.set('multi_slave_lost', `LCLI=X: PCON=${h.plcOnline ? 1 : 0}, MCON=${h.pmOnline ? 1 : 0} — hai slave không trả lời`);
      break;
  }
  if (ptimStale(h, now)) out.set('logo_lost', `PCON=1 nhưng PTIM không đổi từ ${new Date(h.deviceTimeChangedAt!).toISOString()}`);
  if (dhMeterLost(h)) out.set('dh_meter_lost', 'MCON=1 nhưng U/I/P đều = 0');
  if (phaseLoss(h)) out.set('phase_loss', `U pha: L1 ${n(h.vL1)} V · L2 ${n(h.vL2)} V · L3 ${n(h.vL3)} V`);
  if (h.tempSensorFault && !ctLost(h.busStatus)) out.set('temp_sensor_fault', 'CTTE=1000: CT_KEY không đọc được DS18B20');
  if (!h.gpsDevice && h.lastBootAt && now - Date.parse(h.lastBootAt) > GPS_GRACE_MS) out.set('gps_nofix', 'LGPS=X quá 10 phút sau khởi động');
  if (h.fwProfile === 'v2-1307ebc') out.set('fw_unsafe', 'Firmware 1307ebc (frame không có LQ2/LQ3/PMAN): web chặn điều khiển');
  return out;
}

/** Spec section 6. `criticalActive` = any critical alarm open for this cabinet. */
export function deriveCabinetStatus(h: Pick<HealthInput, 'online' | 'plcOnline' | 'branch1On' | 'branch2On'>, criticalActive: boolean): CabinetStatus {
  if (!h.online) return 'offline';
  if (criticalActive) return 'fault';
  if (h.plcOnline === false || h.branch1On === null) return 'unknown';
  return h.branch1On || h.branch2On ? 'on' : 'off';
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('vi-VN', { hour12: false, timeZone: 'Asia/Ho_Chi_Minh' }) : '—');

/** Per-subsystem view for the "Chẩn đoán lỗi" tab. */
export function buildDiagnostics(h: HealthInput, now = Date.now()): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];
  const add = (subsystem: string, role: string, status: DiagnosticItem['status'], code: string | null, evidence: string, detail: string) =>
    items.push({ subsystem, role, status, code, evidence, detail });
  const stale = !h.online;
  const unknown = (subsystem: string, role: string) => add(subsystem, role, 'unknown', null, 'Tủ mất kết nối', 'Hiển thị lại khi tủ có kết nối.');

  if (!h.online) add('Kết nối 4G / máy chủ', 'LTE ↔ broker MQTT', 'fault', 'E101', `Frame cuối ${fmt(h.lastSeenAt)}`, 'Không nhận telemetry quá 60 s.');
  else if (h.bootsLastHour >= FLAPPING_BOOTS_PER_HOUR) add('Kết nối 4G / máy chủ', 'LTE ↔ broker MQTT', 'warn', 'E103', `${h.bootsLastHour} lần khởi động / 1 h`, 'Kết nối chập chờn hoặc nguồn không ổn định.');
  else add('Kết nối 4G / máy chủ', 'LTE ↔ broker MQTT', 'ok', null, `Frame cuối ${fmt(h.lastSeenAt)}`, 'Đang gửi telemetry bình thường.');

  if (stale) unknown('Bus RS485', 'LTE ↔ PLC / PM / CT');
  else if (h.busStatus === '4') add('Bus RS485', 'LTE ↔ PLC / PM / CT', 'fault', 'E204', 'LCLI=4', 'Cả 3 slave không trả lời — nghi lỗi bus phía LTE. Chạy tự kiểm tra RS485.');
  else if (h.busStatus === 'X') add('Bus RS485', 'LTE ↔ PLC / PM / CT', 'fault', 'E205', 'LCLI=X', 'Hai slave không trả lời.');
  else if (h.busStatus === '0') add('Bus RS485', 'LTE ↔ PLC / PM / CT', 'ok', null, 'LCLI=0', 'Cả 3 slave đều trả lời.');
  else if (h.busStatus) add('Bus RS485', 'LTE ↔ PLC / PM / CT', 'warn', null, `LCLI=${h.busStatus}`, 'Bus chạy nhưng có 1 slave không trả lời.');
  else add('Bus RS485', 'LTE ↔ PLC / PM / CT', 'unknown', null, 'LCLI=?', 'Chưa nhận LCLI.');

  if (stale) unknown('PLC_KEY (slave 4)', 'Cầu nối LTE ↔ LOGO');
  else if (h.plcOnline === false) add('PLC_KEY (slave 4)', 'Cầu nối LTE ↔ LOGO', 'fault', 'E201', 'PCON=0', 'Không biết trạng thái nhánh, không gửi được lệnh.');
  else add('PLC_KEY (slave 4)', 'Cầu nối LTE ↔ LOGO', 'ok', null, 'PCON=1', 'Đang trả lời.');

  if (stale || h.plcOnline !== true) add('LOGO (qua module ETH)', 'PLC_KEY ↔ LOGO, Modbus TCP', 'unknown', null, 'PTIM=X', 'Cần PLC_KEY trả lời mới đánh giá được.');
  else if (ptimStale(h, now)) add('LOGO (qua module ETH)', 'PLC_KEY ↔ LOGO, Modbus TCP', 'fault', 'E301', `PTIM đứng ở ${fmt(h.deviceTime)}`, 'PLC_KEY không đọc được LOGO; LQ2/LQ3 là giá trị cũ.');
  else add('LOGO (qua module ETH)', 'PLC_KEY ↔ LOGO, Modbus TCP', 'ok', null, `PTIM ${fmt(h.deviceTime)}`, 'Giờ LOGO đang cập nhật.');

  if (stale) unknown('PM_KEY (slave 3)', 'Cầu nối LTE ↔ đồng hồ DH');
  else if (h.pmOnline === false) add('PM_KEY (slave 3)', 'Cầu nối LTE ↔ đồng hồ DH', 'fault', 'E202', 'MCON=0', 'Không có số liệu điện năng.');
  else add('PM_KEY (slave 3)', 'Cầu nối LTE ↔ đồng hồ DH', 'ok', null, 'MCON=1', 'Đang trả lời.');

  if (stale || h.pmOnline !== true) add('Đồng hồ điện DH', 'Đo U / I / P 3 pha', 'unknown', null, 'MCON=0', 'Cần PM_KEY trả lời mới đánh giá được.');
  else if (dhMeterLost(h)) add('Đồng hồ điện DH', 'Đo U / I / P 3 pha', 'fault', 'E401', 'MCON=1, U=I=P=0', 'PM_KEY không đọc được đồng hồ DH hoặc mất điện lưới.');
  else if (phaseLoss(h)) add('Đồng hồ điện DH', 'Đo U / I / P 3 pha', 'fault', 'E402', `L1 ${n(h.vL1)} V · L2 ${n(h.vL2)} V · L3 ${n(h.vL3)} V`, 'Mất pha.');
  else add('Đồng hồ điện DH', 'Đo U / I / P 3 pha', 'ok', null, `L1 ${n(h.vL1)} V · L2 ${n(h.vL2)} V · L3 ${n(h.vL3)} V`, 'Số liệu hợp lệ.');

  if (stale) unknown('CT_KEY (slave 2)', 'Dòng rò + nhiệt độ tủ');
  else if (ctLost(h.busStatus)) add('CT_KEY (slave 2)', 'Dòng rò + nhiệt độ tủ', 'fault', 'E203', `LCLI=${h.busStatus}`, 'Không có dòng rò và nhiệt độ tủ.');
  else add('CT_KEY (slave 2)', 'Dòng rò + nhiệt độ tủ', 'ok', null, `CTVL=${h.leakMa ?? 'X'} mA`, 'Đang trả lời.');

  if (stale || ctLost(h.busStatus)) add('Cảm biến nhiệt DS18B20', 'Nhiệt độ trong tủ', 'unknown', null, 'CTTE=X', 'Cần CT_KEY trả lời mới đánh giá được.');
  else if (h.tempSensorFault) add('Cảm biến nhiệt DS18B20', 'Nhiệt độ trong tủ', 'fault', 'E503', 'CTTE=1000', 'Đứt dây OneWire hoặc cảm biến hỏng.');
  else add('Cảm biến nhiệt DS18B20', 'Nhiệt độ trong tủ', 'ok', null, `CTTE=${h.tempC ?? 'X'} °C`, 'Đang đọc được.');

  if (stale) unknown('GPS', 'Định vị GNSS của EC25');
  else if (!h.gpsDevice) add('GPS', 'Định vị GNSS của EC25', 'warn', 'E801', 'LGPS=X', 'Chưa có fix GNSS.');
  else add('GPS', 'Định vị GNSS của EC25', 'ok', null, `${h.gpsDevice.lat.toFixed(5)}, ${h.gpsDevice.lng.toFixed(5)}`, 'Có fix.');

  if (h.batteryMv !== null && h.batteryMv < 3600) add('Pin dự phòng', 'Nguồn dự phòng bộ điều khiển', 'warn', 'E803', `LBAT=${h.batteryMv} mV`, 'Pin yếu.');
  else add('Pin dự phòng', 'Nguồn dự phòng bộ điều khiển', h.batteryMv === null ? 'unknown' : 'ok', null, `LBAT=${h.batteryMv ?? 'X'} mV`, h.batteryMv === null ? 'Chưa có số liệu.' : 'Bình thường.');

  if (h.fwProfile === 'v2-1307ebc') add('Firmware LTE', 'Phiên bản / an toàn lệnh', 'warn', 'E804', 'v2-1307ebc', 'Không lọc LTID — web chặn điều khiển.');
  else add('Firmware LTE', 'Phiên bản / an toàn lệnh', 'ok', null, h.fwProfile, 'Có lọc LTID, hỗ trợ PMAN/PLN.');

  add('Cửa tủ / contactor', 'PDOR / PFLT từ LOGO', 'unsupported', null, 'TELE_SEND_DOOR_FAULT 0', 'Firmware chưa gửi — sẽ có khi bật cờ.');
  return items;
}
