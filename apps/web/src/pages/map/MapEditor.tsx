// Map editor (spec S4/S5, M8): toolbar, pole panel, pole generation, Excel/CSV import.
// Edits stay in a draft (list of ops) until "Lưu", which saves them in one transaction.
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileSpreadsheet, MousePointer2, Spline, Undo2, X, MapPin } from 'lucide-react';
import { LAMP_GROUP_LABELS, lineLengthM, pointsAlong, type LampGroup } from '@citylight/shared';
import { api, ApiError, type ImportReport, type MapAssets, type MapEditOp, type PoleAsset } from '@/lib/api';
import { Button, Field, Input, Modal, Select, Spinner, toast } from '@/components/ui';
import type { EditTool } from './CabinetMap';

const err = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Lỗi', 'error');

const OP_LABEL: Record<MapEditOp['op'], string> = {
  moveCabinet: 'dời tủ', upsertRoute: 'vẽ tuyến', deleteRoute: 'xóa tuyến', addPole: 'thêm trụ', movePole: 'dời trụ', deletePole: 'xóa trụ', setPoleLamps: 'sửa đèn',
};

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
  const summary = useMemo(() => {
    const m = new Map<string, number>();
    p.ops.forEach((o) => m.set(OP_LABEL[o.op], (m.get(OP_LABEL[o.op]) ?? 0) + 1));
    return [...m].map(([k, v]) => `${v} ${k}`).join(', ');
  }, [p.ops]);
  const needCabinet = !p.cabinetName;
  return (
    <div className="absolute bottom-6 left-1/2 z-10 w-[min(920px,calc(100vw-32px))] -translate-x-1/2 space-y-2 rounded-lg border bg-panel px-3 py-2 text-sm shadow-lg">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={p.tool === 'select' ? 'primary' : 'outline'} onClick={() => p.setTool('select')}>
          <MousePointer2 className="h-4 w-4" /> Chọn / kéo
        </Button>
        <Button size="sm" variant={p.tool === 'route' ? 'primary' : 'outline'} disabled={needCabinet} onClick={() => p.setTool('route')}>
          <Spline className="h-4 w-4" /> Vẽ tuyến
        </Button>
        <Button size="sm" variant={p.tool === 'pole' ? 'primary' : 'outline'} disabled={needCabinet} onClick={() => p.setTool('pole')}>
          <MapPin className="h-4 w-4" /> Thêm trụ
        </Button>
        <Select className="h-8 w-20 text-xs" value={p.branch} onChange={(e) => p.setBranch(Number(e.target.value) as 1 | 2)} aria-label="Nhánh">
          <option value={1}>N1</option>
          <option value={2}>N2</option>
        </Select>
        <Button size="sm" variant="outline" disabled={needCabinet} onClick={p.onGenerate}>Sinh trụ</Button>
        <Button size="sm" variant="outline" onClick={p.onImport}>
          <FileSpreadsheet className="h-4 w-4" /> Nhập Excel
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={!p.ops.length} onClick={p.onUndo} aria-label="Hoàn tác">
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={p.onCancel}>Hủy</Button>
          <Button size="sm" disabled={!p.ops.length} loading={p.saving} onClick={p.onSave}>Lưu {p.ops.length ? `(${p.ops.length})` : ''}</Button>
        </div>
      </div>
      <div className="text-xs text-subtle">
        {needCabinet
          ? 'Bấm một tủ trên bản đồ để chọn, rồi vẽ tuyến / thêm trụ cho tủ đó. Kéo trụ để dời. '
          : `Tủ ${p.cabinetName} · nhánh N${p.branch}. `}
        {p.tool === 'route' && (p.drawing ? 'Bấm để thêm điểm, nhấp đúp hoặc ' : 'Bấm lên bản đồ để bắt đầu từ tủ. ')}
        {p.tool === 'route' && p.drawing && (
          <button className="font-medium text-primary underline" onClick={p.onFinishRoute}>kết thúc tuyến</button>
        )}
        {p.tool === 'pole' && 'Bấm lên bản đồ để đặt trụ (cần có tuyến). '}
        {p.ops.length ? ` Nháp: ${summary}.` : ' Chưa có thay đổi.'}
      </div>
    </div>
  );
}

