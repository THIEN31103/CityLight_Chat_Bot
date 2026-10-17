import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Popover from '@radix-ui/react-popover';
import {
  Crosshair, Layers, LocateFixed, PanelLeftClose, PanelLeftOpen, Pencil, Ruler, Satellite, Search, Star, Trash2, X, Map as MapIcon,
} from 'lucide-react';
import type { CabinetStatus, GeoPoint } from '@citylight/shared';
import { STATUS_LABELS } from '@citylight/shared';
import { api, type PoleAsset } from '@/lib/api';
import { useSession } from '@/stores/session';
import { cn } from '@/lib/utils';
import { Button, Checkbox, Input, Modal, STATUS_ICON, StatusBadge, confirm, toast, Field, Select } from '@/components/ui';
import { CabinetMap, type CabinetMapHandle, type MapLayers } from './CabinetMap';
import { LeftPanel } from './LeftPanel';
import { CabinetDrawer } from '../cabinet/CabinetDrawer';
import { BASEMAPS, type BasemapId } from './mapStyle';

const KPI_ORDER: CabinetStatus[] = ['offline', 'fault', 'on', 'off', 'dimming', 'unknown'];
const KPI_COLOR: Record<CabinetStatus, string> = {
  offline: 'text-st-offline',
  fault: 'text-st-fault',
  dimming: 'text-st-dimming',
  on: 'text-st-on',
  off: 'text-st-off',
  unknown: 'text-st-unknown',
};

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

