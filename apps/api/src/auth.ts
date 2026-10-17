// Session auth (spec 13): argon2id password, random session id in an httpOnly SameSite=Lax cookie,
// lockout after 5 failed logins for 15 min. TOTP 2FA and CSRF tokens come in M2.
import { randomBytes } from 'node:crypto';
import {
  Body, CanActivate, Controller, ExecutionContext, Get, HttpCode, Inject, Injectable, Module, Post, Req, Res, SetMetadata,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { verify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RoleKey, User } from '@citylight/shared';
import { hasPermission, type Permission } from '@citylight/shared';
import { ApiError } from './errors';
import { SQL, type Sql } from './infra';

export const SESSION_COOKIE = 'cl_sid';
const SESSION_HOURS = 12;
const REMEMBER_DAYS = 30;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export const PUBLIC = 'cl:public';
export const Public = () => SetMetadata(PUBLIC, true);
export const PERM = 'cl:perm';
export const RequirePerm = (p: Permission) => SetMetadata(PERM, p);

export interface AuthedRequest extends FastifyRequest {
  user?: User & { organizationId: string };
}

interface UserRow {
  id: string;
  organization_id: string;
  email: string;
  full_name: string;
  role: RoleKey;
  totp_enabled: boolean;
  active: boolean;
  last_login_at: Date | null;
}

function toUser(r: UserRow, scopes: string[]): User & { organizationId: string } {
  return {
    id: r.id,
    organizationId: r.organization_id,
    email: r.email,
    fullName: r.full_name,
    role: r.role,
    scopeAreaIds: scopes,
    totpEnabled: r.totp_enabled,
    active: r.active,
    lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
  };
}

@Injectable()
export class AuthService {
  private cache = new Map<string, { user: User & { organizationId: string }; until: number }>();
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  async login(email: string, password: string, ip: string | undefined, ua: string | undefined, remember: boolean) {
    const rows = await this.sql<(UserRow & { password_hash: string; failed_logins: number; locked_until: Date | null })[]>`
      SELECT * FROM users WHERE lower(email) = lower(${email}) LIMIT 1`;
    const u = rows[0];
    // same message for unknown user and bad password (no account enumeration)
    const invalid = new ApiError(401, 'invalid_credentials', 'Email hoặc mật khẩu không đúng');
    if (!u) throw invalid;
    if (u.locked_until && u.locked_until.getTime() > Date.now()) throw new ApiError(423, 'account_locked', `Tài khoản tạm khóa tới ${u.locked_until.toLocaleTimeString('vi-VN')}`);
    if (!u.active) throw new ApiError(403, 'account_disabled', 'Tài khoản đã bị khóa');
    if (!(await verify(u.password_hash, password))) {
      const failed = u.failed_logins + 1;
      const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
      await this.sql`UPDATE users SET failed_logins = ${lock ? 0 : failed}, locked_until = ${lock} WHERE id = ${u.id}`;
      throw invalid;
    }
    await this.sql`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = ${u.id}`;
    const sid = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + (remember ? REMEMBER_DAYS * 24 : SESSION_HOURS) * 3_600_000);
    await this.sql`INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (${sid}, ${u.id}, ${expires}, ${ip ?? null}, ${ua ?? null})`;
    await this.log(u, 'Đăng nhập', ip);
    return { sid, expires, user: await this.userById(u.id) };
  }

  async logout(sid: string | undefined) {
    if (!sid) return;
    this.cache.delete(sid);
    await this.sql`DELETE FROM sessions WHERE id = ${sid}`;
  }

  async userById(id: string) {
    const rows = await this.sql<UserRow[]>`SELECT * FROM users WHERE id = ${id}`;
    const scopes = await this.sql<{ area_id: string }[]>`SELECT area_id FROM user_scopes WHERE user_id = ${id}`;
    return toUser(rows[0]!, scopes.map((s) => s.area_id));
  }

  async fromSession(sid: string | undefined) {
    if (!sid) return null;
    const hit = this.cache.get(sid);
    if (hit && hit.until > Date.now()) return hit.user;
    const rows = await this.sql<{ user_id: string }[]>`SELECT user_id FROM sessions WHERE id = ${sid} AND expires_at > now()`;
    if (!rows[0]) return null;
    const user = await this.userById(rows[0].user_id);
    if (!user.active) return null;
    this.cache.set(sid, { user, until: Date.now() + 30_000 });
    return user;
  }

  async log(u: { id: string; email: string }, action: string, ip?: string, target?: { type: string; id?: string; name?: string }, newValue?: string) {
    await this.sql`INSERT INTO activity_logs (user_id, user_email, action, target_type, target_id, target_name, new_value, ip)
                   VALUES (${u.id}, ${u.email}, ${action}, ${target?.type ?? 'user'}, ${target?.id ?? null}, ${target?.name ?? u.email}, ${newValue ?? null}, ${ip ?? null})`;
  }
}

/** Global guard: session required unless @Public(); optional @RequirePerm checked on the backend (spec principle 4). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(Reflector) private readonly reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const user = await this.auth.fromSession(req.cookies?.[SESSION_COOKIE]);
    if (!user) throw new ApiError(401, 'unauthenticated', 'Chưa đăng nhập');
    req.user = user;
    const perm = this.reflector.getAllAndOverride<Permission | undefined>(PERM, [ctx.getHandler(), ctx.getClass()]);
    if (perm && !hasPermission(user.role, perm)) throw new ApiError(403, 'forbidden', 'Không đủ quyền');
    return true;
  }
}

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200), remember: z.boolean().optional() });

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const b = LoginBody.parse(body);
    const { sid, expires, user } = await this.auth.login(b.email, b.password, req.ip, req.headers['user-agent'], b.remember ?? true);
    reply.setCookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      path: '/',
      expires,
    });
    return { requires2fa: false, user };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(req.cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  me(@Req() req: AuthedRequest) {
    return req.user;
  }

  @Post('2fa/verify')
  verify2fa() {
    throw new ApiError(501, 'not_implemented', '2FA sẽ có ở M2');
  }
}

@Module({
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
