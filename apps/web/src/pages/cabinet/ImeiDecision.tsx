// E805 "Nghi giả mạo tủ" (S42): a frame came under this cabinet's LTID with another IMEI and was ignored.
// Either the modem was replaced (accept the new IMEI / re-learn) or it is forged (keep the IMEI, do nothing).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Fingerprint } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { fmtTime } from '@/lib/utils';
import { Badge, Button, Modal, Spinner, confirm, toast } from '@/components/ui';

export function ImeiDialog({ cabinetId, label, open, onOpenChange, onDone }: { cabinetId: string; label: string; open: boolean; onOpenChange: (v: boolean) => void; onDone?: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['imei-candidates', cabinetId], queryFn: () => api.imeiCandidates(cabinetId), enabled: open, staleTime: 0 });
  const set = useMutation({
    mutationFn: (imei: string | null) => api.setImei(cabinetId, imei),
    onSuccess: (r) => {
      toast(r.imei ? `Đã đổi IMEI tủ thành ${r.imei}` : 'IMEI sẽ được ghi nhận lại từ frame tiếp theo của tủ', 'success');
      for (const key of [['cabinet', cabinetId], ['imei-candidates', cabinetId], ['alarms']]) void qc.invalidateQueries({ queryKey: key });
      onOpenChange(false);
      onDone?.();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Không đổi được IMEI', 'error'),
  });
  const accept = async (imei: string) => {
    const ok = await confirm({
      title: 'Chấp nhận IMEI mới',
      body: (
        <div>
          Từ giờ chỉ frame mang IMEI <b className="font-mono">{imei}</b> mới được nhận cho tủ <b>{label}</b>; frame mang IMEI cũ sẽ bị bỏ qua. Chỉ làm khi
          modem EC25 của tủ <b>thật sự đã được thay</b>.
        </div>
      ),
      danger: true,
      confirmLabel: 'Chấp nhận',
    });
    if (ok) set.mutate(imei);
  };
  const relearn = async () => {
    const ok = await confirm({
      title: 'Học lại IMEI',
      body: 'Xóa IMEI đang ghi nhận; IMEI của frame tiếp theo (có thể là của kẻ giả mạo nếu họ gửi trước) sẽ thành IMEI của tủ. Chỉ dùng khi đang đứng ở tủ, vừa thay modem.',
      danger: true,
      confirmLabel: 'Học lại',
    });
    if (ok) set.mutate(null);
  };
  const d = q.data;
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="IMEI của tủ" className="w-[min(640px,calc(100vw-32px))]">
      <div className="space-y-3 p-4 text-sm">
        <div>
          Tủ <b>{label}</b> · IMEI đang ghi nhận: <b className="font-mono">{d ? (d.registered ?? '(chưa có, học từ frame tiếp theo)') : '…'}</b>
        </div>
        <div className="flex gap-2 rounded-md border border-st-dimming/40 bg-st-dimming/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-st-dimming" />
          <div>
            Broker còn cho kết nối ẩn danh: ai cũng gửi được frame mang LTID của tủ, nhưng ít ai biết IMEI. Frame có IMEI khác bị <b>bỏ qua</b>. Nếu{' '}
            <b>không ai thay modem</b>, đây là dữ liệu giả: <b>giữ nguyên IMEI</b>, không bấm gì.
          </div>
        </div>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-4"><Spinner /></div>
        ) : (
          <table className="w-full">
            <thead className="text-left text-xs text-subtle">
              <tr><th className="py-1">IMEI trong frame (24 giờ qua)</th><th>Số frame</th><th>Gần nhất</th><th /></tr>
            </thead>
            <tbody>
              {!d.seen.length && <tr><td colSpan={4} className="py-2 text-subtle">Không có frame nào trong 24 giờ</td></tr>}
              {d.seen.map((s) => (
                <tr key={s.imei ?? 'none'} className="border-t">
                  <td className="py-1.5 font-mono">{s.imei ?? <span className="text-subtle">(không có IMEI)</span>}</td>
                  <td>{s.frames}</td>
                  <td className="text-xs">{fmtTime(s.lastSeenAt)}</td>
                  <td className="text-right">
                    {s.registered ? <Badge tone="green">đang dùng</Badge> : s.imei && (
                      <Button size="sm" variant="outline" loading={set.isPending} onClick={() => void accept(s.imei!)}>Chấp nhận (đã thay modem)</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => void relearn()} disabled={set.isPending}>Học lại IMEI từ frame tiếp theo</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Button + dialog for users who may edit cabinets. */
export function ImeiButton({ cabinetId, label, onDone, text = 'Xử lý IMEI' }: { cabinetId: string; label: string; onDone?: () => void; text?: string }) {
  const can = useSession((x) => x.can('admin.devices'));
  const [open, setOpen] = useState(false);
  if (!can) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Fingerprint className="h-4 w-4" /> {text}
      </Button>
      <ImeiDialog cabinetId={cabinetId} label={label} open={open} onOpenChange={setOpen} onDone={onDone} />
    </>
  );
}