function haversine(a: GeoPoint, b: GeoPoint) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function MapPage() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('cabinet');
  const qc = useQueryClient();
  const can = useSession((s) => s.can);
  const mapRef = useRef<CabinetMapHandle>(null);

  const [panelOpen, setPanelOpen] = useState(true);
  const [statusFilter, setStatusFilter] = useState<Set<CabinetStatus>>(new Set());
  const [layers, setLayers] = useState<MapLayers>({ cabinets: true, routes: true, poles: true, labels: true, codes: false });
  const [basemap, setBasemapState] = useState<BasemapId>(() => readPref('cl.basemap', 'auto') as BasemapId);
  const setBasemap = (b: BasemapId) => {
    setBasemapState(b);
    writePref('cl.basemap', b);
  };
  const [detailMode, setDetailModeState] = useState<'center' | 'dock'>(() => (readPref('cl.detailMode', 'center') === 'dock' ? 'dock' : 'center'));
  const setDetailMode = (m: 'center' | 'dock') => {
    setDetailModeState(m);
    writePref('cl.detailMode', m);
  };
  // Docked panel covers the right 760 px: keep the cabinet centred in the visible part of the map.
  const flyPadding = detailMode === 'dock' ? { right: Math.min(760, window.innerWidth * 0.6) } : undefined;
  const [center, setCenter] = useState<GeoPoint>({ lat: 10.79, lng: 106.7 });
  const [editMode, setEditMode] = useState(false);
  const [moves, setMoves] = useState<Record<string, GeoPoint>>({});
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePts, setMeasurePts] = useState<GeoPoint[]>([]);
  const [pole, setPole] = useState<PoleAsset | null>(null);
  const [genOpen, setGenOpen] = useState(false);

  const stats = useQuery({ queryKey: ['map-stats'], queryFn: api.mapStats, refetchInterval: 15000 });
  const cabinetsQ = useQuery({ queryKey: ['map-cabinets'], queryFn: api.mapCabinets });
  const cabinets = useMemo(() => {
    const list = cabinetsQ.data ?? [];
    return list.map((c) => (moves[c.id] ? { ...c, location: moves[c.id]! } : c));
  }, [cabinetsQ.data, moves]);

  // Opened from a link (?cabinet=…, e.g. alarm bell): fly to it once the list is loaded.
  const flewTo = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || flewTo.current === selectedId || !cabinetsQ.data) return;
    const c = cabinetsQ.data.find((x) => x.id === selectedId);
    if (c) {
      flewTo.current = selectedId;
      setTimeout(() => mapRef.current?.flyTo(c.location, 16, flyPadding), 300);
    }
  }, [selectedId, cabinetsQ.data]);

  const saveEdits = useMutation({
    mutationFn: () => api.saveMapEdits(Object.entries(moves).map(([cabinetId, p]) => ({ cabinetId, ...p }))),
    onSuccess: (r) => {
      toast(`Đã lưu ${r.saved} thay đổi vị trí`, 'success');
      setMoves({});
      setEditMode(false);
      qc.invalidateQueries({ queryKey: ['map-cabinets'] });
    },
  });

  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('cabinet', id);
    else next.delete('cabinet');
    setParams(next, { replace: true });
    setPole(null);
  };

  const flyToCabinet = (id: string) => {
    const c = cabinets.find((x) => x.id === id);
    if (c) mapRef.current?.flyTo(c.location, Math.max(16, mapRef.current.getView().zoom), flyPadding);
    select(id);
  };

  const toggleStatus = (s: CabinetStatus) =>
    setStatusFilter((prev) => {
      const n = new Set(prev);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });

  const measureTotal = measurePts.reduce((sum, p, i) => (i ? sum + haversine(measurePts[i - 1]!, p) : 0), 0);

  return (
    <div className="absolute inset-0 flex">
      {/* Left panel */}
      <aside className={cn('z-10 flex w-[340px] shrink-0 flex-col border-r bg-panel transition-all', !panelOpen && '-ml-[340px]')}>
        <div className="grid grid-cols-3 gap-1.5 border-b p-2">
          {KPI_ORDER.map((s) => {
            const Icon = STATUS_ICON[s];
            const active = statusFilter.has(s);
            return (
              <button
                key={s}
                onClick={() => toggleStatus(s)}
                aria-pressed={active}
                className={cn('rounded-md border px-2 py-1.5 text-left transition hover:bg-muted', active && 'border-primary bg-primary/10')}
              >
                <div className={cn('flex items-center gap-1 text-[11px]', KPI_COLOR[s])}>
                  <Icon className="h-3.5 w-3.5" />
                  <span className="truncate">{STATUS_LABELS[s]}</span>
                </div>
                <div className="text-lg font-semibold tabular-nums">{stats.data ? stats.data.cabinets[s].toLocaleString('vi-VN') : '…'}</div>
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-3 gap-1.5 border-b p-2 text-center text-[11px] text-subtle">
          <div>
            <div className="text-base font-semibold text-fg">{stats.data ? `${stats.data.onlinePct.toFixed(1)}%` : '…'}</div>
            Tủ online
          </div>
          <div>
            <div className="text-base font-semibold text-fg">{stats.data?.energyTodayKwh ?? '—'}</div>
            kWh hôm nay
          </div>
          <div>
            <div className="text-base font-semibold text-fg">{stats.data?.overdueIncidents ?? '…'}</div>
            Sự cố quá hạn
          </div>
        </div>
        {statusFilter.size > 0 && (
          <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs">
            <span className="text-subtle">Đang lọc: {[...statusFilter].map((s) => STATUS_LABELS[s]).join(', ')}</span>
            <button className="text-primary" onClick={() => setStatusFilter(new Set())}>
              Bỏ lọc
            </button>
          </div>
        )}
        <LeftPanel center={center} cabinets={cabinets} statusFilter={statusFilter} selectedId={selectedId} onPick={flyToCabinet} />
      </aside>

      {/* Map */}
      <div className="relative min-w-0 flex-1">
        <CabinetMap
          ref={mapRef}
          cabinets={cabinets}
          statusFilter={statusFilter}
          layers={layers}
          basemap={basemap}
          selectedId={selectedId}
          editMode={editMode}
          measureMode={measureMode}
          measurePoints={measurePts}
          onSelectCabinet={flyToCabinet}
          onSelectPole={setPole}
          onMoveCabinet={(id, p) => setMoves((m) => ({ ...m, [id]: p }))}
          onMeasure={setMeasurePts}
          onViewChange={(c) => setCenter(c)}
        />

        {/* Toolbar */}
        <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => setPanelOpen((v) => !v)} aria-label={panelOpen ? 'Ẩn danh sách' : 'Hiện danh sách'} className="shadow">
            {panelOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
          </Button>
          <SearchBox onPick={flyToCabinet} />
          <LayersPopover layers={layers} setLayers={setLayers} basemap={basemap} setBasemap={setBasemap} />
          <FavoritesPopover getView={() => mapRef.current!.getView()} flyTo={(p, z) => mapRef.current?.flyTo(p, z)} />
          <Button
            variant={measureMode ? 'primary' : 'outline'}
            size="icon"
            className="shadow"
            aria-label="Đo khoảng cách"
            onClick={() => {
              setMeasureMode((v) => !v);
              setMeasurePts([]);
            }}
          >
            <Ruler className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="shadow"
            aria-label="Vị trí hiện tại"
            onClick={() =>
              navigator.geolocation?.getCurrentPosition(
                (p) => mapRef.current?.flyTo({ lat: p.coords.latitude, lng: p.coords.longitude }, 15),
                () => toast('Không lấy được vị trí hiện tại', 'error'),
              )
            }
          >
            <LocateFixed className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" className="shadow" aria-label="Vệ tinh / bản đồ thường" onClick={() => setBasemap(basemap === 'hybrid' || basemap === 'satellite' ? 'auto' : 'hybrid')}>
            {basemap === 'hybrid' || basemap === 'satellite' ? <MapIcon className="h-4 w-4" /> : <Satellite className="h-4 w-4" />}
          </Button>
          {can('map.edit') && (
            <Button variant={editMode ? 'primary' : 'outline'} size="sm" className="shadow" onClick={() => setEditMode((v) => !v)}>
              <Pencil className="h-4 w-4" /> Chỉnh sửa
            </Button>
          )}
        </div>

        {measureMode && (
          <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-3 rounded-md border bg-panel px-3 py-1.5 text-sm shadow">
            <Crosshair className="h-4 w-4 text-st-offline" />
            Bấm lên bản đồ để thêm điểm · Tổng: <b>{Math.round(measureTotal).toLocaleString('vi-VN')} m</b>
            <Button size="sm" variant="ghost" onClick={() => setMeasurePts([])}>
              Xóa
            </Button>
          </div>
        )}

        {editMode && (
          <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border bg-panel px-3 py-2 text-sm shadow-lg">
            <span className="text-subtle">
              Chế độ chỉnh sửa · chọn tủ rồi kéo marker xanh · {Object.keys(moves).length} thay đổi nháp
            </span>
            <Button size="sm" variant="outline" onClick={() => setGenOpen(true)}>
              Sinh trụ hàng loạt
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                if (Object.keys(moves).length && !(await confirm({ title: 'Hủy các thay đổi?', body: 'Các thay đổi vị trí chưa lưu sẽ bị bỏ.', danger: true, confirmLabel: 'Hủy thay đổi' }))) return;
                setMoves({});
                setEditMode(false);
              }}
            >
              Hủy các thay đổi
            </Button>
            <Button size="sm" disabled={!Object.keys(moves).length} loading={saveEdits.isPending} onClick={() => saveEdits.mutate()}>
              Lưu thay đổi
            </Button>
          </div>
        )}

        {pole && !selectedId && <PolePanel pole={pole} onClose={() => setPole(null)} onOpenCabinet={() => select(pole.cabinetId)} />}
        <GeneratePolesModal open={genOpen} onOpenChange={setGenOpen} />
      </div>

      {selectedId && (
        <CabinetDrawer
          cabinetId={selectedId}
          mode={detailMode}
          onToggleMode={() => setDetailMode(detailMode === 'center' ? 'dock' : 'center')}
          onClose={() => select(null)}
          onLocate={(p) => {
            if (detailMode === 'center') setDetailMode('dock');
            mapRef.current?.flyTo(p, 17, { right: Math.min(760, window.innerWidth * 0.6) });
          }}
        />
      )}
    </div>
  );
}

function SearchBox({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ['search', q], queryFn: () => api.search(q), enabled: q.trim().length >= 2 });
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" />
      <Input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Tìm tủ theo mã, tên, địa chỉ…"
        className="w-72 pl-8 shadow"
        aria-label="Tìm tủ"
      />
      {open && q.trim().length >= 2 && (
        <div className="absolute mt-1 w-full overflow-hidden rounded-md border bg-panel shadow-lg">
          {data?.length ? (
            data.map((c) => (
              <button
                key={c.id}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                onMouseDown={() => {
                  onPick(c.id);
                  setQ('');
                }}
              >
                <span className="truncate">
                  <b>{c.code}</b> · {c.name}
                </span>
                <StatusBadge status={c.status} />
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-sm text-subtle">Không tìm thấy</div>
          )}
        </div>
      )}
    </div>
  );
}

function LayersPopover({ layers, setLayers, basemap, setBasemap }: { layers: MapLayers; setLayers: (l: MapLayers) => void; basemap: BasemapId; setBasemap: (b: BasemapId) => void }) {
  const set = (k: keyof MapLayers) => (v: boolean) => setLayers({ ...layers, [k]: v });
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="outline" size="icon" className="shadow" aria-label="Lớp hiển thị">
          <Layers className="h-4 w-4" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-50 w-64 space-y-3 rounded-lg border bg-panel p-3 shadow-xl">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-subtle">Lớp đối tượng</div>
            <div className="space-y-1">
              <Checkbox label="Tủ chiếu sáng" checked={layers.cabinets} onChange={set('cabinets')} />
              <Checkbox label="Tuyến chiếu sáng" checked={layers.routes} onChange={set('routes')} />
              <Checkbox label="Trụ / đèn chiếu sáng" checked={layers.poles} onChange={set('poles')} />
              <Checkbox label="Camera giám sát (giai đoạn 2)" checked={false} onChange={() => undefined} disabled />
              <Checkbox label="Cây xanh (giai đoạn 2)" checked={false} onChange={() => undefined} disabled />
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-subtle">Nhãn</div>
            <div className="space-y-1">
              <Checkbox label="Hiện tên đối tượng" checked={layers.labels} onChange={set('labels')} />
              <Checkbox label="Hiện mã đối tượng" checked={layers.codes} onChange={set('codes')} />
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-subtle">Bản đồ nền</div>
            <Select value={basemap} onChange={(e) => setBasemap(e.target.value as BasemapId)} className="w-full">
              <option value="auto">Tự động theo giao diện sáng/tối</option>
              {(['Sáng', 'Tối', 'Ảnh vệ tinh', 'Khác'] as const).map((g) => (
                <optgroup key={g} label={g}>
                  {BASEMAPS.filter((b) => b.group === g).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            {BASEMAPS.find((b) => b.id === basemap)?.note && <div className="mt-1 text-[11px] text-subtle">{BASEMAPS.find((b) => b.id === basemap)?.note}</div>}
          </div>
          <div className="text-[11px] text-subtle">Trụ và tuyến hiện khi phóng to (zoom ≥ 14)</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FavoritesPopover({ getView, flyTo }: { getView: () => { center: GeoPoint; zoom: number }; flyTo: (p: GeoPoint, z: number) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['favorites'], queryFn: api.favorites });
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: () => api.addFavorite({ name: name || 'Vị trí mới', ...getView() }),
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: ['favorites'] });
    },
  });
  const del = useMutation({ mutationFn: api.deleteFavorite, onSuccess: () => qc.invalidateQueries({ queryKey: ['favorites'] }) });
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="outline" size="icon" className="shadow" aria-label="Vị trí ưa thích">
          <Star className="h-4 w-4" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-50 w-72 rounded-lg border bg-panel p-3 shadow-xl">
          <div className="mb-2 text-xs font-semibold uppercase text-subtle">Vị trí ưa thích</div>
          <div className="mb-2 max-h-48 space-y-1 overflow-auto">
            {data?.map((f) => (
              <div key={f.id} className="flex items-center justify-between rounded px-2 py-1 hover:bg-muted">
                <button className="truncate text-left text-sm" onClick={() => flyTo(f.center, f.zoom)}>
                  {f.name}
                </button>
                <button className="text-subtle hover:text-st-offline" onClick={() => del.mutate(f.id)} aria-label={`Xóa ${f.name}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {!data?.length && <div className="text-sm text-subtle">Chưa có vị trí nào</div>}
          </div>
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên vị trí hiện tại" className="h-8" />
            <Button size="sm" onClick={() => add.mutate()} loading={add.isPending}>
              Lưu
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PolePanel({ pole, onClose, onOpenCabinet }: { pole: PoleAsset; onClose: () => void; onOpenCabinet: () => void }) {
  return (
    <div className="absolute right-3 top-3 z-10 w-72 rounded-lg border bg-panel shadow-lg">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="font-semibold">Trụ {pole.code}</div>
        <button onClick={onClose} aria-label="Đóng">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-1 px-3 py-2 text-sm">
        <div>
          <span className="text-subtle">Tủ:</span> {pole.cabinetName}
        </div>
        <div>
          <span className="text-subtle">Tuyến:</span> {pole.routeCode} ({pole.branch})
        </div>
        <div>
          <span className="text-subtle">Số đèn:</span> {pole.lampCount}
        </div>
        <div className="pt-1">
          {Array.from({ length: pole.lampCount }, (_, i) => (
            <div key={i} className="flex items-center justify-between border-t py-1 text-xs">
              <span>L{i + 1} · Đèn chính · 150 W</span>
              <span className="text-subtle">Chưa có đèn thông minh</span>
            </div>
          ))}
        </div>
        <Button size="sm" variant="outline" className="mt-2 w-full" onClick={onOpenCabinet}>
          Mở chi tiết tủ
        </Button>
      </div>
    </div>
  );
}

function GeneratePolesModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dist, setDist] = useState(30);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Sinh trụ hàng loạt"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button
            onClick={() => {
              toast('Đã sinh trụ vào bản nháp (mock) — bấm Lưu thay đổi để ghi', 'success');
              onOpenChange(false);
            }}
          >
            Sinh trụ
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-subtle">Chọn 2 trụ đầu/cuối và khoảng cách; hệ thống sinh các trụ dọc đoạn giữa với mã tự tăng.</p>
        <Field label="Trụ đầu (mã)">
          <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="vd TL01.001_N1_1" />
        </Field>
        <Field label="Trụ cuối (mã)">
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="vd TL01.001_N1_8" />
        </Field>
        <Field label="Khoảng cách giữa các trụ (m)">
          <Input type="number" min={5} value={dist} onChange={(e) => setDist(Number(e.target.value))} />
        </Field>
      </div>
    </Modal>
  );
}
