import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Popover from '@radix-ui/react-popover';
import {
  Crosshair, Layers, LocateFixed, PanelLeftClose, PanelLeftOpen, Pencil, Ruler, Satellite, Search, Star, Trash2, X, Map as MapIcon,
} from 'lucide-react';
import type { CabinetStatus, GeoPoint } from '@citylight/shared';
import { api, ApiError, type MapAssets, type MapEditOp, type PoleAsset } from '@/lib/api';
import { fill, locale, useDict, useLabels } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { MAP } from '@/i18n/dict/map';
import { EditToolbar, GeneratePolesModal, ImportPolesModal, PolePanel } from './MapEditor';
import { useSession } from '@/stores/session';
import { cn } from '@/lib/utils';
import { isMobileNow } from '@/lib/useIsMobile';
import { Button, Checkbox, Input, Modal, STATUS_ICON, StatusBadge, confirm, toast, Field, Select } from '@/components/ui';
import { CabinetMap, type CabinetMapHandle, type MapLayers, type EditTool, type MapDraft } from './CabinetMap';
import { LeftPanel } from './LeftPanel';
import { CabinetDrawer } from '../cabinet/CabinetDrawer';
import { BASEMAPS, BASEMAP_GROUPS, type BasemapId } from './mapStyle';

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
  const t = useDict(MAP);
  const L = useLabels();
  const mapRef = useRef<CabinetMapHandle>(null);

  // the list covers a phone screen, so a phone starts on the map
  const [panelOpen, setPanelOpen] = useState(() => !isMobileNow());
  // KPI card clicked -> left panel lists every cabinet in that status (null = normal tabs)
  const [statusView, setStatusView] = useState<CabinetStatus | null>(null);
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
  const flyPadding = detailMode === 'dock' && !isMobileNow() ? { right: Math.min(760, window.innerWidth * 0.6) } : undefined;
  const [center, setCenter] = useState<GeoPoint>({ lat: 10.79, lng: 106.7 });
  const [editMode, setEditMode] = useState(false);
  // map editor draft (M8): saved in one transaction by "Lưu"
  const [ops, setOps] = useState<MapEditOp[]>([]);
  const [tool, setTool] = useState<EditTool>('select');
  const [branch, setBranch] = useState<1 | 2>(1);
  const [drawing, setDrawing] = useState<[number, number][] | null>(null);
  const [editCabinetId, setEditCabinetId] = useState<string | null>(null);
  const [assets, setAssets] = useState<MapAssets | null>(null);
  const [assetsVersion, setAssetsVersion] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const moves = useMemo(() => {
    const m: Record<string, GeoPoint> = {};
    for (const o of ops) if (o.op === 'moveCabinet') m[o.cabinetId] = { lat: o.lat, lng: o.lng };
    return m;
  }, [ops]);
  const draft = useMemo<MapDraft>(() => {
    const lines: [number, number][][] = ops.flatMap((o) => (o.op === 'upsertRoute' ? [o.path] : []));
    if (drawing) lines.push(drawing);
    const points = ops.flatMap((o) => (o.op === 'addPole' || o.op === 'movePole' ? [{ lat: o.lat, lng: o.lng }] : []));
    const hiddenPoleIds = ops.flatMap((o) => (o.op === 'deletePole' || o.op === 'movePole' ? [o.poleId] : []));
    return { lines, points, hiddenPoleIds };
  }, [ops, drawing]);
  /** add an op; a newer op on the same object replaces the older one */
  const pushOp = (op: MapEditOp) =>
    setOps((list) => {
      const same = (x: MapEditOp) =>
        (op.op === 'moveCabinet' && x.op === 'moveCabinet' && x.cabinetId === op.cabinetId) ||
        (op.op === 'upsertRoute' && x.op === 'upsertRoute' && x.cabinetId === op.cabinetId && x.branch === op.branch) ||
        (op.op === 'movePole' && x.op === 'movePole' && x.poleId === op.poleId) ||
        (op.op === 'setPoleLamps' && x.op === 'setPoleLamps' && x.poleId === op.poleId);
      return [...list.filter((x) => !same(x)), op];
    });
  const finishRoute = () => {
    if (!drawing || drawing.length < 2 || !editCabinetId) return setDrawing(null);
    const saved = assets?.routes.find((r) => r.cabinetId === editCabinetId && r.branch === `N${branch}`);
    pushOp({ op: 'upsertRoute', cabinetId: editCabinetId, branch, path: drawing, expectedUpdatedAt: saved?.updatedAt });
    setDrawing(null);
  };
  const leaveEdit = () => {
    setOps([]);
    setDrawing(null);
    setTool('select');
    setEditCabinetId(null);
    setEditMode(false);
  };
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePts, setMeasurePts] = useState<GeoPoint[]>([]);
  const [pole, setPole] = useState<PoleAsset | null>(null);
  const [genOpen, setGenOpen] = useState(false);

  const stats = useQuery({ queryKey: ['map-stats'], queryFn: api.mapStats, refetchInterval: 15000 });
  const cabinetsQ = useQuery({ queryKey: ['map-cabinets'], queryFn: api.mapCabinets });
  // open E802 alarms: declared -> GPS lines on the map (refreshed with the alarms)
  const gpsDriftQ = useQuery({ queryKey: ['gps-drift'], queryFn: api.gpsDrift, refetchInterval: 60_000 });
  const regionQ = useQuery({ queryKey: ['map-region'], queryFn: api.mapRegion, staleTime: Infinity });
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
    mutationFn: () => api.saveMapEdits(ops),
    onSuccess: (r) => {
      toast(t.edit.saved(r.saved), 'success');
      setOps([]);
      setDrawing(null);
      setAssetsVersion((v) => v + 1);
      void qc.invalidateQueries({ queryKey: ['map-cabinets'] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : t.edit.saveFailed, 'error'),
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

  const pickFromList = (id: string) => {
    if (isMobileNow()) setPanelOpen(false);
    flyToCabinet(id);
  };

  const measureTotal = measurePts.reduce((sum, p, i) => (i ? sum + haversine(measurePts[i - 1]!, p) : 0), 0);

  return (
    <div className="absolute inset-0 flex max-md:flex-col">
      {/* Phone: the panel holding the counters is closed, so they stay reachable above the map */}
      <div className="grid shrink-0 grid-cols-6 gap-1 border-b bg-panel p-1.5 md:hidden">
        {KPI_ORDER.map((s) => {
          const Icon = STATUS_ICON[s];
          return (
            <button
              key={s}
              onClick={() => {
                setStatusView(s);
                setPanelOpen(true);
              }}
              title={fill(t.kpi.openList, { status: L.status[s] })}
              className="flex min-w-0 flex-col items-center rounded-md border px-0.5 py-1"
            >
              <Icon className={cn('h-4 w-4', KPI_COLOR[s])} />
              <span className="text-sm font-semibold leading-tight tabular-nums">{stats.data ? stats.data.cabinets[s].toLocaleString(locale()) : '…'}</span>
              <span className="w-full truncate text-center text-[10px] leading-tight text-subtle">{L.status[s]}</span>
            </button>
          );
        })}
      </div>
      {/* Left panel */}
      <aside className={cn('z-10 flex w-[340px] shrink-0 flex-col border-r bg-panel transition-all max-md:absolute max-md:inset-0 max-md:z-20 max-md:w-full max-md:border-r-0', !panelOpen && '-ml-[340px] max-md:hidden')}>
        <button onClick={() => setPanelOpen(false)} className="flex h-11 shrink-0 items-center justify-end gap-1 border-b px-3 text-sm text-subtle md:hidden">
          {t.toolbar.hideList} <X className="h-4 w-4" />
        </button>
        <div className="grid grid-cols-3 gap-1.5 border-b p-2">
          {KPI_ORDER.map((s) => {
            const Icon = STATUS_ICON[s];
            const active = statusView === s;
            return (
              <button
                key={s}
                onClick={() => setStatusView(active ? null : s)}
                aria-pressed={active}
                title={fill(t.kpi.openList, { status: L.status[s] })}
                className={cn('rounded-md border px-2 py-1.5 text-left transition hover:bg-muted', active && 'border-primary bg-primary/10')}
              >
                <div className={cn('flex items-center gap-1 text-[11px]', KPI_COLOR[s])}>
                  <Icon className="h-3.5 w-3.5" />
                  <span className="truncate">{L.status[s]}</span>
                </div>
                <div className="text-lg font-semibold tabular-nums">{stats.data ? stats.data.cabinets[s].toLocaleString(locale()) : '…'}</div>
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-3 gap-1.5 border-b p-2 text-center text-[11px] text-subtle">
          <div>
            <div className="text-base font-semibold text-fg">{stats.data ? `${stats.data.onlinePct.toFixed(1)}%` : '…'}</div>
            {t.kpi.online}
          </div>
          <div>
            <div className="text-base font-semibold text-fg">{stats.data?.energyTodayKwh ?? '—'}</div>
            {t.kpi.energyToday}
          </div>
          <div>
            <div className="text-base font-semibold text-fg">{stats.data?.overdueIncidents ?? '…'}</div>
            {t.kpi.overdue}
          </div>
        </div>
        <LeftPanel
          center={center}
          cabinets={cabinets}
          statusView={statusView}
          onCloseStatus={() => setStatusView(null)}
          selectedId={selectedId}
          onPick={pickFromList}
        />
      </aside>

      {/* Map */}
      <div className="relative min-h-0 min-w-0 flex-1">
        <CabinetMap
          ref={mapRef}
          cabinets={cabinets}
          layers={layers}
          basemap={basemap}
          selectedId={editMode ? editCabinetId : selectedId}
          editMode={editMode}
          tool={tool}
          draft={draft}
          assetsVersion={assetsVersion}
          onAssets={setAssets}
          onMapClick={(pt) => {
            const c = cabinets.find((x) => x.id === editCabinetId);
            if (!c) return toast(t.edit.pickCabinetFirst, 'error');
            if (tool === 'route') setDrawing((d) => (d ? [...d, [pt.lng, pt.lat]] : [[c.location.lng, c.location.lat], [pt.lng, pt.lat]]));
            if (tool === 'pole') pushOp({ op: 'addPole', cabinetId: c.id, branch, lat: pt.lat, lng: pt.lng, lampCount: 1 });
          }}
          onMapDblClick={finishRoute}
          onPoleDrag={(pole, pt) => pushOp({ op: 'movePole', poleId: pole.id, lat: pt.lat, lng: pt.lng, expectedUpdatedAt: pole.updatedAt })}
          measureMode={measureMode}
          measurePoints={measurePts}
          onSelectCabinet={(id) => (editMode ? (setEditCabinetId(id), setDrawing(null)) : flyToCabinet(id))}
          onSelectPole={setPole}
          onMoveCabinet={(id, p) => pushOp({ op: 'moveCabinet', cabinetId: id, lat: p.lat, lng: p.lng })}
          onMeasure={setMeasurePts}
          onViewChange={(c) => setCenter(c)}
          gpsDrift={gpsDriftQ.data}
          region={regionQ.data?.region ?? null}
        />

        {/* Toolbar */}
        <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2 max-md:right-3">
          <Button variant="outline" size="icon" onClick={() => setPanelOpen((v) => !v)} aria-label={panelOpen ? t.toolbar.hideList : t.toolbar.showList} className="shadow">
            {panelOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
          </Button>
          <SearchBox onPick={flyToCabinet} />
          <LayersPopover layers={layers} setLayers={setLayers} basemap={basemap} setBasemap={setBasemap} />
          <FavoritesPopover getView={() => mapRef.current!.getView()} flyTo={(p, z) => mapRef.current?.flyTo(p, z)} />
          <Button
            variant={measureMode ? 'primary' : 'outline'}
            size="icon"
            className="shadow"
            aria-label={t.toolbar.measure}
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
            aria-label={t.toolbar.myLocation}
            onClick={() =>
              navigator.geolocation?.getCurrentPosition(
                (p) => mapRef.current?.flyTo({ lat: p.coords.latitude, lng: p.coords.longitude }, 15),
                () => toast(t.toolbar.noLocation, 'error'),
              )
            }
          >
            <LocateFixed className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" className="shadow" aria-label={t.toolbar.satellite} onClick={() => setBasemap(basemap === 'hybrid' || basemap === 'satellite' ? 'auto' : 'hybrid')}>
            {basemap === 'hybrid' || basemap === 'satellite' ? <MapIcon className="h-4 w-4" /> : <Satellite className="h-4 w-4" />}
          </Button>
          {can('map.edit') && (
            <Button variant={editMode ? 'primary' : 'outline'} size="sm" className="shadow" onClick={() => (editMode ? undefined : (select(null), setEditMode(true)))}>
              <Pencil className="h-4 w-4" /> {t.toolbar.edit}
            </Button>
          )}
        </div>

        {measureMode && (
          <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-3 rounded-md border bg-panel px-3 py-1.5 text-sm shadow max-md:left-3 max-md:right-3 max-md:top-32 max-md:translate-x-0">
            <Crosshair className="h-4 w-4 text-st-offline" />
            {t.toolbar.measureHint} <b>{Math.round(measureTotal).toLocaleString(locale())} m</b>
            <Button size="sm" variant="ghost" onClick={() => setMeasurePts([])}>
              {t.toolbar.measureClear}
            </Button>
          </div>
        )}

        {editMode && (
          <EditToolbar
            tool={tool}
            setTool={(t) => {
              setTool(t);
              setDrawing(null);
            }}
            branch={branch}
            setBranch={setBranch}
            cabinetName={cabinets.find((c) => c.id === editCabinetId)?.code ?? null}
            ops={ops}
            drawing={!!drawing}
            onFinishRoute={finishRoute}
            onUndo={() => setOps((l) => l.slice(0, -1))}
            onCancel={async () => {
              if (ops.length && !(await confirm({ title: t.edit.discardTitle, body: t.edit.discardBody(ops.length), danger: true, confirmLabel: t.edit.discard }))) return;
              leaveEdit();
            }}
            onSave={() => saveEdits.mutate()}
            saving={saveEdits.isPending}
            onGenerate={() => setGenOpen(true)}
            onImport={() => setImportOpen(true)}
          />
        )}

        {pole && !selectedId && (
          <PolePanel key={pole.id} pole={pole} editMode={editMode} onClose={() => setPole(null)} onOpenCabinet={() => select(pole.cabinetId)} onOp={pushOp} />
        )}
        <GeneratePolesModal open={genOpen} onOpenChange={setGenOpen} assets={assets} cabinetId={editCabinetId} branch={branch} onDone={() => setAssetsVersion((v) => v + 1)} />
        <ImportPolesModal open={importOpen} onOpenChange={setImportOpen} onDone={() => setAssetsVersion((v) => v + 1)} />
      </div>

      {selectedId && (
        <CabinetDrawer
          cabinetId={selectedId}
          mode={detailMode}
          onToggleMode={() => setDetailMode(detailMode === 'center' ? 'dock' : 'center')}
          onClose={() => select(null)}
          onLocate={(p) => {
            // on a phone the details cover the whole map: close them to show the spot
            if (isMobileNow()) {
              select(null);
              mapRef.current?.flyTo(p, 17);
              return;
            }
            if (detailMode === 'center') setDetailMode('dock');
            mapRef.current?.flyTo(p, 17, { right: Math.min(760, window.innerWidth * 0.6) });
          }}
        />
      )}
    </div>
  );
}

function SearchBox({ onPick }: { onPick: (id: string) => void }) {
  const t = useDict(MAP).search;
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ['search', q], queryFn: () => api.search(q), enabled: q.trim().length >= 2 });
  return (
    <div className="relative max-md:min-w-0 max-md:flex-1 max-md:basis-[calc(100%-3rem)]">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle max-md:top-3.5" />
      <Input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={t.placeholder}
        className="w-72 pl-8 shadow max-md:w-full"
        aria-label={t.label}
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
            <div className="px-3 py-2 text-sm text-subtle">{t.none}</div>
          )}
        </div>
      )}
    </div>
  );
}

