import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap, MapMouseEvent, PaddingOptions } from 'maplibre-gl';
import type { CabinetStatus, CabinetSummary, GeoPoint, GpsDriftItem } from '@citylight/shared';
import { api, type MapAssets, type PoleAsset } from '@/lib/api';
import { useUi } from '@/stores/session';
import { FONT_BOLD, FONT_REGULAR, resolveBasemap, type BasemapId } from './mapStyle';
import { addMapIcons } from './mapIcons';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// Ship the (self-contained) MapLibre worker as a build asset; its default import.meta.url lookup
// is not followed by the bundler, so production builds would otherwise have no worker file.
maplibregl.setWorkerUrl(workerUrl);

export interface MapLayers {
  cabinets: boolean;
  routes: boolean;
  poles: boolean;
  labels: boolean;
  codes: boolean;
}

/** Map editor draft drawn over the saved assets (M8). */
export interface MapDraft {
  lines: [number, number][][];
  points: { lng: number; lat: number }[];
  /** saved poles hidden because they are deleted or moved in the draft */
  hiddenPoleIds: string[];
}
export type EditTool = 'select' | 'route' | 'pole';

export interface CabinetMapHandle {
  flyTo: (p: GeoPoint, zoom?: number, padding?: Partial<PaddingOptions>) => void;
  getView: () => { center: GeoPoint; zoom: number };
}

interface Props {
  cabinets: CabinetSummary[];
  statusFilter: Set<CabinetStatus>;
  layers: MapLayers;
  basemap: BasemapId;
  selectedId: string | null;
  editMode: boolean;
  measureMode: boolean;
  onSelectCabinet: (id: string) => void;
  onSelectPole: (p: PoleAsset) => void;
  onMoveCabinet: (id: string, p: GeoPoint) => void;
  onMeasure: (points: GeoPoint[]) => void;
  onViewChange: (center: GeoPoint, zoom: number) => void;
  measurePoints: GeoPoint[];
  tool?: EditTool;
  draft?: MapDraft;
  /** bump to reload routes / poles after a save */
  assetsVersion?: number;
  onAssets?: (a: MapAssets) => void;
  onMapClick?: (p: GeoPoint) => void;
  onMapDblClick?: () => void;
  onPoleDrag?: (pole: PoleAsset, p: GeoPoint) => void;
  /** cabinets with an open E802: dashed line declared -> GPS fix, so a misplaced cabinet shows on the map */
  gpsDrift?: GpsDriftItem[];
}

const HCMC: [number, number] = [106.7, 10.79];
const EMPTY = { type: 'FeatureCollection' as const, features: [] };
const coords = (g: unknown) => (g as { coordinates: [number, number] }).coordinates;

function cabinetsGeoJson(list: CabinetSummary[], filter: Set<CabinetStatus>) {
  return {
    type: 'FeatureCollection' as const,
    features: list
      .filter((c) => filter.size === 0 || filter.has(c.status))
      .map((c) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [c.location.lng, c.location.lat] },
        properties: { id: c.id, name: c.name, code: c.code, status: c.status },
      })),
  };
}

/** Use the label fonts of the active basemap so our text renders with its glyph server. */
function pickFonts(m: MlMap): { regular: string[]; bold: string[] } {
  const fonts = new Set<string>();
  for (const l of m.getStyle().layers ?? []) {
    const f = (l as { layout?: Record<string, unknown> }).layout?.['text-font'];
    if (Array.isArray(f)) f.forEach((x) => typeof x === 'string' && fonts.add(x));
  }
  const list = [...fonts];
  if (!list.length) return { regular: FONT_REGULAR, bold: FONT_BOLD };
  const regular = list.find((f) => /regular/i.test(f)) ?? list[0]!;
  const bold = list.find((f) => /bold/i.test(f)) ?? regular;
  return { regular: [regular], bold: [bold] };
}

