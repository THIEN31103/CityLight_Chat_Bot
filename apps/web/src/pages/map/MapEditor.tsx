// Map editor (spec S4/S5, M8): toolbar, pole panel, pole generation, Excel/CSV import.
// Edits stay in a draft (list of ops) until "Lưu", which saves them in one transaction.
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileSpreadsheet, MousePointer2, Spline, Undo2, X, MapPin } from 'lucide-react';
import { lineLengthM, pointsAlong, type LampGroup } from '@citylight/shared';
import { api, ApiError, type ImportReport, type MapAssets, type MapEditOp, type PoleAsset } from '@/lib/api';
import { dictNow, fill, locale, useDict } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { DIMMING } from '@/i18n/dict/dimming';
import { MAP } from '@/i18n/dict/map';
import { Button, Field, Input, Modal, Select, Spinner, toast } from '@/components/ui';
import type { EditTool } from './CabinetMap';

const err = (e: unknown) => toast(e instanceof ApiError ? e.message : dictNow(COMMON).error, 'error');

export function EditToolbar(p: {
  tool: EditTool;
  setTool: (t: EditTool) => void;
  branch: 1 | 2;
  setBranch: (b: 1 | 2) => void;
  cabinetName: string | null;
  ops: MapEditOp[];
  drawing: boolean;
  onFinishRoute: () => void;
  onUndo: () => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  onGenerate: () => void;
  onImport: () => void;
}) {
  const t = useDict(MAP).editor;
  const c = useDict(COMMON);
  const summary = useMemo(() => {
    const m = new Map<MapEditOp['op'], number>();
    p.ops.forEach((o) => m.set(o.op, (m.get(o.op) ?? 0) + 1));
    return [...m].map(([k, v]) => t.op[k](v)).join(', ');
  }, [p.ops, t]);
  const needCabinet = !p.cabinetName;
  return (
    <div className="absolute bottom-6 left-1/2 z-10 w-[min(920px,calc(100vw-32px))] -translate-x-1/2 space-y-2 rounded-lg border bg-panel px-3 py-2 text-sm shadow-lg">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={p.tool === 'select' ? 'primary' : 'outline'} onClick={() => p.setTool('select')}>
          <MousePointer2 className="h-4 w-4" /> {t.select}
        </Button>
        <Button size="sm" variant={p.tool === 'route' ? 'primary' : 'outline'} disabled={needCabinet} onClick={() => p.setTool('route')}>
          <Spline className="h-4 w-4" /> {t.drawRoute}
        </Button>
        <Button size="sm" variant={p.tool === 'pole' ? 'primary' : 'outline'} disabled={needCabinet} onClick={() => p.setTool('pole')}>
          <MapPin className="h-4 w-4" /> {t.addPole}
        </Button>
        <Select className="h-8 w-20 text-xs" value={p.branch} onChange={(e) => p.setBranch(Number(e.target.value) as 1 | 2)} aria-label={t.branch}>
          <option value={1}>{fill(t.branchOption, { branch: 1 })}</option>
          <option value={2}>{fill(t.branchOption, { branch: 2 })}</option>
        </Select>
        <Button size="sm" variant="outline" disabled={needCabinet} onClick={p.onGenerate}>{t.generate}</Button>
        <Button size="sm" variant="outline" onClick={p.onImport}>
          <FileSpreadsheet className="h-4 w-4" /> {t.import}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={!p.ops.length} onClick={p.onUndo} aria-label={t.undo}>
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={p.onCancel}>{c.cancel}</Button>
          <Button size="sm" disabled={!p.ops.length} loading={p.saving} onClick={p.onSave}>{c.save} {p.ops.length ? `(${p.ops.length})` : ''}</Button>
        </div>
      </div>
      <div className="text-xs text-subtle">
        {needCabinet
          ? t.pickCabinetHint
          : fill(t.cabinetHint, { name: p.cabinetName, branch: p.branch })}
        {p.tool === 'route' && (p.drawing ? t.routeDrawing : t.routeStart)}
        {p.tool === 'route' && p.drawing && (
          <button className="font-medium text-primary underline" onClick={p.onFinishRoute}>{t.finishRoute}</button>
        )}
        {p.tool === 'pole' && t.poleHint}
        {p.ops.length ? fill(t.draft, { summary }) : t.noChanges}
      </div>
    </div>
  );
}

