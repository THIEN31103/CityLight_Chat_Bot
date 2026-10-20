import { defineDict } from '@citylight/shared';

export const LOGIN = defineDict(
  {
    tagline: 'Giám sát & điều khiển chiếu sáng',
    email: 'Email',
    password: 'Mật khẩu',
    remember: 'Ghi nhớ đăng nhập',
    totpPrompt: 'Nhập mã 6 số từ ứng dụng xác thực',
    recoveryPrompt: 'Nhập một mã khôi phục (dùng một lần)',
    recoveryCode: 'Mã khôi phục',
    totpCode: 'Mã xác thực (2FA)',
    useApp: 'Dùng mã từ ứng dụng xác thực',
    lostPhone: 'Mất điện thoại? Dùng mã khôi phục',
    signIn: 'Đăng nhập',
    verify: 'Xác thực',
    mockNote: 'Chế độ mock: tài khoản mẫu xem trong',
  },
  {
    tagline: 'Street-lighting monitoring & control',
    email: 'Email',
    password: 'Password',
    remember: 'Keep me signed in',
    totpPrompt: 'Enter the 6-digit code from your authenticator app',
    recoveryPrompt: 'Enter one recovery code (single use)',
    recoveryCode: 'Recovery code',
    totpCode: 'Authentication code (2FA)',
    useApp: 'Use a code from the authenticator app',
    lostPhone: 'Lost your phone? Use a recovery code',
    signIn: 'Sign in',
    verify: 'Verify',
    mockNote: 'Mock mode: sample accounts are listed in',
  },
);
