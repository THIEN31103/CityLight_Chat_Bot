// Session auth (spec 13): argon2id password, random session id in an httpOnly SameSite=Lax cookie,
// lockout after 5 failures (password or 2FA) for 15 min, TOTP 2FA required for roles that can switch
// lights (AUTH_REQUIRE_2FA=false relaxes it for local tests), CSRF double-submit token bound to the session.
import { createHash, randomBytes } from 'node:crypto';
import {
  Body, CanActivate, Controller, ExecutionContext, Get, HttpCode, Inject, Injectable, Module, Patch, Post, Req, Res, SetMetadata,
  type OnModuleDestroy, type OnModuleInit,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { EVENTS_CHANNEL } from '@citylight/db/commands';
import type { RoleKey, SecurityEvent, SecurityKind, User } from '@citylight/shared';
import { DEFAULT_LANG, LANGS, hasPermission, isLang, roleRequires2fa, roleSeesAll, type Lang, type Permission } from '@citylight/shared';
import { NOTIFY_CHANGED_CHANNEL } from '@citylight/db/notify';
import { ApiError } from './errors';
import { REDIS, SQL, type Sql } from './infra';
import { loadScope, type Scope } from './scope';
import {
  base32Encode, decryptSecret, encryptSecret, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUrl, parseEncKey, verifyTotp,
} from './totp';

export const SESSION_COOKIE = 'cl_sid';
export const CSRF_COOKIE = 'cl_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const CHALLENGE_COOKIE = 'cl_2fa';
const SESSION_HOURS = 12;
const REMEMBER_DAYS = 30;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const CHALLENGE_TTL_S = 300;
const SETUP_TTL_S = 600;
const RATE_PER_MIN = 20;
export const PASSWORD_MIN = 10;
/** Redis channel: session revocations, so every API instance drops caches and sockets. */
export const AUTH_CHANNEL = 'cl:auth';
/** activity_logs.action of a sign-in; also the history the new-IP alert looks at. */
const LOGIN_ACTION = 'Đăng nhập';
/** Alerts raised by a sign-in attempt (repeat attempts from one IP give one alert per 10 min); the user is told too. */
const SIGNIN_KINDS = new Set<SecurityKind>(['new_ip', 'locked', 'recovery_login']);
const ALERT_DEDUPE_S = 600;

export const PUBLIC = 'cl:public';
export const Public = () => SetMetadata(PUBLIC, true);
export const PERM = 'cl:perm';
export const RequirePerm = (p: Permission) => SetMetadata(PERM, p);
/** Reachable while a forced step (2FA setup / password change) is pending. */
export const ALLOW_PENDING = 'cl:allow-pending';
export const AllowPending = () => SetMetadata(ALLOW_PENDING, true);
/**
 * A4 (S45): the current 2FA code must have been entered on this session within REAUTH_TTL_S (POST /auth/reauth),
 * for actions that hand out access or change a cabinet's identity. 403 reauth_required otherwise.
 */
export const REAUTH = 'cl:reauth';
export const RequireReauth = () => SetMetadata(REAUTH, true);
const REAUTH_TTL_S = 300;

export type SessionUser = User & { organizationId: string; scope: Scope };

export interface AuthedRequest extends FastifyRequest {
  user?: SessionUser;
  sid?: string;
}

interface UserRow {
  id: string;
  organization_id: string;
  email: string;
  full_name: string;
  role: RoleKey;
  totp_enabled: boolean;
  scope_all: boolean;
  password_change_required: boolean;
  active: boolean;
  last_login_at: Date | null;
  lang: string;
}

interface AuthRow extends UserRow {
  password_hash: string;
  failed_logins: number;
  locked_until: Date | null;
  totp_secret: string | null;
  totp_last_step: number | null;
}

export const csrfFor = (sid: string) => createHash('sha256').update(`csrf:${sid}`).digest('base64url');

const cookieOpts = (expires?: Date) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.COOKIE_SECURE === 'true',
  path: '/',
  ...(expires ? { expires } : {}),
});

export const require2faEnforced = () => process.env.AUTH_REQUIRE_2FA !== 'false';

