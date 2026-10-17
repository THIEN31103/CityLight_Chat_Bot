import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtTime } from '@/lib/utils';
import { Badge, Card, Empty, PageHeader, Select, Spinner } from '@/components/ui';
import { BatchProgress, KIND_LABEL } from '../BatchesPage';

export function SyncLogPage() {
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const batches = useQuery({ queryKey: ['batches'], queryFn: api.batches, refetchInterval: 3000 });
  const [zone, setZone] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['batch', open], queryFn: () => api.batch(open!), enabled: !!open });
  const list = (batches.data ?? []).filter((b) => !zone || b.scope.includes(zone));

  return (
    <div className="p-4">
      <PageHeader
        title="Nhật ký đồng bộ theo vùng"
        actions={
          <Select value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="">Tất cả vùng</option>
            {zones.data?.map((z) => <option key={z.id} value={z.name}>{z.name}</option>)}
          </Select>
        }
      />
      <Card>
        {batches.isLoading ? (
          <div className="p-6"><Spinner /></div>
        ) : !list.length ? (
          <Empty>
            Chưa có lần đồng bộ nào trong phiên này. Tạo ở <Link className="text-primary" to="/schedules">Lịch chiếu sáng</Link> hoặc <Link className="text-primary" to="/batches">Đồng bộ hàng loạt</Link>.
          </Empty>
        ) : (
          <div className="divide-y">
            {list.map((b) => (
              <div key={b.id}>
                <button className="grid w-full grid-cols-[20px_1fr_200px] items-center gap-3 px-4 py-3 text-left hover:bg-muted/50" onClick={() => setOpen(open === b.id ? null : b.id)}>
                  {open === b.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <div>
                    <div className="font-medium">{KIND_LABEL[b.kind]} · {b.scope}</div>
                    <div className="text-xs text-subtle">{b.requestedBy} · {fmtTime(b.createdAt)} · {b.total} tủ</div>
                  </div>
                  <BatchProgress b={b} />
                </button>
                {open === b.id && (
                  <div className="max-h-72 overflow-auto bg-muted/30 px-10 py-2">
                    {detail.data?.items.map((it) => (
                      <div key={it.cabinetId} className="flex items-center justify-between border-b py-1 text-sm last:border-0">
                        <span>{it.cabinetName}</span>
                        <span className="flex items-center gap-2">
                          <span className="text-xs text-subtle">{it.error}</span>
                          <Badge tone={it.result === 'ok' ? 'green' : it.result === 'pending' ? 'muted' : it.result === 'offline' ? 'red' : 'orange'}>
                            {it.result === 'ok' ? 'Thành công' : it.result === 'pending' ? 'Đang chờ' : it.result === 'offline' ? 'Mất kết nối' : 'Lỗi'}
                          </Badge>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
