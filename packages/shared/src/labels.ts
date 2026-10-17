import type { AlarmSeverity, AlarmType, CabinetStatus, CommandStatus, CommandType, IncidentStatus } from './domain';

export const STATUS_LABELS: Record<CabinetStatus, string> = {
  offline: 'Mất kết nối',
  fault: 'Lỗi',
  dimming: 'Tiết giảm',
  on: 'Sáng đèn',
  off: 'Nghỉ',
  unknown: 'Không xác định',
};

export const ALARM_TYPE_LABELS: Record<AlarmType, string> = {
  offline: 'Mất kết nối',
  plc_lost: 'Mất kết nối PLC',
  pm_lost: 'Mất đồng hồ điện',
  ct_lost: 'Mất cảm biến CT',
  over_voltage: 'Quá áp',
  under_voltage: 'Thấp áp',
  voltage_swing: 'Dao động điện áp',
  over_current: 'Quá dòng',
  no_load: 'Không tải',
  leak_current: 'Rò dòng',
  over_temp: 'Nhiệt độ tủ cao',
  clock_drift: 'Sai giờ TĐK',
  schedule_mismatch: 'Lệch lịch',
  battery_low: 'Pin yếu',
  gps_drift: 'Lệch vị trí GPS',
  door_open: 'Mở cửa tủ',
  contactor_fault: 'Lỗi contactor',
};

export const SEVERITY_LABELS: Record<AlarmSeverity, string> = {
  critical: 'Nghiêm trọng',
  major: 'Cao',
  minor: 'Thấp',
};

export const COMMAND_TYPE_LABELS: Record<CommandType, string> = {
  MANUAL_ALL: 'Bật/tắt toàn tủ',
  MANUAL_BRANCH: 'Bật/tắt nhánh',
  AUTO: 'Về chế độ tự động',
  SET_SCHEDULE: 'Đặt lịch',
  SET_TIME: 'Đồng bộ giờ',
  PULSE_ON: 'Xung bật tay',
  DIAG: 'Tự kiểm tra RS485',
  SET_DIMMING: 'Đặt tiết giảm',
  LAMP_CONTROL: 'Điều khiển đèn',
};

export const COMMAND_STATUS_LABELS: Record<CommandStatus, string> = {
  queued: 'Đang chờ',
  sent: 'Đã gửi',
  acked: 'Tủ đã nhận',
  confirmed: 'Đã xác nhận',
  acked_unconfirmed: 'Đã nhận, chưa thấy đổi',
  failed: 'Lỗi',
  timeout: 'Quá thời gian',
  cancelled: 'Đã hủy',
};

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  new: 'Chưa xử lý',
  assigned: 'Yêu cầu xử lý',
  deferred: 'Chưa cần xử lý',
  resolved: 'Đã xử lý',
  closed: 'Đã đóng',
};

/** Minutes from 00:00 of the switch-on day (may exceed 1440) -> "HH:MM". */
export function minutesToHhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Human-readable description of a command; the raw device frame is never shown in the UI. */
export function describeCommand(type: CommandType, params: Record<string, unknown>): string {
  const onOff = (v: unknown) => (v ? 'Bật' : 'Tắt');
  switch (type) {
    case 'MANUAL_ALL':
      return `${onOff(params.on)} toàn tủ (thủ công)`;
    case 'MANUAL_BRANCH':
      return `${onOff(params.on)} nhánh ${params.branch} (thủ công)`;
    case 'AUTO':
      return 'Về chế độ tự động theo lịch';
    case 'SET_TIME':
      return 'Đồng bộ thời gian với máy chủ';
    case 'SET_SCHEDULE': {
      const p = params as { mode?: number; on1?: string; off1?: string; on2?: string; off2?: string };
      return p.mode === 2 ? `Đặt lịch Chế độ 2: N1 ${p.on1}–${p.off1}, N2 ${p.on2}–${p.off2}` : `Đặt lịch Chế độ 1: ${p.on1}–${p.off1}`;
    }
    default:
      return COMMAND_TYPE_LABELS[type];
  }
}