/** Saved pole: details + lamps; in edit mode delete / change lamps go to the draft. */
export function PolePanel(p: { pole: PoleAsset; editMode: boolean; onClose: () => void; onOpenCabinet: () => void; onOp: (op: MapEditOp) => void }) {
  const t = useDict(MAP).pole;
  const c = useDict(COMMON);
  const groups = useDict(DIMMING).lampGroup;
  const q = useQuery({ queryKey: ['pole', p.pole.id], queryFn: () => api.pole(p.pole.id) });
  const lamp0 = q.data?.lamps[0];
  const [count, setCount] = useState<number | null>(null);
  const [power, setPower] = useState<string>('');
  const [group, setGroup] = useState<LampGroup | null>(null);
  const n = count ?? q.data?.lampCount ?? p.pole.lampCount;
  return (
    <div className="absolute right-3 top-3 z-10 w-80 rounded-lg border bg-panel shadow-lg">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="font-semibold">{fill(t.title, { code: p.pole.code })}</div>
        <button onClick={p.onClose} aria-label={c.close}><X className="h-4 w-4" /></button>
      </div>
      <div className="space-y-1 px-3 py-2 text-sm">
        <div><span className="text-subtle">{t.cabinet}</span> {p.pole.cabinetName}</div>
        <div><span className="text-subtle">{t.route}</span> {p.pole.routeCode} ({p.pole.branch}) · {fill(t.seq, { seq: p.pole.seq ?? '—' })}</div>
        <div><span className="text-subtle">{t.coords}</span> {p.pole.location.lat.toFixed(6)}, {p.pole.location.lng.toFixed(6)}</div>
        {q.isLoading ? (
          <Spinner />
        ) : (
          <div className="pt-1">
            {(q.data?.lamps ?? []).map((l) => (
              <div key={l.id} className="flex items-center justify-between border-t py-1 text-xs">
                <span>{l.code.split('_').pop()} · {groups[l.lampGroup as LampGroup]}{l.ratedPowerW ? ` · ${l.ratedPowerW} W` : ''}</span>
                <span className="text-subtle">{l.isSmart ? t.smart : ''}</span>
              </div>
            ))}
            {!q.data?.lamps.length && <div className="border-t py-1 text-xs text-subtle">{t.noLamps}</div>}
          </div>
        )}
        {p.editMode ? (
          <div className="space-y-2 border-t pt-2">
            <div className="grid grid-cols-3 gap-2">
              <Field label={t.lampCount}><Input type="number" min={0} max={20} value={n} onChange={(e) => setCount(Number(e.target.value))} /></Field>
              <Field label={t.power}><Input type="number" min={0} value={power || (lamp0?.ratedPowerW ?? '')} onChange={(e) => setPower(e.target.value)} /></Field>
              <Field label={t.group}>
                <Select value={group ?? lamp0?.lampGroup ?? 0} onChange={(e) => setGroup(Number(e.target.value) as LampGroup)}>
                  {[0, 1, 2, 3].map((g) => <option key={g} value={g}>{groups[g as LampGroup]}</option>)}
                </Select>
              </Field>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="flex-1" onClick={() => {
                p.onOp({ op: 'setPoleLamps', poleId: p.pole.id, lampCount: n, ratedPowerW: power ? Number(power) : lamp0?.ratedPowerW ?? null, lampGroup: group ?? lamp0?.lampGroup ?? 0 });
                toast(t.addedToDraft);
              }}>{t.editLamps}</Button>
              <Button size="sm" variant="danger" onClick={() => {
                p.onOp({ op: 'deletePole', poleId: p.pole.id, expectedUpdatedAt: p.pole.updatedAt });
                p.onClose();
              }}>{t.deletePole}</Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="mt-2 w-full" onClick={p.onOpenCabinet}>{t.openCabinet}</Button>
        )}
      </div>
    </div>
  );
}

