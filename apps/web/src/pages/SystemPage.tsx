import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useDict } from '@/i18n';
import { SYSTEM } from '@/i18n/dict/system';
import { Card, CardHeader, PageHeader, Spinner } from '@/components/ui';

const mb = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

export function SystemPage() {
  const t = useDict(SYSTEM);
  const s = t.storage;
  const { data } = useQuery({ queryKey: ['system-stats'], queryFn: api.systemStats, refetchInterval: 5000 });
  const storage = useQuery({ queryKey: ['system-storage'], queryFn: api.systemStorage, refetchInterval: 60_000 });
  /** policy text "30 days" / "6 hours" -> localized span */
  const span = (v: string | null, empty: string) => {
    if (!v) return empty;
    const m = /^(\d+) (day|hour)s?$/.exec(v);
    return m ? s.span(Number(m[1]), m[2] as 'day' | 'hour') : v;
  };
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
    <div className="space-y-4 p-4">
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
      <Card className="overflow-x-auto">
        <CardHeader title={s.title} subtitle={s.hint} />
        {!storage.data ? (
          <div className="p-6"><Spinner /></div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs text-subtle">
              <tr>
                <th className="px-3 py-2">{s.name}</th>
                <th className="px-3 py-2 text-right">{s.size}</th>
                <th className="px-3 py-2 text-right">{s.compressed}</th>
                <th className="px-3 py-2">{s.keep}</th>
                <th className="px-3 py-2">{s.compressAfter}</th>
              </tr>
            </thead>
            <tbody>
              {storage.data.items.map((r) => (
                <tr key={r.name} className="border-t">
                  <td className="px-3 py-2">
                    {s.labels[r.name] ?? r.name} <span className="text-xs text-subtle">{r.name}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{mb(r.bytes)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.compressedBytes ? mb(r.compressedBytes) : s.none}</td>
                  <td className="px-3 py-2">{span(r.keep, s.forever)}</td>
                  <td className="px-3 py-2">{span(r.compressAfter, s.none)}</td>
                </tr>
              ))}
              <tr className="border-t">
                <td className="px-3 py-2">{s.other}</td>
                <td className="px-3 py-2 text-right tabular-nums">{mb(storage.data.otherBytes)}</td>
                <td colSpan={3} />
              </tr>
              <tr className="border-t font-semibold">
                <td className="px-3 py-2">{s.total}</td>
                <td className="px-3 py-2 text-right tabular-nums">{mb(storage.data.totalBytes)}</td>
                <td colSpan={3} />
              </tr>
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
