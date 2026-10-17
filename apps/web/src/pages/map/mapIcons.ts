// Map marker icons drawn as SVG, rasterised once at 2x and registered with map.addImage().
import type { Map as MlMap } from 'maplibre-gl';
import type { CabinetStatus } from '@citylight/shared';
import { CABINET_STATUSES } from '@citylight/shared';
import { statusColors } from './mapStyle';

// Status glyph inside the white cabinet body (centre 32,30). Shape + colour, never colour alone.
function glyph(status: CabinetStatus, c: string): string {
  switch (status) {
    case 'on':
      return `<circle cx="32" cy="27" r="7" fill="${c}"/><rect x="28.5" y="34" width="7" height="4.5" rx="1.2" fill="${c}"/>`;
    case 'off':
      return `<path d="M32 20.5v8" stroke="${c}" stroke-width="3.6" stroke-linecap="round"/><path d="M26 24.2a8.6 8.6 0 1 0 12 0" fill="none" stroke="${c}" stroke-width="3.6" stroke-linecap="round"/>`;
    case 'offline':
      return `<path d="M25.5 23.5l13 13M38.5 23.5l-13 13" stroke="${c}" stroke-width="4.2" stroke-linecap="round"/>`;
    case 'fault':
      return `<rect x="30" y="20" width="4" height="12" rx="2" fill="${c}"/><circle cx="32" cy="37.5" r="2.5" fill="${c}"/>`;
    case 'dimming':
      return `<circle cx="32" cy="30" r="8" fill="none" stroke="${c}" stroke-width="3"/><path d="M32 22a8 8 0 0 1 0 16z" fill="${c}"/>`;
    default:
      return `<text x="32" y="37" text-anchor="middle" font-size="19" font-weight="700" font-family="Arial, sans-serif" fill="${c}">?</text>`;
  }
}

/** Teardrop pin, status colour, white cabinet body with status glyph. 64x80 @2x = 32x40 px. */
function cabinetSvg(status: CabinetStatus, c: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="80" viewBox="0 0 64 80">
<defs><filter id="s" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2.5" stdDeviation="2.5" flood-color="#000" flood-opacity="0.35"/></filter></defs>
<path filter="url(#s)" d="M32 77C32 77 7 51 7 31a25 25 0 1 1 50 0c0 20-25 46-25 46z" fill="${c}" stroke="#fff" stroke-width="3.5"/>
<rect x="18.5" y="14.5" width="27" height="31" rx="5" fill="#fff"/>
<rect x="18.5" y="14.5" width="27" height="31" rx="5" fill="none" stroke="${c}" stroke-opacity="0.25" stroke-width="1.5"/>
${glyph(status, c)}
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
