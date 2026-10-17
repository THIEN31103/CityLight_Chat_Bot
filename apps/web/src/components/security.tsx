// Account security pieces shared by the forced-setup screen, the Account page and the admin screen:
// TOTP enrolment (QR + manual key + recovery codes), password change, area scope picker.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import type { Area, User } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { Button, Checkbox, Field, Input, Spinner, toast } from '@/components/ui';

export const PASSWORD_MIN = 10;

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Không kết nối được máy chủ');

/** Area id -> name, for showing a user's scope. */
export function useAreaNames() {
  const { data } = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree, staleTime: 60_000 });
  return useMemo(() => new Map((data?.areas ?? []).map((a) => [a.id, a.name])), [data]);
}

export function scopeLabel(u: Pick<User, 'scopeAll' | 'scopeAreaIds'>, names: Map<string, string>) {
  if (u.scopeAll) return 'Toàn hệ thống';
  if (!u.scopeAreaIds.length) return 'Chưa gán khu vực (không thấy tủ nào)';
  return u.scopeAreaIds.map((id) => names.get(id) ?? id).join(', ');
}

/** Scan QR -> type a code -> show recovery codes once. */
export function TotpEnroll({ onDone }: { onDone: (u: User) => void }) {
  const [setup, setSetup] = useState<{ otpauthUrl: string; secret: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [result, setResult] = useState<{ user: User; recoveryCodes: string[] } | null>(null);
  const [saved, setSaved] = useState(false);

  const start = useMutation({ mutationFn: api.setup2fa, onSuccess: setSetup, onError: (e) => toast(errText(e), 'error') });
  const enable = useMutation({ mutationFn: () => api.enable2fa(code), onSuccess: setResult, onError: (e) => toast(errText(e), 'error') });

  useEffect(() => {
    if (!setup) return;
    QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 176 }).then(setQr, () => setQr(null));
  }, [setup]);

  if (result)
    return (
      <div className="space-y-3 text-sm">
        <p className="font-medium text-st-on">Đã bật xác thực 2 lớp.</p>
        <p>Lưu 8 mã khôi phục dưới đây ở nơi an toàn. Mỗi mã dùng được <b>một lần</b> khi mất điện thoại. Mã chỉ hiện lần này.</p>
        <div className="grid grid-cols-2 gap-1 rounded-md border bg-muted/40 p-3 font-mono text-sm">
          {result.recoveryCodes.map((c) => <span key={c}>{c}</span>)}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => navigator.clipboard?.writeText(result.recoveryCodes.join('\n')).then(() => toast('Đã chép mã khôi phục', 'success'))}>
            <Copy className="h-4 w-4" /> Chép
          </Button>
          <Checkbox label="Tôi đã lưu các mã này" checked={saved} onChange={setSaved} />
        </div>
        <Button disabled={!saved} onClick={() => onDone(result.user)}>Xong</Button>
      </div>
    );

  if (!setup)
    return (
      <div className="space-y-3 text-sm">
        <p>Cần một ứng dụng xác thực trên điện thoại: Google Authenticator, Microsoft Authenticator hoặc Authy.</p>
        <Button onClick={() => start.mutate()} loading={start.isPending}>Thiết lập 2FA</Button>
      </div>
    );

  return (
    <div className="space-y-3 text-sm">
      <p>1. Mở ứng dụng xác thực, quét mã QR:</p>
      <div className="flex h-44 w-44 items-center justify-center rounded-md border bg-white p-1">
        {qr ? <img src={qr} alt="Mã QR thiết lập 2FA" className="h-full w-full" /> : <Spinner />}
      </div>
      <p className="text-xs text-subtle">
        Không quét được? Nhập khóa thủ công: <code className="break-all rounded bg-muted px-1 py-0.5 font-mono">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
      </p>
      <Field label="2. Nhập mã 6 số đang hiện trong ứng dụng">
        <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="w-40 font-mono tracking-widest" />
      </Field>
      <Button disabled={code.length !== 6} loading={enable.isPending} onClick={() => enable.mutate()}>Xác nhận & bật 2FA</Button>
    </div>
  );
}

