// Map marker icons drawn as SVG, rasterised once at 2x and registered with map.addImage().
import type { Map as MlMap } from 'maplibre-gl';
import type { CabinetStatus } from '@citylight/shared';
import { CABINET_STATUSES } from '@citylight/shared';
import { statusColors } from './mapStyle';

// Status glyph centred on (x,y), drawn for a ±8 box then scaled by k. Shape + colour, never colour alone.
function glyph(status: CabinetStatus, c: string, x: number, y: number, k: number): string {
  const t = `transform="translate(${x} ${y}) scale(${k})"`;
  switch (status) {
    case 'on':
      return `<g ${t}><circle cy="-1.5" r="5.5" fill="${c}"/><rect x="-2.6" y="4.6" width="5.2" height="3.2" rx="1" fill="${c}"/></g>`;
    case 'off':
      return `<g ${t} fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"><path d="M0 -7.5v6.5"/><path d="M-5 -4.2a7 7 0 1 0 10 0"/></g>`;
    case 'offline':
      return `<g ${t} stroke="${c}" stroke-width="3.6" stroke-linecap="round"><path d="M-5 -5l10 10M5 -5l-10 10"/></g>`;
    case 'fault':
      return `<g ${t} fill="${c}"><rect x="-1.9" y="-7.5" width="3.8" height="9.5" rx="1.9"/><circle cy="5.6" r="2.1"/></g>`;
    case 'dimming':
      return `<g ${t}><circle r="6" fill="none" stroke="${c}" stroke-width="2.4"/><path d="M0 -6a6 6 0 0 1 0 12z" fill="${c}"/></g>`;
    default:
      return `<g ${t}><text y="5.5" text-anchor="middle" font-size="16" font-weight="700" font-family="Arial, sans-serif" fill="${c}">?</text></g>`;
  }
}

/** Dark glyph on light status colours (the dark theme's amber / green), white otherwise. */
function glyphColor(c: string): string {
  const [r, g, b] = (c.match(/\d+/g) ?? ['0', '0', '0']).map(Number) as [number, number, number];
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#1f2937' : '#fff';
}

/**
 * Cabinet with a roof (S48, Bảo picked design A, like the cabinet diagram): body in the status colour, status glyph,
 * door handle, base; white outline + ground shadow for contrast on any tile. 64x80 @2x = 32x40 px, anchor bottom.
 */
function cabinetSvg(status: CabinetStatus, c: string): string {
  const fg = glyphColor(c);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="80" viewBox="0 0 64 80">
<ellipse cx="32" cy="76" rx="19" ry="3.5" fill="#000" opacity="0.22"/>
<rect x="16" y="66" width="32" height="8" rx="1.5" fill="#374151" stroke="#fff" stroke-width="1.5"/>
<path d="M9 19L55 19L50 9L14 9Z" fill="#374151" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
<rect x="13" y="19" width="38" height="48" rx="3" fill="${c}" stroke="#fff" stroke-width="2.5"/>
<rect x="43" y="36" width="3.2" height="12" rx="1.6" fill="${fg}" opacity="0.85"/>
${glyph(status, fg, 29, 42, 1.45)}
</svg>`;
}

/** Street-light pole: base at the bottom (anchor), arm, lamp head; lit = warm glow. 40x60 @2x. */
function poleSvg(state: 'on' | 'off' | 'unknown'): string {
  const head = state === 'on' ? '#facc15' : state === 'off' ? '#cbd5e1' : '#c4b5fd';
  const glow = state === 'on' ? `<circle cx="29" cy="15" r="11" fill="#fde047" fill-opacity="0.45"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="60" viewBox="0 0 40 60">
${glow}
<path d="M13 56V14q0-7 7-7h9" stroke="#fff" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M13 56V14q0-7 7-7h9" stroke="#334155" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="6.5" y="53" width="13" height="5" rx="2" fill="#334155" stroke="#fff" stroke-width="1.5"/>
<path d="M21.5 6h15l-2.5 7h-10z" fill="#1e293b" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
<ellipse cx="29" cy="14.5" rx="5" ry="2.6" fill="${head}" stroke="#1e293b" stroke-width="0.8"/>
</svg>`;
}

function load(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

let cache: { key: string; images: Record<string, HTMLImageElement> } | null = null;

async function buildImages(): Promise<Record<string, HTMLImageElement>> {
  const colors = statusColors();
  const key = JSON.stringify(colors);
  if (cache?.key === key) return cache.images;
  const entries = await Promise.all([
    ...CABINET_STATUSES.map(async (s) => [`cab-${s}`, await load(cabinetSvg(s, colors[s]))] as const),
    ...(['on', 'off', 'unknown'] as const).map(async (s) => [`pole-${s}`, await load(poleSvg(s))] as const),
  ]);
  cache = { key, images: Object.fromEntries(entries) };
  return cache.images;
}

/** (Re)register all marker images on the current style; styles drop images on every setStyle. */
export async function addMapIcons(m: MlMap) {
  const images = await buildImages();
  for (const [name, img] of Object.entries(images)) {
    if (m.hasImage(name)) m.removeImage(name);
    m.addImage(name, img, { pixelRatio: 2 });
  }
}
