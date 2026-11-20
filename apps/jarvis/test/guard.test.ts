import { describe, expect, it } from 'vitest';
import { classifyReply } from '../src/guard/confirm-words';

describe('confirm words (spec 6.4, >= 30 sentences)', () => {
  it.each([
    'xác nhận', 'Xác nhận.', 'xac nhan', 'XÁC NHẬN!', 'ừ xác nhận nhé', 'đồng ý', 'dong y', 'ok', 'OK Jarvis', 'oke làm đi', 'làm đi',
    'gửi đi', 'gửi lệnh đi', 'thực hiện', 'tiến hành đi', 'được', 'đúng rồi', 'có', 'ừ', 'chốt', 'yes', 'ok xác nhận lệnh đó',
  ])('confirm: %s', (t) => expect(classifyReply(t)).toBe('confirm'));

  it.each([
    'hủy', 'Huỷ.', 'huy', 'hủy bỏ', 'thôi', 'thôi khỏi', 'không', 'ko', 'đừng', 'đừng làm', 'dừng lại', 'dừng', 'bỏ qua', 'khỏi',
    'không cần', 'chưa', 'không, đừng làm', 'không xác nhận', 'chưa đồng ý', 'đừng gửi', 'cancel', 'Hồi.',
  ])('cancel: %s', (t) => expect(classifyReply(t)).toBe('cancel'));

  it.each(['ok thôi', 'có, à không', 'đồng ý hủy'])('unclear: %s', (t) => expect(classifyReply(t)).toBe('unclear'));

  it.each(['', 'tủ TL01.0009 thế nào', 'hệ thống hôm nay có bao nhiêu tủ mất kết nối', 'dung', 'mấy giờ rồi', 'bật đèn tủ đó lên'])(
    'not a reply: "%s"', (t) => expect(classifyReply(t)).toBeNull(),
  );
});

import { parseOrder } from '../src/guard/orders';
import { PendingSlot } from '../src/guard/pending';
import { cabinetRefused, CommandRate, controlUnavailable, MAX_COMMANDS_PER_MIN, PENDING_TTL_MS, tierFor, type GuardState } from '../src/guard/policy';

const focus = { cabinet: { id: 'c9', code: 'TL01.0009', name: 'Lý Thường Kiệt 9' } };

describe('orders (parsed in code, never by the model)', () => {
  it.each([
    ['Bật đèn tủ TL01.0009 lên giúp tôi', 'MANUAL_ALL', { on: true }, 'tl01.0009'],
    ['tắt tủ đó đi', 'MANUAL_ALL', { on: false }, 'tủ đó'],
    ['bật tay tủ demo số hai', 'MANUAL_ALL', { on: true }, 'demo so 2'],
    ['tắt nhánh hai tủ TL01.0016', 'MANUAL_BRANCH', { branch: 2, on: false }, 'tl01.0016'],
    ['bật nhánh 1 tủ đó', 'MANUAL_BRANCH', { branch: 1, on: true }, 'tủ đó'],
    ['trả tủ đó về chạy theo lịch', 'AUTO', {}, 'tủ đó'],
    ['bật xung tủ TL01.0016', 'PULSE_ON', {}, 'tl01.0016'],
    ['gửi lệnh chẩn đoán tủ TL01.0009', 'DIAG', {}, 'tl01.0009'],
    ['tắt nó đi', 'MANUAL_ALL', { on: false }, 'tủ đó'],
  ])('%s -> %s', (q, type, params, cabinet) => {
    expect(parseOrder(q, focus)).toEqual({ kind: 'cabinet', command: { type, params }, cabinet });
  });
  it('several cabinets at once is a batch (web + OTP), an order without a cabinet asks which', () => {
    expect(parseOrder('tắt hết đèn quận 1', focus)).toMatchObject({ kind: 'many' });
    expect(parseOrder('bật đèn lên', {})).toMatchObject({ kind: 'which_cabinet' });
  });
  it.each(['Tủ TL01.0009 đã bật đèn chưa?', 'tủ đó có đang tắt không', 'lịch bật tắt tủ đó thế nào', 'Hệ thống thế nào', 'xác nhận', 'chẩn đoán tủ TL01.0009 giúp tôi', 'đèn tủ đó bật lúc mấy giờ'])(
    'not an order: %s', (q) => expect(parseOrder(q, focus)).toBeNull(),
  );
});

