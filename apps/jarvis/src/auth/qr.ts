// A QR code for the authenticator app (user request 2026-11-25: "dùng điện thoại quét QR"). Jarvis has no QR library
// and adds none: this is a small encoder for what it needs, byte mode, error correction M, versions 1-10 (up to 213
// bytes; an otpauth:// link is ~150). Checked module by module against the "qrcode" package the CityLight web uses
// (test/qr.test.ts). Output: an SVG with a 4-module quiet zone.

/** error correction level M: [data codewords per block, number of blocks] groups and EC codewords per block, v1-10 */
const BLOCKS: { ec: number; groups: [number, number][] }[] = [
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
];
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// ---------- GF(256) and Reed-Solomon ----------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

function rsGenerator(n: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] = next[j]! ^ g[j]!;
      next[j + 1] = next[j + 1]! ^ mul(g[j]!, EXP[i]!);
    }
    g = next;
  }
  return g;
}

function rsRemainder(data: number[], n: number): number[] {
  const gen = rsGenerator(n);
  const rem = new Array<number>(n).fill(0);
  for (const d of data) {
    const factor = d ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < n; i++) rem[i] = rem[i]! ^ mul(gen[i + 1]!, factor);
  }
  return rem;
}

// ---------- data ----------
function codewords(bytes: Uint8Array, version: number): number[] {
  const spec = BLOCKS[version - 1]!;
  const capacity = spec.groups.reduce((s, [n, d]) => s + n * d, 0);
  const bits: number[] = [];
  const put = (v: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);
  // split into blocks, add EC, interleave
  const blocks: number[][] = [];
  let at = 0;
  for (const [n, d] of spec.groups) for (let k = 0; k < n; k++, at += d) blocks.push(data.slice(at, at + d));
  const ecs = blocks.map((b) => rsRemainder(b, spec.ec));
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < spec.ec; i++) for (const e of ecs) out.push(e[i]!);
  return out;
}

const capacityOf = (version: number) => BLOCKS[version - 1]!.groups.reduce((s, [n, d]) => s + n * d, 0);
const bytesFit = (version: number) => capacityOf(version) - (version < 10 ? 2 : 3);

// ---------- matrix ----------
type Grid = { size: number; mod: Uint8Array; fixed: Uint8Array };

function bch(value: number, poly: number, shift: number): number {
  let v = value << shift;
  const top = 31 - Math.clz32(poly);
  for (let i = 31 - Math.clz32(v); i >= top; i = 31 - Math.clz32(v)) v ^= poly << (i - top);
  return (value << shift) | v;
}

function base(version: number): Grid {
  const size = 17 + version * 4;
  const g: Grid = { size, mod: new Uint8Array(size * size), fixed: new Uint8Array(size * size) };
  const set = (r: number, c: number, dark: boolean) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    g.mod[r * size + c] = dark ? 1 : 0;
    g.fixed[r * size + c] = 1;
  };
  // finders + separators
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      set(r0 + r, c0 + c, inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)));
    }
  }
  // timing
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // alignment
  const pos = ALIGN[version - 1]!;
  for (const r of pos) for (const c of pos) {
    if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (r === pos[pos.length - 1] && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  // dark module, reserved format areas
  set(size - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    if (!g.fixed[8 * size + i]) set(8, i, false);
    if (!g.fixed[i * size + 8]) set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, false);
    if (!g.fixed[(size - 1 - i) * size + 8]) set(size - 1 - i, 8, false);
  }
  // version information (v7+)
  if (version >= 7) {
    const v = bch(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const bit = ((v >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      set(a, b, bit);
      set(b, a, bit);
    }
  }
  return g;
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function place(g: Grid, words: number[], mask: number): Uint8Array {
  const { size } = g;
  const m = g.mod.slice();
  let bit = 0;
  const total = words.length * 8;
  let up = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < size; k++) {
      const r = up ? size - 1 - k : k;
      for (const c of [right, right - 1]) {
        if (g.fixed[r * size + c]) continue;
        const dark = bit < total ? ((words[bit >> 3]! >>> (7 - (bit & 7))) & 1) === 1 : false;
        bit++;
        m[r * size + c] = (dark !== MASKS[mask]!(r, c)) ? 1 : 0;
      }
    }
    up = !up;
  }
  // format information: level M = 00, then the mask
  const f = bch((0b00 << 3) | mask, 0x537, 10) ^ 0x5412;
  const at = (r: number, c: number, i: number) => (m[r * size + c] = (f >>> i) & 1);
  // first copy, around the top-left finder (bits 0-5 down column 8, then 6, 7, 8 around the corner, 9-14 along row 8)
  for (let i = 0; i <= 5; i++) at(i, 8, i);
  at(7, 8, 6);
  at(8, 8, 7);
  at(8, 7, 8);
  for (let i = 9; i < 15; i++) at(8, 14 - i, i);
  // second copy: bits 0-7 along row 8 from the right edge, 8-14 up column 8 from the bottom
  for (let i = 0; i < 8; i++) at(8, size - 1 - i, i);
  for (let i = 8; i < 15; i++) at(size - 15 + i, 8, i);
  m[(size - 8) * size + 8] = 1;
  return m;
}

function penalty(m: Uint8Array, size: number): number {
  let p = 0;
  const at = (r: number, c: number) => m[r * size + c]!;
  // rule 1: runs of 5+ in rows and columns
  for (let r = 0; r < size; r++) for (const row of [true, false]) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      const same = row ? at(r, c) === at(r, c - 1) : at(c, r) === at(c - 1, r);
      if (same) run++;
      else {
        if (run >= 5) p += run - 2;
        run = 1;
      }
    }
    if (run >= 5) p += run - 2;
  }
  // rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = at(r, c);
    if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) p += 3;
  }
  // rule 3: finder-like patterns
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < size; r++) for (let c = 0; c <= size - 11; c++) for (const row of [true, false]) {
    for (const pat of [pat1, pat2]) {
      let ok = true;
      for (let k = 0; k < 11 && ok; k++) ok = (row ? at(r, c + k) : at(c + k, r)) === pat[k];
      if (ok) p += 40;
    }
  }
  // rule 4: balance of dark modules
  let dark = 0;
  for (const v of m) dark += v;
  p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return p;
}

/** the QR modules (1 = dark), row by row; mask: forced (tests) or the one with the lowest penalty */
export function qrMatrix(text: string, opts: { version?: number; mask?: number } = {}): { size: number; modules: Uint8Array; version: number; mask: number } {
  const bytes = new TextEncoder().encode(text);
  const version = opts.version ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((v) => bytesFit(v) >= bytes.length);
  if (!version || bytesFit(version) < bytes.length) throw new Error(`QR: ${bytes.length} bytes do not fit (max ${bytesFit(10)})`);
  const words = codewords(bytes, version);
  const g = base(version);
  let best: { m: Uint8Array; mask: number; p: number } | null = null;
  for (const mask of opts.mask !== undefined ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7]) {
    const m = place(g, words, mask);
    const p = opts.mask !== undefined ? 0 : penalty(m, g.size);
    if (!best || p < best.p) best = { m, mask, p };
  }
  return { size: g.size, modules: best!.m, version, mask: best!.mask };
}

/** an SVG of the QR code, black on white with a 4-module quiet zone (any phone camera / authenticator reads it) */
export function qrSvg(text: string, px = 4): string {
  const { size, modules } = qrMatrix(text);
  const q = 4;
  const n = size + 2 * q;
  let path = '';
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (modules[r * size + c]) path += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * px}" height="${n * px}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
