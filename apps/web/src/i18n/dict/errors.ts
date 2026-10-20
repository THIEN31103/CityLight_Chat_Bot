// API error codes -> text (S49). The API answers { code, detail (Vietnamese), params? }; the web shows this
// dictionary's text for the code in the user's language, with {param} placeholders filled from `params`.
// A code missing here falls back to the server's Vietnamese `detail`, so keep every ApiError code of apps/api listed.
import { defineDict } from '@citylight/shared';

const vi: Record<string, string> = {
  unauthenticated: 'Chưa đăng nhập',
  csrf_failed: 'Phiên làm việc không hợp lệ, hãy tải lại trang',
  forbidden: 'Không đủ quyền',
  rate_limited: 'Quá nhiều lần thử, vui lòng đợi 1 phút',
  internal_error: 'Lỗi máy chủ',
  invalid_request: 'Dữ liệu gửi lên không hợp lệ',
  not_found: 'Không tìm thấy',
  reauth_required: 'Nhập mã xác thực 2 lớp để tiếp tục',
  invalid_otp: 'Mã xác thực không đúng hoặc đã dùng',
};

const en: Record<string, string> = {
  unauthenticated: 'Not signed in',
  csrf_failed: 'Your session is no longer valid, reload the page',
  forbidden: 'You do not have permission for this',
  rate_limited: 'Too many attempts, wait one minute',
  internal_error: 'Server error',
  invalid_request: 'The data sent is not valid',
  not_found: 'Not found',
  reauth_required: 'Enter your 2FA code to continue',
  invalid_otp: 'Wrong or already used code',
};

export const ERRORS = defineDict(vi, en);
