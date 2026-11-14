import { describe, expect, it } from 'vitest';
import { route } from '../src/brain/router';
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