export const CabinetMap = forwardRef<CabinetMapHandle, Props>(function CabinetMap(props, ref) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const theme = useUi((s) => s.theme);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const editMarker = useRef<maplibregl.Marker | null>(null);
  const poleCache = useRef<PoleAsset[]>([]);
  const styleKey = `${props.basemap}:${theme}`;

  useImperativeHandle(ref, () => ({
    flyTo: (p, zoom = 16, padding) =>
      map.current?.flyTo({ center: [p.lng, p.lat], zoom, speed: 1.6, padding: { top: 0, bottom: 0, left: 0, right: 0, ...padding } }),
    getView: () => {
      const c = map.current!.getCenter();
      return { center: { lat: c.lat, lng: c.lng }, zoom: map.current!.getZoom() };
    },
  }));

  // ---- create map once ----
  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: resolveBasemap(props.basemap, theme === 'dark').style(),
      center: HCMC,
      zoom: 11.5,
      attributionControl: { compact: true },
    });
    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __clMap: MlMap }).__clMap = m; // debug handle
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    // Fires after the first style and after every setStyle (theme / basemap change): re-add icons + overlay layers.
    m.on('style.load', () => void installOverlay(m));
    installHandlers(m);
    m.on('moveend', () => {
      const c = m.getCenter();
      propsRef.current.onViewChange({ lat: c.lat, lng: c.lng }, m.getZoom());
      void loadPoles(m);
    });
    return () => {
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function installOverlay(m: MlMap) {
    await addMapIcons(m);
    if (m.getSource('cabinets')) return;
    const p = propsRef.current;
    const dark = themeRef.current === 'dark';
    const f = pickFonts(m);
    const halo = { 'text-halo-color': dark ? '#0b0f17' : '#ffffff', 'text-halo-width': 1.4 };
    const textColor = dark ? '#e5e7eb' : '#111827';

    // Routes: lit = amber, off = grey, unknown = violet; casing keeps them readable on any basemap.
    m.addSource('routes', { type: 'geojson', data: EMPTY });
    m.addLayer({
      id: 'routes-casing',
      type: 'line',
      source: 'routes',
      minzoom: 13,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': dark ? '#0b0f17' : '#ffffff', 'line-width': 6, 'line-opacity': 0.9 },
    });
    m.addLayer({
      id: 'routes',
      type: 'line',
      source: 'routes',
      minzoom: 13,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['match', ['get', 'state'], 'on', '#f59e0b', 'off', '#94a3b8', '#a78bfa'], 'line-width': 3 },
    });

    m.addSource('poles', { type: 'geojson', data: EMPTY });
    m.addLayer({
      id: 'poles',
      type: 'symbol',
      source: 'poles',
      minzoom: 14.5,
      layout: {
        'icon-image': ['concat', 'pole-', ['get', 'state']] as unknown as ExpressionSpecification,
        'icon-anchor': 'bottom',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 14.5, 0.65, 17, 1.05, 19, 1.4],
        'icon-allow-overlap': true,
      },
    });
    m.addLayer({
      id: 'pole-labels',
      type: 'symbol',
      source: 'poles',
      minzoom: 17,
      layout: {
        'text-field': ['concat', ['get', 'code'], ['case', ['>', ['get', 'lampCount'], 1], ['concat', ' (', ['to-string', ['get', 'lampCount']], ' đèn)'], '']],
        'text-size': 10,
        'text-offset': [0, 0.4],
        'text-anchor': 'top',
        'text-font': f.regular,
      },
      paint: { 'text-color': textColor, ...halo },
    });

    m.addSource('cabinets', { type: 'geojson', data: cabinetsGeoJson(p.cabinets, p.statusFilter), cluster: true, clusterRadius: 50, clusterMaxZoom: 14 });
    m.addLayer({
      id: 'cluster-halo',
      type: 'circle',
      source: 'cabinets',
      filter: ['has', 'point_count'],
      paint: { 'circle-color': '#2563eb', 'circle-opacity': 0.18, 'circle-radius': ['step', ['get', 'point_count'], 24, 20, 30, 100, 38] },
    });
    m.addLayer({
      id: 'clusters',
      type: 'circle',
      source: 'cabinets',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#2563eb',
        'circle-radius': ['step', ['get', 'point_count'], 15, 20, 19, 100, 25],
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#ffffff',
      },
    });
    m.addLayer({
      id: 'cluster-count',
      type: 'symbol',
      source: 'cabinets',
      filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 13, 'text-font': f.bold, 'text-allow-overlap': true },
      paint: { 'text-color': '#ffffff' },
    });
    m.addLayer({
      id: 'cabinet-selected',
      type: 'circle',
      source: 'cabinets',
      filter: ['==', ['get', 'id'], ''],
      paint: { 'circle-radius': 14, 'circle-color': '#2563eb', 'circle-opacity': 0.25, 'circle-stroke-width': 2, 'circle-stroke-color': '#2563eb' },
    });
    m.addLayer({
      id: 'cabinet-points',
      type: 'symbol',
      source: 'cabinets',
      filter: ['!', ['has', 'point_count']],
      layout: {
        'icon-image': ['concat', 'cab-', ['get', 'status']] as unknown as ExpressionSpecification,
        'icon-anchor': 'bottom',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.7, 16, 1.05],
        'icon-allow-overlap': true,
        'symbol-sort-key': ['match', ['get', 'status'], 'offline', 0, 'fault', 1, 2],
        'text-field': ['get', 'name'],
        'text-font': f.regular,
        'text-size': 11,
        'text-anchor': 'top',
        'text-offset': [0, 0.3],
        'text-optional': true,
      },
      paint: { 'text-color': textColor, ...halo, 'text-opacity': ['step', ['zoom'], 0, 14, 1] },
    });
    m.addSource('measure', { type: 'geojson', data: EMPTY });
    m.addLayer({ id: 'measure-line', type: 'line', source: 'measure', paint: { 'line-color': '#ef4444', 'line-width': 2.5, 'line-dasharray': [2, 1] } });
    m.addLayer({
      id: 'measure-pts',
      type: 'circle',
      source: 'measure',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 5, 'circle-color': '#ef4444', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
    });

    m.addSource('pole-drag', { type: 'geojson', data: EMPTY });
    m.addLayer({ id: 'pole-drag', type: 'circle', source: 'pole-drag', paint: { 'circle-radius': 7, 'circle-color': '#f59e0b', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    m.addSource('draft', { type: 'geojson', data: EMPTY });
    m.addLayer({ id: 'draft-lines', type: 'line', source: 'draft', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#2563eb', 'line-width': 3, 'line-dasharray': [2, 1.5] } });
    m.addLayer({
      id: 'draft-points',
      type: 'circle',
      source: 'draft',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 6, 'circle-color': '#2563eb', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
    });

    // GPS drift (E802): orange dashed line from the declared position to the GPS fix + hollow dot + distance label
    m.addSource('gps-drift', { type: 'geojson', data: EMPTY });
    m.addLayer({
      id: 'gps-drift-line',
      type: 'line',
      source: 'gps-drift',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#ea580c', 'line-width': 2, 'line-dasharray': [2, 2] },
    });
    m.addLayer({
      id: 'gps-drift-pt',
      type: 'circle',
      source: 'gps-drift',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 6, 'circle-color': 'rgba(234,88,12,0.15)', 'circle-stroke-color': '#ea580c', 'circle-stroke-width': 2 },
    });
    m.addLayer({
      id: 'gps-drift-label',
      type: 'symbol',
      source: 'gps-drift',
      minzoom: 13,
      filter: ['==', ['geometry-type'], 'Point'],
      layout: { 'text-field': ['get', 'label'], 'text-font': f.regular, 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top' },
      paint: { 'text-color': '#ea580c', ...halo },
    });

    applyLayerVisibility(m);
    applySelected(m);
    applyMeasure(m);
    applyDraft(m);
    applyGpsDrift(m);
    void loadPoles(m);
  }

  function applyGpsDrift(m: MlMap) {
    const list = propsRef.current.gpsDrift ?? [];
    (m.getSource('gps-drift') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: list.flatMap((d) => [
        { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: [[d.declared.lng, d.declared.lat], [d.gps.lng, d.gps.lat]] }, properties: {} },
        { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [d.gps.lng, d.gps.lat] }, properties: { label: `GPS ${d.code} · lệch ${d.distanceM} m` } },
      ]),
    });
  }

  function installHandlers(m: MlMap) {
    m.on('click', (e: MapMouseEvent) => {
      const p = propsRef.current;
      if (p.measureMode) p.onMeasure([...p.measurePoints, { lat: e.lngLat.lat, lng: e.lngLat.lng }]);
      else if (p.editMode && p.tool && p.tool !== 'select') p.onMapClick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    m.on('dblclick', (e) => {
      const p = propsRef.current;
      if (p.editMode && p.tool === 'route') {
        e.preventDefault(); // finish the route instead of zooming in
        p.onMapDblClick?.();
      }
    });
    // edit mode: drag a saved pole (select tool)
    let dragging: PoleAsset | null = null;
    let dragFrom: { x: number; y: number } | null = null;
    m.on('mousedown', 'poles', (e) => {
      const p = propsRef.current;
      if (!p.editMode || p.tool !== 'select') return;
      const id = e.features?.[0]?.properties?.id as string | undefined;
      dragging = poleCache.current.find((x) => x.id === id) ?? null;
      if (!dragging) return;
      dragFrom = { x: e.point.x, y: e.point.y };
      e.preventDefault();
      m.dragPan.disable();
      m.getCanvas().style.cursor = 'grabbing';
    });
    m.on('mousemove', (e) => {
      if (!dragging) return;
      (m.getSource('pole-drag') as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] }, properties: {} }],
      });
    });
    m.on('mouseup', (e) => {
      if (!dragging) return;
      const pole = dragging;
      dragging = null;
      m.dragPan.enable();
      m.getCanvas().style.cursor = '';
      (m.getSource('pole-drag') as GeoJSONSource | undefined)?.setData(EMPTY);
      // a click on a pole is not a move: it opens the pole panel (the click handler)
      const moved = dragFrom ? Math.hypot(e.point.x - dragFrom.x, e.point.y - dragFrom.y) : 0;
      if (moved > 4) propsRef.current.onPoleDrag?.(pole, { lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    m.on('click', 'clusters', async (e) => {
      const f = m.queryRenderedFeatures(e.point, { layers: ['clusters'] })[0];
      if (!f) return;
      const zoom = await (m.getSource('cabinets') as GeoJSONSource).getClusterExpansionZoom(f.properties!.cluster_id as number);
      m.easeTo({ center: coords(f.geometry), zoom });
    });
    m.on('click', 'cabinet-points', (e) => {
      if (propsRef.current.measureMode) return;
      const id = e.features?.[0]?.properties?.id as string | undefined;
      if (id) propsRef.current.onSelectCabinet(id);
    });
    m.on('click', 'poles', (e) => {
      if (propsRef.current.measureMode) return;
      const id = e.features?.[0]?.properties?.id as string | undefined;
      const pole = poleCache.current.find((x) => x.id === id);
      if (pole) propsRef.current.onSelectPole(pole);
    });
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: [0, -26] });
    m.on('mouseenter', 'poles', (e) => {
      m.getCanvas().style.cursor = 'pointer';
      const f = e.features?.[0];
      if (!f) return;
      const pr = f.properties as Record<string, string>;
      popup
        .setLngLat(coords(f.geometry))
        .setHTML(`<div style="font-size:12px"><b>Trụ:</b> ${pr.code} · <b>Tủ:</b> ${pr.cabinetName} · <b>Tuyến:</b> ${pr.routeCode}</div>`)
        .addTo(m);
    });
    m.on('mouseleave', 'poles', () => {
      m.getCanvas().style.cursor = '';
      popup.remove();
    });
    for (const l of ['clusters', 'cabinet-points']) {
      m.on('mouseenter', l, () => (m.getCanvas().style.cursor = 'pointer'));
      m.on('mouseleave', l, () => (m.getCanvas().style.cursor = propsRef.current.measureMode ? 'crosshair' : ''));
    }
  }

  async function loadPoles(m: MlMap) {
    const p = propsRef.current;
    if (!m.getSource('poles') || m.getZoom() < 13 || (!p.layers.poles && !p.layers.routes)) return;
    const b = m.getBounds();
    const assets = await api.mapAssets([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], m.getZoom()).catch(() => null);
    if (!assets) return;
    poleCache.current = assets.poles;
    p.onAssets?.(assets);
    const cab = new Map(p.cabinets.map((c) => [c.id, c]));
    const stateOf = (cabinetId: string, branch: 'N1' | 'N2') => {
      const c = cab.get(cabinetId);
      const on = branch === 'N1' ? c?.branch1On : c?.branch2On;
      return on === null || on === undefined ? 'unknown' : on ? 'on' : 'off';
    };
    const hidden = new Set(p.draft?.hiddenPoleIds ?? []);
    (m.getSource('poles') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: assets.poles
        .filter((x) => !hidden.has(x.id))
        .map((x) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [x.location.lng, x.location.lat] },
          properties: { id: x.id, code: x.code, cabinetName: x.cabinetName, routeCode: x.routeCode, lampCount: x.lampCount, state: stateOf(x.cabinetId, x.branch) },
        })),
    });
    (m.getSource('routes') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: assets.routes.map((r) => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: r.path },
        properties: { id: r.id, code: r.code, state: stateOf(r.cabinetId, r.branch) },
      })),
    });
  }

  function applyDraft(m: MlMap) {
    const d = propsRef.current.draft;
    (m.getSource('draft') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: [
        ...(d?.lines ?? []).filter((l) => l.length > 1).map((l) => ({ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: l }, properties: {} })),
        ...(d?.points ?? []).map((pt) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [pt.lng, pt.lat] }, properties: {} })),
      ],
    });
  }

  function applyLayerVisibility(m: MlMap) {
    const l = propsRef.current.layers;
    const set = (id: string, on: boolean) => m.getLayer(id) && m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    ['cluster-halo', 'clusters', 'cluster-count', 'cabinet-points', 'cabinet-selected', 'gps-drift-line', 'gps-drift-pt', 'gps-drift-label'].forEach((id) => set(id, l.cabinets));
    if (m.getLayer('cabinet-points')) {
      const field = !l.labels && !l.codes ? '' : l.codes && l.labels ? ['concat', ['get', 'code'], ' · ', ['get', 'name']] : l.codes ? ['get', 'code'] : ['get', 'name'];
      m.setLayoutProperty('cabinet-points', 'text-field', field as unknown as ExpressionSpecification);
    }
    set('routes', l.routes);
    set('routes-casing', l.routes);
    set('poles', l.poles);
    set('pole-labels', l.poles && l.labels);
  }

  function applySelected(m: MlMap) {
    if (m.getLayer('cabinet-selected')) m.setFilter('cabinet-selected', ['==', ['get', 'id'], propsRef.current.selectedId ?? '']);
  }

  function applyMeasure(m: MlMap) {
    const src = m.getSource('measure') as GeoJSONSource | undefined;
    if (!src) return;
    const pts = propsRef.current.measurePoints;
    src.setData({
      type: 'FeatureCollection',
      features: [
        ...(pts.length > 1 ? [{ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: pts.map((p) => [p.lng, p.lat]) }, properties: {} }] : []),
        ...pts.map((p) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] }, properties: {} })),
      ],
    });
  }

  // ---- reactive updates ----
  useEffect(() => {
    const m = map.current;
    (m?.getSource('cabinets') as GeoJSONSource | undefined)?.setData(cabinetsGeoJson(props.cabinets, props.statusFilter));
    if (m) void loadPoles(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.cabinets, props.statusFilter]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    applyLayerVisibility(m);
    void loadPoles(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.layers]);

  useEffect(() => {
    const m = map.current;
    if (m) applyGpsDrift(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.gpsDrift]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    applyDraft(m);
    void loadPoles(m); // hidden / moved poles
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.draft, props.assetsVersion]);

  useEffect(() => {
    const m = map.current;
    if (m) m.getCanvas().style.cursor = props.editMode && props.tool && props.tool !== 'select' ? 'crosshair' : '';
  }, [props.editMode, props.tool]);

  useEffect(() => {
    if (map.current) applySelected(map.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedId]);

  // Basemap or theme change → full style swap (no diff); 'style.load' then re-installs the overlay with current data.
  const lastStyle = useRef(styleKey);
  useEffect(() => {
    const m = map.current;
    if (!m || lastStyle.current === styleKey) return;
    lastStyle.current = styleKey;
    m.setStyle(resolveBasemap(props.basemap, theme === 'dark').style(), { diff: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleKey]);

  // edit mode: draggable marker on the selected cabinet
  useEffect(() => {
    editMarker.current?.remove();
    editMarker.current = null;
    const m = map.current;
    const c = props.cabinets.find((x) => x.id === props.selectedId);
    if (!m || !props.editMode || !c) return;
    const mk = new maplibregl.Marker({ draggable: true, color: '#2563eb' }).setLngLat([c.location.lng, c.location.lat]).addTo(m);
    mk.on('dragend', () => {
      const ll = mk.getLngLat();
      propsRef.current.onMoveCabinet(c.id, { lat: ll.lat, lng: ll.lng });
    });
    editMarker.current = mk;
  }, [props.editMode, props.selectedId, props.cabinets]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    applyMeasure(m);
    m.getCanvas().style.cursor = props.measureMode ? 'crosshair' : '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.measurePoints, props.measureMode]);

  return <div ref={el} className="absolute inset-0" />;
});
