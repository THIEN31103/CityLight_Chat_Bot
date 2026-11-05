import { describe, expect, it } from 'vitest';
import { assignableRoles, canManageRole, hasPermission, roleRequires2fa, roleSeesAll, userCan } from '../src';

describe('role hierarchy (S47)', () => {
  it('provider manages every role, including other provider accounts', () => {
    expect(assignableRoles('admin')).toEqual(['admin', 'manager', 'operator', 'viewer', 'maintenance']);
  });
  it('manager hands out only roles below itself: no manager, no provider', () => {
    expect(assignableRoles('manager')).toEqual(['operator', 'viewer', 'maintenance']);
    expect(canManageRole('manager', 'manager')).toBe(false);
    expect(canManageRole('manager', 'admin')).toBe(false);
  });
  it('operator / viewer / maintenance manage nobody they could matter to', () => {
    expect(assignableRoles('operator')).toEqual(['viewer', 'maintenance']); // and they have no admin.users anyway
    expect(assignableRoles('viewer')).toEqual([]);
  });
});

describe('cabinet approval', () => {
  it('comes with the admin and manager roles', () => {
    expect(userCan({ role: 'admin', canEnroll: false }, 'device.enroll')).toBe(true);
    expect(userCan({ role: 'manager', canEnroll: false }, 'device.enroll')).toBe(true);
  });
  it('is refused to other roles unless the account was granted it', () => {
    for (const role of ['operator', 'viewer', 'maintenance'] as const) {
      expect(userCan({ role, canEnroll: false }, 'device.enroll')).toBe(false);
      expect(userCan({ role, canEnroll: true }, 'device.enroll')).toBe(true);
    }
  });
  it('grants nothing else: no registration admin, no user management', () => {
    const installer = { role: 'viewer', canEnroll: true } as const;
    for (const p of ['admin.devices', 'admin.users', 'cabinet.control', 'device.identity'] as const) expect(userCan(installer, p)).toBe(false);
  });
});

describe('manager permissions (S47)', () => {
  it('runs the customer side: users, catalog, cabinet registration, control', () => {
    for (const p of ['admin.users', 'admin.catalog', 'admin.devices', 'cabinet.control', 'batch.run', 'log.view', 'map.edit'] as const) expect(hasPermission('manager', p)).toBe(true);
  });
  it('not the provider-only parts: IMEI identity / field map, server health', () => {
    expect(hasPermission('manager', 'device.identity')).toBe(false);
    expect(hasPermission('manager', 'system.view')).toBe(false);
    expect(hasPermission('admin', 'device.identity')).toBe(true);
  });
  it('needs 2FA and sees every cabinet', () => {
    expect(roleRequires2fa('manager')).toBe(true);
    expect(roleSeesAll('manager')).toBe(true);
    expect(roleSeesAll('operator')).toBe(false);
  });
});
