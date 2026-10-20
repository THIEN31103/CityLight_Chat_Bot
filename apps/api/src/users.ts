// User administration (spec 8 S16, permission admin.users; hierarchy S47: see assertCanManage). No email service yet: new users and password
// resets get a temporary password shown once to the admin; the user must change it at first sign-in.
import { randomInt } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, Patch, Post, Req } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { z } from 'zod';
import type { RoleKey, User } from '@citylight/shared';
import { ROLE_LABELS, canManageRole, roleRequires2fa, roleSeesAll } from '@citylight/shared';
import { AuthModule, AuthService, RequirePerm, RequireReauth, require2faEnforced, type AuthedRequest, type SessionUser } from './auth';
import { ApiError } from './errors';
import { SQL, type Sql } from './infra';

const ROLES = ['admin', 'manager', 'operator', 'viewer', 'maintenance'] as const;

/**
 * Hierarchy (S47): only the provider (admin) manages accounts of its own rank or above; everyone else only roles
 * strictly below their own (a manager cannot create a manager or touch a provider account).
 */
function assertCanManage(actor: SessionUser, target: RoleKey, what: 'account' | 'role') {
  if (canManageRole(actor.role, target)) return;
  throw what === 'role'
    ? new ApiError(403, 'role_forbidden', `Không được cấp vai trò "${ROLE_LABELS[target]}"`)
    : new ApiError(403, 'user_forbidden', `Không được thay đổi tài khoản vai trò "${ROLE_LABELS[target]}"`);
}
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const tempPassword = () => Array.from({ length: 14 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join('');

const CreateBody = z.object({
  email: z.string().email().max(200),
  fullName: z.string().trim().min(1).max(120),
  role: z.enum(ROLES).default('viewer'),
  scopeAll: z.boolean().default(false),
  scopeAreaIds: z.array(z.string().uuid()).max(500).default([]),
});
const PatchBody = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  scopeAll: z.boolean().optional(),
  scopeAreaIds: z.array(z.string().uuid()).max(500).optional(),
});

interface ListRow {
  id: string; email: string; full_name: string; role: RoleKey; scope_all: boolean; totp_enabled: boolean;
  password_change_required: boolean; active: boolean; last_login_at: Date | null; locked_until: Date | null; areas: string[];
}

@Injectable()
export class UsersService {
  constructor(@Inject(SQL) private readonly sql: Sql, @Inject(AuthService) private readonly auth: AuthService) {}

  private toUser(r: ListRow, actor?: RoleKey): User & { lockedUntil: string | null; manageable: boolean } {
    return {
      id: r.id, email: r.email, fullName: r.full_name, role: r.role,
      scopeAll: roleSeesAll(r.role) || r.scope_all, scopeAreaIds: r.areas,
      totpEnabled: r.totp_enabled, totpRequired: require2faEnforced() && roleRequires2fa(r.role),
      passwordChangeRequired: r.password_change_required, active: r.active,
      lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
      lockedUntil: r.locked_until && r.locked_until.getTime() > Date.now() ? r.locked_until.toISOString() : null,
      // provider accounts stay listed for a manager (who has access to their system), read-only
      manageable: actor ? canManageRole(actor, r.role) : true,
    };
  }

  async list(orgId: string, id?: string, actor?: RoleKey) {
    const rows = await this.sql<ListRow[]>`
      SELECT u.id, u.email, u.full_name, u.role, u.scope_all, u.totp_enabled, u.password_change_required, u.active, u.last_login_at, u.locked_until,
             coalesce(array_agg(s.area_id::text) FILTER (WHERE s.area_id IS NOT NULL), '{}') AS areas
      FROM users u LEFT JOIN user_scopes s ON s.user_id = u.id
      WHERE u.organization_id = ${orgId} AND (${id ?? null}::uuid IS NULL OR u.id = ${id ?? null})
      GROUP BY u.id ORDER BY u.full_name`;
    return rows.map((r) => this.toUser(r, actor));
  }

  private async one(orgId: string, id: string) {
    const u = (await this.list(orgId, id))[0];
    if (!u) throw new ApiError(404, 'not_found', 'Không tìm thấy người dùng');
    return u;
  }

