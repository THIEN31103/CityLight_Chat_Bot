import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleSlash, HelpCircle, Play, XCircle } from 'lucide-react';
import type { CabinetDetail, Command, DiagStatus } from '@citylight/shared';
import { decodeRs485SelfTest } from '@citylight/shared';
import { api } from '@/lib/api';
import { subscribe } from '@/lib/realtime';
import { useSession } from '@/stores/session';
import { cn, fmtTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, KV, Spinner } from '@/components/ui';
import { ErrorCodeBadge } from '@/components/ErrorHelp';
import { useDict, useLang } from '@/i18n';
import { CABINET } from '@/i18n/dict/cabinet';
import { useCommand } from './useCommand';

// label: CABINET.diag.status[status]
const STATUS: Record<DiagStatus, { cls: string; Icon: typeof CheckCircle2 }> = {
  ok: { cls: 'text-st-on', Icon: CheckCircle2 },
  warn: { cls: 'text-st-dimming', Icon: AlertTriangle },
  fault: { cls: 'text-st-offline', Icon: XCircle },
  unknown: { cls: 'text-st-unknown', Icon: HelpCircle },
  unsupported: { cls: 'text-subtle', Icon: CircleSlash },
};

export function DiagnosticsTab({ detail }: { detail: CabinetDetail }) {
  const t = useDict(CABINET).diag;
  const lang = useLang((s) => s.lang);
  const id = detail.cabinet.id;
  const qc = useQueryClient();
  const can = useSession((s) => s.can('cabinet.control'));
  const { data, isLoading } = useQuery({ queryKey: ['diagnostics', id], queryFn: () => api.diagnostics(id), refetchInterval: 15000 });
  const { send } = useCommand(id, `${detail.cabinet.code} - ${detail.cabinet.name}`);

  useEffect(
    () =>
      subscribe<Command>('command.updated', (c) => {
        if (c.cabinetId === id && c.type === 'DIAG' && c.status === 'confirmed') qc.invalidateQueries({ queryKey: ['diagnostics', id] });
      }),
    [id, qc],
  );

  if (isLoading || !data) return <Spinner />;
  // decoded here (not the API's text) so it follows the UI language
  const selfTest = data.selfTest ? { ...data.selfTest, ...decodeRs485SelfTest(data.selfTest.summary, lang) } : null;
  const counts = data.items.reduce<Record<DiagStatus, number>>((acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }), { ok: 0, warn: 0, fault: 0, unknown: 0, unsupported: 0 });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(['fault', 'warn', 'ok', 'unknown'] as DiagStatus[]).map((k) => {
          const S = STATUS[k];
          return (
            <Card key={k} className="flex items-center gap-3 p-3">
              <S.Icon className={cn('h-6 w-6', S.cls)} />
              <div>
                <div className="text-xl font-semibold">{counts[k]}</div>
                <div className="text-xs text-subtle">{t.status[k]}</div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader title={t.partsTitle} subtitle={t.partsSub} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs text-subtle">
              <tr>
                <th className="px-3 py-2">{t.colPart}</th>
                <th className="px-3 py-2">{t.colStatus}</th>
                <th className="px-3 py-2">{t.colCode}</th>
                <th className="px-3 py-2">{t.colData}</th>
                <th className="px-3 py-2">{t.colVerdict}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => {
                const S = STATUS[i.status];
                return (
                  <tr key={i.subsystem} className={cn('border-t', i.status === 'fault' && 'bg-st-offline/5')}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{i.subsystem}</div>
                      <div className="text-xs text-subtle">{i.role}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={cn('inline-flex items-center gap-1 text-xs font-medium', S.cls)}>
                        <S.Icon className="h-4 w-4" /> {t.status[i.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <ErrorCodeBadge code={i.code} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{i.evidence}</td>
                    <td className="px-3 py-2 text-xs">{i.detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader
            title={t.selfTestTitle}
            subtitle={t.selfTestSub}
            actions={
              can && (
                <Button size="sm" variant="outline" disabled={!detail.state.online} onClick={() => send('DIAG', {}, t.runAction)}>
                  <Play className="h-4 w-4" /> {t.run}
                </Button>
              )
            }
          />
          <div className="px-4 py-2">
            {selfTest ? (
              <>
                <KV label={t.at} value={fmtTime(selfTest.at)} />
                <KV label={t.raw} value={<span className="font-mono">{selfTest.summary}</span>} />
                <KV label={t.rx} value={<span className="text-xs">{selfTest.rx}</span>} />
                <KV label={t.de} value={<span className="text-xs">{selfTest.de}</span>} />
                <KV label={t.tx} value={<span className="text-xs">{selfTest.tx}</span>} />
                <div className="pt-2">
                  {selfTest.fail ? <Badge tone="orange">{t.needCheck}</Badge> : <Badge tone="green">{t.noFault}</Badge>}
                </div>
              </>
            ) : (
              <div className="py-4 text-sm text-subtle">{t.neverRun}</div>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title={t.bootTitle} />
          <div className="px-4 py-2">
            <KV label={t.lastBoot} value={fmtTime(data.lastBootAt)} />
            <KV label={t.boots24h} value={<span className={data.bootsLast24h >= 3 ? 'text-st-offline' : ''}>{data.bootsLast24h}</span>} />
            <KV label={t.lastFrame} value={fmtTime(detail.state.lastSeenAt)} />
            <KV label={t.busCode} value={<span className="font-mono">{detail.state.busStatus ?? 'X'}</span>} />
            <p className="pt-2 text-xs text-subtle">{t.ledHint}</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