/** Public shape (no scope internals). */
export function publicUser(u: SessionUser): User {
  const { scope: _s, organizationId: _o, ...rest } = u;
  return rest;
}

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private cache = new Map<string, { user: SessionUser; until: number }>();
  private readonly encKey = parseEncKey(process.env.TOTP_ENC_KEY);
  private sub: Redis | null = null;

  constructor(@Inject(SQL) private readonly sql: Sql, @Inject(REDIS) private readonly redis: Redis) {}

  async onModuleInit() {
    this.sub = this.redis.duplicate();
    await this.sub.subscribe(AUTH_CHANNEL);
    this.sub.on('message', (_ch, msg) => {
      try {
        const ev = JSON.parse(msg) as { type: string; userId: string };
        if (ev.type === 'revoke' || ev.type === 'changed') this.dropCache(ev.userId);
      } catch {
        /* ignore malformed */
      }
    });
  }

  async onModuleDestroy() {
    await this.sub?.quit().catch(() => undefined);
  }

  private dropCache(userId: string) {
    for (const [sid, v] of this.cache) if (v.user.id === userId) this.cache.delete(sid);
  }

  // ---------- rate limit / lockout ----------

  async rateLimit(bucket: string, ip: string | undefined) {
    const key = `cl:rl:${bucket}:${ip ?? 'unknown'}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 60);
    if (n > RATE_PER_MIN) throw new ApiError(429, 'rate_limited', 'Quá nhiều lần thử, vui lòng đợi 1 phút');
  }

  private async registerFailure(u: { id: string; email: string; failed_logins: number }, ip?: string, ua?: string) {
    const failed = u.failed_logins + 1;
    const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
    await this.sql`UPDATE users SET failed_logins = ${lock ? 0 : failed}, locked_until = ${lock} WHERE id = ${u.id}`;
    if (lock) await this.securityAlert('locked', u, { ip, ua });
    return lock;
  }

  // ---------- security alerts (A6) ----------

  /**
   * Telegram alert to admins (and, for sign-in events, the user): published on the events channel, sent by the
   * notify-worker. Sign-in events are de-duplicated per user + IP for 10 min. Never fails the request.
   */
  async securityAlert(kind: SecurityKind, target: { id: string; email: string }, o: { ip?: string; ua?: string; by?: string; detail?: string } = {}) {
    try {
      if (SIGNIN_KINDS.has(kind) && (await this.redis.set(`cl:secalert:${kind}:${target.id}:${o.ip ?? ''}`, '1', 'EX', ALERT_DEDUPE_S, 'NX')) !== 'OK') return;
      const security: SecurityEvent = {
        kind, userId: target.id, email: target.email, ip: o.ip ?? null, ua: o.ua ?? null, by: o.by ?? null, detail: o.detail ?? null, at: new Date().toISOString(),
      };
      await this.redis.publish(EVENTS_CHANNEL, JSON.stringify({ type: 'security', security }));
    } catch (e) {
      console.error('[auth] security alert', kind, (e as Error).message);
    }
  }

  /** A successful sign-in from an IP this user has not signed in from in 90 days (not on the very first sign-in). */
  private async alertIfNewIp(u: { id: string; email: string }, ip?: string, ua?: string) {
    if (!ip) return;
    const [r] = await this.sql<{ seen: boolean; before: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM activity_logs WHERE user_id = ${u.id} AND action = ${LOGIN_ACTION} AND ip = ${ip} AND ts > now() - interval '90 days') AS seen,
             EXISTS (SELECT 1 FROM activity_logs WHERE user_id = ${u.id} AND action = ${LOGIN_ACTION}) AS before`;
    if (r && r.before && !r.seen) await this.securityAlert('new_ip', u, { ip, ua });
  }

  private async authRow(where: { email?: string; id?: string }) {
    const rows = where.email
      ? await this.sql<AuthRow[]>`SELECT * FROM users WHERE lower(email) = lower(${where.email}) LIMIT 1`
      : await this.sql<AuthRow[]>`SELECT * FROM users WHERE id = ${where.id!}`;
    return rows[0];
  }

  private assertUsable(u: AuthRow) {
    if (u.locked_until && u.locked_until.getTime() > Date.now()) {
      const until = u.locked_until.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      throw new ApiError(423, 'account_locked', `Tài khoản tạm khóa tới ${until}`, { until });
    }
    if (!u.active) throw new ApiError(403, 'account_disabled', 'Tài khoản đã bị khóa');
  }

  // ---------- login ----------

  async login(email: string, password: string, remember: boolean, ip?: string, ua?: string) {
    const u = await this.authRow({ email });
    // same message for unknown user and bad password (no account enumeration)
    const invalid = new ApiError(401, 'invalid_credentials', 'Email hoặc mật khẩu không đúng');
    if (!u) throw invalid;
    this.assertUsable(u);
    if (!(await verify(u.password_hash, password))) {
      await this.registerFailure(u, ip, ua);
      throw invalid;
    }
    if (u.totp_enabled && u.totp_secret) {
      const challenge = randomBytes(24).toString('base64url');
      await this.redis.set(`cl:2fa:${challenge}`, JSON.stringify({ userId: u.id, remember }), 'EX', CHALLENGE_TTL_S);
      return { kind: 'challenge' as const, challenge };
    }
    return { kind: 'session' as const, ...(await this.startSession(u, remember, ip, ua)) };
  }

  /** Second step: a 6-digit TOTP code or one recovery code. */
  /**
   * Re-authentication for mass actions (M6 batches): the current TOTP code of a signed-in user.
   * Same replay guard as login. Without 2FA it is refused, unless 2FA is switched off for tests.
   */
  async reauthTotp(userId: string, code: string | undefined) {
    const u = await this.authRow({ id: userId });
    if (!u) throw new ApiError(401, 'unauthenticated', 'Phiên đăng nhập không hợp lệ');
    if (!u.totp_enabled || !u.totp_secret) {
      if (!require2faEnforced()) return;
      throw new ApiError(403, 'totp_setup_required', 'Cần bật xác thực 2 lớp để chạy lệnh hàng loạt');
    }
    const bad = new ApiError(422, 'invalid_otp', 'Mã xác thực không đúng hoặc đã dùng');
    if (!code || !/^\d{6}$/.test(code)) throw bad;
    const step = verifyTotp(decryptSecret(u.totp_secret, this.encKey), code, u.totp_last_step);
    if (step === null) throw bad;
    const r = await this.sql`UPDATE users SET totp_last_step = ${step} WHERE id = ${u.id} AND (totp_last_step IS NULL OR totp_last_step < ${step}) RETURNING id`;
    if (r.length !== 1) throw bad;
  }

  /**
   * Step-up for @RequireReauth actions: the current TOTP code opens a REAUTH_TTL_S window on this session.
   * Wrong codes count toward the account lock; a lock also ends every session (a stolen session cannot keep guessing).
   */
  async reauth(user: SessionUser, sid: string, code: string, ip?: string, ua?: string) {
    const u = await this.authRow({ id: user.id });
    if (!u) throw new ApiError(401, 'unauthenticated', 'Phiên đăng nhập không hợp lệ');
    this.assertUsable(u);
    if (!u.totp_enabled || !u.totp_secret) {
      if (require2faEnforced()) throw new ApiError(403, 'totp_setup_required', 'Cần bật xác thực 2 lớp');
    } else {
      const step = verifyTotp(decryptSecret(u.totp_secret, this.encKey), code, u.totp_last_step);
      const ok = step !== null
        && (await this.sql`UPDATE users SET totp_last_step = ${step}, failed_logins = 0 WHERE id = ${u.id} AND (totp_last_step IS NULL OR totp_last_step < ${step}) RETURNING id`).length === 1;
      if (!ok) {
        if (await this.registerFailure(u, ip, ua)) {
          await this.revokeUser(u.id);
          throw new ApiError(423, 'reauth_locked', `Nhập sai ${MAX_FAILED} lần: tài khoản tạm khóa ${LOCK_MINUTES} phút và đã đăng xuất mọi nơi`, {
            max: MAX_FAILED,
            minutes: LOCK_MINUTES,
          });
        }
        throw new ApiError(422, 'invalid_otp', 'Mã xác thực không đúng hoặc đã dùng');
      }
    }
    await this.redis.set(`cl:reauth:${sid}`, '1', 'EX', REAUTH_TTL_S);
    await this.log(user, 'Xác thực lại 2FA', ip);
    return { validForS: REAUTH_TTL_S };
  }

  async hasRecentReauth(user: SessionUser, sid: string) {
    if (!user.totpEnabled && !require2faEnforced()) return true; // test setups without 2FA
    return (await this.redis.exists(`cl:reauth:${sid}`)) === 1;
  }

  async verify2fa(challenge: string | undefined, code: string | undefined, recoveryCode: string | undefined, ip?: string, ua?: string) {
    const expired = new ApiError(401, 'challenge_expired', 'Phiên xác thực đã hết hạn, vui lòng đăng nhập lại');
    if (!challenge) throw expired;
    const raw = await this.redis.get(`cl:2fa:${challenge}`);
    if (!raw) throw expired;
    const { userId, remember } = JSON.parse(raw) as { userId: string; remember: boolean };
    const u = await this.authRow({ id: userId });
    if (!u || !u.totp_secret) throw expired;
    this.assertUsable(u);

    let ok = false;
    if (code) {
      const step = verifyTotp(decryptSecret(u.totp_secret, this.encKey), code, u.totp_last_step);
      if (step !== null) {
        // conditional update: two parallel requests with the same code cannot both pass
        const r = await this.sql`UPDATE users SET totp_last_step = ${step} WHERE id = ${u.id} AND (totp_last_step IS NULL OR totp_last_step < ${step}) RETURNING id`;
        ok = r.length === 1;
      }
    } else if (recoveryCode) {
      ok = await this.useRecoveryCode(u.id, recoveryCode);
    }
    if (!ok) {
      const lock = await this.registerFailure(u, ip, ua);
      if (lock) await this.redis.del(`cl:2fa:${challenge}`);
      throw new ApiError(401, 'invalid_totp', 'Mã xác thực không đúng');
    }
    await this.redis.del(`cl:2fa:${challenge}`);
    const s = await this.startSession(u, remember, ip, ua);
    if (recoveryCode) {
      await this.log(s.user, 'Đăng nhập bằng mã khôi phục 2FA', ip);
      await this.securityAlert('recovery_login', u, { ip, ua });
    }
    return s;
  }

  private async useRecoveryCode(userId: string, input: string) {
    const norm = normalizeRecoveryCode(input);
    if (norm.length !== 8) return false;
    const rows = await this.sql<{ id: string; code_hash: string }[]>`SELECT id, code_hash FROM user_recovery_codes WHERE user_id = ${userId} AND used_at IS NULL`;
    for (const r of rows) {
      if (await verify(r.code_hash, norm)) {
        const upd = await this.sql`UPDATE user_recovery_codes SET used_at = now() WHERE id = ${r.id} AND used_at IS NULL RETURNING id`;
        return upd.length === 1;
      }
    }
    return false;
  }

  private async startSession(u: AuthRow, remember: boolean, ip?: string, ua?: string) {
    await this.sql`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = ${u.id}`;
    const sid = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + (remember ? REMEMBER_DAYS * 24 : SESSION_HOURS) * 3_600_000);
    await this.sql`INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (${sid}, ${u.id}, ${expires}, ${ip ?? null}, ${ua ?? null})`;
    const user = await this.userById(u.id);
    await this.alertIfNewIp(u, ip, ua); // before this sign-in is logged
    await this.log(user, LOGIN_ACTION, ip);
    return { sid, expires, user };
  }

  setSessionCookies(reply: FastifyReply, sid: string, expires: Date) {
    reply.setCookie(SESSION_COOKIE, sid, cookieOpts(expires));
    // readable by the web so it can echo it in X-CSRF-Token
    reply.setCookie(CSRF_COOKIE, csrfFor(sid), { ...cookieOpts(expires), httpOnly: false });
  }

  setChallengeCookie(reply: FastifyReply, challenge: string) {
    reply.setCookie(CHALLENGE_COOKIE, challenge, { ...cookieOpts(new Date(Date.now() + CHALLENGE_TTL_S * 1000)), path: '/api/v1/auth' });
  }

  clearChallengeCookie(reply: FastifyReply) {
    reply.clearCookie(CHALLENGE_COOKIE, { path: '/api/v1/auth' });
  }

  readChallenge(req: FastifyRequest) {
    return req.cookies?.[CHALLENGE_COOKIE];
  }

  async logout(sid: string | undefined) {
    if (!sid) return;
    this.cache.delete(sid);
    await this.sql`DELETE FROM sessions WHERE id = ${sid}`;
  }

  // ---------- users / sessions ----------

  async userById(id: string): Promise<SessionUser> {
    const rows = await this.sql<UserRow[]>`SELECT * FROM users WHERE id = ${id}`;
    const r = rows[0];
    if (!r) throw new ApiError(404, 'not_found', 'Không tìm thấy người dùng');
    const direct = await this.sql<{ area_id: string }[]>`SELECT area_id FROM user_scopes WHERE user_id = ${id}`;
    return {
      id: r.id,
      organizationId: r.organization_id,
      email: r.email,
      fullName: r.full_name,
      role: r.role,
      scopeAll: roleSeesAll(r.role) || r.scope_all,
      scopeAreaIds: direct.map((s) => s.area_id),
      totpEnabled: r.totp_enabled,
      totpRequired: require2faEnforced() && roleRequires2fa(r.role),
      passwordChangeRequired: r.password_change_required,
      active: r.active,
      lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
      lang: isLang(r.lang) ? r.lang : DEFAULT_LANG,
      scope: await loadScope(this.sql, r.id, r.role, r.scope_all),
    };
  }

  async fromSession(sid: string | undefined) {
    if (!sid) return null;
    const hit = this.cache.get(sid);
    if (hit && hit.until > Date.now()) return hit.user;
    const rows = await this.sql<{ user_id: string }[]>`SELECT user_id FROM sessions WHERE id = ${sid} AND expires_at > now()`;
    if (!rows[0]) {
      this.cache.delete(sid);
      return null;
    }
    const user = await this.userById(rows[0].user_id);
    if (!user.active) return null;
    this.cache.set(sid, { user, until: Date.now() + 30_000 });
    return user;
  }

  /** Delete the user's sessions (except one) and tell every API instance to drop caches and sockets. */
  async revokeUser(userId: string, exceptSid?: string) {
    if (exceptSid) await this.sql`DELETE FROM sessions WHERE user_id = ${userId} AND id <> ${exceptSid}`;
    else await this.sql`DELETE FROM sessions WHERE user_id = ${userId}`;
    this.dropCache(userId);
    await this.redis.publish(AUTH_CHANNEL, JSON.stringify({ type: 'revoke', userId, exceptSid: exceptSid ?? null }));
  }

  /** User data changed without revoking sessions (name, 2FA state): refresh caches everywhere. */
  async userChanged(userId: string) {
    this.dropCache(userId);
    await this.redis.publish(AUTH_CHANNEL, JSON.stringify({ type: 'changed', userId }));
  }

  async log(u: { id: string; email: string }, action: string, ip?: string, target?: { type: string; id?: string; name?: string }, newValue?: string) {
    await this.sql`INSERT INTO activity_logs (user_id, user_email, action, target_type, target_id, target_name, new_value, ip)
                   VALUES (${u.id}, ${u.email}, ${action}, ${target?.type ?? 'user'}, ${target?.id ?? null}, ${target?.name ?? u.email}, ${newValue ?? null}, ${ip ?? null})`;
  }

  // ---------- 2FA management ----------

  async setup2fa(u: SessionUser) {
    if (u.totpEnabled) throw new ApiError(409, 'totp_already_enabled', '2FA đang bật; tắt trước khi thiết lập lại');
    const secret = newTotpSecret();
    await this.redis.set(`cl:2fa-setup:${u.id}`, encryptSecret(secret, this.encKey), 'EX', SETUP_TTL_S);
    // secret is shown once for manual entry when the QR cannot be scanned
    return { otpauthUrl: otpauthUrl(u.email, secret), secret: base32Encode(secret) };
  }

  async enable2fa(u: SessionUser, code: string, ip?: string) {
    const pending = await this.redis.get(`cl:2fa-setup:${u.id}`);
    if (!pending) throw new ApiError(409, 'totp_setup_expired', 'Phiên thiết lập 2FA đã hết hạn, bấm "Thiết lập 2FA" lại');
    const step = verifyTotp(decryptSecret(pending, this.encKey), code, null);
    if (step === null) throw new ApiError(422, 'totp_setup_invalid', 'Mã xác thực không đúng — kiểm tra giờ trên điện thoại');
    const codes = newRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => hash(normalizeRecoveryCode(c))));
    await this.sql.begin(async (tx) => {
      await tx`UPDATE users SET totp_secret = ${pending}, totp_enabled = true, totp_last_step = ${step} WHERE id = ${u.id}`;
      await tx`DELETE FROM user_recovery_codes WHERE user_id = ${u.id}`;
      for (const h of hashes) await tx`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (${u.id}, ${h})`;
    });
    await this.redis.del(`cl:2fa-setup:${u.id}`);
    await this.log(u, 'Bật xác thực 2 lớp', ip);
    await this.userChanged(u.id);
    return { user: publicUser(await this.userById(u.id)), recoveryCodes: codes };
  }

  async disable2fa(u: SessionUser, password: string, ip?: string) {
    if (u.totpRequired) throw new ApiError(403, 'totp_required_by_role', 'Vai trò của bạn bắt buộc 2FA, không thể tắt');
    const row = await this.authRow({ id: u.id });
    if (!row || !(await verify(row.password_hash, password))) throw new ApiError(422, 'invalid_password', 'Mật khẩu không đúng');
    await this.clear2fa(u.id);
    await this.log(u, 'Tắt xác thực 2 lớp', ip);
    return publicUser(await this.userById(u.id));
  }

  async clear2fa(userId: string) {
    await this.sql`UPDATE users SET totp_secret = NULL, totp_enabled = false, totp_last_step = NULL WHERE id = ${userId}`;
    await this.sql`DELETE FROM user_recovery_codes WHERE user_id = ${userId}`;
    await this.userChanged(userId);
  }

  async setLang(userId: string, lang: Lang) {
    await this.sql`UPDATE users SET lang = ${lang} WHERE id = ${userId}`;
    await this.userChanged(userId);
    await this.redis.publish(NOTIFY_CHANGED_CHANNEL, '1'); // the notify-worker reloads recipients: Telegram follows the language
  }

  async changePassword(u: SessionUser, sid: string, oldPassword: string, newPassword: string, ip?: string) {
    const row = await this.authRow({ id: u.id });
    if (!row || !(await verify(row.password_hash, oldPassword))) throw new ApiError(422, 'invalid_password', 'Mật khẩu hiện tại không đúng');
    if (oldPassword === newPassword) throw new ApiError(422, 'password_reused', 'Mật khẩu mới phải khác mật khẩu cũ');
    await this.sql`UPDATE users SET password_hash = ${await hash(newPassword)}, password_change_required = false WHERE id = ${u.id}`;
    await this.revokeUser(u.id, sid); // sign out other devices, keep this one
    await this.log(u, 'Đổi mật khẩu', ip);
  }
}

