// CoreIF framing: *#KEY'VAL&KEY'VAL$ (BOARD_LTE_KEY/Core/Src/main.c append_kv / finish_frame,
// BOARD_LTE_KEY/Mylib/core_if.c). Values may themselves contain "'" (LGPS = lat'lon'sats),
// so a pair is split on its FIRST "'" only.

export interface ParsedFrame {
  /** Keys upper-cased (device keys are case-insensitive), values verbatim. */
  fields: Record<string, string>;
  /** Keys in arrival order (duplicates keep the last value in `fields`). */
  order: string[];
  warnings: string[];
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

/** Parse one CoreIF frame. Throws FrameError when the envelope is wrong. */
export function parseFrame(raw: string): ParsedFrame {
  const text = raw.trim();
  if (!text.startsWith('*#')) throw new FrameError('Frame phải bắt đầu bằng *#');
  if (!text.endsWith('$')) throw new FrameError('Frame phải kết thúc bằng $');
  const body = text.slice(2, -1);
  if (!body) throw new FrameError('Frame rỗng');
  const fields: Record<string, string> = {};
  const order: string[] = [];
  const warnings: string[] = [];
  for (const pair of body.split('&')) {
    if (!pair) {
      warnings.push('Cặp rỗng (&&)');
      continue;
    }
    const sep = pair.indexOf("'");
    if (sep <= 0) {
      warnings.push(`Cặp không có giá trị: "${pair}"`);
      continue;
    }
    const key = pair.slice(0, sep).trim().toUpperCase();
    const value = pair.slice(sep + 1);
    if (key in fields) warnings.push(`Key trùng: ${key}`);
    fields[key] = value;
    order.push(key);
  }
  return { fields, order, warnings };
}

/** Legacy KEY=VAL&KEY=VAL form accepted by core_if.c (needs LTID= too). */
export function parseLegacy(raw: string): ParsedFrame {
  const fields: Record<string, string> = {};
  const order: string[] = [];
  for (const pair of raw.trim().split('&')) {
    const sep = pair.indexOf('=');
    if (sep <= 0) continue;
    const key = pair.slice(0, sep).trim().toUpperCase();
    fields[key] = pair.slice(sep + 1);
    order.push(key);
  }
  return { fields, order, warnings: [] };
}

export const MAX_KEYS_PER_FRAME = 16; // core_if.c CORE_IF_MAX_KV
export const MAX_KEY_LEN = 7;

/** Encode an uplink-style frame without the downlink key limit (telemetry has ~33 keys). */
export function encodeFrame(pairs: [string, string | number][]): string {
  return `*#${pairs.map(([k, v]) => `${k.toUpperCase()}'${String(v)}`).join('&')}$`;
}

/** Build a frame. LTID first (destination address on dev_lte_plc_manual_dgb+ firmware). */
export function buildFrame(pairs: [string, string | number][]): string {
  if (!pairs.length) throw new FrameError('Frame cần ít nhất 1 cặp');
  if (pairs.length > MAX_KEYS_PER_FRAME) throw new FrameError(`Tối đa ${MAX_KEYS_PER_FRAME} key mỗi frame`);
  const parts = pairs.map(([k, v]) => {
    const key = k.toUpperCase();
    const val = String(v);
    if (!/^[A-Z0-9]{1,7}$/.test(key)) throw new FrameError(`Key không hợp lệ: ${k}`);
    if (/[&$]/.test(val)) throw new FrameError(`Giá trị chứa ký tự cấm (& hoặc $): ${key}`);
    return `${key}'${val}`;
  });
  return `*#${parts.join('&')}$`;
}
