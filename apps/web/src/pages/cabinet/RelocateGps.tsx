// "Cập nhật vị trí theo GPS" (owner request 2026-10-19): the server proposes the median of the recent fixes,
// a person with admin.devices confirms. Used from the cabinet Info tab and from an E802 (gps_drift) alarm.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, LocateFixed, MapPin } from 'lucide-react';
import type { GeoPoint, GpsSuggestion } from '@citylight/shared';
import { GPS_RELOCATE_MAX_SPREAD_M, GPS_RELOCATE_MIN_SAMPLES, judgeGpsSuggestion } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { Button, KV, Modal, Spinner, toast } from '@/components/ui';
import { dictNow, fill, useDict, useLang } from '@/i18n';
import { CABINET } from '@/i18n/dict/cabinet';
import { COMMON } from '@/i18n/dict/common';
import { rich } from './rich';

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
  const t = useDict(CABINET).relocate;
  if (!s.gps || s.distanceM === null) return null;
  const deg = bearing(s.declared, s.gps);
  return (
    <div className="flex items-center gap-3 rounded-md bg-muted/50 px-3 py-2">
      <svg viewBox="-20 -20 40 40" className="h-12 w-12 shrink-0 text-subtle" aria-hidden>
        <circle r="18" fill="none" stroke="currentColor" strokeWidth="1" />
        <text y="-10" textAnchor="middle" fontSize="7" fill="currentColor">{t.north}</text>
        <g transform={`rotate(${deg})`} className="text-primary">
          <line y1="6" y2="-13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          <path d="M-4.5 -8 L0 -15 L4.5 -8 Z" fill="currentColor" />
        </g>
        <circle r="2" fill="currentColor" />
      </svg>
      <div className="text-sm">{rich(t.move, { distance: <b>{s.distanceM} m</b>, dir: <b>{t.dirs[Math.round(deg / 45) % 8]}</b> })}</div>
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
  const t = useDict(CABINET).relocate;
  const c = useDict(COMMON);
  const lang = useLang((x) => x.lang);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['gps-suggestion', cabinetId], queryFn: () => api.gpsSuggestion(cabinetId), enabled: open, staleTime: 0 });
  const s = q.data;
  // judged here (not the API's reason text) so the message follows the UI language
  const reason = s ? judgeGpsSuggestion(s, lang).reason : null;
  const apply = useMutation({
    mutationFn: () => api.relocateFromGps(cabinetId, s!.gps!),
    onSuccess: (r) => {
      toast(fill(dictNow(CABINET).relocate.applied, { m: r.movedM }), 'success');
      for (const key of [['cabinet', cabinetId], ['map-cabinets'], ['gps-drift'], ['gps-suggestion', cabinetId], ['alarms']]) void qc.invalidateQueries({ queryKey: key });
      onOpenChange(false);
      onDone?.();
    },
    onError: (e) => {
      toast(e instanceof ApiError ? e.message : dictNow(CABINET).relocate.failed, 'error');
      void q.refetch();
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t.title}
      footer={
        <>
          {s?.gps && onLocate && (
            <Button variant="ghost" onClick={() => { onLocate(s.gps!); onOpenChange(false); }}>
              <MapPin className="h-4 w-4" /> {t.viewGps}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>{c.cancel}</Button>
          <Button disabled={!s?.ok} loading={apply.isPending} onClick={() => apply.mutate()}>
            <LocateFixed className="h-4 w-4" /> {t.apply}
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <div className="text-sm">{rich(t.cabinet, { label: <b>{label}</b> })}</div>
        {q.isLoading || !s ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : (
          <>
            <div>
              <KV label={t.declared} value={<span className="font-mono">{fmtPoint(s.declared)}</span>} />
              <KV label={fill(t.gps, { n: s.windowMin })} value={s.gps ? <span className="font-mono">{fmtPoint(s.gps)}</span> : '—'} />
              <KV label={t.samples} value={fill(t.samplesValue, { n: s.samples, min: GPS_RELOCATE_MIN_SAMPLES })} />
              <KV label={t.spread} value={s.spreadM === null ? '—' : fill(t.spreadValue, { m: s.spreadM, max: GPS_RELOCATE_MAX_SPREAD_M })} />
              <KV label={t.distance} value={s.distanceM === null ? '—' : `${s.distanceM} m`} />
            </div>
            <MoveCompass s={s} />
            {reason ? (
              <div className="rounded-md bg-muted px-3 py-2 text-sm">{reason}</div>
            ) : (
              <div className="flex gap-2 rounded-md border border-st-dimming/40 bg-st-dimming/10 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-st-dimming" />
                <div>{rich(t.warning, { lte: <b>{t.warnLte}</b>, moved: <b>{t.warnMoved}</b>, dont: <b>{t.warnDont}</b> })}</div>
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
  const t = useDict(CABINET).relocate;
  const [open, setOpen] = useState(false);
  if (!can) return null;
  return (
    <>
      <Button size={size} variant="outline" onClick={() => setOpen(true)}>
        <LocateFixed className="h-4 w-4" /> {t.button}
      </Button>
      <RelocateGpsDialog cabinetId={cabinetId} label={label} open={open} onOpenChange={setOpen} onLocate={onLocate} onDone={onDone} />
    </>
  );
}
