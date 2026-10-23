import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { CommandBatch } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { Button, Checkbox, Field, Input, Modal, Select, Spinner, Textarea, toast } from './ui';
import { dictNow, useDict } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { SYNC } from '@/i18n/dict/sync';
import { rich } from '@/pages/cabinet/rich';

type ActionKey = keyof (typeof SYNC)['vi']['actions'];
/** Commands a control batch offers (S56), in menu order. */
const ACTIONS: Record<ActionKey, NonNullable<CommandBatch['command']>> = {
  allOn: { type: 'MANUAL_ALL', params: { on: true } },
  allOff: { type: 'MANUAL_ALL', params: { on: false } },
  b1On: { type: 'MANUAL_BRANCH', params: { branch: 1, on: true } },
  b1Off: { type: 'MANUAL_BRANCH', params: { branch: 1, on: false } },
  b2On: { type: 'MANUAL_BRANCH', params: { branch: 2, on: true } },
  b2Off: { type: 'MANUAL_BRANCH', params: { branch: 2, on: false } },
  auto: { type: 'AUTO', params: {} },
  pulse: { type: 'PULSE_ON', params: {} },
};

/**
 * Zones and / or cabinet codes (+ the command for kind = control), then "N cabinets affected" with 2FA; starts a
 * batch and jumps to its progress page.
 */
export function SyncDialog({ open, onOpenChange, kind, title, initialZones = [] }: { open: boolean; onOpenChange: (v: boolean) => void; kind: CommandBatch['kind']; title: string; initialZones?: string[] }) {
  const t = useDict(SYNC);
  const c = useDict(COMMON);
  const nav = useNavigate();
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const [selected, setSelected] = useState<string[]>(initialZones);
  const [codes, setCodes] = useState('');
  const [action, setAction] = useState<ActionKey | ''>('');
  const [confirmStep, setConfirmStep] = useState(false);
  const [otp, setOtp] = useState('');
  const control = kind === 'control';
  const command = control && action ? ACTIONS[action] : null;
  const target = { zoneIds: selected, codes: codes.trim() || undefined };
  const ready = (selected.length > 0 || codes.trim().length > 0) && (!control || !!command);
  const preview = useQuery({
    queryKey: ['batch-preview', kind, selected, codes.trim(), action],
    queryFn: () => api.previewBatch(kind, target, command),
    enabled: confirmStep && ready,
  });
  const tooMany = !!preview.data?.max && preview.data.total > preview.data.max;
  const run = useMutation({
    mutationFn: () => api.createBatch(kind, target, otp, command),
    onSuccess: (b) => {
      setOtp('');
      toast(control ? dictNow(SYNC).controlStarted(b.total) : dictNow(SYNC).started(b.total), 'success');
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
            <Button variant="danger" loading={run.isPending} disabled={!preview.data?.total || tooMany || otp.length !== 6} onClick={() => run.mutate()}>
              {control ? t.send(preview.data?.total) : t.run(preview.data?.total)}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>{c.cancel}</Button>
            <Button disabled={!ready} onClick={() => setConfirmStep(true)}>{t.next}</Button>
          </>
        )
      }
    >
      {!confirmStep ? (
        <div className="space-y-3">
          {control && (
            <Field label={t.command}>
              <Select className="w-full" value={action} onChange={(e) => setAction(e.target.value as ActionKey | '')}>
                <option value="">{t.pickCommand}</option>
                {(Object.keys(ACTIONS) as ActionKey[]).map((k) => (
                  <option key={k} value={k}>{t.actions[k]}</option>
                ))}
              </Select>
            </Field>
          )}
          <div className="text-subtle">{t.pickZones}</div>
          <Field label={t.zones}>
            <div className="max-h-56 space-y-1 overflow-auto rounded-md border p-2">
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
          </Field>
          <Field label={t.codes} hint={t.codesHint}>
            <Textarea rows={3} value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="TM01.0001, TM01.0002&#10;TL01.*" className="font-mono" />
          </Field>
        </div>
      ) : preview.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-2">
          {control && action ? (
            <p>{rich(t.controlSummary, { command: <b>{t.actions[action]}</b>, total: <b>{preview.data?.total}</b>, offline: <b className="text-st-offline">{preview.data?.offline}</b> })}</p>
          ) : (
            <p>{rich(t.summary, { total: <b>{preview.data?.total}</b>, offline: <b className="text-st-offline">{preview.data?.offline}</b> })}</p>
          )}
          {tooMany && <p className="font-medium text-st-fault">{t.tooMany(preview.data!.max!)}</p>}
          {command && (command.type === 'MANUAL_ALL' || command.type === 'MANUAL_BRANCH') && <p className="text-subtle">{t.manualNote}</p>}
          {!!preview.data?.blocked && <p className="text-subtle">{t.blocked(preview.data.blocked)}</p>}
          {!!preview.data?.unsupported && <p className="text-subtle">{t.unsupported(preview.data.unsupported)}</p>}
          <p className="text-subtle">{t.queued}</p>
          <Field label={t.otp}>
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
