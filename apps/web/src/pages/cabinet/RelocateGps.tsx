// "Cập nhật vị trí theo GPS" (owner request 2026-10-19): the server proposes the median of the recent fixes,
// a person with admin.devices confirms. Used from the cabinet Info tab and from an E802 (gps_drift) alarm.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, LocateFixed, MapPin } from 'lucide-react';
import type { GeoPoint, GpsSuggestion } from '@citylight/shared';
import { GPS_RELOCATE_MAX_SPREAD_M, GPS_RELOCATE_MIN_SAMPLES } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { Button, KV, Modal, Spinner, toast } from '@/components/ui';

const DIRS = ['Bắc', 'Đông Bắc', 'Đông', 'Đông Nam', 'Nam', 'Tây Nam', 'Tây', 'Tây Bắc'];

/** Initial bearing a -> b in degrees (0 = north, clockwise). */
function bearing(a: GeoPoint, b: GeoPoint): number {
  const r = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

const fmtPoint = (p: GeoPoint) => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;

/** Small compass: which way and how far the cabinet would move. */
function MoveCompass({ s }: { s: GpsSuggestion }) {
  if (!s.gps || s.distanceM === null) return null;
  const deg = bearing(s.declared, s.gps);
  return (
    <div className="flex items-center gap-3 rounded-md bg-muted/50 px-3 py-2">
      <svg viewBox="-20 -20 40 40" className="h-12 w-12 shrink-0 text-subtle" aria-hidden>
        <circle r="18" fill="none" stroke="currentColor" strokeWidth="1" />
        <text y="-10" textAnchor="middle" fontSize="7" fill="currentColor">B</text>
        <g transform={`rotate(${deg})`} className="text-primary">
          <line y1="6" y2="-13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          <path d="M-4.5 -8 L0 -15 L4.5 -8 Z" fill="currentColor" />
        </g>
        <circle r="2" fill="currentColor" />
      </svg>
      <div className="text-sm">
        Tủ sẽ dời <b>{s.distanceM} m</b> về hướng <b>{DIRS[Math.round(deg / 45) % 8]}</b>
      </div>
    </div>
  );
}

export function RelocateGpsDialog({
  cabinetId,
  label,
  open,
  onOpenChange,
  onLocate,
  onDone,
}: {
  cabinetId: string;
  label: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onLocate?: (p: GeoPoint) => void;
  /** after a successful move (e.g. close the alarm dialog that opened this) */
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['gps-suggestion', cabinetId], queryFn: () => api.gpsSuggestion(cabinetId), enabled: open, staleTime: 0 });
  const s = q.data;
  const apply = useMutation({
    mutationFn: () => api.relocateFromGps(cabinetId, s!.gps!),
    onSuccess: (r) => {
      toast(`Đã cập nhật vị trí tủ (dời ${r.movedM} m). Cảnh báo lệch GPS sẽ tự đóng sau vài phút`, 'success');
      for (const key of [['cabinet', cabinetId], ['map-cabinets'], ['gps-drift'], ['gps-suggestion', cabinetId], ['alarms']]) void qc.invalidateQueries({ queryKey: key });
      onOpenChange(false);
      onDone?.();
    },
    onError: (e) => {
      toast(e instanceof ApiError ? e.message : 'Cập nhật vị trí thất bại', 'error');
      void q.refetch();
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cập nhật vị trí tủ theo GPS"
      footer={
        <>
          {s?.gps && onLocate && (
            <Button variant="ghost" onClick={() => { onLocate(s.gps!); onOpenChange(false); }}>
              <MapPin className="h-4 w-4" /> Xem điểm GPS trên bản đồ
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Hủy</Button>
          <Button disabled={!s?.ok} loading={apply.isPending} onClick={() => apply.mutate()}>
            <LocateFixed className="h-4 w-4" /> Cập nhật vị trí
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <div className="text-sm">
          Tủ <b>{label}</b>
        </div>
        {q.isLoading || !s ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : (
          <>
            <div>
              <KV label="Vị trí khai báo (hiện tại)" value={<span className="font-mono">{fmtPoint(s.declared)}</span>} />
              <KV label={`GPS (trung vị ${s.windowMin} phút gần nhất)`} value={s.gps ? <span className="font-mono">{fmtPoint(s.gps)}</span> : '—'} />
              <KV label="Số điểm GPS" value={`${s.samples} (cần ≥ ${GPS_RELOCATE_MIN_SAMPLES})`} />
              <KV label="Độ tụ của GPS (90 % điểm trong)" value={s.spreadM === null ? '—' : `${s.spreadM} m (cho phép ≤ ${GPS_RELOCATE_MAX_SPREAD_M} m)`} />
              <KV label="Khoảng cách" value={s.distanceM === null ? '—' : `${s.distanceM} m`} />
            </div>
            <MoveCompass s={s} />
            {s.reason ? (
              <div className="rounded-md bg-muted px-3 py-2 text-sm">{s.reason}</div>
            ) : (
              <div className="flex gap-2 rounded-md border border-st-dimming/40 bg-st-dimming/10 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-st-dimming" />
                <div>
                  GPS là của <b>bộ điều khiển LTE</b>, không phải của tủ. Chỉ cập nhật khi tủ <b>thật sự được dời</b> tới đây. Nếu tủ không dời mà bộ
                  điều khiển bị lắp nhầm sang tủ khác, <b>đừng cập nhật</b>: kiểm tra lại LTID / phần cứng. Sau khi cập nhật, xem lại phường, khu vực và
                  tuyến/trụ của tủ nếu vị trí mới thuộc địa bàn khác.
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** Button + dialog, shown only to users who may edit cabinets. */
export function RelocateGpsButton({
  cabinetId,
  label,
  onLocate,
  onDone,
  size = 'sm',
}: {
  cabinetId: string;
  label: string;
  onLocate?: (p: GeoPoint) => void;
  onDone?: () => void;
  size?: 'sm' | 'md';
}) {
  const can = useSession((x) => x.can('admin.devices'));
  const [open, setOpen] = useState(false);
  if (!can) return null;
  return (
    <>
      <Button size={size} variant="outline" onClick={() => setOpen(true)}>
        <LocateFixed className="h-4 w-4" /> Cập nhật vị trí theo GPS
      </Button>
      <RelocateGpsDialog cabinetId={cabinetId} label={label} open={open} onOpenChange={setOpen} onLocate={onLocate} onDone={onDone} />
    </>
  );
}
