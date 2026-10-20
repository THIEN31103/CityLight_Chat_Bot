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
  /** provider only (S47): cabinet IMEI identity (anti-spoofing) and the telemetry field map */
  | 'device.identity'
  /** provider only (S47): server / broker / database health */
  | 'system.view';

const ALL: Permission[] = [
  'map.view', 'map.edit', 'cabinet.control', 'cabinet.configure', 'alarm.view', 'alarm.ack',
  'incident.view', 'incident.manage', 'incident.resolve', 'schedule.manage', 'dimming.manage',
  'batch.run', 'log.view', 'admin.users', 'admin.catalog', 'admin.devices', 'device.identity', 'system.view',
];

const OPERATOR: Permission[] = [
  'map.view', 'cabinet.control', 'cabinet.configure', 'alarm.view', 'alarm.ack', 'incident.view',
  'incident.manage', 'schedule.manage', 'dimming.manage', 'batch.run', 'log.view',
];

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  admin: ALL,
  // the customer's top account (S47): everything an operator does + its own users, catalog, cabinet registration
  manager: [...OPERATOR, 'map.edit', 'incident.resolve', 'admin.users', 'admin.catalog', 'admin.devices'],
  operator: OPERATOR,
  viewer: ['map.view', 'alarm.view', 'incident.view'],
  maintenance: ['map.view', 'alarm.view', 'incident.view', 'incident.resolve'],
};

export function hasPermission(role: RoleKey, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm);
}

/** Roles that can switch lights need 2FA (spec 13). The server may relax this with AUTH_REQUIRE_2FA=false. */
export function roleRequires2fa(role: RoleKey): boolean {
  return hasPermission(role, 'cabinet.control');
}

/** Provider (admin) and the customer's manager always see every cabinet; area scopes do not apply. */
export function roleSeesAll(role: RoleKey): boolean {
  return role === 'admin' || role === 'manager';
}

/** Hierarchy (S47): provider > manager > operator > viewer = maintenance. */
export const ROLE_RANK: Record<RoleKey, number> = { admin: 4, manager: 3, operator: 2, viewer: 1, maintenance: 1 };

/**
 * Whether `actor` may create / edit / reset / unlock an account of role `target`, or hand out that role.
 * The provider manages everyone (incl. other provider accounts); anyone else only roles strictly below their own,
 * so a manager cannot create another manager or touch a provider account.
 */
export function canManageRole(actor: RoleKey, target: RoleKey): boolean {
  return actor === 'admin' || ROLE_RANK[target] < ROLE_RANK[actor];
}

/** Roles `actor` may give out, in display order. */
export function assignableRoles(actor: RoleKey): RoleKey[] {
  return (Object.keys(ROLE_RANK) as RoleKey[]).filter((r) => canManageRole(actor, r));
}