export function ChangePasswordForm({ forced, onDone }: { forced?: boolean; onDone?: () => void }) {
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const change = useMutation({
    mutationFn: () => api.changePassword(oldPw, newPw),
    onSuccess: () => {
      toast('Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất.', 'success');
      setOldPw('');
      setNewPw('');
      setNewPw2('');
      onDone?.();
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const mismatch = newPw2.length > 0 && newPw !== newPw2;
  const ok = newPw.length >= PASSWORD_MIN && newPw === newPw2 && newPw !== oldPw;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (oldPw && ok) change.mutate();
      }}
    >
      <Field label={forced ? 'Mật khẩu tạm (quản trị viên gửi)' : 'Mật khẩu hiện tại'}>
        <Input type="password" autoComplete="current-password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
      </Field>
      <Field label="Mật khẩu mới" hint={`Tối thiểu ${PASSWORD_MIN} ký tự`}>
        <Input type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
      </Field>
      <Field label="Nhập lại mật khẩu mới" hint={mismatch ? <span className="text-st-offline">Không khớp</span> : undefined}>
        <Input type="password" autoComplete="new-password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />
      </Field>
      <Button type="submit" disabled={!oldPw || !ok} loading={change.isPending}>Đổi mật khẩu</Button>
    </form>
  );
}

export interface ScopeValue {
  scopeAll: boolean;
  scopeAreaIds: string[];
}

/** "Toàn hệ thống" or a set of districts / wards. A ticked district covers all its wards. */
export function ScopePicker({ value, onChange, disabled }: { value: ScopeValue; onChange: (v: ScopeValue) => void; disabled?: boolean }) {
  const { data, isLoading } = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree, staleTime: 60_000 });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const districts = useMemo(() => (data?.areas ?? []).filter((a) => a.kind === 'district'), [data]);
  const wardsOf = (d: Area) => (data?.areas ?? []).filter((a) => a.parentId === d.id);
  const set = new Set(value.scopeAreaIds);
  const toggle = (id: string, on: boolean, clear: string[] = []) => {
    const next = new Set(value.scopeAreaIds);
    clear.forEach((x) => next.delete(x));
    if (on) next.add(id);
    else next.delete(id);
    onChange({ ...value, scopeAreaIds: [...next] });
  };

  return (
    <div className="space-y-2">
      <Checkbox label={<span className="font-medium">Toàn hệ thống (mọi tủ, kể cả tủ chưa phân khu vực)</span>} checked={value.scopeAll} disabled={disabled} onChange={(v) => onChange({ ...value, scopeAll: v })} />
      {!value.scopeAll && (
        <div className="max-h-64 overflow-auto rounded-md border p-2">
          {isLoading && <Spinner />}
          {districts.map((d) => {
            const wards = wardsOf(d);
            const dOn = set.has(d.id);
            const picked = wards.filter((w) => set.has(w.id)).length;
            return (
              <div key={d.id}>
                <div className="flex items-center gap-1">
                  <button type="button" className="rounded p-0.5 hover:bg-muted" onClick={() => setOpen({ ...open, [d.id]: !open[d.id] })} aria-label={`Mở ${d.name}`}>
                    {open[d.id] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </button>
                  <Checkbox
                    label={<span>{d.name} <span className="text-xs text-subtle">({d.cabinetCount} tủ{!dOn && picked ? `, ${picked} phường` : ''})</span></span>}
                    checked={dOn}
                    disabled={disabled}
                    // ticking a district replaces its individual wards
                    onChange={(v) => toggle(d.id, v, wards.map((w) => w.id))}
                  />
                </div>
                {open[d.id] && (
                  <div className="ml-7 grid grid-cols-2 gap-x-3">
                    {wards.map((w) => (
                      <Checkbox key={w.id} label={<span className="text-xs">{w.name}</span>} checked={dOn || set.has(w.id)} disabled={disabled || dOn} onChange={(v) => toggle(w.id, v)} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!value.scopeAll && !value.scopeAreaIds.length && <p className="text-xs text-st-fault">Chưa chọn khu vực: người dùng sẽ không thấy tủ nào.</p>}
    </div>
  );
}
