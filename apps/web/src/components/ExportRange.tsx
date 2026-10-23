// S55: period + step picker shared by the cabinet "Xuất Excel" dialog and the data report page.
// Days are Vietnamese calendar days: from 00:00 +07:00 of the first day to 00:00 of the day after the last one.
import { useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { api, type ExportRange } from '@/lib/api';
import { dictNow, useDict } from '@/i18n';
import { REPORTS } from '@/i18n/dict/reports';
import { Button, Field, Input, Modal, Select, toast } from '@/components/ui';

type Preset = 'today' | 'd7' | 'd30' | 'month' | 'custom';

/** YYYY-MM-DD of a date in Asia/Ho_Chi_Minh, `days` days from now. */
const vnDay = (days = 0) => new Date(Date.now() + 7 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
const startOf = (d: string) => new Date(`${d}T00:00:00+07:00`);

export function presetDays(p: Preset): [string, string] {
  const today = vnDay();
  if (p === 'd7') return [vnDay(-6), today];
  if (p === 'd30') return [vnDay(-29), today];
  if (p === 'month') return [`${today.slice(0, 8)}01`, today];
  return [today, today];
}

export function useExportRange() {
  const [preset, setPreset] = useState<Preset>('today');
  const [[from, to], setDays] = useState<[string, string]>(presetDays('today'));
  const [step, setStep] = useState<ExportRange['step']>('auto');
  const valid = !!from && !!to && from <= to;
  const range: ExportRange | null = valid
    ? { from: startOf(from).toISOString(), to: new Date(startOf(to).getTime() + 86_400_000).toISOString(), step }
    : null;
  const choose = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') setDays(presetDays(p));
  };
  return { preset, choose, from, to, setFrom: (v: string) => setDays([v, to]), setTo: (v: string) => setDays([from, v]), step, setStep, range };
}

export function ExportRangeFields({ r }: { r: ReturnType<typeof useExportRange> }) {
  const t = useDict(REPORTS);
  return (
    <div className="space-y-3">
      <Field label={t.period}>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(t.presets) as Preset[]).map((p) => (
            <Button key={p} size="sm" variant={r.preset === p ? 'primary' : 'outline'} onClick={() => r.choose(p)}>
              {t.presets[p]}
            </Button>
          ))}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t.from}>
          <Input type="date" value={r.from} max={r.to} onChange={(e) => { r.choose('custom'); r.setFrom(e.target.value); }} />
        </Field>
        <Field label={t.to}>
          <Input type="date" value={r.to} min={r.from} onChange={(e) => { r.choose('custom'); r.setTo(e.target.value); }} />
        </Field>
      </div>
      <Field label={t.step}>
        <Select value={r.step} onChange={(e) => r.setStep(e.target.value as ExportRange['step'])}>
          {(Object.keys(t.steps) as ExportRange['step'][]).map((s) => (
            <option key={s} value={s}>{t.steps[s]}</option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

/** Downloads through api.downloadFile; false = no server route (mock demo). */
export async function runDownload(go: () => Promise<boolean>) {
  const t = dictNow(REPORTS);
  if (await go()) toast(t.downloaded, 'success');
  else toast(t.mockOnly, 'info');
}

/** "Xuất Excel" button of the cabinet drawer. */
export function CabinetExportButton({ cabinetId }: { cabinetId: string }) {
  const t = useDict(REPORTS);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const r = useExportRange();
  const go = async () => {
    if (!r.range) return;
    setBusy(true);
    try {
      await runDownload(() => api.exportCabinet(cabinetId, r.range!));
      setOpen(false);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-md p-1.5 hover:bg-muted" aria-label={t.exportButton} title={t.exportButton}>
        <FileSpreadsheet className="h-5 w-5" />
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t.exportTitle}
        footer={<Button loading={busy} disabled={!r.range} onClick={go}><FileSpreadsheet className="h-4 w-4" /> {t.download}</Button>}
      >
        <p className="mb-3 text-subtle">{t.exportHint}</p>
        <ExportRangeFields r={r} />
      </Modal>
    </>
  );
}
