import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, Bell } from 'lucide-react';
import type { AlarmSeverity } from '@citylight/shared';
import { ROLE_LABELS, SEVERITY_LABELS } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { fmtTime } from '@/lib/utils';
import { ChangePasswordForm, TotpEnroll, scopeLabel, useAreaNames } from '@/components/security';
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, KV, PageHeader, Select, Spinner, toast } from '@/components/ui';

export function AccountPage() {
  const { user, setUser } = useSession();
  const names = useAreaNames();
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
        <NotificationsCard />
      </div>
    </div>
  );
}

const SEVERITY_OPTIONS: { value: AlarmSeverity; label: string }[] = [
  { value: 'critical', label: `Chỉ ${SEVERITY_LABELS.critical}` },
  { value: 'major', label: `${SEVERITY_LABELS.major} và ${SEVERITY_LABELS.critical}` },
  { value: 'minor', label: 'Tất cả mức' },
];

/** Telegram now; Zalo OA / e-mail appear once the server has an OA / SMTP (NotificationChannel classes). */
function NotificationsCard() {
  const qc = useQueryClient();
  const [link, setLink] = useState<{ url: string; code: string; botUsername: string } | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['my-notifications'],
    queryFn: api.myNotifications,
    // while a link code is out, poll until the bot has stored the chat id
    refetchInterval: link ? 3000 : false,
  });
  const [draft, setDraft] = useState<{ minSeverity: AlarmSeverity; telegram: boolean } | null>(null);
  const cur = draft ?? (data ? { minSeverity: data.minSeverity, telegram: data.telegram.enabled } : null);
  if (link && data?.telegram.linked) setLink(null);
  const err = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Lỗi', 'error');
  const save = useMutation({
    mutationFn: () => api.saveNotifications(cur!),
    onSuccess: (d) => {
      qc.setQueryData(['my-notifications'], d);
      setDraft(null);
      toast('Đã lưu đăng ký thông báo', 'success');
    },
    onError: err,
  });
  const start = useMutation({ mutationFn: api.linkTelegram, onSuccess: setLink, onError: err });
  const unlink = useMutation({
    mutationFn: api.unlinkTelegram,
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['my-notifications'] });
      toast('Đã hủy liên kết Telegram');
    },
    onError: err,
  });

  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Bell className="h-4 w-4" /> Nhận thông báo cảnh báo</span>} />
      {isLoading || !data || !cur ? (
        <Spinner />
      ) : (
        <div className="space-y-3 p-4 text-sm">
          <Field label="Mức cảnh báo nhận">
            <Select value={cur.minSeverity} onChange={(e) => setDraft({ ...cur, minSeverity: e.target.value as AlarmSeverity })}>
              {SEVERITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Checkbox label="Telegram" checked={cur.telegram} disabled={!data.telegram.linked} onChange={(v) => setDraft({ ...cur, telegram: v })} />
              {data.telegram.linked ? (
                <Button size="sm" variant="ghost" loading={unlink.isPending} onClick={() => unlink.mutate()}>Hủy liên kết</Button>
              ) : data.telegram.available ? (
                <Button size="sm" variant="outline" loading={start.isPending} onClick={() => start.mutate()}>Liên kết Telegram</Button>
              ) : null}
            </div>
            {!data.telegram.available && !data.telegram.linked && <p className="text-xs text-subtle">Máy chủ chưa cấu hình bot Telegram.</p>}
            {data.telegram.linked && <p className="text-xs text-subtle">Đã liên kết với bot @{data.telegram.botUsername ?? '—'}.</p>}
            {link && (
              <div className="rounded-md border bg-muted/40 p-2 text-xs">
                Mở{' '}
                <a className="text-primary underline" href={link.url} target="_blank" rel="noreferrer">t.me/{link.botUsername}</a> và bấm <b>Start</b> (hoặc gửi{' '}
                <code>/start {link.code}</code> cho bot). Mã có hiệu lực 10 phút; trang tự cập nhật khi liên kết xong.
              </div>
            )}
          </div>
          <Checkbox label="Zalo OA (chưa hỗ trợ: cần OA doanh nghiệp)" checked={false} disabled onChange={() => undefined} />
          <Checkbox label="Email (chưa hỗ trợ: cần máy chủ SMTP)" checked={false} disabled onChange={() => undefined} />
          <p className="text-xs text-subtle">Chỉ nhận cảnh báo của tủ trong khu vực bạn được phân quyền. Nhiều cảnh báo cùng lúc được gom thành một tin tóm tắt.</p>
          <Button size="sm" disabled={!draft} loading={save.isPending} onClick={() => save.mutate()}>Lưu</Button>
        </div>
      )}
    </Card>
  );
}
