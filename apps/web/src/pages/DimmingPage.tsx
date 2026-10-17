import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Save } from 'lucide-react';
import type { DimmingProfile, LampGroup } from '@citylight/shared';
import { LAMP_GROUP_LABELS } from '@citylight/shared';
import { api } from '@/lib/api';
import { DimmingEditor } from '@/components/DimmingEditor';
import { Button, Card, CardHeader, PageHeader, Spinner, Unsupported, toast } from '@/components/ui';
import { cn } from '@/lib/utils';

export function DimmingPage() {
  const qc = useQueryClient();
  const [group, setGroup] = useState<LampGroup>(0);
  const { data } = useQuery({ queryKey: ['group-dimming', group], queryFn: () => api.groupDimming(group) });
  const [p, setP] = useState<DimmingProfile | null>(null);
  useEffect(() => setP(data ?? null), [data]);
  const save = useMutation({
    mutationFn: () => api.setGroupDimming(group, p!),
    onSuccess: () => {
      toast('Đã lưu cấu hình tiết giảm', 'success');
      qc.invalidateQueries({ queryKey: ['group-dimming', group] });
    },
  });
  return (
    <div className="mx-auto max-w-5xl p-4">
      <PageHeader
        title="Đồng bộ cấu hình tiết giảm năng lượng"
        actions={
          <>
            <Button variant="outline" onClick={() => save.mutate()} loading={save.isPending} disabled={!p}>
              <Save className="h-4 w-4" /> Lưu cấu hình
            </Button>
            <Button disabled title="Thiết bị chưa hỗ trợ tiết giảm">
              <RefreshCw className="h-4 w-4" /> Đồng bộ thông số
            </Button>
          </>
        }
      />
      <div className="mb-3">
        <Unsupported>Tủ hiện tại chưa có phần cứng dim. Cấu hình được lưu ở máy chủ; nút Đồng bộ sẽ bật khi firmware hỗ trợ (capability “dimming”).</Unsupported>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        {([0, 1, 2, 3] as LampGroup[]).map((g) => (
          <button key={g} onClick={() => setGroup(g)} className={cn('rounded-md border px-3 py-1.5 text-sm', group === g ? 'border-primary bg-primary/10 font-medium' : 'bg-panel hover:bg-muted')}>
            {g} – {LAMP_GROUP_LABELS[g]}
          </button>
        ))}
      </div>
      <Card>
        <CardHeader title={`Thời đoạn tiết giảm — ${LAMP_GROUP_LABELS[group]}`} subtitle="Thời đoạn sau luôn bắt đầu đúng chỗ thời đoạn trước kết thúc" />
        <div className="p-4">{p ? <DimmingEditor segments={p.segments} onChange={(segments) => setP({ ...p, segments })} /> : <Spinner />}</div>
      </Card>
    </div>
  );
}
