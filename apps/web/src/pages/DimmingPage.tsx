import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Save, Undo2 } from 'lucide-react';
import type { DimmingProfile, LampGroup } from '@citylight/shared';
import { LAMP_GROUP_LABELS } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { DimmingEditor } from '@/components/DimmingEditor';
import { Button, Card, CardHeader, PageHeader, Select, Spinner, Unsupported, toast } from '@/components/ui';
import { cn } from '@/lib/utils';

export const DIMMING_SOURCE: Record<NonNullable<DimmingProfile['source']>, string> = {
  cabinet: 'hồ sơ riêng của tủ',
  zone: 'hồ sơ riêng của vùng',
  system: 'hồ sơ toàn hệ thống',
  default: 'mặc định có sẵn (chưa lưu)',
};

/** Dimming profiles (M9): system level, or one zone; cabinets inherit cabinet > zone > system > default. */
export function DimmingPage() {
  const qc = useQueryClient();
  const can = useSession((s) => s.can('dimming.manage'));
  const [group, setGroup] = useState<LampGroup>(0);
  const [zoneId, setZoneId] = useState(''); // '' = whole system
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const { data } = useQuery({ queryKey: ['group-dimming', group, zoneId], queryFn: () => api.groupDimming(group, zoneId || undefined) });
  const [p, setP] = useState<DimmingProfile | null>(null);
  useEffect(() => setP(data ?? null), [data]);
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Lỗi', 'error');
  const done = (msg: string) => {
    toast(msg, 'success');
    qc.invalidateQueries({ queryKey: ['group-dimming'] });
    qc.invalidateQueries({ queryKey: ['cabinet-dimming'] });
  };
  const save = useMutation({ mutationFn: () => api.setGroupDimming(group, p!, zoneId || undefined), onSuccess: () => done('Đã lưu hồ sơ tiết giảm'), onError: fail });
  const drop = useMutation({ mutationFn: () => api.dropGroupDimming(group, zoneId), onSuccess: () => done('Vùng đã quay về hồ sơ toàn hệ thống'), onError: fail });
  // Refused by the API (409 capability_unsupported, before any OTP) until the firmware can dim; its reason is shown as is.
  const sync = useMutation({
    mutationFn: () => api.createBatch('dimming', zoneId ? [zoneId] : (zones.data ?? []).map((z) => z.id), ''),
    onSuccess: () => toast('Đã tạo lệnh hàng loạt', 'success'),
    onError: fail,
  });
  const zoneName = zones.data?.find((z) => z.id === zoneId)?.name;
  const own = zoneId ? p?.source === 'zone' : p?.source === 'system';
  return (
    <div className="mx-auto max-w-5xl p-4">
      <PageHeader
        title="Đồng bộ cấu hình tiết giảm năng lượng"
        actions={
          <>
            {can && (
              <Button variant="outline" onClick={() => save.mutate()} loading={save.isPending} disabled={!p}>
                <Save className="h-4 w-4" /> Lưu cấu hình
              </Button>
            )}
            <Button onClick={() => sync.mutate()} loading={sync.isPending} disabled={!can || !zones.data?.length}>
              <RefreshCw className="h-4 w-4" /> Đồng bộ thông số
            </Button>
          </>
        }
      />
      <div className="mb-3">
        <Unsupported>Tủ hiện tại chưa có phần cứng dim. Hồ sơ được lưu ở máy chủ; đồng bộ xuống tủ sẽ chạy khi firmware hỗ trợ (capability “dimming”).</Unsupported>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={zoneId} onChange={(e) => setZoneId(e.target.value)} aria-label="Phạm vi hồ sơ">
          <option value="">Toàn hệ thống</option>
          {zones.data?.map((z) => (
            <option key={z.id} value={z.id}>
              Vùng {z.name}
            </option>
          ))}
        </Select>
        {([0, 1, 2, 3] as LampGroup[]).map((g) => (
          <button key={g} onClick={() => setGroup(g)} className={cn('rounded-md border px-3 py-1.5 text-sm', group === g ? 'border-primary bg-primary/10 font-medium' : 'bg-panel hover:bg-muted')}>
            {g} – {LAMP_GROUP_LABELS[g]}
          </button>
        ))}
      </div>
      <Card>
        <CardHeader
          title={`${LAMP_GROUP_LABELS[group]} · ${zoneName ? `Vùng ${zoneName}` : 'Toàn hệ thống'}`}
          subtitle={
            p?.source
              ? `Đang dùng ${DIMMING_SOURCE[p.source]}${zoneId && !own ? ' — lưu để tạo hồ sơ riêng cho vùng' : ''}. Tủ không có hồ sơ riêng sẽ theo hồ sơ này.`
              : 'Thời đoạn sau luôn bắt đầu đúng chỗ thời đoạn trước kết thúc'
          }
          actions={
            can && zoneId && own ? (
              <Button size="sm" variant="outline" onClick={() => drop.mutate()} loading={drop.isPending}>
                <Undo2 className="h-4 w-4" /> Bỏ hồ sơ riêng
              </Button>
            ) : undefined
          }
        />
        <div className="p-4">{p ? <DimmingEditor segments={p.segments} onChange={(segments) => setP({ ...p, segments })} disabled={!can} estimate={p.estimate} /> : <Spinner />}</div>
      </Card>
    </div>
  );
}
