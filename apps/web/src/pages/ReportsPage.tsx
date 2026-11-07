// S55: data report page — telemetry of several cabinets (zones and / or cabinet codes) to Excel or CSV.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileDown, FileSpreadsheet } from 'lucide-react';
import { api } from '@/lib/api';
import { fill, useDict } from '@/i18n';
import { REPORTS } from '@/i18n/dict/reports';
import { Button, Card, CardHeader, Checkbox, Field, PageHeader, Textarea, toast } from '@/components/ui';
import { ExportRangeFields, runDownload, useExportRange } from '@/components/ExportRange';

export function ReportsPage() {
  const t = useDict(REPORTS);
  const P = t.page;
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const [picked, setPicked] = useState<string[]>([]);
  const [codes, setCodes] = useState('');
  const [busy, setBusy] = useState<'xlsx' | 'csv' | null>(null);
  const r = useExportRange();
  const ready = !!r.range && (picked.length > 0 || codes.trim().length > 0);
  const go = async (fmt: 'xlsx' | 'csv') => {
    if (!r.range) return;
    if (!ready) return toast(P.needCabinets, 'info');
    setBusy(fmt);
    try {
      await runDownload(() => api.exportReport(fmt, { ...r.range!, zoneIds: picked.join(','), codes: codes.trim() }));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <PageHeader title={P.title} subtitle={P.subtitle} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title={P.cabinets} />
          <div className="space-y-3 px-4 pb-4">
            <Field label={P.zones}>
              <div className="max-h-48 space-y-1 overflow-auto rounded-md border p-2">
                {zones.data?.map((z) => (
                  <Checkbox
                    key={z.id}
                    label={<span>{z.name} <span className="text-subtle">· {fill(P.cabinetCount, { n: z.cabinetCount })}</span></span>}
                    checked={picked.includes(z.id)}
                    onChange={(v) => toggle(z.id, v)}
                  />
                ))}
              </div>
            </Field>
            <Field label={P.codes} hint={P.codesHint}>
              <Textarea rows={4} value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="TM01.0001, TM01.0002&#10;TL01.*" className="font-mono" />
            </Field>
          </div>
        </Card>
        <Card>
          <CardHeader title={P.exportCard} />
          <div className="space-y-3 px-4 pb-4">
            <ExportRangeFields r={r} />
            <p className="text-xs text-subtle">{P.contents}</p>
            <div className="flex flex-wrap gap-2">
              <Button loading={busy === 'xlsx'} disabled={!ready || !!busy} onClick={() => go('xlsx')}><FileSpreadsheet className="h-4 w-4" /> {P.excel}</Button>
              <Button variant="outline" loading={busy === 'csv'} disabled={!ready || !!busy} onClick={() => go('csv')}><FileDown className="h-4 w-4" /> {P.csv}</Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
