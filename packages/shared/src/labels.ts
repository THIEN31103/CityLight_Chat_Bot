import type { AlarmSeverity, AlarmType, CabinetStatus, CommandStatus, CommandType, IncidentStatus, RoleKey } from './domain';
import { errorCatalog } from './errors';
import { defineDict, type Lang } from './i18n';

/** Enum labels in both languages (S49). The *_LABELS constants below are the Vietnamese ones (server side). */
export const LABELS = defineDict(
  {
    status: {
      offline: 'Mất kết nối',
      fault: 'Lỗi',
      dimming: 'Tiết giảm',
      on: 'Sáng đèn',
      off: 'Nghỉ',
      unknown: 'Không xác định',
    } as Record<CabinetStatus, string>,
    severity: {
      critical: 'Nghiêm trọng',
      major: 'Cao',
      minor: 'Thấp',
    } as Record<AlarmSeverity, string>,
    commandType: {
      MANUAL_ALL: 'Bật/tắt toàn tủ',
      MANUAL_BRANCH: 'Bật/tắt nhánh',
      AUTO: 'Về chế độ tự động',
      SET_SCHEDULE: 'Đặt lịch',
      SET_TIME: 'Đồng bộ giờ',
      PULSE_ON: 'Xung bật tay',
      DIAG: 'Tự kiểm tra RS485',
      SET_DIMMING: 'Đặt tiết giảm',
      LAMP_CONTROL: 'Điều khiển đèn',
    } as Record<CommandType, string>,
    commandStatus: {
      queued: 'Đang chờ',
      sent: 'Đã gửi',
      acked: 'Tủ đã nhận',
      confirmed: 'Đã xác nhận',
      acked_unconfirmed: 'Đã nhận, chưa thấy đổi',
      failed: 'Lỗi',
      timeout: 'Quá thời gian',
      cancelled: 'Đã hủy',
    } as Record<CommandStatus, string>,
    incidentStatus: {
      new: 'Chưa xử lý',
      assigned: 'Yêu cầu xử lý',
      deferred: 'Chưa cần xử lý',
      resolved: 'Đã xử lý',
      closed: 'Đã đóng',
    } as Record<IncidentStatus, string>,
    role: {
      admin: 'Nhà cung cấp',
      manager: 'Quản lý',
      operator: 'Điều hành',
      viewer: 'Giám sát',
      maintenance: 'Đội duy tu',
    } as Record<RoleKey, string>,
    command: {
      on: 'Bật',
      off: 'Tắt',
      all: '{onOff} toàn tủ (thủ công)',
      branch: '{onOff} nhánh {branch} (thủ công)',
      auto: 'Về chế độ tự động theo lịch',
      time: 'Đồng bộ thời gian với máy chủ',
      schedule1: 'Đặt lịch Chế độ 1: {on1}–{off1}',
      schedule2: 'Đặt lịch Chế độ 2: N1 {on1}–{off1}, N2 {on2}–{off2}',
    },
  },
  {
    status: { offline: 'Offline', fault: 'Fault', dimming: 'Dimming', on: 'Lights on', off: 'Off', unknown: 'Unknown' },
    severity: { critical: 'Critical', major: 'High', minor: 'Low' },
    commandType: {
      MANUAL_ALL: 'Whole cabinet on/off',
      MANUAL_BRANCH: 'Branch on/off',
      AUTO: 'Back to automatic',
      SET_SCHEDULE: 'Set schedule',
      SET_TIME: 'Time sync',
      PULSE_ON: 'Manual-on pulse',
      DIAG: 'RS485 self-test',
      SET_DIMMING: 'Set dimming',
      LAMP_CONTROL: 'Lamp control',
    },
    commandStatus: {
      queued: 'Queued',
      sent: 'Sent',
      acked: 'Received by cabinet',
      confirmed: 'Confirmed',
      acked_unconfirmed: 'Received, no change seen',
      failed: 'Failed',
      timeout: 'Timed out',
      cancelled: 'Cancelled',
    },
    incidentStatus: { new: 'Open', assigned: 'Assigned', deferred: 'Deferred', resolved: 'Resolved', closed: 'Closed' },
    role: { admin: 'Provider', manager: 'Manager', operator: 'Operator', viewer: 'Viewer', maintenance: 'Maintenance crew' },
    command: {
      on: 'On',
      off: 'Off',
      all: 'Whole cabinet {onOff} (manual)',
      branch: 'Branch {branch} {onOff} (manual)',
      auto: 'Back to automatic (schedule)',
      time: 'Sync time with the server',
      schedule1: 'Schedule mode 1: {on1}–{off1}',
      schedule2: 'Schedule mode 2: B1 {on1}–{off1}, B2 {on2}–{off2}',
    },
  },
);

export const STATUS_LABELS = LABELS.vi.status;
export const SEVERITY_LABELS = LABELS.vi.severity;
export const COMMAND_TYPE_LABELS = LABELS.vi.commandType;
export const COMMAND_STATUS_LABELS = LABELS.vi.commandStatus;
export const INCIDENT_STATUS_LABELS = LABELS.vi.incidentStatus;

/** Alarm type -> title, from the error catalog of that language. */
export const alarmTypeLabels = (lang: Lang) => Object.fromEntries(errorCatalog(lang).map((e) => [e.type, e.title])) as Record<AlarmType, string>;
export const ALARM_TYPE_LABELS = alarmTypeLabels('vi');

/** Minutes from 00:00 of the switch-on day (may exceed 1440) -> "HH:MM". */
export function minutesToHhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Human-readable description of a command; the raw device frame is never shown in the UI. */
export function describeCommand(type: CommandType, params: Record<string, unknown>, lang: Lang = 'vi'): string {
  const L = LABELS[lang];
  const f = (s: string, v: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (v[k] === undefined ? m : String(v[k])));
  const onOff = (v: unknown) => (lang === 'en' ? (v ? L.command.on : L.command.off).toLowerCase() : v ? L.command.on : L.command.off);
  switch (type) {
    case 'MANUAL_ALL':
      return f(L.command.all, { onOff: onOff(params.on) });
    case 'MANUAL_BRANCH':
      return f(L.command.branch, { onOff: onOff(params.on), branch: params.branch });
    case 'AUTO':
      return L.command.auto;
    case 'SET_TIME':
      return L.command.time;
    case 'SET_SCHEDULE': {
      const p = params as { mode?: number; on1?: string; off1?: string; on2?: string; off2?: string };
      return f(p.mode === 2 ? L.command.schedule2 : L.command.schedule1, p);
    }
    default:
      return L.commandType[type];
  }
}
