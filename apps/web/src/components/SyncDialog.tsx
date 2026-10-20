import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { CommandBatch } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { Button, Checkbox, Field, Input, Modal, Spinner, toast } from './ui';
import { dictNow, useDict } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { SYNC } from '@/i18n/dict/sync';
import { rich } from '@/pages/cabinet/rich';

/** Zone picker + "N cabinets affected" confirmation, then starts a batch and jumps to its progress page. */
export function SyncDialog({ open, onOpenChange, kind, title, initialZones = [] }: { open: boolean; onOpenChange: (v: boolean) => void; kind: CommandBatch['kind']; title: string; initialZones?: string[] }) {
  const t = useDict(SYNC);
  const c = useDict(COMMON);
  const nav = useNavigate();
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const [selected, setSelected] = useState<string[]>(initialZones);
  const [confirmStep, setConfirmStep] = useState(false);
  const [otp, setOtp] = useState('');
  const preview = useQuery({ queryKey: ['batch-preview', selected], queryFn: () => api.previewBatch(selected), enabled: confirmStep && selected.length > 0 });
  const run = useMutation({
    mutationFn: () => api.createBatch(kind, selected, otp),
    onSuccess: (b) => {
      setOtp('');
      toast(dictNow(SYNC).started(b.total), 'success');
      onOpenChange(false);
      setConfirmStep(false);
      nav(`/batches?id=${b.id}`);
    },
    onError: (e) => {
      setOtp('');
      toast(e instanceof ApiError ? e.message : dictNow(SYNC).failed, 'error');
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setConfirmStep(false);
      }}
      title={title}
      footer={
        confirmStep ? (
          <>
            <Button variant="outline" onClick={() => setConfirmStep(false)}>{c.back}</Button>
            <Button variant="danger" loading={run.isPending} disabled={!preview.data || otp.length !== 6} onClick={() => run.mutate()}>
              {t.run(preview.data?.total)}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>{c.cancel}</Button>
            <Button disabled={!selected.length} onClick={() => setConfirmStep(true)}>{t.next}</Button>
          </>
        )
      }
    >
      {!confirmStep ? (
        <div className="space-y-2">
          <div className="text-subtle">{t.pickZones}</div>
          {zones.data?.map((z) => (
            <div key={z.id}>
              <Checkbox
                label={t.zone(z.name, z.cabinetCount)}
                checked={selected.includes(z.id)}
                onChange={(v) => setSelected((s) => (v ? [...s, z.id] : s.filter((x) => x !== z.id)))}
              />
            </div>
          ))}
        </div>
      ) : preview.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-2">
          <p>{rich(t.summary, { total: <b>{preview.data?.total}</b>, offline: <b className="text-st-offline">{preview.data?.offline}</b> })}</p>
          {!!preview.data?.blocked && <p className="text-subtle">{t.blocked(preview.data.blocked)}</p>}
          <p className="text-subtle">{t.queued}</p>
          <Field label={t.otp}>
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
