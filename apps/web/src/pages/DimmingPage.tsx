import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Save, Undo2 } from 'lucide-react';
import type { DimmingProfile, LampGroup } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { fill, useDict } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { DIMMING } from '@/i18n/dict/dimming';
import { useSession } from '@/stores/session';
import { DimmingEditor } from '@/components/DimmingEditor';
import { Button, Card, CardHeader, PageHeader, Select, Spinner, Unsupported, toast } from '@/components/ui';
import { cn } from '@/lib/utils';


/** Dimming profiles (M9): system level, or one zone; cabinets inherit cabinet > zone > system > default. */
export function DimmingPage() {
  const qc = useQueryClient();
  const t = useDict(DIMMING);
  const c = useDict(COMMON);
  const can = useSession((s) => s.can('dimming.manage'));
  const [group, setGroup] = useState<LampGroup>(0);
  const [zoneId, setZoneId] = useState(''); // '' = whole system
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const { data } = useQuery({ queryKey: ['group-dimming', group, zoneId], queryFn: () => api.groupDimming(group, zoneId || undefined) });
  const [p, setP] = useState<DimmingProfile | null>(null);
  useEffect(() => setP(data ?? null), [data]);
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : c.error, 'error');
  const done = (msg: string) => {
    toast(msg, 'success');
    qc.invalidateQueries({ queryKey: ['group-dimming'] });
    qc.invalidateQueries({ queryKey: ['cabinet-dimming'] });
  };
  const save = useMutation({ mutationFn: () => api.setGroupDimming(group, p!, zoneId || undefined), onSuccess: () => done(t.saved), onError: fail });
  const drop = useMutation({ mutationFn: () => api.dropGroupDimming(group, zoneId), onSuccess: () => done(t.dropped), onError: fail });
  // Refused by the API (409 capability_unsupported, before any OTP) until the firmware can dim; its reason is shown as is.
  const sync = useMutation({
    mutationFn: () => api.createBatch('dimming', zoneId ? [zoneId] : (zones.data ?? []).map((z) => z.id), ''),
    onSuccess: () => toast(t.batchCreated, 'success'),
    onError: fail,
  });
  const zoneName = zones.data?.find((z) => z.id === zoneId)?.name;
  const own = zoneId ? p?.source === 'zone' : p?.source === 'system';
  return (
    <div className="mx-auto max-w-5xl p-4">
      <PageHeader
        title={t.title}
        actions={
          <>
            {can && (
              <Button variant="outline" onClick={() => save.mutate()} loading={save.isPending} disabled={!p}>
                <Save className="h-4 w-4" /> {t.save}
              </Button>
            )}
            <Button onClick={() => sync.mutate()} loading={sync.isPending} disabled={!can || !zones.data?.length}>
              <RefreshCw className="h-4 w-4" /> {t.sync}
            </Button>
          </>
        }
      />
      <div className="mb-3">
        <Unsupported>{t.unsupported}</Unsupported>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={zoneId} onChange={(e) => setZoneId(e.target.value)} aria-label={t.scope}>
          <option value="">{t.system}</option>
          {zones.data?.map((z) => (
            <option key={z.id} value={z.id}>
              {fill(t.zone, { name: z.name })}
            </option>
          ))}
        </Select>
        {([0, 1, 2, 3] as LampGroup[]).map((g) => (
          <button key={g} onClick={() => setGroup(g)} className={cn('rounded-md border px-3 py-1.5 text-sm', group === g ? 'border-primary bg-primary/10 font-medium' : 'bg-panel hover:bg-muted')}>
            {g} – {t.lampGroup[g]}
          </button>
        ))}
      </div>
      <Card>
        <CardHeader
          title={`${t.lampGroup[group]} · ${zoneName ? fill(t.zone, { name: zoneName }) : t.system}`}
          subtitle={
            p?.source
              ? fill(t.using, { source: t.source[p.source], hint: zoneId && !own ? t.saveForZone : '' })
              : t.segmentsHint
          }
          actions={
            can && zoneId && own ? (
              <Button size="sm" variant="outline" onClick={() => drop.mutate()} loading={drop.isPending}>
                <Undo2 className="h-4 w-4" /> {t.drop}
              </Button>
            ) : undefined
          }
        />
        <div className="p-4">{p ? <DimmingEditor segments={p.segments} onChange={(segments) => setP({ ...p, segments })} disabled={!can} estimate={p.estimate} /> : <Spinner />}</div>
      </Card>
    </div>
  );
}
