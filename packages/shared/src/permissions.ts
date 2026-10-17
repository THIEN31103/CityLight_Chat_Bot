import type { RoleKey } from './domain';

export type Permission =
  | 'map.view'
  | 'map.edit'
  | 'cabinet.control'
  | 'cabinet.configure'
  | 'alarm.view'
  | 'alarm.ack'
  | 'incident.view'
  | 'incident.manage'
  | 'incident.resolve'
  | 'schedule.manage'
  | 'dimming.manage'
  | 'batch.run'
  | 'log.view'
  | 'admin.users'
  | 'admin.catalog'
  | 'admin.devices'
  | 'system.view';

const ALL: Permission[] = [
  'map.view', 'map.edit', 'cabinet.control', 'cabinet.configure', 'alarm.view', 'alarm.ack',
  'incident.view', 'incident.manage', 'incident.resolve', 'schedule.manage', 'dimming.manage',
  'batch.run', 'log.view', 'admin.users', 'admin.catalog', 'admin.devices', 'system.view',
];

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  admin: ALL,
  operator: [
    'map.view', 'cabinet.control', 'cabinet.configure', 'alarm.view', 'alarm.ack', 'incident.view',
    'incident.manage', 'schedule.manage', 'dimming.manage', 'batch.run', 'log.view',
  ],
  viewer: ['map.view', 'alarm.view', 'incident.view'],
  maintenance: ['map.view', 'alarm.view', 'incident.view', 'incident.resolve'],
};

export function hasPermission(role: RoleKey, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm);
}
