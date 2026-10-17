import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, PageHeader, Spinner } from '@/components/ui';

export function SystemPage() {
  const { data } = useQuery({ queryKey: ['system-stats'], queryFn: api.systemStats, refetchInterval: 5000 });
  const items = data
    ? [
        { label: 'Tủ online', value: `${data.cabinetsOnline} / ${data.cabinetsTotal}` },
        { label: 'Kết nối broker', value: data.brokerConnections },
        { label: 'Telemetry', value: `${data.msgPerSec} msg/s` },
        { label: 'Độ trễ ingest', value: `${data.ingestLagMs} ms` },
        { label: 'Hàng đợi lệnh', value: data.commandQueue },
        { label: 'Lệnh lỗi / timeout', value: data.ackErrors24h },
        { label: 'Dung lượng DB', value: `${data.dbSizeGb} GB` },
        { label: 'Uptime', value: `${data.uptimeHours} giờ` },
      ]
    : [];
  return (
    <div className="p-4">
      <PageHeader title="Giám sát hệ thống" subtitle="Số liệu vận hành của server (mock ở M1-UI; thật từ /metrics ở M1)" />
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