describe('policy (spec 6.1, 6.3, 6.7, 6.8)', () => {
  const g: GuardState = { envEnabled: true, settingsEnabled: true, allowlist: ['TL01.0009'] };
  it('switching off is T2 (button only); on, back to schedule, pulse and diagnosis are T1; anything after 10 idle minutes is T2', () => {
    expect(tierFor({ type: 'MANUAL_ALL', params: { on: false } })).toBe('T2');
    expect(tierFor({ type: 'MANUAL_BRANCH', params: { branch: 2, on: false } })).toBe('T2');
    for (const c of [{ type: 'MANUAL_ALL', params: { on: true } }, { type: 'AUTO', params: {} }, { type: 'PULSE_ON', params: {} }, { type: 'DIAG', params: {} }] as const)
      expect(tierFor(c)).toBe('T1');
    expect(tierFor({ type: 'MANUAL_ALL', params: { on: true } }, 10 * 60_000)).toBe('T2');
  });
  it('kill switches, an empty allowlist (fail closed) and a role without cabinet.control stop everything', () => {
    expect(controlUnavailable(g, 'operator')).toBeNull();
    expect(controlUnavailable({ ...g, envEnabled: false }, 'admin')).toMatch(/cấu hình máy chủ/);
    expect(controlUnavailable({ ...g, settingsEnabled: false }, 'admin')).toMatch(/trang quản trị/);
    expect(controlUnavailable({ ...g, allowlist: [] }, 'admin')).toMatch(/Chưa có tủ nào/);
    expect(controlUnavailable(g, 'viewer')).toMatch(/không có quyền/);
  });
  it('allowlist: in / out', () => {
    expect(cabinetRefused(g, 'tl01.0009')).toBeNull();
    expect(cabinetRefused(g, 'TL01.0016')).toMatch(/không nằm trong danh sách được phép điều khiển qua Jarvis \(.+\)\. Danh sách này do quản trị viên đặt; tủ khác bạn điều khiển trên web CityLight\.$/);
  });
  it(`at most ${MAX_COMMANDS_PER_MIN} commands per user and minute`, () => {
    const r = new CommandRate();
    for (let i = 0; i < MAX_COMMANDS_PER_MIN; i++) {
      expect(r.allow('u', 1000 + i)).toBe(true);
      r.record('u', 1000 + i);
    }
    expect(r.allow('u', 2000)).toBe(false);
    expect(r.allow('v', 2000)).toBe(true);
    expect(r.allow('u', 61_100)).toBe(true);
  });
});

describe('pending actions (spec 6.2)', () => {
  const draft = (on: boolean) => ({ command: { type: 'MANUAL_ALL' as const, params: { on } }, cabinet: { id: 'c9', code: 'TL01.0009', name: 'LTK 9' }, summary: 's', tier: on ? 'T1' as const : 'T2' as const });
  it('one at a time: a new one replaces the old', () => {
    const slot = new PendingSlot();
    const a = slot.create(draft(true), 0).pending;
    const b = slot.create(draft(true), 1000);
    expect(b.replaced?.id).toBe(a.id);
    expect(slot.take(a.id, 'text', 1500)).toMatchObject({ ok: false });
    expect(slot.take(b.pending.id, 'text', 1500)).toMatchObject({ ok: true });
  });
  it('taken once only (a double click never sends twice), and its id is a valid Idempotency-Key', () => {
    const slot = new PendingSlot();
    const p = slot.create(draft(true), 0).pending;
    expect(p.id).toMatch(/^[\w-]{8,100}$/);
    expect(slot.take(p.id, 'button', 10)).toMatchObject({ ok: true });
    expect(slot.take(p.id, 'button', 20)).toEqual({ ok: false, reason: 'Lệnh này đã được xử lý rồi.' });
  });
  it(`expires after ${PENDING_TTL_MS / 1000} s: confirming later is refused`, () => {
    const slot = new PendingSlot();
    const p = slot.create(draft(true), 0).pending;
    expect(slot.take(p.id, 'voice', PENDING_TTL_MS)).toMatchObject({ ok: false, reason: expect.stringMatching(/hết hạn/) });
    expect(slot.active(PENDING_TTL_MS)).toBeNull();
  });
  it('T2 (switch off): voice and typed words are refused, the action keeps waiting for the button', () => {
    const slot = new PendingSlot();
    const p = slot.create(draft(false), 0).pending;
    expect(slot.take(p.id, 'voice', 10)).toMatchObject({ ok: false, reason: expect.stringMatching(/bấm nút/) });
    expect(slot.take(p.id, 'text', 20)).toMatchObject({ ok: false });
    expect(slot.take(p.id, 'button', 30)).toMatchObject({ ok: true });
  });
  it('cancel', () => {
    const slot = new PendingSlot();
    const p = slot.create(draft(true), 0).pending;
    expect(slot.cancel(p.id)?.id).toBe(p.id);
    expect(slot.take(p.id, 'button', 10)).toMatchObject({ ok: false });
  });
});

import { scheduleNote } from '../src/guard/schedule-note';

