// Incident workflow (spec S7–S9, M7), shared by the API (enforced) and the web (buttons).
import type { AlarmType, IncidentStatus } from './domain';
import type { Permission } from './permissions';

export interface IncidentTransition {
  to: IncidentStatus;
  label: string;
  perm: Extract<Permission, 'incident.manage' | 'incident.resolve'>;
  /** assign = needs assignee + deadline; resolve = needs the resolution text */
  needs?: 'assign' | 'resolve';
}

export const INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentTransition[]> = {
  new: [
    { to: 'assigned', label: 'Giao xử lý', perm: 'incident.manage', needs: 'assign' },
    { to: 'deferred', label: 'Chưa cần xử lý', perm: 'incident.manage' },
  ],
  assigned: [{ to: 'resolved', label: 'Báo đã xử lý', perm: 'incident.resolve', needs: 'resolve' }],
  deferred: [{ to: 'assigned', label: 'Giao xử lý', perm: 'incident.manage', needs: 'assign' }],
  resolved: [
    { to: 'closed', label: 'Đóng sự cố', perm: 'incident.manage' },
    { to: 'assigned', label: 'Yêu cầu xử lý lại', perm: 'incident.manage', needs: 'assign' },
  ],
  closed: [{ to: 'new', label: 'Mở lại', perm: 'incident.manage' }],
};

export function findTransition(from: IncidentStatus, to: IncidentStatus): IncidentTransition | null {
  return INCIDENT_TRANSITIONS[from].find((t) => t.to === to) ?? null;
}

/** Statuses of an incident someone still has to deal with. */
export const OPEN_INCIDENT_STATUSES: readonly IncidentStatus[] = ['new', 'assigned', 'deferred'];

export const INCIDENT_CATEGORIES = [
  'Đèn tắt', 'Đèn sáng ban ngày', 'Mất kết nối tủ', 'Mất điện / mất pha', 'Rò điện', 'Tủ hư hỏng', 'Chập điện',
  'Mất cáp', 'Trụ nghiêng', 'Khác',
] as const;

/** Category suggested when an incident is opened from an alarm. */
export function categoryForAlarm(type: AlarmType): (typeof INCIDENT_CATEGORIES)[number] {
  switch (type) {
    case 'offline':
    case 'flapping':
      return 'Mất kết nối tủ';
    case 'phase_loss':
    case 'under_voltage':
    case 'dh_meter_lost':
      return 'Mất điện / mất pha';
    case 'leak_current':
      return 'Rò điện';
    case 'schedule_mismatch':
      return 'Đèn sáng ban ngày';
    case 'no_load':
    case 'cmd_unconfirmed':
      return 'Đèn tắt';
    case 'over_current':
      return 'Chập điện';
    default:
      return 'Tủ hư hỏng';
  }
}

/** Overdue = assigned and the deadline has passed (map KPI, list, report, reminders). */
export function incidentOverdue(i: { status: IncidentStatus; deadline: string | null }, now = Date.now()): boolean {
  return i.status === 'assigned' && !!i.deadline && Date.parse(i.deadline) < now;
}
