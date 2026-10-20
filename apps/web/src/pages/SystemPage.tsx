import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useDict } from '@/i18n';
import { SYSTEM } from '@/i18n/dict/system';
import { Card, PageHeader, Spinner } from '@/components/ui';

export function SystemPage() {
  const t = useDict(SYSTEM);
  const { data } = useQuery({ queryKey: ['system-stats'], queryFn: api.systemStats, refetchInterval: 5000 });
  const items = data
    ? [
        { label: t.cabinetsOnline, value: `${data.cabinetsOnline} / ${data.cabinetsTotal}` },
        { label: t.brokerConnections, value: data.brokerConnections },
        { label: t.telemetry, value: `${data.msgPerSec} msg/s` },
        { label: t.ingestLag, value: `${data.ingestLagMs} ms` },
        { label: t.commandQueue, value: data.commandQueue },
        { label: t.commandErrors, value: data.ackErrors24h },
        { label: t.dbSize, value: `${data.dbSizeGb} GB` },
        { label: t.uptime, value: t.hours(data.uptimeHours) },
      ]
    : [];
  return (
    <div className="p-4">
      <PageHeader title={t.title} subtitle={t.subtitle} />
      {!data ? (
        <Spinner />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {items.map((i) => (
            <Card key={i.label} className="p-4">
              <div className="text-xs text-subtle">{i.label}</div>
              <div className="text-2xl font-semibold tabular-nums">{i.value}</div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
