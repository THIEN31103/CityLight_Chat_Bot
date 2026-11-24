// Jarvis speaks up (spec 7). The console asks every 20 s; this decides, in code, what is said:
// - P0 (critical alarm): said at once, again after 2 minutes while nobody answered and it is still open and not acked,
//   at most 3 times; said even in "im lặng 15 phút".
// - P1 (other new alarm): at most one sentence per 20 s, same code + same area in one sentence; held back while muted,
//   then told as one count when the mute ends.
// - The first look only remembers what is open: those belong to the shift report. Alarms that ended are not told.
import type { Alarm } from '@citylight/shared';
import { fold } from '../tools/names';
import { alarmLabel, vnTime } from '../tools/read';

export const REPEAT_MS = 120_000;
export const P0_TIMES = 3;
export const P1_GAP_MS = 20_000;
export const MUTE_MS = 15 * 60_000;
/** P0 groups said in one look; more are counted in one sentence */
const MAX_P0 = 3;

export interface Notice {
  level: 'P0' | 'P1';
  text: string;
  /** one cabinet told about: it becomes the cabinet in focus, so "tủ đó thế nào?" means it (spec 5.4) */
  focus?: { cabinet: { id: string; code: string; name: string }; alarmCode: string };
}

const keyOf = (a: Alarm) => `${a.code}|${a.districtName}`;

function groupsOf(list: Alarm[]): Alarm[][] {
  const m = new Map<string, Alarm[]>();
  for (const a of list) m.set(keyOf(a), [...(m.get(keyOf(a)) ?? []), a]);
  return [...m.values()];
}

/** the cabinet of a sentence about one cabinet */
const focusOf = (g: Alarm[]): Notice['focus'] =>
  g.length === 1 ? { cabinet: { id: g[0]!.cabinetId, code: g[0]!.cabinetCode, name: g[0]!.cabinetName }, alarmCode: g[0]!.code } : undefined;

function sentence(head: string, g: Alarm[], titles?: Map<string, string>): string {
  const a = g[0]!;
  const where = g.length === 1 ? `tủ ${a.cabinetCode}` : `${g.length} tủ (${g.slice(0, 3).map((x) => x.cabinetCode).join(', ')}${g.length > 3 ? '…' : ''})`;
  return `${head}: ${alarmLabel(a, titles)} ở ${where}${a.districtName ? `, ${a.districtName}` : ''}, từ ${vnTime(a.startedAt)}.`;
}

export class NoticeState {
  /** open alarms at the last look; null until the first look */
  private seen: Set<string> | null = null;
  /** critical alarms told: how many times, and when last */
  private readonly p0 = new Map<string, { times: number; at: number }>();
  /** other new alarms waiting for their turn (one group per 20 s) */
  private queue: Alarm[][] = [];
  private lastP1 = 0;
  mutedUntil = 0;
  /** other new alarms held back while muted */
  private mutedCount = 0;

  get muted() {
    return this.mutedUntil > Date.now();
  }

  mute(now = Date.now()) {
    this.mutedUntil = now + MUTE_MS;
  }

  /** ends the mute; the count of held-back alarms is told at the next look */
  unmute(now = Date.now()): boolean {
    if (this.mutedUntil <= now) return false;
    this.mutedUntil = this.mutedCount ? now : 0;
    return true;
  }