function LayersPopover({ layers, setLayers, basemap, setBasemap }: { layers: MapLayers; setLayers: (l: MapLayers) => void; basemap: BasemapId; setBasemap: (b: BasemapId) => void }) {
  const m = useDict(MAP);
  const t = m.layers;
  const set = (k: keyof MapLayers) => (v: boolean) => setLayers({ ...layers, [k]: v });
  const note = BASEMAPS.find((b) => b.id === basemap)?.note;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="outline" size="icon" className="shadow" aria-label={t.button}>
          <Layers className="h-4 w-4" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-50 w-64 space-y-3 rounded-lg border bg-panel p-3 shadow-xl">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-subtle">{t.objects}</div>
            <div className="space-y-1">
              <Checkbox label={t.cabinets} checked={layers.cabinets} onChange={set('cabinets')} />
              <Checkbox label={t.routes} checked={layers.routes} onChange={set('routes')} />
              <Checkbox label={t.poles} checked={layers.poles} onChange={set('poles')} />
              <Checkbox label={t.cameras} checked={false} onChange={() => undefined} disabled />
              <Checkbox label={t.trees} checked={false} onChange={() => undefined} disabled />
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-subtle">{t.labels}</div>
            <div className="space-y-1">
              <Checkbox label={t.showNames} checked={layers.labels} onChange={set('labels')} />
              <Checkbox label={t.showCodes} checked={layers.codes} onChange={set('codes')} />
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-subtle">{t.basemap}</div>
            <Select value={basemap} onChange={(e) => setBasemap(e.target.value as BasemapId)} className="w-full">
              <option value="auto">{t.auto}</option>
              {BASEMAP_GROUPS.map((g) => (
                <optgroup key={g} label={m.basemapGroup[g]}>
                  {BASEMAPS.filter((b) => b.group === g).map((b) => (
                    <option key={b.id} value={b.id}>
                      {m.basemap[b.id]}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            {note && <div className="mt-1 text-[11px] text-subtle">{m.basemapNote[note]}</div>}
          </div>
          <div className="text-[11px] text-subtle">{t.zoomHint}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FavoritesPopover({ getView, flyTo }: { getView: () => { center: GeoPoint; zoom: number }; flyTo: (p: GeoPoint, z: number) => void }) {
  const qc = useQueryClient();
  const t = useDict(MAP).favorites;
  const c = useDict(COMMON);
  const { data } = useQuery({ queryKey: ['favorites'], queryFn: api.favorites });
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: () => api.addFavorite({ name: name || t.newName, ...getView() }),
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: ['favorites'] });
    },
  });
  const del = useMutation({ mutationFn: api.deleteFavorite, onSuccess: () => qc.invalidateQueries({ queryKey: ['favorites'] }) });
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="outline" size="icon" className="shadow" aria-label={t.button}>
          <Star className="h-4 w-4" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-50 w-72 rounded-lg border bg-panel p-3 shadow-xl">
          <div className="mb-2 text-xs font-semibold uppercase text-subtle">{t.button}</div>
          <div className="mb-2 max-h-48 space-y-1 overflow-auto">
            {data?.map((f) => (
              <div key={f.id} className="flex items-center justify-between rounded px-2 py-1 hover:bg-muted">
                <button className="truncate text-left text-sm" onClick={() => flyTo(f.center, f.zoom)}>
                  {f.name}
                </button>
                <button className="text-subtle hover:text-st-offline" onClick={() => del.mutate(f.id)} aria-label={fill(t.remove, { name: f.name })}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {!data?.length && <div className="text-sm text-subtle">{t.empty}</div>}
          </div>
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.namePlaceholder} className="h-8" />
            <Button size="sm" onClick={() => add.mutate()} loading={add.isPending}>
              {c.save}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