/** Saved pole: details + lamps; in edit mode delete / change lamps go to the draft. */
export function PolePanel(p: { pole: PoleAsset; editMode: boolean; onClose: () => void; onOpenCabinet: () => void; onOp: (op: MapEditOp) => void }) {
  const q = useQuery({ queryKey: ['pole', p.pole.id], queryFn: () => api.pole(p.pole.id) });
  const lamp0 = q.data?.lamps[0];
  const [count, setCount] = useState<number | null>(null);
  const [power, setPower] = useState<string>('');
  const [group, setGroup] = useState<LampGroup | null>(null);
  const n = count ?? q.data?.lampCount ?? p.pole.lampCount;
  return (
    <div className="absolute right-3 top-3 z-10 w-80 rounded-lg border bg-panel shadow-lg">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="font-semibold">Trụ {p.pole.code}</div>
        <button onClick={p.onClose} aria-label="Đóng"><X className="h-4 w-4" /></button>
      </div>
      <div className="space-y-1 px-3 py-2 text-sm">
        <div><span className="text-subtle">Tủ:</span> {p.pole.cabinetName}</div>
        <div><span className="text-subtle">Tuyến:</span> {p.pole.routeCode} ({p.pole.branch}) · trụ số {p.pole.seq ?? '—'}</div>
        <div><span className="text-subtle">Tọa độ:</span> {p.pole.location.lat.toFixed(6)}, {p.pole.location.lng.toFixed(6)}</div>
        {q.isLoading ? (
          <Spinner />
        ) : (
          <div className="pt-1">
            {(q.data?.lamps ?? []).map((l) => (
              <div key={l.id} className="flex items-center justify-between border-t py-1 text-xs">
                <span>{l.code.split('_').pop()} · {LAMP_GROUP_LABELS[l.lampGroup as LampGroup]}{l.ratedPowerW ? ` · ${l.ratedPowerW} W` : ''}</span>
                <span className="text-subtle">{l.isSmart ? 'Đèn thông minh' : ''}</span>
              </div>
            ))}
            {!q.data?.lamps.length && <div className="border-t py-1 text-xs text-subtle">Chưa có đèn</div>}
          </div>
        )}
        {p.editMode ? (
          <div className="space-y-2 border-t pt-2">
            <div className="grid grid-cols-3 gap-2">
              <Field label="Số đèn"><Input type="number" min={0} max={20} value={n} onChange={(e) => setCount(Number(e.target.value))} /></Field>
              <Field label="Công suất W"><Input type="number" min={0} value={power || (lamp0?.ratedPowerW ?? '')} onChange={(e) => setPower(e.target.value)} /></Field>
              <Field label="Nhóm">
                <Select value={group ?? lamp0?.lampGroup ?? 0} onChange={(e) => setGroup(Number(e.target.value) as LampGroup)}>
                  {[0, 1, 2, 3].map((g) => <option key={g} value={g}>{LAMP_GROUP_LABELS[g as LampGroup]}</option>)}
                </Select>
              </Field>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="flex-1" onClick={() => {
                p.onOp({ op: 'setPoleLamps', poleId: p.pole.id, lampCount: n, ratedPowerW: power ? Number(power) : lamp0?.ratedPowerW ?? null, lampGroup: group ?? lamp0?.lampGroup ?? 0 });
                toast('Đã thêm vào nháp');
              }}>Sửa đèn</Button>
              <Button size="sm" variant="danger" onClick={() => {
                p.onOp({ op: 'deletePole', poleId: p.pole.id, expectedUpdatedAt: p.pole.updatedAt });
                p.onClose();
              }}>Xóa trụ</Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="mt-2 w-full" onClick={p.onOpenCabinet}>Mở chi tiết tủ</Button>
        )}
      </div>
    </div>
  );
}

