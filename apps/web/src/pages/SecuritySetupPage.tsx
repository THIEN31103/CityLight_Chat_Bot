// Full-screen step shown before the app when the server requires it (spec 13):
// change an admin-issued temporary password, then set up 2FA if the role needs it.
import { KeyRound, Lightbulb, LogOut, ShieldCheck } from 'lucide-react';
import { ROLE_LABELS } from '@citylight/shared';
import { api } from '@/lib/api';
import { useSession } from '@/stores/session';
import { ChangePasswordForm, TotpEnroll } from '@/components/security';
import { Button, ToastHost } from '@/components/ui';

export function SecuritySetupPage({ step }: { step: 'password' | 'totp' }) {
  const { user, setUser } = useSession();
  if (!user) return null;
  const logout = () => api.logout().finally(() => setUser(null));
  const refresh = () => api.me().then(setUser);

  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-4">
      <div className="w-full max-w-md space-y-4 rounded-xl border bg-panel p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white"><Lightbulb className="h-4 w-4" /></div>
            <div>
              <div className="font-semibold">CityLight</div>
              <div className="text-xs text-subtle">{user.email} · {ROLE_LABELS[user.role]}</div>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={logout}><LogOut className="h-4 w-4" /> Đăng xuất</Button>
        </div>
        {step === 'password' ? (
          <>
            <h1 className="flex items-center gap-2 text-base font-semibold"><KeyRound className="h-5 w-5" /> Đặt mật khẩu mới</h1>
            <p className="text-sm text-subtle">Bạn đang dùng mật khẩu tạm do quản trị viên cấp. Đặt mật khẩu riêng để tiếp tục.</p>
            <ChangePasswordForm forced onDone={refresh} />
          </>
        ) : (
          <>
            <h1 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck className="h-5 w-5" /> Bật xác thực 2 lớp</h1>
            <p className="text-sm text-subtle">Vai trò {ROLE_LABELS[user.role]} có quyền điều khiển tủ nên bắt buộc 2FA. Mỗi lần đăng nhập sẽ cần mã 6 số từ điện thoại.</p>
            <TotpEnroll onDone={setUser} />
          </>
        )}
      </div>
      <ToastHost />
    </div>
  );
}
