import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, RefreshCw } from 'lucide-react';
import type { CommandBatch } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { fill, useDict } from '@/i18n';
import { BATCHES } from '@/i18n/dict/batches';
import { subscribe } from '@/lib/realtime';
import { cn, fmtTime } from '@/lib/utils';
import { SyncDialog } from '@/components/SyncDialog';
import { Badge, Button, Card, CardHeader, Empty, Input, PageHeader, Spinner, toast } from '@/components/ui';


export function BatchProgress({ b }: { b: CommandBatch }) {
  const t = useDict(BATCHES).progress;
  const pct = (n: number) => `${(n / Math.max(1, b.total)) * 100}%`;
  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
        <div className="bg-st-on" style={{ width: pct(b.succeeded) }} />
        <div className="bg-st-fault" style={{ width: pct(b.failed) }} />
        <div className="bg-st-offline" style={{ width: pct(b.offline) }} />
      </div>
      <div className="mt-1 flex flex-wrap gap-3 text-xs text-subtle">
        <span className="text-st-on">✔ {t.succeeded(b.succeeded)}</span>
        <span className="text-st-fault">✖ {t.failed(b.failed)}</span>
        <span className="text-st-offline">⌁ {t.offline(b.offline)}</span>
        <span>… {t.pending(b.pending)}</span>
      </div>
    </div>
  );
}

export function BatchesPage() {
  const qc = useQueryClient();
  const t = useDict(BATCHES);
  const [params, setParams] = useSearchParams();
  const selected = params.get('id');
  const [syncOpen, setSyncOpen] = useState(false);
  const list = useQuery({ queryKey: ['batches'], queryFn: api.batches });
  const detail = useQuery({ queryKey: ['batch', selected], queryFn: () => api.batch(selected!), enabled: !!selected });

  useEffect(
    () =>
      subscribe<CommandBatch>('batch.progress', (b) => {
        qc.invalidateQueries({ queryKey: ['batches'] });
        if (b.id === selected) qc.invalidateQueries({ queryKey: ['batch', selected] });
      }),
    [qc, selected],
  );

  const [otp, setOtp] = useState('');
  const retry = useMutation({
    mutationFn: () => api.retryBatch(selected!, otp),
    onError: (e) => toast(e instanceof ApiError ? e.message : t.retryFailed, 'error'),
    onSettled: () => setOtp(''),
    onSuccess: (b) => {
      toast(t.retrying, 'success');
      setParams({ id: b.id });
    },
  });

  return (
    <div className="p-4">
      <PageHeader
        title={t.title}
        subtitle={t.subtitle}
        actions={
          <Button onClick={() => setSyncOpen(true)}>
            <Clock className="h-4 w-4" /> {t.syncTime}
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <Card>
          <CardHeader title={t.runs} />
          {list.isLoading ? (
            <div className="p-6"><Spinner /></div>
          ) : !list.data?.length ? (
            <Empty>{t.noRuns}</Empty>
          ) : (
            <div className="divide-y">
              {list.data.map((b) => (
                <button key={b.id} onClick={() => setParams({ id: b.id })} className={cn('block w-full px-4 py-3 text-left hover:bg-muted/60', selected === b.id && 'bg-primary/10')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{t.kind[b.kind]}</span>
                    {b.finishedAt ? <Badge tone="green">{t.done}</Badge> : <Badge tone="blue">{t.running}</Badge>}
                  </div>
                  <div className="mb-1 text-xs text-subtle">{b.scope} · {t.cabinets(b.total)} · {fmtTime(b.createdAt)}</div>
                  <BatchProgress b={b} />
                </button>
              ))}
            </div>
          )}
        </Card>
        <Card>
          {!selected ? (
            <Empty>{t.pickRun}</Empty>
          ) : !detail.data ? (
            <div className="p-6"><Spinner /></div>
          ) : (
            <>
              <CardHeader
                title={`${t.kind[detail.data.batch.kind]} — ${detail.data.batch.scope}`}
                subtitle={fill(t.requestedBy, { by: detail.data.batch.requestedBy, at: fmtTime(detail.data.batch.createdAt) })}
                actions={
                  detail.data.batch.finishedAt &&
                  detail.data.batch.failed + detail.data.batch.offline > 0 && (
                    <div className="flex items-center gap-2">
                      <Input className="h-8 w-24" placeholder={t.otp} inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
                      <Button size="sm" variant="outline" disabled={otp.length !== 6} onClick={() => retry.mutate()} loading={retry.isPending}>
                        <RefreshCw className="h-4 w-4" /> {t.retry}
                      </Button>
                    </div>
                  )
                }
              />
              <div className="border-b p-4"><BatchProgress b={detail.data.batch} /></div>
              <div className="max-h-[60vh] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted text-left text-xs text-subtle">
                    <tr><th className="px-3 py-2">{t.col.cabinet}</th><th className="px-3 py-2">{t.col.result}</th><th className="px-3 py-2">{t.col.detail}</th></tr>
                  </thead>
                  <tbody>
                    {detail.data.items.map((it) => (
                      <tr key={it.cabinetId} className="border-t">
                        <td className="px-3 py-1.5">{it.cabinetName}</td>
                        <td className="px-3 py-1.5">
                          {it.result === 'ok' && <Badge tone="green">{t.result.ok}</Badge>}
                          {it.result === 'failed' && <Badge tone="orange">{t.result.failed}</Badge>}
                          {it.result === 'offline' && <Badge tone="red">{t.result.offline}</Badge>}
                          {it.result === 'pending' && <Badge>{t.result.pending}</Badge>}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-subtle">{it.error ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      </div>
      <SyncDialog open={syncOpen} onOpenChange={setSyncOpen} kind="time" title={t.syncTime} />
    </div>
  );
}
