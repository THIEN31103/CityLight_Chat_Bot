import { describe, expect, it } from 'vitest';
import { collapseRepeats, fixCabinetWord, fixPlaceNames, snapPlaces, tidyHeard } from '../src/voice/heard';
import { STT_HINT, sttPrompt } from '../src/voice/groq-stt';

describe('collapseRepeats', () => {
  it('keeps a looped sentence once', () => {
    expect(collapseRepeats('Xin chào. Xin chào. Xin chào. Xin chào.')).toBe('Xin chào.');
    expect(collapseRepeats('Xin chào. xin chào! Tổng quan hệ thống?')).toBe('Xin chào. Tổng quan hệ thống?');
  });
  it('leaves different sentences and repeats further apart alone', () => {
    expect(collapseRepeats('Bật nhánh 1. Tắt nhánh 1.')).toBe('Bật nhánh 1. Tắt nhánh 1.');
    expect(collapseRepeats('Có. Không. Có.')).toBe('Có. Không. Có.');
    expect(collapseRepeats('Tủ TL01.0009 có sáng không?')).toBe('Tủ TL01.0009 có sáng không?');
  });
});

describe('fixPlaceNames', () => {
  it('turns the heard forms of Thủ Đức into the real name', () => {
    expect(fixPlaceNames('Hệ thống khu vực thủ đích thế nào rồi?')).toBe('Hệ thống khu vực Thủ Đức thế nào rồi?');
    expect(fixPlaceNames('Tủ ở Khẩu Đức')).toBe('Tủ ở Thủ Đức');
    expect(fixPlaceNames('thủ đức')).toBe('Thủ Đức');
    expect(fixPlaceNames('tình hình của quận thủ đất')).toBe('tình hình của quận Thủ Đức');
  });
  it('does not touch other words', () => {
    expect(fixPlaceNames('đích đến của khẩu hiệu')).toBe('đích đến của khẩu hiệu');
    expect(fixPlaceNames('Quận 1')).toBe('Quận 1');
  });
});

describe('fixCabinetWord', () => {
  it('writes tổ / tụ as tủ', () => {
    expect(fixCabinetWord('điều khiển tổ ở khu vực quận 1')).toBe('điều khiển tủ ở khu vực quận 1');
    expect(fixCabinetWord('39 tụ mất kết nối')).toBe('39 tủ mất kết nối');
    expect(fixCabinetWord('Tổ TL01.0009 có sáng không?')).toBe('Tủ TL01.0009 có sáng không?');
    expect(fixCabinetWord('hãy cho tôi mã tố.')).toBe('hãy cho tôi mã tủ.');
  });
  it('keeps the real words', () => {
    expect(fixCabinetWord('tổ đội bảo trì')).toBe('tổ đội bảo trì');
    expect(fixCabinetWord('tổ trưởng ca đêm')).toBe('tổ trưởng ca đêm');
    expect(fixCabinetWord('tụ bù bị hỏng')).toBe('tụ bù bị hỏng');
    expect(fixCabinetWord('tổng quan')).toBe('tổng quan');
    expect(fixCabinetWord('tố cáo sai phạm')).toBe('tố cáo sai phạm');
  });
});

it('tidyHeard does all three', () => {
  expect(tidyHeard(' Tổ ở thủ đích. Tổ ở thủ đích. ')).toBe('Tủ ở Thủ Đức.');
});

describe('snapPlaces (real names from the map, 2026-11-23)', () => {
  const names = ['TP Thủ Đức', 'Quận 1', 'Phường Bến Nghé', 'Phường Thảo Điền', 'Lý Thường Kiệt', 'Cộng Hòa', 'Hai Bà Trưng', 'Điện Biên Phủ', 'Lê Lợi', 'Lê Lai'];
  it('a name one letter off is fixed anywhere', () => {
    expect(snapPlaces('tủ trên đường Lý Thường Kiệc có sáng không', names)).toBe('tủ trên đường Lý Thường Kiệt có sáng không');
    expect(snapPlaces('tủ Điện Biên Phú 7', names)).toBe('tủ Điện Biên Phủ 7');
  });
  it('two letters off only right after a place word', () => {
    expect(snapPlaces('tình hình khu vực khẩu đức', names)).toBe('tình hình khu vực Thủ Đức');
    expect(snapPlaces('ở phường thảo diễn.', names)).toBe('ở phường Thảo Điền.');
    expect(snapPlaces('khẩu đức', names)).toBe('khẩu đức');
  });
  it('keeps right names, one-word names, numbers and ties alone', () => {
    expect(snapPlaces('Tủ ở Cộng Hòa', names)).toBe('Tủ ở Cộng Hòa');
    expect(snapPlaces('đường Lê Lui', names)).toBe('đường Lê Lui');
    expect(snapPlaces('đường Lê Lơi', names)).toBe('đường Lê Lợi');
    expect(snapPlaces('quận một', names)).toBe('quận một');
    expect(snapPlaces('tổng quan hệ thống hôm nay thế nào', names)).toBe('tổng quan hệ thống hôm nay thế nào');
    expect(snapPlaces('bật đèn tủ số hai', names)).toBe('bật đèn tủ số hai');
  });
});

it('sttPrompt: the general hint by default; the short one plus what is expected otherwise, without cabinet codes', () => {
  expect(sttPrompt()).toBe(STT_HINT);
  const p = sttPrompt('Bạn chọn số mấy? Số một. Số hai.');
  expect(p.endsWith('Bạn chọn số mấy? Số một. Số hai.')).toBe(true);
  expect(p).not.toMatch(/TL\d|DM\d/);
});
