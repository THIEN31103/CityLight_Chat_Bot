// What happens after an order, from the cabinet's schedule (spec 2.1, packages/shared/src/rules.ts):
//  - Chế độ 1 (or both branches disabled): both branches follow on1-off1.
//  - Chế độ 2: branch 1 follows on1-off1, branch 2 on2-off2, each only when enabled (off otherwise).
//  - A manual order lasts until the NEXT schedule edge (+40 s), then the LOGO runs the schedule again.
// The old sentence "Đèn sẽ tự bật lại theo lịch lúc 18:00" ignored the time of day and the branch (user report,
// 2026-11-15): at 20:00 the next edge is the switch-off, and the lights only come back the next evening.
import { inWindow, localMinutes } from '@citylight/shared';
import type { ActionCommand } from './policy';

export interface ScheduleLike {
  mode?: unknown;
  on1?: unknown;
  off1?: unknown;
  on2?: unknown;
  off2?: unknown;
  branch1Enabled?: unknown;
  branch2Enabled?: unknown;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

interface Sched { mode: 1 | 2; on1: string; off1: string; on2: string; off2: string; b1: boolean; b2: boolean }

/** null when the schedule is unknown or unreadable: then nothing is promised */
function read(s: ScheduleLike | null | undefined): Sched | null {
  if (!s || typeof s.on1 !== 'string' || typeof s.off1 !== 'string' || !HHMM.test(s.on1) || !HHMM.test(s.off1)) return null;
  const on2 = typeof s.on2 === 'string' && HHMM.test(s.on2) ? s.on2 : s.on1;
  const off2 = typeof s.off2 === 'string' && HHMM.test(s.off2) ? s.off2 : s.off1;
  return { mode: s.mode === 2 ? 2 : 1, on1: s.on1, off1: s.off1, on2, off2, b1: s.branch1Enabled !== false, b2: s.branch2Enabled !== false };
}

const followsMode1 = (s: Sched) => s.mode === 1 || (!s.b1 && !s.b2);

/** what the schedule wants for [branch 1, branch 2] at minute `m` of the day */
export function expectedAt(s: Sched, m: number): [boolean, boolean] {
  const w1 = inWindow(m, s.on1, s.off1);
  if (followsMode1(s)) return [w1, w1];
  return [s.b1 && w1, s.b2 && inWindow(m, s.on2, s.off2)];
}

/** what the schedule wants for [branch 1, branch 2] right now; null when the schedule is unknown */
export function expectedNow(raw: ScheduleLike | null | undefined, now = Date.now()): [boolean, boolean] | null {
  const s = read(raw);
  return s ? expectedAt(s, localMinutes(now)) : null;
}

/** the next schedule edge after `nowMin`: when manual mode ends */
export function nextEdge(s: Sched, nowMin: number): { min: number; tomorrow: boolean } | null {
  const times = followsMode1(s) ? [s.on1, s.off1] : [...(s.b1 ? [s.on1, s.off1] : []), ...(s.b2 ? [s.on2, s.off2] : [])];
  let best: { min: number; delta: number } | null = null;
  for (const t of new Set(times)) {
    const m = toMin(t);
    const delta = (m - nowMin + 1440) % 1440 || 1440;
    if (!best || delta < best.delta) best = { min: m, delta };
  }
  return best ? { min: best.min, tomorrow: nowMin + best.delta >= 1440 } : null;
}

const at = (e: { min: number; tomorrow: boolean }) => `${hhmm(e.min)}${e.tomorrow ? ' ngày mai' : ''}`;
const who = (branches: (1 | 2)[]) => (branches.length === 2 ? 'đèn' : `nhánh ${branches[0]}`);
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** The sentence about what the schedule does next; undefined when there is nothing sure to say. */
export function scheduleNote(cmd: ActionCommand, raw: ScheduleLike | null | undefined, now = Date.now()): string | undefined {
  const s = read(raw);
  if (!s) return undefined;
  const nowMin = localMinutes(now);
  if (cmd.type === 'AUTO') {
    const [a, b] = expectedAt(s, nowMin);
    const want = a === b ? `cả hai nhánh ${a ? 'sáng' : 'tắt'}` : `nhánh 1 ${a ? 'sáng' : 'tắt'}, nhánh 2 ${b ? 'sáng' : 'tắt'}`;
    return `Theo lịch thì lúc này ${want}.`;
  }
  if (cmd.type !== 'MANUAL_ALL' && cmd.type !== 'MANUAL_BRANCH') return undefined;
  const e = nextEdge(s, nowMin);
  if (!e) return undefined;
  const branches: (1 | 2)[] = cmd.type === 'MANUAL_BRANCH' ? [cmd.params.branch!] : [1, 2];
  const after = expectedAt(s, e.min);
  const states = branches.map((b) => after[b - 1]);
  const on = cmd.params.on === true;
  if (states.every((x) => x === on)) return `Chế độ tay giữ tới ${at(e)}, sau đó tủ chạy lại theo lịch và ${who(branches)} vẫn ${on ? 'sáng' : 'tắt'}.`;
  if (states.every((x) => x !== on)) return `${cap(who(branches))} sẽ tự ${on ? 'tắt' : 'bật'} lại theo lịch lúc ${at(e)}.`;
  return `Lúc ${at(e)} tủ chạy lại theo lịch: nhánh 1 ${after[0] ? 'sáng' : 'tắt'}, nhánh 2 ${after[1] ? 'sáng' : 'tắt'}.`;
}
