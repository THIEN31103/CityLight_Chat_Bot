// Security alerts (A6): published by the API on the events channel, sent to admins on Telegram by the notify-worker.

export type SecurityKind =
  | 'new_ip' // sign-in from an IP not seen for this user in 90 days
  | 'locked' // 5 wrong passwords / 2FA codes -> locked 15 min
  | 'recovery_login' // signed in with a 2FA recovery code
  | 'user_created'
  | 'role_changed'
  | 'user_disabled'
  | 'password_reset'
  | 'totp_reset';

export interface SecurityEvent {
  kind: SecurityKind;
  /** the account concerned */
  userId: string;
  email: string;
  ip: string | null;
  ua: string | null;
  /** admin who did it (user administration kinds) */
  by: string | null;
  detail: string | null;
  at: string;
}

export const SECURITY_KIND_LABELS: Record<SecurityKind, string> = {
  new_ip: 'Đăng nhập từ IP mới',
  locked: 'Tài khoản bị khóa 15 phút do nhập sai 5 lần',
  recovery_login: 'Đăng nhập bằng mã khôi phục 2FA',
  user_created: 'Tạo người dùng mới',
  role_changed: 'Đổi vai trò người dùng',
  user_disabled: 'Khóa tài khoản người dùng',
  password_reset: 'Đặt lại mật khẩu người dùng',
  totp_reset: 'Đặt lại 2FA người dùng',
};

/** Kinds the account owner is told about too (someone may be using their password). */
export const SECURITY_SELF_KINDS: readonly SecurityKind[] = ['new_ip', 'locked', 'recovery_login'];

/** "Chrome / Windows" from a User-Agent; no version numbers. */
export function shortUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'không rõ trình duyệt';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|python|node|axios|Go-http/i.test(ua) ? 'công cụ dòng lệnh' : 'trình duyệt khác';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} / ${os}` : browser;
}
