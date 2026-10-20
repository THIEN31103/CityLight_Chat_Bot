import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, Bell } from 'lucide-react';
import type { AlarmSeverity } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { fmtTime } from '@/lib/utils';
import { dictNow, fill, useDict, useLabels } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { ACCOUNT } from '@/i18n/dict/account';
import { ChangePasswordForm, TotpEnroll, scopeLabel, useAreaNames } from '@/components/security';
import { LangSwitch } from '@/components/LangSwitch';
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, KV, PageHeader, Select, Spinner, toast } from '@/components/ui';

export function AccountPage() {
  const { user, setUser } = useSession();
  const t = useDict(ACCOUNT);
  const c = useDict(COMMON);
  const L = useLabels();
  const names = useAreaNames();
  const [disablePw, setDisablePw] = useState('');
  const disable2fa = useMutation({
    mutationFn: () => api.disable2fa(disablePw),
    onSuccess: (u) => {
      setUser(u);
      setDisablePw('');
      toast(dictNow(ACCOUNT).totpDisabled);
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : dictNow(COMMON).error, 'error'),
  });

  if (!user) return null;

  return (
    <div className="mx-auto max-w-4xl p-4">
      <PageHeader title={t.title} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title={t.info} />
          <div className="px-4 py-2">
            <KV label={t.fullName} value={user.fullName} />
            <KV label={t.email} value={user.email} />
            <KV label={t.role} value={<Badge tone="blue">{L.role[user.role]}</Badge>} />
            <KV label={t.scope} value={scopeLabel(user, names)} />
            <KV label={t.lastLogin} value={fmtTime(user.lastLoginAt)} />
            <KV label={c.language} value={<LangSwitch />} />
          </div>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> {t.changePassword}</span>} />
          <div className="p-4">
            <ChangePasswordForm />
          </div>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> {t.totpTitle}</span>} actions={user.totpEnabled ? <Badge tone="green">{t.on}</Badge> : <Badge>{t.off}</Badge>} />
          <div className="space-y-3 p-4 text-sm">
            {!user.totpEnabled ? (
              <TotpEnroll onDone={setUser} />
            ) : user.totpRequired ? (
              <p className="text-subtle">{fill(t.totpRequired, { role: L.role[user.role] })}</p>
            ) : (
              <>
                <p className="text-subtle">{t.disableNeedsPassword}</p>
                <Field label={t.password}>
                  <Input type="password" autoComplete="current-password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} />
                </Field>
                <Button variant="outline" disabled={!disablePw} onClick={() => disable2fa.mutate()} loading={disable2fa.isPending}>{t.disable2fa}</Button>
              </>
            )}
          </div>
        </Card>
        <NotificationsCard />
      </div>
    </div>
  );
}

/** Telegram now; Zalo OA / e-mail appear once the server has an OA / SMTP (NotificationChannel classes). */
function NotificationsCard() {
  const t = useDict(ACCOUNT).notify;
  const c = useDict(COMMON);
  const L = useLabels();
  const severityOptions: { value: AlarmSeverity; label: string }[] = [
    { value: 'critical', label: fill(t.onlyCritical, { critical: L.severity.critical }) },
    { value: 'major', label: fill(t.majorAndCritical, { major: L.severity.major, critical: L.severity.critical }) },
    { value: 'minor', label: t.allLevels },
  ];
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
  const err = (e: unknown) => toast(e instanceof ApiError ? e.message : dictNow(COMMON).error, 'error');
  const save = useMutation({
    mutationFn: () => api.saveNotifications(cur!),
    onSuccess: (d) => {
      qc.setQueryData(['my-notifications'], d);
      setDraft(null);
      toast(dictNow(ACCOUNT).notify.saved, 'success');
    },
    onError: err,
  });
  const start = useMutation({ mutationFn: api.linkTelegram, onSuccess: setLink, onError: err });
  const unlink = useMutation({
    mutationFn: api.unlinkTelegram,
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['my-notifications'] });
      toast(dictNow(ACCOUNT).notify.unlinked);
    },
    onError: err,
  });

  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Bell className="h-4 w-4" /> {t.title}</span>} />
      {isLoading || !data || !cur ? (
        <Spinner />
      ) : (
        <div className="space-y-3 p-4 text-sm">
          <Field label={t.minSeverity}>
            <Select value={cur.minSeverity} onChange={(e) => setDraft({ ...cur, minSeverity: e.target.value as AlarmSeverity })}>
              {severityOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Checkbox label="Telegram" checked={cur.telegram} disabled={!data.telegram.linked} onChange={(v) => setDraft({ ...cur, telegram: v })} />
              {data.telegram.linked ? (
                <Button size="sm" variant="ghost" loading={unlink.isPending} onClick={() => unlink.mutate()}>{t.unlink}</Button>
              ) : data.telegram.available ? (
                <Button size="sm" variant="outline" loading={start.isPending} onClick={() => start.mutate()}>{t.link}</Button>
              ) : null}
            </div>
            {!data.telegram.available && !data.telegram.linked && <p className="text-xs text-subtle">{t.noBot}</p>}
            {data.telegram.linked && <p className="text-xs text-subtle">{fill(t.linkedTo, { bot: data.telegram.botUsername ?? '—' })}</p>}
            {link && (
              <div className="rounded-md border bg-muted/40 p-2 text-xs">
                {t.open}{' '}
                <a className="text-primary underline" href={link.url} target="_blank" rel="noreferrer">t.me/{link.botUsername}</a> {t.andPress} <b>Start</b> {t.orSend}{' '}
                <code>/start {link.code}</code> {t.toBot}
              </div>
            )}
          </div>
          <Checkbox label={t.zalo} checked={false} disabled onChange={() => undefined} />
          <Checkbox label={t.email} checked={false} disabled onChange={() => undefined} />
          <p className="text-xs text-subtle">{t.scopeNote}</p>
          <Button size="sm" disabled={!draft} loading={save.isPending} onClick={() => save.mutate()}>{c.save}</Button>
        </div>
      )}
    </Card>
  );
}
