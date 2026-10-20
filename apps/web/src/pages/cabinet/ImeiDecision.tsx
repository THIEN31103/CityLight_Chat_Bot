// E805 "Nghi giả mạo tủ" (S42): a frame came under this cabinet's LTID with another IMEI and was ignored.
// Either the modem was replaced (accept the new IMEI / re-learn) or it is forged (keep the IMEI, do nothing).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Fingerprint } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { fmtTime } from '@/lib/utils';
import { Badge, Button, Modal, Spinner, confirm, toast } from '@/components/ui';
import { dictNow, fill, useDict } from '@/i18n';
import { CABINET } from '@/i18n/dict/cabinet';
import { rich } from './rich';

export function ImeiDialog({ cabinetId, label, open, onOpenChange, onDone }: { cabinetId: string; label: string; open: boolean; onOpenChange: (v: boolean) => void; onDone?: () => void }) {
  const t = useDict(CABINET).imei;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['imei-candidates', cabinetId], queryFn: () => api.imeiCandidates(cabinetId), enabled: open, staleTime: 0 });
  const set = useMutation({
    mutationFn: (imei: string | null) => api.setImei(cabinetId, imei),
    onSuccess: (r) => {
      const d = dictNow(CABINET).imei;
      toast(r.imei ? fill(d.changed, { imei: r.imei }) : d.relearned, 'success');
      for (const key of [['cabinet', cabinetId], ['imei-candidates', cabinetId], ['alarms']]) void qc.invalidateQueries({ queryKey: key });
      onOpenChange(false);
      onDone?.();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : dictNow(CABINET).imei.failed, 'error'),
  });
  const accept = async (imei: string) => {
    const ok = await confirm({
      title: t.acceptTitle,
      body: <div>{rich(t.acceptBody, { imei: <b className="font-mono">{imei}</b>, label: <b>{label}</b>, replaced: <b>{t.acceptReplaced}</b> })}</div>,
      danger: true,
      confirmLabel: t.accept,
    });
    if (ok) set.mutate(imei);
  };
  const relearn = async () => {
    const ok = await confirm({
      title: t.relearnTitle,
      body: t.relearnBody,
      danger: true,
      confirmLabel: t.relearn,
    });
    if (ok) set.mutate(null);
  };
  const d = q.data;
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t.title} className="w-[min(640px,calc(100vw-32px))]">
      <div className="space-y-3 p-4 text-sm">
        <div>{rich(t.header, { label: <b>{label}</b>, imei: <b className="font-mono">{d ? (d.registered ?? t.registeredNone) : '…'}</b> })}</div>
        <div className="flex gap-2 rounded-md border border-st-dimming/40 bg-st-dimming/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-st-dimming" />
          <div>{rich(t.warning, { ignored: <b>{t.warnIgnored}</b>, noReplace: <b>{t.warnNoReplace}</b>, keep: <b>{t.warnKeep}</b> })}</div>
        </div>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-4"><Spinner /></div>
        ) : (
          <table className="w-full">
            <thead className="text-left text-xs text-subtle">
              <tr><th className="py-1">{t.colImei}</th><th>{t.colFrames}</th><th>{t.colLast}</th><th /></tr>
            </thead>
            <tbody>
              {!d.seen.length && <tr><td colSpan={4} className="py-2 text-subtle">{t.noFrames}</td></tr>}
              {d.seen.map((s) => (
                <tr key={s.imei ?? 'none'} className="border-t">
                  <td className="py-1.5 font-mono">{s.imei ?? <span className="text-subtle">{t.noImei}</span>}</td>
                  <td>{s.frames}</td>
                  <td className="text-xs">{fmtTime(s.lastSeenAt)}</td>
                  <td className="text-right">
                    {s.registered ? <Badge tone="green">{t.inUse}</Badge> : s.imei && (
                      <Button size="sm" variant="outline" loading={set.isPending} onClick={() => void accept(s.imei!)}>{t.acceptButton}</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => void relearn()} disabled={set.isPending}>{t.relearnButton}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Button + dialog for users who may edit cabinets. */
export function ImeiButton({ cabinetId, label, onDone, text }: { cabinetId: string; label: string; onDone?: () => void; text?: string }) {
  const t = useDict(CABINET).imei;
  const can = useSession((x) => x.can('device.identity'));
  const [open, setOpen] = useState(false);
  if (!can) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Fingerprint className="h-4 w-4" /> {text ?? t.button}
      </Button>
      <ImeiDialog cabinetId={cabinetId} label={label} open={open} onOpenChange={setOpen} onDone={onDone} />
    </>
  );
}
