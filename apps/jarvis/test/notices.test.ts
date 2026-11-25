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

describe('the cabinet told about becomes the one in focus ("tủ đó", spec 5.4)', () => {
  it('a sentence about one cabinet carries it; a sentence about several does not', () => {
    const st = started();
    const one = alarm({ severity: 'critical', code: 'E204', cabinetId: 'cx', cabinetCode: 'TL09.0001', cabinetName: 'Lê Lợi 1' });
    const told = st.look([one], 0, T0 + 1000).notices;
    expect(told[0]!.focus).toEqual({ cabinet: { id: 'cx', code: 'TL09.0001', name: 'Lê Lợi 1' }, alarmCode: 'E204' });
    const st2 = started();
    const many = st2.look([alarm({ code: 'E105', districtName: 'Quận 9' }), alarm({ code: 'E105', districtName: 'Quận 9' })], 0, T0 + 1000).notices;
    expect(many[0]!.text).toMatch(/2 tủ/);
    expect(many[0]!.focus).toBeUndefined();
  });
});

describe('many critical alarms at once (simulator stopped on the codespace, 2026-11-25)', () => {
  const e101 = (district: string) => alarm({ code: 'E101', severity: 'critical', message: 'Không nhận frame telemetry quá 60 s', districtName: district });
  const titles = new Map([['E101', 'Mất kết nối tủ']]);

  it('one code over 3+ areas is ONE sentence with the count per area; one or two areas keep a sentence each', () => {
    const st = started();
    const burst = [...Array(9)].map(() => e101('Quận 1')).concat([...Array(5)].map(() => e101('Phú Nhuận')), [...Array(2)].map(() => e101('Quận 4')));
    const told = st.look(burst, 0, T0 + 1000, titles).notices;
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toMatch(/^Cảnh báo nghiêm trọng mới: E101 Mất kết nối tủ \(Không nhận gói tin dữ liệu đo quá 60 s\) ở 16 tủ thuộc 3 khu vực \(Quận 1 9, Phú Nhuận 5, Quận 4 2\), từ /);
    const two = started();
    expect(two.look([e101('Quận 1'), e101('Quận 3')], 0, T0 + 1000, titles).notices).toHaveLength(2);
  });

  it('more of the same code within a minute are not said one by one: one "Thêm N tủ" after the minute', () => {
    const st = started();
    const first = [e101('Quận 1'), e101('Quận 3'), e101('Quận 4')];
    expect(st.look(first, 0, T0 + 1000, titles).notices).toHaveLength(1);
    const later = [e101('Quận 1'), e101('Tân Bình')];
    expect(st.look([...first, ...later], 0, T0 + 12_000, titles).notices).toEqual([]);
    const after = st.look([...first, ...later], 0, T0 + 61_500, titles).notices;
    expect(after.map((n) => n.text)).toEqual(['Thêm 2 tủ có cảnh báo nghiêm trọng E101 Mất kết nối tủ từ câu báo trước, tổng 5 tủ đang có cảnh báo này.']);
  });

  it('the repeat after 2 minutes is grouped the same way, all of them together', () => {
    const st = started();
    const first = [e101('Quận 1'), e101('Quận 3'), e101('Quận 4')];
    st.look(first, 0, T0 + 1000, titles);
    const later = [e101('Tân Bình')];
    st.look([...first, ...later], 0, T0 + 12_000, titles);
    st.look([...first, ...later], 0, T0 + 61_500, titles);
    const again = st.look([...first, ...later], 0, T0 + 1000 + REPEAT_MS, titles).notices;
    expect(again).toHaveLength(1);
    expect(again[0]!.text).toMatch(/^Nhắc lại lần 2\/3, chưa ai xử lý cảnh báo nghiêm trọng: E101 Mất kết nối tủ \(.*\) ở 4 tủ thuộc 4 khu vực/);
  });
});
