import type { StyleSpecification } from 'maplibre-gl';
import type { CabinetStatus } from '@citylight/shared';
import { dictNow } from '@/i18n';
import { MAP } from '@/i18n/dict/map';

// Basemap registry (spec: street / satellite / city tile server). All entries work without an API key in dev.
// Production: self-host VersaTiles/OpenFreeMap tiles, or buy a plan (CARTO / Stadia / MapTiler) — see README.
export type BasemapId = 'auto' | 'voyager' | 'colorful' | 'liberty' | 'positron' | 'darkmatter' | 'eclipse' | 'satellite' | 'hybrid' | 'custom';

/** Name: MAP.basemap[id]; group / note labels: MAP.basemapGroup / MAP.basemapNote. */
export interface BasemapDef {
  id: Exclude<BasemapId, 'auto'>;
  group: 'light' | 'dark' | 'satellite' | 'other';
  style: () => string | StyleSpecification;
  note?: 'carto' | 'open';
}

export const BASEMAP_GROUPS: readonly BasemapDef['group'][] = ['light', 'dark', 'satellite', 'other'];

const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
export const FONT_REGULAR = ['Noto Sans Regular'];
export const FONT_BOLD = ['Noto Sans Bold'];

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

function rasterStyle(layers: { url: string; attribution?: string }[]): StyleSpecification {
  const sources: StyleSpecification['sources'] = {};
  layers.forEach((l, i) => {
    sources[`base${i}`] = { type: 'raster', tiles: [l.url], tileSize: 256, attribution: l.attribution, maxzoom: 19 };
  });
  return {
    version: 8,
    glyphs: GLYPHS,
    sources,
    layers: layers.map((_, i) => ({ id: `base${i}`, type: 'raster' as const, source: `base${i}` })),
  };
}

export const BASEMAPS: BasemapDef[] = [
  { id: 'voyager', group: 'light', style: () => 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json', note: 'carto' },
  { id: 'colorful', group: 'light', style: () => 'https://tiles.versatiles.org/assets/styles/colorful/style.json', note: 'open' },
  { id: 'liberty', group: 'light', style: () => 'https://tiles.openfreemap.org/styles/liberty', note: 'open' },
  { id: 'positron', group: 'light', style: () => 'https://tiles.openfreemap.org/styles/positron' },
  { id: 'darkmatter', group: 'dark', style: () => 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', note: 'carto' },
  { id: 'eclipse', group: 'dark', style: () => 'https://tiles.versatiles.org/assets/styles/eclipse/style.json', note: 'open' },
  { id: 'satellite', group: 'satellite', style: () => rasterStyle([{ url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, attribution: 'Imagery © Esri' }]) },
  {
    id: 'hybrid',
    group: 'satellite',
    style: () =>
      rasterStyle([
        { url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, attribution: 'Imagery © Esri' },
        { url: `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}` },
        { url: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}` },
      ]),
  },
  {
    id: 'custom',
    group: 'other',
    // attribution in the language active when the style is (re)loaded
    style: () => rasterStyle([{ url: import.meta.env.VITE_CUSTOM_TILES || `${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, attribution: dictNow(MAP).overlay.customAttribution }]),
  },
];

/** 'auto' follows the UI theme. */
export function resolveBasemap(id: BasemapId, dark: boolean): BasemapDef {
  const real = id === 'auto' ? (dark ? 'eclipse' : 'colorful') : id;
  return BASEMAPS.find((b) => b.id === real) ?? BASEMAPS[0]!;
}

/** Reads the status colour tokens from CSS so map markers follow light/dark theme. */
export function statusColors(): Record<CabinetStatus, string> {
  const cs = getComputedStyle(document.documentElement);
  const get = (n: string) => `rgb(${cs.getPropertyValue(n).trim().split(' ').join(',')})`;
  return {
    offline: get('--st-offline'),
    fault: get('--st-fault'),
    dimming: get('--st-dimming'),
    on: get('--st-on'),
    off: get('--st-off'),
    unknown: get('--st-unknown'),
  };
}
