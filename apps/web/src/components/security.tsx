// Account security pieces shared by the forced-setup screen, the Account page and the admin screen:
// TOTP enrolment (QR + manual key + recovery codes), password change, area scope picker.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { ChevronDown, ChevronRight, Copy, ShieldCheck } from 'lucide-react';
import type { Area, User } from '@citylight/shared';
import { api, ApiError, setReauthPrompt } from '@/lib/api';
import { dictNow, fill, useDict } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { SECURITY } from '@/i18n/dict/account';
import { Button, Checkbox, Field, Input, Modal, Spinner, toast } from '@/components/ui';

export const PASSWORD_MIN = 10;

const errText = (e: unknown) => (e instanceof ApiError ? e.message : dictNow(COMMON).networkError);

/** Area id -> name, for showing a user's scope. */
export function useAreaNames() {
  const { data } = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree, staleTime: 60_000 });
  return useMemo(() => new Map((data?.areas ?? []).map((a) => [a.id, a.name])), [data]);
}

/** Current language; callers re-render on a language change through their own useDict. */
export function scopeLabel(u: Pick<User, 'scopeAll' | 'scopeAreaIds'>, names: Map<string, string>) {
  const t = dictNow(SECURITY);
  if (u.scopeAll) return t.scopeAll;
  if (!u.scopeAreaIds.length) return t.scopeNone;
  return u.scopeAreaIds.map((id) => names.get(id) ?? id).join(', ');
}

/** Scan QR -> type a code -> show recovery codes once. */
export function TotpEnroll({ onDone }: { onDone: (u: User) => void }) {
  const t = useDict(SECURITY).totp;
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
        <p className="font-medium text-st-on">{t.enabled}</p>
        <p>{t.saveCodesBefore}<b>{t.saveCodesOnce}</b>{t.saveCodesAfter}</p>
        <div className="grid grid-cols-2 gap-1 rounded-md border bg-muted/40 p-3 font-mono text-sm">
          {result.recoveryCodes.map((c) => <span key={c}>{c}</span>)}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => navigator.clipboard?.writeText(result.recoveryCodes.join('\n')).then(() => toast(dictNow(SECURITY).totp.codesCopied, 'success'))}>
            <Copy className="h-4 w-4" /> {t.copy}
          </Button>
          <Checkbox label={t.savedThem} checked={saved} onChange={setSaved} />
        </div>
        <Button disabled={!saved} onClick={() => onDone(result.user)}>{t.done}</Button>
      </div>
    );

  if (!setup)
    return (
      <div className="space-y-3 text-sm">
        <p>{t.needApp}</p>
        <Button onClick={() => start.mutate()} loading={start.isPending}>{t.setup}</Button>
      </div>
    );

  return (
    <div className="space-y-3 text-sm">
      <p>{t.scan}</p>
      <div className="flex h-44 w-44 items-center justify-center rounded-md border bg-white p-1">
        {qr ? <img src={qr} alt={t.qrAlt} className="h-full w-full" /> : <Spinner />}
      </div>
      <p className="text-xs text-subtle">
        {t.manualKey} <code className="break-all rounded bg-muted px-1 py-0.5 font-mono">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
      </p>
      <Field label={t.enterCode}>
        <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="w-40 font-mono tracking-widest" />
      </Field>
      <Button disabled={code.length !== 6} loading={enable.isPending} onClick={() => enable.mutate()}>{t.confirmEnable}</Button>
    </div>
  );
}

export function ChangePasswordForm({ forced, onDone }: { forced?: boolean; onDone?: () => void }) {
  const t = useDict(SECURITY).password;
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const change = useMutation({
    mutationFn: () => api.changePassword(oldPw, newPw),
    onSuccess: () => {
      toast(dictNow(SECURITY).password.changed, 'success');
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
      <Field label={forced ? t.temp : t.current}>
        <Input type="password" autoComplete="current-password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
      </Field>
      <Field label={t.new} hint={fill(t.minLength, { n: PASSWORD_MIN })}>
        <Input type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
      </Field>
      <Field label={t.repeat} hint={mismatch ? <span className="text-st-offline">{t.mismatch}</span> : undefined}>
        <Input type="password" autoComplete="new-password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />
      </Field>
      <Button type="submit" disabled={!oldPw || !ok} loading={change.isPending}>{t.change}</Button>
    </form>
  );
}

export interface ScopeValue {
  scopeAll: boolean;
  scopeAreaIds: string[];
}

/** "Toàn hệ thống" or a set of districts / wards. A ticked district covers all its wards. */
export function ScopePicker({ value, onChange, disabled }: { value: ScopeValue; onChange: (v: ScopeValue) => void; disabled?: boolean }) {
  const t = useDict(SECURITY).scope;
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
      <Checkbox label={<span className="font-medium">{t.all}</span>} checked={value.scopeAll} disabled={disabled} onChange={(v) => onChange({ ...value, scopeAll: v })} />
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
                  <button type="button" className="rounded p-0.5 hover:bg-muted" onClick={() => setOpen({ ...open, [d.id]: !open[d.id] })} aria-label={fill(t.expand, { name: d.name })}>
                    {open[d.id] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </button>
                  <Checkbox
                    label={<span>{d.name} <span className="text-xs text-subtle">({t.cabinets(d.cabinetCount)}{!dOn && picked ? `, ${t.wards(picked)}` : ''})</span></span>}
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
      {!value.scopeAll && !value.scopeAreaIds.length && <p className="text-xs text-st-fault">{t.noneWarning}</p>}
    </div>
  );
}

/**
 * A4 (S45): global "enter your 2FA code" dialog. Any API call answered 403 reauth_required waits on it (lib/api.ts),
 * then is sent again; one code covers 5 minutes of such actions on this session. Mounted once in AppShell.
 */
export function ReauthHost() {
  const t = useDict(SECURITY).reauth;
  const c = useDict(COMMON);
  const [pending, setPending] = useState<((ok: boolean) => void) | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReauthPrompt(
      () =>
        new Promise<boolean>((resolve) => {
          setCode('');
          setError(null);
          setPending(() => resolve);
        }),
    );
    return () => setReauthPrompt(null);
  }, []);

  const close = (ok: boolean) => {
    pending?.(ok);
    setPending(null);
  };
  const submit = async () => {
    if (!/^\d{6}$/.test(code)) return setError(t.need6);
    setBusy(true);
    try {
      await api.reauth(code);
      close(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_otp') {
        setError(e.message);
        setCode('');
      } else {
        toast(errText(e), 'error');
        close(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!pending}
      onOpenChange={(v) => !v && close(false)}
      title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> {t.title}</span>}
      footer={
        <>
          <Button variant="outline" onClick={() => close(false)}>{c.cancel}</Button>
          <Button loading={busy} onClick={() => void submit()}>{c.confirm}</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3">
        <p className="text-sm text-subtle">{t.body}</p>
        <Field label={t.code}>
          <Input
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            className="font-mono tracking-widest"
            value={code}
            onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setError(null); }}
          />
        </Field>
        {error && <p className="text-sm text-st-offline">{error}</p>}
      </form>
    </Modal>
  );
}
