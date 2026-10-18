import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { CommandBatch } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { Button, Checkbox, Field, Input, Modal, Spinner, toast } from './ui';

/** Zone picker + "N cabinets affected" confirmation, then starts a batch and jumps to its progress page. */
export function SyncDialog({ open, onOpenChange, kind, title, initialZones = [] }: { open: boolean; onOpenChange: (v: boolean) => void; kind: CommandBatch['kind']; title: string; initialZones?: string[] }) {
  const nav = useNavigate();
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const [selected, setSelected] = useState<string[]>(initialZones);
  const [confirmStep, setConfirmStep] = useState(false);
  const [otp, setOtp] = useState('');
  const preview = useQuery({ queryKey: ['batch-preview', selected], queryFn: () => api.previewBatch(selected), enabled: confirmStep && selected.length > 0 });
  const run = useMutation({
    mutationFn: () => api.createBatch(kind, selected, otp),
    onSuccess: (b) => {
      setOtp('');
      toast(`Đã bắt đầu đồng bộ ${b.total} tủ`, 'success');
      onOpenChange(false);
      setConfirmStep(false);
      nav(`/batches?id=${b.id}`);
    },
    onError: (e) => {
      setOtp('');
      toast(e instanceof ApiError ? e.message : 'Không tạo được lô lệnh', 'error');
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
            <Button variant="outline" onClick={() => setConfirmStep(false)}>Quay lại</Button>
            <Button variant="danger" loading={run.isPending} disabled={!preview.data || otp.length !== 6} onClick={() => run.mutate()}>
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
            Lệnh sẽ gửi tới <b>{preview.data?.total}</b> tủ, trong đó <b className="text-st-offline">{preview.data?.offline}</b> tủ đang mất kết nối (ghi nhận offline; lịch sẽ tự gửi khi tủ có kết nối lại).
          </p>
          {!!preview.data?.blocked && <p className="text-subtle">{preview.data.blocked} tủ chạy firmware cũ 1307ebc sẽ bị bỏ qua.</p>}
          <p className="text-subtle">Lệnh được đưa vào hàng đợi, gửi có giới hạn tốc độ; tiến độ hiển thị realtime.</p>
          <Field label="Mã xác thực 2 lớp (6 số) để xác nhận">
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
