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

import { normalizeCodes, cabinetSearchTerms, codeAlternatives } from '../src/tools/names';
import { cabinetRefOf } from '../src/brain/router';

describe('cabinet codes as speech recognition writes them (user voice test 2026-11-21)', () => {
  it.each([
    ['TL1 số 16.', 'tl01.0016'],
    ['Tắt nhánh một tủ TL1 số 9.', 'tl01.0009'],
    ['Nhánh một, tổ TL01.00016.', 'tl01.0016'],
    ['H1 tủ TL01.00016', 'tl01.0016'],
    ['H1TL1.0009', 'tl01.0009'],
    ['TL1009', 'tl01.0009'],
    ['tủ TL01.0016 thế nào', 'tl01.0016'],
  ])('%s -> %s', (q, code) => expect(cabinetRefOf(q, {})).toBe(code));
  it('"TL1009" also reads as TL10.0009, so both are looked up', () => {
    expect(cabinetSearchTerms('TL1009').slice(0, 2)).toEqual(['TL01.0009', 'TL10.0009']);
    expect(codeAlternatives('tl01.0009')).toEqual([]);
  });
  it('keeps other numbers as they are', () => {
    expect(normalizeCodes('quan 1 co 46 tu')).toBe('quan 1 co 46 tu');
    expect(normalizeCodes('dm0010 the nao')).toBe('dm0010 the nao');
  });
});

describe('branches in spoken orders (2026-11-21)', () => {
  it.each([
    ['Tắt nhánh một tủ TL1 số 9.', { type: 'MANUAL_BRANCH', params: { branch: 1, on: false } }, 'tl01.0009'],
    ['Có tắt nhánh một, tủ TL1 số 16.', { type: 'MANUAL_BRANCH', params: { branch: 1, on: false } }, 'tl01.0016'],
    ['tắt nhánh hai tủ TL01.0016', { type: 'MANUAL_BRANCH', params: { branch: 2, on: false } }, 'tl01.0016'],
    ['tắt nhánh một và nhánh hai tủ TL01.0016', { type: 'MANUAL_ALL', params: { on: false } }, 'tl01.0016'],
    ['tắt hai nhánh tủ TL01.0016', { type: 'MANUAL_ALL', params: { on: false } }, 'tl01.0016'],
  ])('%s', (q, command, cabinet) => expect(parseOrder(q, {})).toEqual({ kind: 'cabinet', command, cabinet }));
});

describe('"H1" is "nhánh một" (2026-11-21 recordings)', () => {
  it('in a reply to "tủ nào?" and glued to the code', () => {
    expect(normalizeCodes('h1 tucab tl01.00016')).toBe('nhanh 1 tucab tl01.0016');
    expect(normalizeCodes('h1tl1.0009')).toBe('nhanh 1 tl01.0009');
    expect(parseOrder('Tắt H1 tủ TL01.0016', {})).toMatchObject({ command: { type: 'MANUAL_BRANCH', params: { branch: 1, on: false } } });
  });
});

import { isExplicitConfirm } from '../src/guard/confirm-words';
describe('user voice test 2 (2026-11-21)', () => {
  it.each(['Xác nhận.', 'xác nhận nhé', 'Đồng ý', 'xác nhận tắt'])('explicit: %s', (q) => expect(isExplicitConfirm(q)).toBe(true));
  it.each(['ok', 'có', 'được', 'làm đi', 'không xác nhận', 'xác nhận bật tủ khác đi'])('not explicit: %s', (q) => expect(isExplicitConfirm(q)).toBe(false));
  it('"TL01 số 9.0009" is TL01.0009', () => expect(cabinetRefOf('Bật đèn tủ TL01 số 9.0009', {})).toBe('tl01.0009'));
  it('"cho tôi một tủ khác để điều khiển" asks for the allowlist', () => expect(isAllowedCabinetsQuestion('Cho tôi một tủ khác để điều khiển đi.')).toBe(true));
  it('"tắt hai nhánh của tủ vừa mới bật" switches off the cabinet in focus', () => {
    const focus = { cabinet: { id: 'c', code: 'TL01.0016', name: 'X' } };
    expect(parseOrder('Giờ thì tắt hai nhánh của tủ vừa mới bật.', focus)).toEqual({ kind: 'cabinet', command: { type: 'MANUAL_ALL', params: { on: false } }, cabinet: 'tủ đó' });
  });
});

import { wordsToDigits, fold } from '../src/tools/names';
describe('user voice test 3 (2026-11-21)', () => {
  it('"TL01 số mười sáu." is TL01.0016 (the full stop is not part of the number)', () => {
    expect(cabinetRefOf('Bật đèn tổ TL01 số mười sáu.', {})).toBe('tl01.0016');
  });
  it('a comma ends a number, and "không" at the end stays a word', () => {
    expect(wordsToDigits(fold('nhánh hai, tủ DM0010'))).toBe('nhanh 2, tu dm0010');
    expect(wordsToDigits(fold('có sáng không.'))).toBe('co sang khong.');
    expect(parseOrder('đèn có sáng không.', {})).toBeNull();
  });
  it('an unreadable code is said back', () => {
    expect(parseOrder('Bật đèn tổ TL166', {})).toMatchObject({ kind: 'which_cabinet', heard: 'TL166' });
  });
});