  private async assertAreas(orgId: string, ids: string[]) {
    if (!ids.length) return;
    const n = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM areas WHERE organization_id = ${orgId} AND id = ANY(${this.sql.array(ids)}::uuid[])`;
    if (n[0]!.n !== new Set(ids).size) throw new ApiError(422, 'invalid_area', 'Có khu vực không tồn tại');
  }

  private async activeAdmins(orgId: string) {
    const r = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE organization_id = ${orgId} AND role = 'admin' AND active`;
    return r[0]!.n;
  }

  async create(admin: SessionUser, body: unknown, ip?: string) {
    const b = CreateBody.parse(body);
    assertCanManage(admin, b.role, 'role');
    await this.assertAreas(admin.organizationId, b.scopeAreaIds);
    const taken = await this.sql`SELECT 1 FROM users WHERE lower(email) = lower(${b.email})`;
    if (taken.length) throw new ApiError(409, 'email_taken', 'Email đã được dùng');
    const pw = tempPassword();
    const pwHash = await hash(pw);
    const id = await this.sql.begin(async (tx) => {
      const r = await tx<{ id: string }[]>`
        INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all, password_change_required)
        VALUES (${admin.organizationId}, ${b.email.trim()}, ${b.fullName}, ${pwHash}, ${b.role}, ${b.scopeAll}, true) RETURNING id`;
      for (const a of new Set(b.scopeAreaIds)) await tx`INSERT INTO user_scopes (user_id, area_id) VALUES (${r[0]!.id}, ${a})`;
      return r[0]!.id;
    });
    const summary = `${b.role}${b.scopeAll ? ', toàn hệ thống' : `, ${b.scopeAreaIds.length} khu vực`}`;
    await this.auth.log(admin, 'Tạo người dùng', ip, { type: 'user', id, name: b.email }, summary);
    await this.auth.securityAlert('user_created', { id, email: b.email }, { ip, by: admin.email, detail: summary });
    return { user: await this.one(admin.organizationId, id), tempPassword: pw };
  }

  async update(admin: SessionUser, id: string, body: unknown, ip?: string) {
    const uid = z.string().uuid().parse(id);
    const b = PatchBody.parse(body);
    const before = await this.one(admin.organizationId, uid);
    const self = uid === admin.id;
    if (self && (b.role !== undefined || b.active !== undefined || b.scopeAll !== undefined || b.scopeAreaIds !== undefined))
      throw new ApiError(409, 'self_change', 'Không tự đổi vai trò, phạm vi hay trạng thái của chính mình');
    if (!self) assertCanManage(admin, before.role, 'account');
    if (b.role) assertCanManage(admin, b.role, 'role');
    const losesAdmin = before.role === 'admin' && before.active && ((b.role && b.role !== 'admin') || b.active === false);
    if (losesAdmin && (await this.activeAdmins(admin.organizationId)) <= 1) throw new ApiError(409, 'last_admin', 'Phải còn ít nhất một quản trị viên đang hoạt động');
    if (b.scopeAreaIds) await this.assertAreas(admin.organizationId, b.scopeAreaIds);

    await this.sql.begin(async (tx) => {
      await tx`UPDATE users SET
        full_name = coalesce(${b.fullName ?? null}, full_name),
        role = coalesce(${b.role ?? null}::role, role),
        active = coalesce(${b.active ?? null}::boolean, active),
        scope_all = coalesce(${b.scopeAll ?? null}::boolean, scope_all)
        WHERE id = ${uid}`;
      if (b.scopeAreaIds) {
        await tx`DELETE FROM user_scopes WHERE user_id = ${uid}`;
        for (const a of new Set(b.scopeAreaIds)) await tx`INSERT INTO user_scopes (user_id, area_id) VALUES (${uid}, ${a})`;
      }
    });

    const after = await this.one(admin.organizationId, uid);
    const sameScope = before.scopeAll === after.scopeAll && [...before.scopeAreaIds].sort().join() === [...after.scopeAreaIds].sort().join();
    const accessChanged = before.role !== after.role || before.active !== after.active || !sameScope;
    if (accessChanged) await this.auth.revokeUser(uid);
    else await this.auth.userChanged(uid);

    const changes = [
      before.fullName !== after.fullName && `tên: ${after.fullName}`,
      before.role !== after.role && `vai trò: ${before.role} → ${after.role}`,
      before.active !== after.active && (after.active ? 'mở khóa tài khoản' : 'khóa tài khoản'),
      !sameScope && (after.scopeAll ? 'phạm vi: toàn hệ thống' : `phạm vi: ${after.scopeAreaIds.length} khu vực`),
    ].filter(Boolean).join('; ');
    if (changes) await this.auth.log(admin, 'Sửa người dùng', ip, { type: 'user', id: uid, name: after.email }, changes);
    if (before.role !== after.role) await this.auth.securityAlert('role_changed', after, { ip, by: admin.email, detail: `${before.role} → ${after.role}` });
    if (before.active && !after.active) await this.auth.securityAlert('user_disabled', after, { ip, by: admin.email });
    return after;
  }