/**
 * Global guard: session required unless @Public(); CSRF on state-changing methods; forced steps
 * (password change, 2FA setup) block everything except @AllowPending() routes; then @RequirePerm.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(Reflector) private readonly reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext) {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const sid = req.cookies?.[SESSION_COOKIE];
    const user = await this.auth.fromSession(sid);
    if (!user || !sid) throw new ApiError(401, 'unauthenticated', 'Chưa đăng nhập');
    req.user = user;
    req.sid = sid;

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const header = req.headers[CSRF_HEADER];
      if (typeof header !== 'string' || header !== csrfFor(sid)) throw new ApiError(403, 'csrf_failed', 'Phiên làm việc không hợp lệ, hãy tải lại trang');
    }

    if (!this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING, targets)) {
      if (user.passwordChangeRequired) throw new ApiError(403, 'password_change_required', 'Bạn cần đổi mật khẩu tạm trước khi tiếp tục');
      if (user.totpRequired && !user.totpEnabled) throw new ApiError(403, 'totp_setup_required', 'Vai trò của bạn bắt buộc bật xác thực 2 lớp');
    }

    const perm = this.reflector.getAllAndOverride<Permission | undefined>(PERM, targets);
    if (perm && !hasPermission(user.role, perm)) throw new ApiError(403, 'forbidden', 'Không đủ quyền');
    if (this.reflector.getAllAndOverride<boolean>(REAUTH, targets) && !(await this.auth.hasRecentReauth(user, sid)))
      throw new ApiError(403, 'reauth_required', 'Nhập mã xác thực 2 lớp để tiếp tục');
    return true;
  }
}

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200), remember: z.boolean().optional() });
const VerifyBody = z
  .object({ code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().min(8).max(20).optional() })
  .refine((b) => !!b.code !== !!b.recoveryCode, { message: 'cần đúng một trong code / recoveryCode' });
const CodeBody = z.object({ code: z.string().regex(/^\d{6}$/, 'mã 6 số') });
const PasswordBody = z.object({ password: z.string().min(1).max(200) });
export const NewPassword = z.string().min(PASSWORD_MIN, `tối thiểu ${PASSWORD_MIN} ký tự`).max(200);
const ChangePasswordBody = z.object({ oldPassword: z.string().min(1).max(200), newPassword: NewPassword });
const PreferencesBody = z.object({ lang: z.enum(LANGS as [Lang, ...Lang[]]) });

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.rateLimit('login', req.ip);
    const b = LoginBody.parse(body);
    const r = await this.auth.login(b.email, b.password, b.remember ?? true, req.ip, req.headers['user-agent']);
    if (r.kind === 'challenge') {
      this.auth.setChallengeCookie(reply, r.challenge);
      return { requires2fa: true };
    }
    this.auth.setSessionCookies(reply, r.sid, r.expires);
    return { requires2fa: false, user: publicUser(r.user) };
  }

  @Public()
  @Post('2fa/verify')
  @HttpCode(200)
  async verify2fa(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.rateLimit('2fa', req.ip);
    const b = VerifyBody.parse(body);
    const s = await this.auth.verify2fa(this.auth.readChallenge(req), b.code, b.recoveryCode, req.ip, req.headers['user-agent']);
    this.auth.clearChallengeCookie(reply);
    this.auth.setSessionCookies(reply, s.sid, s.expires);
    return { user: publicUser(s.user) };
  }

  @AllowPending()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(req.sid);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  @AllowPending()
  @Get('me')
  me(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    // re-issue the CSRF cookie if the browser lost it (it is derived from the session id)
    if (req.cookies?.[CSRF_COOKIE] !== csrfFor(req.sid!)) reply.setCookie(CSRF_COOKIE, csrfFor(req.sid!), { ...cookieOpts(), httpOnly: false });
    return publicUser(req.user!);
  }

  @AllowPending()
  @Post('2fa/setup')
  @HttpCode(200)
  setup(@Req() req: AuthedRequest) {
    return this.auth.setup2fa(req.user!);
  }

  @AllowPending()
  @Post('2fa/enable')
  @HttpCode(200)
  enable(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.auth.enable2fa(req.user!, CodeBody.parse(body).code, req.ip);
  }

  @Post('reauth')
  @HttpCode(200)
  async reauth(@Body() body: unknown, @Req() req: AuthedRequest) {
    await this.auth.rateLimit('reauth', req.ip);
    return this.auth.reauth(req.user!, req.sid!, CodeBody.parse(body).code, req.ip, req.headers['user-agent']);
  }

  @Post('2fa/disable')
  @HttpCode(200)
  @RequireReauth()
  disable(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.auth.disable2fa(req.user!, PasswordBody.parse(body).password, req.ip);
  }
}

@Controller('me')
export class MeController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @AllowPending()
  @Post('password')
  @HttpCode(204)
  async changePassword(@Body() body: unknown, @Req() req: AuthedRequest) {
    const b = ChangePasswordBody.parse(body);
    await this.auth.changePassword(req.user!, req.sid!, b.oldPassword, b.newPassword, req.ip);
  }

  /** Per-user preferences (S49): UI / Telegram / export language. */
  @AllowPending()
  @Patch('preferences')
  async preferences(@Body() body: unknown, @Req() req: AuthedRequest) {
    const b = PreferencesBody.parse(body);
    await this.auth.setLang(req.user!.id, b.lang);
    return publicUser(await this.auth.userById(req.user!.id));
  }
}

@Module({
  controllers: [AuthController, MeController],
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
