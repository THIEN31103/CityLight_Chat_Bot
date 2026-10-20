import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { RefreshCw, Save, Sun } from 'lucide-react';
import type { Schedule } from '@citylight/shared';
import { astroPreview, vnDate } from '@citylight/shared';
import { api } from '@/lib/api';
import { fill, useDict } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { SCHEDULES } from '@/i18n/dict/schedules';
import { EChart } from '@/components/EChart';
import { SyncDialog } from '@/components/SyncDialog';
import { Button, Card, CardHeader, Checkbox, Field, Input, PageHeader, Spinner, Unsupported, toast } from '@/components/ui';
import { cn } from '@/lib/utils';

const toMin = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h! * 60 + m!;
};

export function SchedulesPage() {
  const qc = useQueryClient();
  const t = useDict(SCHEDULES);
  const c = useDict(COMMON);
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const [zoneId, setZoneId] = useState<string | null>(null);
  const zone = zones.data?.find((z) => z.id === zoneId) ?? zones.data?.[0];
  const sched = useQuery({ queryKey: ['zone-schedule', zone?.id], queryFn: () => api.zoneSchedule(zone!.id), enabled: !!zone });
  const [s, setS] = useState<Schedule | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  useEffect(() => setS(sched.data ?? null), [sched.data]);

  const save = useMutation({
    mutationFn: () => api.setZoneSchedule(zone!.id, s!),
    onSuccess: () => {
      toast(t.saved, 'success');
      qc.invalidateQueries({ queryKey: ['zone-schedule', zone?.id] });
    },
  });

  // 30-day astronomical preview, same function the scheduler uses to compute what it sends
  const preview = useMemo(() => {
    if (!zone || !s) return [];
    return astroPreview(zone.center, vnDate(), 30, s.offsetOnMin, s.offsetOffMin).map((p) => ({ day: dayjs(p.date).format('DD/MM'), on: p.on, off: p.off }));
  }, [zone, s]);

  const chart = useMemo(
    () => ({
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { left: 52, right: 16, top: 32, bottom: 28 },
      xAxis: { type: 'category', data: preview.map((p) => p.day) },
      yAxis: {
        type: 'value',
        min: 1020,
        max: 1860,
        interval: 60,
        axisLabel: { formatter: (v: number) => `${String(Math.floor((v % 1440) / 60)).padStart(2, '0')}:00` },
      },
      series: [
        { name: t.onTime, type: 'line', data: preview.map((p) => toMin(p.on)), itemStyle: { color: '#d97706' } },
        { name: t.offTime, type: 'line', data: preview.map((p) => toMin(p.off) + 1440), itemStyle: { color: '#2563eb' } },
      ],
    }),
    [preview, t],
  );

  const set = <K extends keyof Schedule>(k: K, v: Schedule[K]) => setS((p) => (p ? { ...p, [k]: v } : p));

  return (
    <div className="flex h-full">
      <aside className="w-64 shrink-0 overflow-auto border-r bg-panel p-2">
        <div className="mb-1 px-2 text-xs font-semibold uppercase text-subtle">{t.zones}</div>
        {zones.data?.map((z) => (
          <button key={z.id} onClick={() => setZoneId(z.id)} className={cn('block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted', zone?.id === z.id && 'bg-primary/10 font-medium')}>
            {z.name}
            <div className="text-xs text-subtle">{t.zoneCabinets(z.cabinetCount)} · #{z.id}</div>
          </button>
        ))}
      </aside>
      <div className="min-w-0 flex-1 overflow-auto p-4">
        <PageHeader
          title={fill(t.title, { zone: zone?.name ?? '' })}
          subtitle={t.subtitle}
          actions={
            <>
              <Button variant="outline" onClick={() => save.mutate()} loading={save.isPending} disabled={!s}>
                <Save className="h-4 w-4" /> {c.save}
              </Button>
              <Button onClick={() => setSyncOpen(true)}>
                <RefreshCw className="h-4 w-4" /> {t.sync}
              </Button>
            </>
          }
        />
        {!s ? (
          <Spinner />
        ) : (
          <div className="space-y-4">
            <Card>
              <CardHeader title={t.source} />
              <div className="space-y-3 p-4">
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2"><input type="radio" checked={s.source === 'astronomical'} onChange={() => set('source', 'astronomical')} /> <Sun className="h-4 w-4 text-st-dimming" /> {t.astronomical}</label>
                  <label className="flex items-center gap-2"><input type="radio" checked={s.source === 'manual'} onChange={() => set('source', 'manual')} /> {t.fixed}</label>
                </div>
                {s.source === 'astronomical' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t.offsetOn}><Input type="number" value={s.offsetOnMin} onChange={(e) => set('offsetOnMin', Number(e.target.value))} /></Field>
                    <Field label={t.offsetOff}><Input type="number" value={s.offsetOffMin} onChange={(e) => set('offsetOffMin', Number(e.target.value))} /></Field>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex gap-4 text-sm">
                      <label className="flex items-center gap-2"><input type="radio" checked={s.mode === 1} onChange={() => set('mode', 1)} /> {t.mode1}</label>
                      <label className="flex items-center gap-2"><input type="radio" checked={s.mode === 2} onChange={() => set('mode', 2)} /> {t.mode2}</label>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {s.mode === 2 ? <Checkbox label={t.branch1} checked={s.branch1Enabled} onChange={(v) => set('branch1Enabled', v)} /> : <span className="w-24 text-sm">{t.lightsOn}</span>}
                      <Input type="time" value={s.on1} onChange={(e) => set('on1', e.target.value)} className="w-28" /> →
                      <Input type="time" value={s.off1} onChange={(e) => set('off1', e.target.value)} className="w-28" />
                    </div>
                    {s.mode === 2 && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Checkbox label={t.branch2} checked={s.branch2Enabled} onChange={(v) => set('branch2Enabled', v)} />
                        <Input type="time" value={s.on2} onChange={(e) => set('on2', e.target.value)} className="w-28" /> →
                        <Input type="time" value={s.off2} onChange={(e) => set('off2', e.target.value)} className="w-28" />
                      </div>
                    )}
                    <Unsupported>{t.dimmingUnsupported}</Unsupported>
                  </div>
                )}
              </div>
            </Card>
            {s.source === 'astronomical' && (
              <>
                <Card>
                  <CardHeader title={t.chartTitle} />
                  <div className="p-2"><EChart option={chart} height={300} /></div>
                </Card>
                <Card>
                  <CardHeader title={t.table} />
                  <div className="max-h-72 overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-muted text-left text-xs text-subtle">
                        <tr><th className="px-3 py-2">{t.day}</th><th className="px-3 py-2">{t.onTime}</th><th className="px-3 py-2">{t.offTime}</th></tr>
                      </thead>
                      <tbody>
                        {preview.map((p) => (
                          <tr key={p.day} className="border-t"><td className="px-3 py-1.5">{p.day}</td><td className="px-3 py-1.5 tabular-nums">{p.on}</td><td className="px-3 py-1.5 tabular-nums">{p.off}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </>
            )}
          </div>
        )}
      </div>
      {zone && <SyncDialog key={zone.id} open={syncOpen} onOpenChange={setSyncOpen} kind="schedule" title={t.syncTitle} initialZones={[zone.id]} />}
    </div>
  );
}
