import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { CommandBatch } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { Button, Checkbox, Modal, Spinner, toast } from './ui';

/** Zone picker + "N cabinets affected" confirmation, then starts a batch and jumps to its progress page. */
export function SyncDialog({ open, onOpenChange, kind, title, initialZones = [] }: { open: boolean; onOpenChange: (v: boolean) => void; kind: CommandBatch['kind']; title: string; initialZones?: string[] }) {
  const nav = useNavigate();
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const [selected, setSelected] = useState<string[]>(initialZones);
  const [confirmStep, setConfirmStep] = useState(false);
  const preview = useQuery({ queryKey: ['batch-preview', selected], queryFn: () => api.previewBatch(selected), enabled: confirmStep && selected.length > 0 });
  const run = useMutation({
    mutationFn: () => api.createBatch(kind, selected),
    onSuccess: (b) => {
      toast(`Đã bắt đầu đồng bộ ${b.total} tủ`, 'success');
      onOpenChange(false);
      setConfirmStep(false);
      nav(`/batches?id=${b.id}`);
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Không tạo được lô lệnh', 'error'),
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
            <Button variant="outline" onClick={() => setConfirmStep(false)}>Quay lại</Button>
            <Button variant="danger" loading={run.isPending} disabled={!preview.data} onClick={() => run.mutate()}>
              Đồng bộ {preview.data?.total ?? ''} tủ
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Hủy</Button>
            <Button disabled={!selected.length} onClick={() => setConfirmStep(true)}>Tiếp tục</Button>
          </>
        )
      }
    >
      {!confirmStep ? (
        <div className="space-y-2">
          <div className="text-subtle">Chọn vùng cần đồng bộ:</div>
          {zones.data?.map((z) => (
            <div key={z.id}>
              <Checkbox
                label={`${z.name} (${z.cabinetCount} tủ)`}
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
          <p>
            Lệnh sẽ gửi tới <b>{preview.data?.total}</b> tủ, trong đó <b className="text-st-offline">{preview.data?.offline}</b> tủ đang mất kết nối (sẽ báo lỗi, có thể gửi lại sau).
          </p>
          <p className="text-subtle">Lệnh được đưa vào hàng đợi, gửi có giới hạn tốc độ; tiến độ hiển thị realtime.</p>
        </div>
      )}
    </Modal>
  );
}
