import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, Bell } from 'lucide-react';
import { ROLE_LABELS } from '@citylight/shared';
import { api } from '@/lib/api';
import { useSession } from '@/stores/session';
import { fmtTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, KV, PageHeader, toast } from '@/components/ui';

export function AccountPage() {
  const { user, setUser } = useSession();
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [setup, setSetup] = useState<{ otpauthUrl: string; recoveryCodes: string[] } | null>(null);
  const [channels, setChannels] = useState({ telegram: false, zalo: false, email: true });

  const changePw = useMutation({
    mutationFn: () => api.changePassword(oldPw, newPw),
    onSuccess: () => {
      toast('Đã đổi mật khẩu', 'success');
      setOldPw('');
      setNewPw('');
      setNewPw2('');
    },
  });
  const start2fa = useMutation({ mutationFn: api.setup2fa, onSuccess: setSetup });
  const enable2fa = useMutation({
    mutationFn: api.enable2fa,
    onSuccess: (u) => {
      setUser(u);
      setSetup(null);
      toast('Đã bật xác thực 2 lớp', 'success');
    },
  });
  const disable2fa = useMutation({
    mutationFn: api.disable2fa,
    onSuccess: (u) => {
      setUser(u);
      toast('Đã tắt xác thực 2 lớp');
    },
  });

  if (!user) return null;
  const pwOk = newPw.length >= 10 && newPw === newPw2;

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
            <KV label="Phạm vi" value={user.scopeAreaIds.length ? user.scopeAreaIds.join(', ') : 'Toàn hệ thống'} />
            <KV label="Đăng nhập gần nhất" value={fmtTime(user.lastLoginAt)} />
          </div>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> Đổi mật khẩu</span>} />
          <div className="space-y-3 p-4">
            <Field label="Mật khẩu hiện tại"><Input type="password" autoComplete="current-password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} /></Field>
            <Field label="Mật khẩu mới" hint="Tối thiểu 10 ký tự"><Input type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} /></Field>
            <Field label="Nhập lại mật khẩu mới"><Input type="password" autoComplete="new-password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} /></Field>
            <Button disabled={!oldPw || !pwOk} loading={changePw.isPending} onClick={() => changePw.mutate()}>Đổi mật khẩu</Button>
          </div>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Xác thực 2 lớp (TOTP)</span>} actions={user.totpEnabled ? <Badge tone="green">Đang bật</Badge> : <Badge>Đang tắt</Badge>} />
          <div className="space-y-3 p-4 text-sm">
            {user.totpEnabled ? (
              <>
                <p className="text-subtle">Tài khoản có quyền điều khiển có thể bị bắt buộc 2FA theo vai trò.</p>
                <Button variant="outline" onClick={() => disable2fa.mutate()} loading={disable2fa.isPending}>Tắt 2FA</Button>
              </>
            ) : setup ? (
              <>
                <div className="flex h-40 w-40 items-center justify-center rounded-md border border-dashed text-center text-xs text-subtle">Mã QR<br />(sinh từ otpauth URL ở M2)</div>
                <code className="block break-all text-xs">{setup.otpauthUrl}</code>
                <div>
                  <div className="text-xs font-medium">Mã khôi phục (lưu lại ngay):</div>
                  <div className="mt-1 grid grid-cols-2 gap-1 font-mono text-xs">{setup.recoveryCodes.map((c) => <span key={c}>{c}</span>)}</div>
                </div>
                <Button onClick={() => enable2fa.mutate()} loading={enable2fa.isPending}>Tôi đã quét mã — bật 2FA</Button>
              </>
            ) : (
              <Button onClick={() => start2fa.mutate()} loading={start2fa.isPending}>Thiết lập 2FA</Button>
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