describe('what the schedule does after an order (spec 2.1: manual lasts until the next schedule edge)', () => {
  // Vietnam time is UTC+7: 16:50 VN = 09:50 UTC
  const at = (hhmm: string) => Date.parse(`2026-11-15T${String((Number(hhmm.slice(0, 2)) + 17) % 24).padStart(2, '0')}:${hhmm.slice(3)}:00Z`);
  const mode1 = { mode: 1, on1: '18:00', off1: '05:30', on2: '18:15', off2: '23:00', branch1Enabled: true, branch2Enabled: true };
  const mode2 = { ...mode1, mode: 2 };
  const off = { type: 'MANUAL_ALL' as const, params: { on: false } };
  const on = { type: 'MANUAL_ALL' as const, params: { on: true } };
  it.each([
    // switch off in the afternoon: the lights come back at the ON edge
    [off, mode1, '16:50', 'Đèn sẽ tự bật lại theo lịch lúc 18:00.'],
    // switch off at night: the next edge is the morning OFF edge, nothing comes back on tonight
    [off, mode1, '20:00', 'Chế độ tay giữ tới 05:30 ngày mai, sau đó tủ chạy lại theo lịch và đèn vẫn tắt.'],
    // switch on at night: the lights go off by schedule at the morning edge
    [on, mode1, '20:00', 'Đèn sẽ tự tắt lại theo lịch lúc 05:30 ngày mai.'],
    // switch on in the afternoon: from 18:00 the schedule keeps them on
    [on, mode1, '16:50', 'Chế độ tay giữ tới 18:00, sau đó tủ chạy lại theo lịch và đèn vẫn sáng.'],
    // Chế độ 2, branch 2 off at 20:00: the next edge of any branch is branch 2's 23:00, where branch 2 is off anyway
    [{ type: 'MANUAL_BRANCH' as const, params: { branch: 2 as const, on: false } }, mode2, '20:00', 'Chế độ tay giữ tới 23:00, sau đó tủ chạy lại theo lịch và nhánh 2 vẫn tắt.'],
    // Chế độ 2, branch 1 off at 17:00: the next edge is 18:00 (branch 1 ON)
    [{ type: 'MANUAL_BRANCH' as const, params: { branch: 1 as const, on: false } }, mode2, '17:00', 'Nhánh 1 sẽ tự bật lại theo lịch lúc 18:00.'],
    // Chế độ 2, both off at 18:05: at the next edge 18:15 branch 1 should be on, branch 2 too
    [off, mode2, '18:05', 'Đèn sẽ tự bật lại theo lịch lúc 18:15.'],
    [{ type: 'AUTO' as const, params: {} }, mode1, '16:50', 'Theo lịch thì lúc này cả hai nhánh tắt.'],
    [{ type: 'AUTO' as const, params: {} }, mode2, '23:30', 'Theo lịch thì lúc này nhánh 1 sáng, nhánh 2 tắt.'],
  ])('%j %#', (cmd, sched, time, said) => expect(scheduleNote(cmd, sched, at(time))).toBe(said));

  it('no schedule, or one that cannot be read: nothing is promised', () => {
    expect(scheduleNote(off, null, at('16:50'))).toBeUndefined();
    expect(scheduleNote(off, { on1: '6h', off1: '' }, at('16:50'))).toBeUndefined();
    expect(scheduleNote({ type: 'DIAG', params: {} }, mode1, at('16:50'))).toBeUndefined();
  });
});

import { sendAndFollow } from '../src/guard/pending';
import type { ApiClient } from '../src/api/client';

describe('following a sent command', () => {
  const api = (status: string) => ({
    post: async () => ({ id: 'c1', status: 'queued' }),
    get: async () => ({ id: 'c1', status, error: null }),
  }) as unknown as ApiClient;
  const p = (type: 'PULSE_ON' | 'DIAG' | 'MANUAL_ALL') => ({ id: 'jv-abcdefgh', command: { type, params: type === 'MANUAL_ALL' ? { on: true } : {} }, cabinet: { id: 'x', code: 'X', name: 'X' }, summary: '', tier: 'T1' as const, createdAt: 0, expiresAt: 1 });
  it('pulse and RS485 self-test end at "acked" (nothing in the data proves them): done at once', async () => {
    expect((await sendAndFollow(api('acked'), p('PULSE_ON'), { pollMs: 1, followMs: 5000 })).status).toBe('acked');
    expect((await sendAndFollow(api('acked'), p('DIAG'), { pollMs: 1, followMs: 5000 })).status).toBe('acked');
  });
  it('switching waits for "confirmed": "acked" alone runs into the time limit', async () => {
    expect((await sendAndFollow(api('acked'), p('MANUAL_ALL'), { pollMs: 1, followMs: 30 })).status).toBe('timeout');
  });
});

import { isAllowedCabinetsQuestion } from '../src/guard/orders';

describe('"which cabinets can I control" is answered from the allowlist', () => {
  it.each(['cho tui một mã tủ để điều khiển đi', 'tủ nào điều khiển được?', 'bạn bật tắt được những tủ nào', 'danh sách tủ được phép điều khiển', 'mấy tủ ra lệnh được'])(
    'yes: %s', (q) => expect(isAllowedCabinetsQuestion(q)).toBe(true),
  );
  it.each(['Bật đèn tủ TL01.0016', 'tủ nào đang mất kết nối', 'tủ nào đang bật đèn?', 'những tủ nào tắt rồi', 'bạn có thể điều khiển đèn chưa', 'Tủ TL01.0009 đã bật đèn chưa?', 'lịch bật tắt tủ đó'])(
    'no: %s', (q) => expect(isAllowedCabinetsQuestion(q)).toBe(false),
  );
});