/** Poles every N metres along the saved route of the selected cabinet + branch (replaces its poles). */
export function GeneratePolesModal(p: { open: boolean; onOpenChange: (v: boolean) => void; assets: MapAssets | null; cabinetId: string | null; branch: 1 | 2; onDone: () => void }) {
  const [spacing, setSpacing] = useState(30);
  const [lamps, setLamps] = useState(1);
  const [power, setPower] = useState('');
  const route = p.assets?.routes.find((r) => r.cabinetId === p.cabinetId && r.branch === `N${p.branch}`);
  const preview = route ? pointsAlong(route.path, spacing).length : 0;
  const run = useMutation({
    mutationFn: () => api.generatePoles(route!.id, { spacingM: spacing, lampCount: lamps, ratedPowerW: power ? Number(power) : null, lampGroup: 0 }),
    onSuccess: (r) => {
      toast(`Đã sinh ${r.poles} trụ`, 'success');
      p.onOpenChange(false);
      p.onDone();
    },
    onError: err,
  });
  return (
    <Modal
      open={p.open}
      onOpenChange={p.onOpenChange}
      title={`Sinh trụ hàng loạt · nhánh N${p.branch}`}
      footer={
        <>
          <Button variant="outline" onClick={() => p.onOpenChange(false)}>Hủy</Button>
          <Button variant="danger" disabled={!route || spacing < 5} loading={run.isPending} onClick={() => run.mutate()}>Sinh {preview} trụ</Button>
        </>
      }
    >
      {!route ? (
        <p className="text-subtle">Tủ này chưa có tuyến N{p.branch} đã lưu trong vùng đang xem. Vẽ tuyến rồi bấm Lưu trước.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-subtle">
            Tuyến {route.code} dài <b>{Math.round(lineLengthM(route.path)).toLocaleString('vi-VN')} m</b>. Trụ đặt dọc tuyến theo đúng khoảng cách (tính theo đường đi), mã tự
            tăng từ 1. <b>Các trụ hiện có của tuyến sẽ bị thay.</b> Thao tác lưu ngay, không qua nháp.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Khoảng cách (m)"><Input type="number" min={5} max={200} value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} /></Field>
            <Field label="Số đèn / trụ"><Input type="number" min={0} max={20} value={lamps} onChange={(e) => setLamps(Number(e.target.value))} /></Field>
            <Field label="Công suất W"><Input type="number" min={0} value={power} onChange={(e) => setPower(e.target.value)} /></Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Excel / CSV import: check first (row errors), then write. */
export function ImportPolesModal(p: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const check = useMutation({ mutationFn: (f: File) => api.importPoles(f, true), onSuccess: setReport, onError: err });
  const write = useMutation({
    mutationFn: () => api.importPoles(file!, false),
    onSuccess: (r) => {
      toast(`Đã nhập ${r.poles} trụ, ${r.lamps} đèn, ${r.routes} tuyến`, 'success');
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
      title="Nhập trụ / đèn từ Excel"
      className="w-[min(720px,calc(100vw-32px))]"
      footer={
        <>
          <Button variant="outline" onClick={() => void api.importTemplate().catch(err)}>Tải file mẫu</Button>
          <Button variant="outline" onClick={() => input.current?.click()}>Chọn file…</Button>
          <Button disabled={!report || report.errorCount > 0 || !report.poles} loading={write.isPending} onClick={() => write.mutate()}>
            Nhập {report?.poles ?? 0} trụ
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
          Mỗi dòng một trụ: mã tủ, nhánh, thứ tự trụ, vĩ độ, kinh độ, số đèn, công suất, nhóm đèn. Tuyến được vẽ nối tủ → các trụ theo thứ tự. Nhập lại cùng tủ + nhánh sẽ thay
          trụ của tuyến đó. File có lỗi sẽ không được ghi.
        </p>
        {file && <div>File: <b>{file.name}</b></div>}
        {check.isPending && <Spinner />}
        {report && (
          <div className="space-y-2">
            <div className={report.errorCount ? 'text-st-offline' : 'text-st-on'}>
              {report.rows} dòng · {report.cabinets} tủ · {report.routes} tuyến · {report.poles} trụ · {report.lamps} đèn
              {report.errorCount ? ` · ${report.errorCount} dòng lỗi` : ' · không có lỗi'}
            </div>
            {report.errorCount > 0 && (
              <div className="max-h-60 overflow-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="bg-muted"><tr><th className="px-2 py-1 text-left">Dòng</th><th className="px-2 py-1 text-left">Lỗi</th></tr></thead>
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