  async resetPassword(admin: SessionUser, id: string, ip?: string) {
    const u = await this.one(admin.organizationId, z.string().uuid().parse(id));
    if (u.id === admin.id) throw new ApiError(409, 'self_change', 'Dùng trang Tài khoản để đổi mật khẩu của chính mình');
    assertCanManage(admin, u.role, 'account');
    const pw = tempPassword();
    await this.sql`UPDATE users SET password_hash = ${await hash(pw)}, password_change_required = true, failed_logins = 0, locked_until = NULL WHERE id = ${u.id}`;
    await this.auth.revokeUser(u.id);
    await this.auth.log(admin, 'Đặt lại mật khẩu', ip, { type: 'user', id: u.id, name: u.email });
    await this.auth.securityAlert('password_reset', u, { ip, by: admin.email });
    return { user: await this.one(admin.organizationId, u.id), tempPassword: pw };
  }

  async unlock(admin: SessionUser, id: string, ip?: string) {
    const u = await this.one(admin.organizationId, z.string().uuid().parse(id));
    assertCanManage(admin, u.role, 'account');
    await this.sql`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ${u.id}`;
    await this.auth.log(admin, 'Mở khóa đăng nhập', ip, { type: 'user', id: u.id, name: u.email });
    return this.one(admin.organizationId, u.id);
  }

  async reset2fa(admin: SessionUser, id: string, ip?: string) {
    const u = await this.one(admin.organizationId, z.string().uuid().parse(id));
    if (u.id === admin.id) throw new ApiError(409, 'self_change', 'Dùng trang Tài khoản để quản lý 2FA của chính mình');
    assertCanManage(admin, u.role, 'account');
    await this.auth.clear2fa(u.id);
    await this.auth.revokeUser(u.id);
    await this.auth.log(admin, 'Đặt lại 2FA', ip, { type: 'user', id: u.id, name: u.email });
    await this.auth.securityAlert('totp_reset', u, { ip, by: admin.email });
    return this.one(admin.organizationId, u.id);
  }
}

@Controller('users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly svc: UsersService) {}

  @Get() @RequirePerm('admin.users')
  list(@Req() r: AuthedRequest) { return this.svc.list(r.user!.organizationId, undefined, r.user!.role); }

  @Post() @RequirePerm('admin.users') @RequireReauth()
  create(@Req() r: AuthedRequest, @Body() body: unknown) { return this.svc.create(r.user!, body, r.ip); }

  @Patch(':id') @RequirePerm('admin.users') @RequireReauth()
  update(@Req() r: AuthedRequest, @Param('id') id: string, @Body() body: unknown) { return this.svc.update(r.user!, id, body, r.ip); }

  @Post(':id/reset-password') @HttpCode(200) @RequirePerm('admin.users') @RequireReauth()
  resetPassword(@Req() r: AuthedRequest, @Param('id') id: string) { return this.svc.resetPassword(r.user!, id, r.ip); }

  @Post(':id/unlock') @HttpCode(200) @RequirePerm('admin.users')
  unlock(@Req() r: AuthedRequest, @Param('id') id: string) { return this.svc.unlock(r.user!, id, r.ip); }

  @Post(':id/reset-2fa') @HttpCode(200) @RequirePerm('admin.users') @RequireReauth()
  reset2fa(@Req() r: AuthedRequest, @Param('id') id: string) { return this.svc.reset2fa(r.user!, id, r.ip); }
}

@Module({ imports: [AuthModule], controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}