  /**
   * open: the open alarms now. lastInteraction: the user's last question or click; a P0 told before it was answered.
   * Returns what to say, critical first, and how many alarms were new.
   */
  look(open: Alarm[], lastInteraction: number, now = Date.now(), titles?: Map<string, string>): { notices: Notice[]; fresh: number } {
    if (!this.seen) {
      this.seen = new Set(open.map((a) => a.id));
      return { notices: [], fresh: 0 };
    }
    const byId = new Map(open.map((a) => [a.id, a]));
    const fresh = open.filter((a) => !this.seen!.has(a.id));
    this.seen = new Set(byId.keys());

    // what ended, was acked or got an answer is not told again
    for (const [id, t] of this.p0) {
      const a = byId.get(id);
      if (!a || a.ackedAt || lastInteraction >= t.at || t.times >= P0_TIMES) this.p0.delete(id);
    }
    this.queue = this.queue.map((g) => g.filter((a) => byId.has(a.id))).filter((g) => g.length);

    const p0: Notice[] = [];
    const critical = fresh.filter((a) => a.severity === 'critical');
    for (const g of groupsOf(critical)) {
      p0.push({ level: 'P0', text: sentence('Cảnh báo nghiêm trọng mới', g, titles), focus: focusOf(g) });
      for (const a of g) this.p0.set(a.id, { times: 1, at: now });
    }
    const due = [...this.p0].filter(([id, t]) => now - t.at >= REPEAT_MS && !critical.some((a) => a.id === id));
    for (const g of groupsOf(due.map(([id]) => byId.get(id)!))) {
      const times = Math.max(...g.map((a) => this.p0.get(a.id)!.times)) + 1;
      p0.push({ level: 'P0', text: sentence(`Nhắc lại lần ${times}/${P0_TIMES}, chưa ai xử lý cảnh báo nghiêm trọng`, g, titles), focus: focusOf(g) });
      for (const a of g) this.p0.set(a.id, { times, at: now });
    }
    const out = p0.slice(0, MAX_P0);
    if (p0.length > MAX_P0) out.push({ level: 'P0', text: `Còn ${p0.length - MAX_P0} nhóm cảnh báo nghiêm trọng khác, bạn hỏi "đang có cảnh báo gì?" để xem.` });

    const others = fresh.filter((a) => a.severity !== 'critical');
    if (this.mutedUntil > now) this.mutedCount += others.length;
    else {
      // same code and area as one waiting (within 60 s of each other at 20 s looks): one sentence
      for (const g of groupsOf(others)) {
        const same = this.queue.find((q) => keyOf(q[0]!) === keyOf(g[0]!));
        if (same) same.push(...g);
        else this.queue.push(g);
      }
    }
    if (this.mutedUntil && this.mutedUntil <= now) {
      if (this.mutedCount) out.push({ level: 'P1', text: `Hết giờ im lặng. Trong lúc im lặng có ${this.mutedCount} cảnh báo mới, bạn hỏi "đang có cảnh báo gì?" để xem.` });
      this.mutedUntil = 0;
      this.mutedCount = 0;
      if (out.some((n) => n.level === 'P1')) this.lastP1 = now;
    } else if (this.mutedUntil <= now && this.queue.length && now - this.lastP1 >= P1_GAP_MS) {
      const g = this.queue.shift()!;
      out.push({ level: 'P1', text: sentence('Cảnh báo mới', g, titles), focus: focusOf(g) });
      this.lastP1 = now;
    }
    return { notices: out, fresh: fresh.length };
  }
}

/**
 * "im lặng 15 phút", "tắt thông báo", "đừng báo nữa" → 'on'; "bật lại thông báo", "hết im lặng" → 'off'. A question
 * about it ("im lặng là gì?") or a long sentence is not an order.
 */
export function parseMute(text: string): 'on' | 'off' | null {
  const t = fold(text).replace(/[^a-z0-9 ?]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 10 || /\?|\b(la gi|nghia la|the nao|sao|khong$|chua$)/.test(t)) return null;
  if (/\b(bat lai|mo lai)( che do)? (thong bao|canh bao|tu bao|bao)\b|\b(het|thoi|bo|tat|ngung|dung)( che do)? im lang\b/.test(t)) return 'off';
  if (/\bim lang\b|\b(tat|ngung|dung|khoi)( het)? (thong bao|tu bao|bao canh bao)\b|\b(dung|khoi|thoi) (bao|lam phien)( nua)?\b/.test(t)) return 'on';
  return null;
}
