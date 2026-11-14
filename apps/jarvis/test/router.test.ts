import { describe, expect, it } from 'vitest';
import { isControlCapabilityQuestion, isSwitchOrder, isWhoAmI, route } from '../src/brain/router';
import { KEEP_MESSAGES, ShiftContext } from '../src/brain/context';

const focus = { cabinet: { id: 'c1', code: 'DM0010', name: 'Tủ demo 10' } };

describe('keyword router', () => {
  it.each([
    ['Mã E201 nghĩa là gì?', 'explain_alarm_code', { code: 'E201' }],
    ['e301 là lỗi gì vậy', 'explain_alarm_code', { code: 'E301' }],
    ['Hệ thống thế nào rồi?', 'get_system_overview', {}],
    ['báo cáo tình hình đi', 'get_system_overview', {}],
    ['Quận nào đang có nhiều cảnh báo nhất?', 'list_alarms', {}],
    ['Phường nào đang có lỗi?', 'list_alarms', {}],
    ['Có sự cố nào quá hạn không?', 'list_incidents', { filter: 'overdue' }],
    ['các sự cố đang mở', 'list_incidents', { filter: 'open' }],
    ['Tủ TL01.0009 bị gì?', 'get_cabinet', { cabinet: 'tl01.0009' }],
    ['tủ demo số mười bị gì vậy', 'get_cabinet', { cabinet: 'demo so 10' }],
    ['Tối qua tủ TL01.0016 bật lúc mấy giờ?', 'get_cabinet_history', { cabinet: 'tl01.0016', hours: 24 }],
    ['dòng rò tủ DM0003 24 giờ qua có bất thường không', 'get_cabinet_history', { cabinet: 'dm0003', hours: 24 }],
    ['lịch bật tắt tủ đó thế nào', 'get_schedule', { cabinet: 'tủ đó' }],
    ['Tủ demo số 1 có đang sáng không', 'get_cabinet', { cabinet: 'demo so 1' }],
    // missed by the end-to-end run of 2026-11-14 (C6, C9, C10, C13)
    ['Tủ đó có cảnh báo gì không?', 'get_cabinet', { cabinet: 'tủ đó' }],
    ['Có bao nhiêu cảnh báo nghiêm trọng đang mở?', 'list_alarms', { severity: 'critical' }],
    ['cảnh báo nhẹ hiện tại', 'list_alarms', { severity: 'minor' }],
    ['Tìm giúp tôi các tủ trên đường Lý Thường Kiệt', 'find_cabinets', { query: 'Lý Thường Kiệt' }],
    ['tủ ở phố Hàng Bài nhé', 'find_cabinets', { query: 'Hàng Bài' }],
    ['Hệ thống có những khu vực nào?', 'list_areas', {}],
    ['danh sách các quận', 'list_areas', {}],
    ['Tủ TL01.0009 đã bật đèn chưa?', 'get_cabinet', { cabinet: 'tl01.0009' }],
    ['tủ đó tắt đèn chưa', 'get_cabinet', { cabinet: 'tủ đó' }],
  ])('%s -> %s', (q, name, input) => {
    expect(route(q, focus)).toEqual({ name, input });
  });

  it.each(['Xin chào Jarvis', 'bạn làm được gì', 'tắt hết đèn đi', 'cảm ơn', 'trả tủ đó về chạy theo lịch', 'bật tay tủ demo số hai', 'xác nhận'])('%s -> no route (the model decides)', (q) => {
    expect(route(q, focus)).toBeNull();
  });

  it('"từ" (from) is not "tủ" (cabinet): "cảnh báo từ 5 giờ" is not about cabinet 5', () => {
    expect(route('Có cảnh báo nào từ 5 giờ sáng không', focus)).toEqual({ name: 'list_alarms', input: {} });
    expect(route('Báo cáo tình hình từ 5 giờ sáng', focus)).toEqual({ name: 'get_system_overview', input: {} });
    expect(route('tủ 5 thế nào', focus)).toEqual({ name: 'get_cabinet', input: { cabinet: 'tủ 5 thế nào' } });
  });

  it.each([
    ['Mã E hai không một nghĩa là gì?', 'E201'],
    ['mã e ba không một là gì', 'E301'],
    ['E 2 0 1 nghĩa là gì', 'E201'],
    ['mã E201 là gì', 'E201'],
  ])('alarm code read aloud: %s -> %s', (q, code) => {
    expect(route(q, focus)).toEqual({ name: 'explain_alarm_code', input: { code } });
  });

  it('"tủ đó" without anything in focus is not routed', () => {
    expect(route('lịch tủ đó thế nào', {})).toBeNull();
  });
});

describe('switch orders (Jarvis cannot switch yet)', () => {
  it.each(['Bật đèn tủ TL01.0009 lên giúp tôi', 'tắt hết đèn đi', 'bật tay tủ demo số hai', 'trả tủ đó về chạy theo lịch'])('order: %s', (q) => {
    expect(isSwitchOrder(q)).toBe(true);
  });
  it.each(['Tủ TL01.0009 đã bật đèn chưa?', 'tủ đó đang tắt đèn à?', 'lịch bật tắt tủ đó thế nào', 'xác nhận', 'có bất thường không', 'Tối qua tủ TL01.0016 bật lúc mấy giờ?'])('not an order: %s', (q) => {
    expect(isSwitchOrder(q)).toBe(false);
  });
});

describe('shift context', () => {
  it('keeps 20 messages but sends only the last N, with a note of older questions', () => {
    const c = new ShiftContext();
    for (let i = 1; i <= 15; i++) c.addTurn(`câu ${i}`, `trả lời ${i}`);
    expect(c.size).toBe(KEEP_MESSAGES);
    const sent = c.messagesFor('câu mới', 6);
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'câu mới' });
    expect(sent.filter((m) => m.role === 'assistant' && m.content.startsWith('trả lời'))).toHaveLength(3);
    expect(sent[0]!.content).toContain('câu 12');
    expect(sent[0]!.content).not.toContain('câu 1;');
  });
});

describe('questions about Jarvis itself (fixed answers)', () => {
  it.each(['bạn có thể điều khiển đèn chưa', 'bạn có tính năng điều khiển tủ chưa', 'Jarvis điều khiển đèn được không?', 'bạn biết bật tắt đèn không', 'có chức năng gửi lệnh tắt đèn không'])(
    'capability: %s', (q) => expect(isControlCapabilityQuestion(q)).toBe(true),
  );
  it.each(['Tủ TL01.0009 đã bật đèn chưa?', 'tủ đó có bật đèn lúc mấy giờ không', 'Bật đèn tủ TL01.0009 lên giúp tôi', 'Hệ thống thế nào rồi?', 'bạn là ai'])(
    'not a capability question: %s', (q) => expect(isControlCapabilityQuestion(q)).toBe(false),
  );
  it.each(['biết tui là ai không', 'tôi là ai', 'Jarvis có biết mình là ai không'])('who am I: %s', (q) => expect(isWhoAmI(q)).toBe(true));
  it.each(['bạn là ai', 'Jarvis là ai vậy'])('not who am I: %s', (q) => expect(isWhoAmI(q)).toBe(false));
});
