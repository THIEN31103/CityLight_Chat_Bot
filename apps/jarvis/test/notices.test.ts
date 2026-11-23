import { describe, expect, it } from 'vitest';
import type { Alarm } from '@citylight/shared';
import { MUTE_MS, NoticeState, P1_GAP_MS, REPEAT_MS, parseMute } from '../src/console/notices';

const T0 = Date.parse('2026-11-24T01:00:00Z');
let n = 0;
function alarm(over: Partial<Alarm> = {}): Alarm {
  n++;
  return {
    id: `a${n}`, code: 'E202', cabinetId: `c${n}`, cabinetName: `Tủ ${n}`, cabinetCode: `TL01.00${String(n).padStart(2, '0')}`, districtName: 'Quận 1',
    type: 'lamp_fault' as Alarm['type'], severity: 'major', message: 'Mất pha', value: null, startedAt: new Date(T0).toISOString(), endedAt: null, active: true,
    ackedBy: null, ackedAt: null, ...over,
  };
}

/** a state that already had its first look at `open` */
function started(open: Alarm[] = []) {
  const st = new NoticeState();
  expect(st.look(open, 0, T0).notices).toEqual([]);
  return st;
}

describe('notices: what Jarvis says on its own (spec 7)', () => {
  it('the first look tells nothing; a new critical alarm is said at once as P0', () => {
    const old = alarm({ severity: 'critical' });
    const st = started([old]);
    const p0 = alarm({ severity: 'critical', code: 'E204', message: 'Lỗi contactor' });
    const r = st.look([old, p0], 0, T0 + 20_000);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toMatchObject({ level: 'P0' });
    expect(r.notices[0]!.text).toMatch(/^Cảnh báo nghiêm trọng mới: E204 Lỗi contactor ở tủ TL01/);
  });

  it('a P0 nobody answered comes back after 2 minutes, at most 3 times in all', () => {
    const st = started();
    const p0 = alarm({ severity: 'critical' });
    expect(st.look([p0], 0, T0 + 1000).notices).toHaveLength(1);
    expect(st.look([p0], 0, T0 + 1000 + REPEAT_MS - 1).notices).toEqual([]);
    const second = st.look([p0], 0, T0 + 1000 + REPEAT_MS).notices;
    expect(second[0]!.text).toMatch(/^Nhắc lại lần 2\/3/);
    const third = st.look([p0], 0, T0 + 1000 + 2 * REPEAT_MS).notices;
    expect(third[0]!.text).toMatch(/^Nhắc lại lần 3\/3/);
    expect(st.look([p0], 0, T0 + 1000 + 3 * REPEAT_MS).notices).toEqual([]);
    expect(st.look([p0], 0, T0 + 1000 + 9 * REPEAT_MS).notices).toEqual([]);
  });

  it('no repeat once the user answered, the alarm was acked or it ended', () => {
    for (const after of ['answered', 'acked', 'ended'] as const) {
      const st = started();
      const p0 = alarm({ severity: 'critical' });
      st.look([p0], 0, T0 + 1000);
      const now = T0 + 1000 + REPEAT_MS;
      const open = after === 'ended' ? [] : [after === 'acked' ? { ...p0, ackedAt: new Date(now).toISOString() } : p0];
      expect(st.look(open, after === 'answered' ? T0 + 5000 : 0, now).notices).toEqual([]);
    }
  });

  it('other new alarms: one sentence per 20 s, same code and area together, closed ones dropped', () => {
    const st = started();
    const a = alarm({ code: 'E202', districtName: 'Quận 1' });
    const b = alarm({ code: 'E202', districtName: 'Quận 1' });
    const c = alarm({ code: 'E301', districtName: 'Quận 3' });
    const d = alarm({ code: 'E101', districtName: 'Quận 5' });
    const first = st.look([a, b, c, d], 0, T0 + 1000).notices;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ level: 'P1' });
    expect(first[0]!.text).toMatch(/^Cảnh báo mới: E202 Mất pha ở 2 tủ \(TL01\.\d+, TL01\.\d+\), Quận 1/);
    expect(st.look([a, b, c, d], 0, T0 + 1000 + P1_GAP_MS - 1).notices).toEqual([]);
    // c ended meanwhile: d is next
    const next = st.look([a, b, d], 0, T0 + 1000 + P1_GAP_MS).notices;
    expect(next[0]!.text).toMatch(/^Cảnh báo mới: E101/);
    expect(st.look([a, b, d], 0, T0 + 1000 + 3 * P1_GAP_MS).notices).toEqual([]);
  });

  it('a critical alarm is not held back by the 20 s gap', () => {
    const st = started();
    st.look([alarm()], 0, T0 + 1000);
    const p0 = alarm({ severity: 'critical' });
    expect(st.look([p0], 0, T0 + 2000).notices.map((x) => x.level)).toEqual(['P0']);
  });

  it('"im lặng 15 phút": others are counted and told once at the end; P0 is still said', () => {
    const st = started();
    st.mute(T0);
    expect(st.mutedUntil).toBe(T0 + MUTE_MS);
    expect(st.look([alarm(), alarm({ code: 'E301' })], 0, T0 + 1000).notices).toEqual([]);
    const p0 = alarm({ severity: 'critical' });
    expect(st.look([p0], 0, T0 + 60_000).notices.map((x) => x.level)).toEqual(['P0']);
    const end = st.look([p0], T0 + 70_000, T0 + MUTE_MS).notices;
    expect(end).toHaveLength(1);
    expect(end[0]!.text).toBe('Hết giờ im lặng. Trong lúc im lặng có 2 cảnh báo mới, bạn hỏi "đang có cảnh báo gì?" để xem.');
    expect(st.mutedUntil).toBe(0);
  });

  it('unmute: the count comes at the next look; nothing to tell when nothing came', () => {
    const st = started();
    st.mute(T0);
    st.look([alarm()], 0, T0 + 1000);
    expect(st.unmute(T0 + 2000)).toBe(true);
    expect(st.look([], 0, T0 + 3000).notices[0]!.text).toMatch(/có 1 cảnh báo mới/);
    expect(st.unmute(T0 + 4000)).toBe(false);
    const quiet = started();
    quiet.mute(T0);
    expect(quiet.unmute(T0 + 1000)).toBe(true);
    expect(quiet.mutedUntil).toBe(0);
  });
});

describe('parseMute', () => {
  it.each([
    ['Im lặng 15 phút', 'on'], ['im lặng đi Jarvis', 'on'], ['Tắt thông báo', 'on'], ['đừng báo nữa', 'on'], ['thôi đừng làm phiền nữa', 'on'], ['ngừng tự báo', 'on'],
    ['bật lại thông báo', 'off'], ['Hết im lặng', 'off'], ['thôi im lặng', 'off'], ['tắt chế độ im lặng', 'off'], ['mở lại cảnh báo', 'off'],
  ])('%s → %s', (text, want) => expect(parseMute(text)).toBe(want));

  it.each(['Chế độ im lặng là gì?', 'im lặng có tắt cảnh báo nghiêm trọng không', 'tắt đèn tủ TL01.0009', 'đang có cảnh báo gì?', 'bật đèn quận 1', 'thông báo mới nhất là gì'])(
    'not an order: %s', (text) => expect(parseMute(text)).toBeNull());
});
