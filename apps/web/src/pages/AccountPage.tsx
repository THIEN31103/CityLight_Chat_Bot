import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, Bell } from 'lucide-react';
import { ROLE_LABELS } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { fmtTime } from '@/lib/utils';
import { ChangePasswordForm, TotpEnroll, scopeLabel, useAreaNames } from '@/components/security';
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, KV, PageHeader, toast } from '@/components/ui';

export function AccountPage() {
  const { user, setUser } = useSession();
  const names = useAreaNames();
  const [channels, setChannels] = useState({ telegram: false, zalo: false, email: true });
  const [disablePw, setDisablePw] = useState('');
  const disable2fa = useMutation({
    mutationFn: () => api.disable2fa(disablePw),
    onSuccess: (u) => {
      setUser(u);
      setDisablePw('');
      toast('Đã tắt xác thực 2 lớp');
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Lỗi', 'error'),
  });

  if (!user) return null;

  return (
    <div className="mx-auto max-w-4xl p-4">
      <PageHeader title="Tài khoản cá nhân" />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Thông tin" />
          <div className="px-4 py-2">
            <KV label="Họ tên" value={user.fullName} />
            <KV label="Email" value={user.email} />
            <KV label="Vai trò" value={<Badge tone="blue">{ROLE_LABELS[user.role]}</Badge>} />
            <KV label="Phạm vi" value={scopeLabel(user, names)} />
            <KV label="Đăng nhập gần nhất" value={fmtTime(user.lastLoginAt)} />
          </div>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> Đổi mật khẩu</span>} />
          <div className="p-4">
            <ChangePasswordForm />
          </div>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Xác thực 2 lớp (TOTP)</span>} actions={user.totpEnabled ? <Badge tone="green">Đang bật</Badge> : <Badge>Đang tắt</Badge>} />
          <div className="space-y-3 p-4 text-sm">
            {!user.totpEnabled ? (
              <TotpEnroll onDone={setUser} />
            ) : user.totpRequired ? (
              <p className="text-subtle">Vai trò {ROLE_LABELS[user.role]} bắt buộc 2FA nên không tắt được. Mất điện thoại: dùng mã khôi phục, hoặc nhờ quản trị viên đặt lại 2FA.</p>
            ) : (
              <>
                <p className="text-subtle">Tắt 2FA cần nhập lại mật khẩu.</p>
                <Field label="Mật khẩu">
                  <Input type="password" autoComplete="current-password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} />
                </Field>
                <Button variant="outline" disabled={!disablePw} onClick={() => disable2fa.mutate()} loading={disable2fa.isPending}>Tắt 2FA</Button>
              </>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Bell className="h-4 w-4" /> Nhận thông báo cảnh báo</span>} />
          <div className="space-y-2 p-4">
            <Checkbox label="Telegram" checked={channels.telegram} onChange={(v) => setChannels({ ...channels, telegram: v })} />
            <Checkbox label="Zalo OA" checked={channels.zalo} onChange={(v) => setChannels({ ...channels, zalo: v })} />
            <Checkbox label="Email" checked={channels.email} onChange={(v) => setChannels({ ...channels, email: v })} />
            <p className="text-xs text-subtle">Kênh thông báo dạng plugin (NotificationChannel) — thêm kênh mới không đổi giao diện.</p>
            <Button size="sm" variant="outline" onClick={() => toast('Đã lưu đăng ký thông báo (mock)', 'success')}>Lưu</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
