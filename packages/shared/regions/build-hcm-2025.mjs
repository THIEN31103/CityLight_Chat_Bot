// Builds hcm-2025.json, the service region of the trial (S62): TP. Hồ Chí Minh after the 2025 merger
// (old TP HCM + Bình Dương + Bà Rịa – Vũng Tàu, 168 commune-level units: 113 phường, 54 xã, 1 đặc khu).
// Inputs (downloaded once, not kept in the repo):
//   Provinces.geojson  github.com/nguyenduy1133/Free-GIS-Data, "Vietnam Administrative Divisions (Post-2025)"
//   Data.tsv           github.com/lqtue/phuongnao Data/Data.tsv (names, type, units merged into each one)
//   node packages/shared/regions/build-hcm-2025.mjs <Provinces.geojson> <Data.tsv>
// The province file has no Côn Đảo: the special zone is added as a box around the archipelago (sea only).
// Wards are grouped by the former district most of their merged units came from, so the existing
// unit -> district -> ward tree keeps working; the group is only a filter, named "<district> (cũ)".
import { readFileSync, writeFileSync } from 'node:fs';

const [provincesPath, wardsPath] = process.argv.slice(2);
if (!provincesPath || !wardsPath) throw new Error('usage: build-hcm-2025.mjs <Provinces.geojson> <Data.tsv>');

const CHECK_TOL = 0.0002; // ~22 m: polygon used for the inside / outside check
const OUTLINE_TOL = 0.002; // ~220 m: outline drawn on the web map
const CON_DAO = [[106.45, 8.5], [106.85, 8.5], [106.85, 8.85], [106.45, 8.85], [106.45, 8.5]];

const r5 = (v) => Math.round(v * 1e5) / 1e5;

/** Douglas–Peucker on one closed ring (degrees). */
function simplify(ring, tol) {
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a];
    const [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let best = -1, bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = ring.filter((_, i) => keep[i]).map(([x, y]) => [r5(x), r5(y)]);
  return out.length >= 4 ? out : null;
}

// ---- boundary ----
const prov = JSON.parse(readFileSync(provincesPath, 'utf8'));
const hcm = prov.features.find((f) => f.properties.Ma === '79');
if (!hcm || hcm.properties.SoXa !== 168) throw new Error('TP. Hồ Chí Minh (Ma 79, 168 xã) not found in the province file');
const multi = hcm.geometry.type === 'MultiPolygon' ? hcm.geometry.coordinates : [hcm.geometry.coordinates];
const polygons = [...multi.map((poly) => poly.map((ring) => simplify(ring, CHECK_TOL)).filter(Boolean)).filter((p) => p.length), [CON_DAO]];
const outline = [...multi.map((poly) => simplify(poly[0], OUTLINE_TOL)).filter(Boolean), CON_DAO];
let minX = 180, minY = 90, maxX = -180, maxY = -90;
for (const poly of polygons) for (const [x, y] of poly[0]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }

// ---- wards ----
const rows = readFileSync(wardsPath, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split('\t'));
const count = { 'Phường': 0, 'Xã': 0, 'Đặc khu': 0 };
const groups = new Map();
for (const [name, , kind, , , , whole, part] of rows) {
  if (!(kind in count)) throw new Error(`unknown unit type ${kind} (${name})`);
  count[kind]++;
  const src = `${whole}, ${part}`;
  const tally = new Map();
  for (const m of src.matchAll(/\(([^)]+)\)/g)) tally.set(m[1].trim(), (tally.get(m[1].trim()) ?? 0) + 1);
  let old = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? src.match(/^(Huyện|Thành phố|Thị xã|Quận) [^,]+/)?.[0];
  if (!old) throw new Error(`no former district for ${kind} ${name}`);
  old = old.replace(/^H\. /, 'Huyện ').replace(/^TP\. ?/, 'TP. ').replace(/^Thành phố /, 'TP. ');
  const g = `${old} (cũ)`;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(`${kind} ${name}`);
}
if (rows.length !== 168 || count['Phường'] !== 113 || count['Xã'] !== 54 || count['Đặc khu'] !== 1)
  throw new Error(`expected 168 = 113 phường + 54 xã + 1 đặc khu, got ${rows.length} ${JSON.stringify(count)}`);
const coll = new Intl.Collator('vi', { numeric: true });

const region = {
  id: 'hcm-2025',
  name: 'TP. Hồ Chí Minh',
  note: 'Địa giới từ 01/07/2025 (TP HCM + Bình Dương + Bà Rịa – Vũng Tàu); Côn Đảo = khung bao quần đảo',
  bbox: [r5(minX), r5(minY), r5(maxX), r5(maxY)],
  polygons,
  outline,
  groups: [...groups].sort((a, b) => coll.compare(a[0], b[0])).map(([name, wards]) => ({ name, wards: wards.sort(coll.compare) })),
};
const out = new URL('./hcm-2025.json', import.meta.url);
writeFileSync(out, JSON.stringify(region));
const pts = polygons.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0);
console.log(`hcm-2025.json: ${polygons.length} polygons / ${pts} points, outline ${outline.reduce((n, r) => n + r.length, 0)} points, ${groups.size} groups, ${rows.length} units`);