/** Poles every N metres along the saved route of the selected cabinet + branch (replaces its poles). */
export function GeneratePolesModal(p: { open: boolean; onOpenChange: (v: boolean) => void; assets: MapAssets | null; cabinetId: string | null; branch: 1 | 2; onDone: () => void }) {
  const t = useDict(MAP).generate;
  const c = useDict(COMMON);
  const [spacing, setSpacing] = useState(30);
  const [lamps, setLamps] = useState(1);
  const [power, setPower] = useState('');
  const route = p.assets?.routes.find((r) => r.cabinetId === p.cabinetId && r.branch === `N${p.branch}`);
  const preview = route ? pointsAlong(route.path, spacing).length : 0;
  const run = useMutation({
    mutationFn: () => api.generatePoles(route!.id, { spacingM: spacing, lampCount: lamps, ratedPowerW: power ? Number(power) : null, lampGroup: 0 }),
    onSuccess: (r) => {
      toast(t.done(r.poles), 'success');
      p.onOpenChange(false);
      p.onDone();
    },
    onError: err,
  });
  return (
    <Modal
      open={p.open}
      onOpenChange={p.onOpenChange}
      title={fill(t.title, { branch: p.branch })}
      footer={
        <>
          <Button variant="outline" onClick={() => p.onOpenChange(false)}>{c.cancel}</Button>
          <Button variant="danger" disabled={!route || spacing < 5} loading={run.isPending} onClick={() => run.mutate()}>{t.run(preview)}</Button>
        </>
      }
    >
      {!route ? (
        <p className="text-subtle">{fill(t.noRoute, { branch: p.branch })}</p>
      ) : (
        <div className="space-y-3">
          <p className="text-subtle">
            {fill(t.routeLength, { code: route.code })} <b>{Math.round(lineLengthM(route.path)).toLocaleString(locale())} m</b>
            {t.howItWorks} <b>{t.replaces}</b>
            {t.immediate}
          </p>
          <div className="grid grid-cols-3 gap-2">
            <Field label={t.spacing}><Input type="number" min={5} max={200} value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} /></Field>
            <Field label={t.lampsPerPole}><Input type="number" min={0} max={20} value={lamps} onChange={(e) => setLamps(Number(e.target.value))} /></Field>
            <Field label={t.power}><Input type="number" min={0} value={power} onChange={(e) => setPower(e.target.value)} /></Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Excel / CSV import: check first (row errors), then write. */
export function ImportPolesModal(p: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const t = useDict(MAP).import;
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const check = useMutation({ mutationFn: (f: File) => api.importPoles(f, true), onSuccess: setReport, onError: err });
  const write = useMutation({
    mutationFn: () => api.importPoles(file!, false),
    onSuccess: (r) => {
      toast(t.done(r.poles, r.lamps, r.routes), 'success');
      setFile(null);
      setReport(null);
      p.onOpenChange(false);
      p.onDone();
    },
    onError: err,
  });
  return (
    <Modal
      open={p.open}
      onOpenChange={p.onOpenChange}
      title={t.title}
      className="w-[min(720px,calc(100vw-32px))]"
      footer={
        <>
          <Button variant="outline" onClick={() => void api.importTemplate().catch(err)}>{t.template}</Button>
          <Button variant="outline" onClick={() => input.current?.click()}>{t.chooseFile}</Button>
          <Button disabled={!report || report.errorCount > 0 || !report.poles} loading={write.isPending} onClick={() => write.mutate()}>
            {t.run(report?.poles ?? 0)}
          </Button>
        </>
      }
    >
      <input
        ref={input}
        type="file"
        accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setFile(f);
          setReport(null);
          check.mutate(f);
        }}
      />
      <div className="space-y-3 text-sm">
        <p className="text-subtle">
          {t.help}
        </p>
        {file && <div>{t.file} <b>{file.name}</b></div>}
        {check.isPending && <Spinner />}
        {report && (
          <div className="space-y-2">
            <div className={report.errorCount ? 'text-st-offline' : 'text-st-on'}>
              {t.summary(report.rows, report.cabinets, report.routes, report.poles, report.lamps)}
              {report.errorCount ? t.errors(report.errorCount) : t.noErrors}
            </div>
            {report.errorCount > 0 && (
              <div className="max-h-60 overflow-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="bg-muted"><tr><th className="px-2 py-1 text-left">{t.row}</th><th className="px-2 py-1 text-left">{t.error}</th></tr></thead>
                  <tbody>
                    {report.errors.map((e, i) => (
                      <tr key={i} className="border-t"><td className="px-2 py-1">{e.row}</td><td className="px-2 py-1">{e.message}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
