// D7-lite command signing (S59), provider only (device.identity). Ingest turns signing on by itself from the
// cabinet's signed identity; the provider only accepts a replaced LTE board (UID, decision K7) or turns it off.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, KeyRound } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { fmtTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, KV, confirm, toast } from '@/components/ui';
import { dictNow, useDict } from '@/i18n';
import { CABINET } from '@/i18n/dict/cabinet';
import { rich } from './rich';

function useSigning(cabinetId: string, enabled = true) {
  const can = useSession((x) => x.can('device.identity'));
  const q = useQuery({ queryKey: ['signing', cabinetId], queryFn: () => api.signing(cabinetId), enabled: can && enabled, staleTime: 5_000 });
  return { can, q };
}

function useSigningActions(cabinetId: string) {
  const qc = useQueryClient();
  const done = (msg: string) => {
    toast(msg, 'success');
    for (const key of [['signing', cabinetId], ['cabinet', cabinetId], ['alarms']]) void qc.invalidateQueries({ queryKey: key });
  };
  const failed = (e: unknown) => toast(e instanceof ApiError ? e.message : dictNow(CABINET).signing.failed, 'error');
  const accept = useMutation({ mutationFn: (uid: string) => api.acceptUid(cabinetId, uid), onSuccess: () => done(dictNow(CABINET).signing.accepted), onError: failed });
  const disable = useMutation({ mutationFn: () => api.disableSigning(cabinetId), onSuccess: () => done(dictNow(CABINET).signing.disabled), onError: failed });
  return { accept, disable };
}

/** Pending board UID with its accept button; shown in the signing card and in the E805 dialog. */
export function UidPending({ cabinetId, label, enabled = true }: { cabinetId: string; label: string; enabled?: boolean }) {
  const t = useDict(CABINET).signing;
  const { can, q } = useSigning(cabinetId, enabled);
  const { accept } = useSigningActions(cabinetId);
  const uid = q.data?.uidPending;
  if (!can || !uid) return null;
  const onAccept = async () => {
    const ok = await confirm({
      title: t.acceptTitle,
      body: <div>{rich(t.acceptBody, { label: <b>{label}</b>, uid: <b className="font-mono">{uid}</b> })}</div>,
      danger: true,
      confirmLabel: t.accept,
    });
    if (ok) accept.mutate(uid);
  };
  return (
    <div className="flex gap-2 rounded-md border border-st-dimming/40 bg-st-dimming/10 px-3 py-2 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-st-dimming" />
      <div className="space-y-2">
        <div>{rich(t.pending, { uid: <b className="font-mono">{uid}</b>, replaced: <b>{t.pendingReplaced}</b> })}</div>
        <Button size="sm" variant="outline" loading={accept.isPending} onClick={() => void onAccept()}>{t.acceptButton}</Button>
      </div>
    </div>
  );
}

export function SigningCard({ cabinetId, label }: { cabinetId: string; label: string }) {
  const t = useDict(CABINET).signing;
  const { can, q } = useSigning(cabinetId);
  const { disable } = useSigningActions(cabinetId);
  if (!can) return null;
  const s = q.data;
  const onDisable = async () => {
    const ok = await confirm({ title: t.disableTitle, body: t.disableBody, danger: true, confirmLabel: t.disable });
    if (ok) disable.mutate();
  };
  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><KeyRound className="h-4 w-4" /> {t.title}</span>}
        actions={s?.signed && <Button size="sm" variant="ghost" loading={disable.isPending} onClick={() => void onDisable()}>{t.disable}</Button>}
      />
      <div className="space-y-2 px-4 py-2">
        <div>
          <KV label={t.state} value={s ? <Badge tone={s.signed ? 'green' : 'muted'}>{s.signed ? t.on : t.off}</Badge> : '…'} />
          <KV label={t.uid} value={<span className="font-mono">{s?.uid ?? t.never}</span>} />
          <KV label={t.fp} value={<span className="font-mono">{s?.keyFp ?? t.never}</span>} />
          <KV label={t.boot} value={s?.boot ?? t.never} />
          <KV label={t.seq} value={s ? s.cmdSeq : '…'} />
          <KV label={t.lastInvalid} value={s?.lastInvalidAt ? <span className="text-st-offline">{fmtTime(s.lastInvalidAt)}</span> : t.never} />
        </div>
        <UidPending cabinetId={cabinetId} label={label} />
        <div className="text-xs text-subtle">{t.note}</div>
      </div>
    </Card>
  );
}