import { areaIn, narrow, pickIn, stateIn, streetIn } from '../src/guard/finder';
describe('the cabinet finder (2026-11-21)', () => {
  const areas = [
    { id: 'td', name: 'TP Thủ Đức', kind: 'district', parentId: null, cabinetCount: 4 }, { id: 'q1', name: 'Quận 1', kind: 'district', parentId: null, cabinetCount: 1 },
    { id: 'q10', name: 'Quận 10', kind: 'district', parentId: null, cabinetCount: 0 }, { id: 'p1', name: 'Phường 1', kind: 'ward', parentId: 'td', cabinetCount: 3 },
  ] as never[];
  const cab = (code: string, name: string, status: string, districtId = 'td', wardId = 'p1') => ({ id: code, code, name, status, districtId, wardId }) as never;
  const all = [cab('TL12.0417', 'Lý Thường Kiệt 3', 'offline'), cab('TL12.0393', 'Lý Thường Kiệt 6', 'off'), cab('TL12.0006', 'Võ Văn Kiệt 6', 'on'), cab('TL12.0011', 'Cộng Hòa 2', 'off'), cab('TL01.0009', 'Lý Thường Kiệt 9', 'on', 'q1', 'x')];
  const allowed = new Set(['TL12.0417', 'TL12.0393', 'TL12.0006', 'TL12.0011']);
  const ward = () => 'Phường 1';
  it.each([
    ['Tắt đèn một tủ ở Thủ Đức', 'TP Thủ Đức'], ['ở khu vực khu đức', 'TP Thủ Đức'], ['tủ ở quận 1', 'Quận 1'], ['tủ ở quận 10', 'Quận 10'], ['phường 1', 'Phường 1'],
  ])('area: %s -> %s', (q, name) => expect(areaIn(q, areas)?.name).toBe(name));
  it('no bare number is an area', () => expect(areaIn('bật nhánh 1', areas)).toBeUndefined());
  it.each([
    ['đường Lý Thường Kiệt gì đó', 'Lý Thường Kiệt', undefined], ['Lý Thường gì đó', 'Lý Thường Kiệt', undefined], ['tủ Lý Thường Kiệc 6', 'Lý Thường Kiệt', '6'], ['Võ Văn Kiệt 6', 'Võ Văn Kiệt', '6'],
  ])('street: %s', (q, name, n) => expect(streetIn(q, all)).toMatchObject({ name, number: n }));
  it('the order verb is not a state; "đang tắt" is', () => {
    expect(stateIn('bật đèn tủ ở Thủ Đức')).toBeUndefined();
    expect(stateIn('tủ đang tắt')).toBe('dang_tat');
  });
  it.each([['số 2', 2], ['cái thứ hai', 2], ['số hai nhé', 2], ['thứ nhất', 1], ['cái cuối', 3], ['tủ số ba', 3], ['bật đèn tủ số 2 ở quận 1', null], ['số 9', null], ['Bật đèn tủ số 2', 2], ['tắt tay cả hai nhánh tủ số 3 nhé', 3], ['bật nhánh 1 cái số 2', 2], ['bật tủ số hệ', 2], ['bật nhánh 2', null], ['chọn 2', 2], ['tủ số 2 có sáng không', null]])('pick: %s', (q, n) => expect(pickIn(q as string, 3)).toBe(n));
  it('only a few connected among many: those are read at once', () => {
    const many = [...all, ...[1, 2, 3, 4].map((i) => cab(`TL12.10${i}`, `Lê Lợi ${i}`, 'offline'))];
    const r = narrow(many, new Set([...allowed, 'TL12.101', 'TL12.102', 'TL12.103', 'TL12.104']), { area: { name: 'TP Thủ Đức', ids: ['td'] } }, ward);
    expect(r).toMatchObject({ kind: 'ask', say: expect.stringMatching(/^Có 8 tủ ở TP Thủ Đức, chỉ 3 tủ đang kết nối: số 1: Lý Thường Kiệt 6/) });
  });
  it('one cabinet left: it is the one', () => {
    expect(narrow(all, allowed, { street: { name: 'Võ Văn Kiệt', folded: ['vo van kiet'] } }, ward)).toMatchObject({ kind: 'one', cabinet: { code: 'TL12.0006' } });
  });
  it('found but none allowed', () => {
    const names = (id: string | null) => (id === 'td' ? 'TP Thủ Đức' : id === 'q1' ? 'Quận 1' : 'Phường 1');
    expect(narrow(all, allowed, { area: { name: 'Quận 1', ids: ['q1'] } }, names)).toMatchObject({ say: 'Có 1 tủ ở Quận 1 nhưng chưa tủ nào được phép điều khiển qua Jarvis. Tủ được phép ở: TP Thủ Đức (4 tủ).' });
  });
});

import { markCabinetWord } from '../src/tools/names';
describe('"tổ" / "tụ" heard for "tủ" (2026-11-21)', () => {
  it.each([['điều khiển tổ ở quận 1', 'điều khiển tucab ở quận 1'], ['39 tụ mất kết nối', '39 tucab mất kết nối'], ['tổ bảo trì', 'tổ bảo trì'], ['tụ bù', 'tụ bù'], ['từ 5 giờ', 'từ 5 giờ']])('%s', (q, out) => expect(markCabinetWord(q)).toBe(out));
});

describe('voice test on the codespace (2026-11-23)', () => {
  it('"quận mộng" / "Quân mong" is quận 1', () => {
    expect(normalizeCodes(fold('tắt đèn một tủ ở quận mộng'))).toContain('quan 1');
    expect(normalizeCodes(fold('Quân mong'))).toBe('quan 1');
  });
});
