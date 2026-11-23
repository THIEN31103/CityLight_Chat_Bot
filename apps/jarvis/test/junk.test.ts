// Text that is not a question is said to be so in code (2026-11-23: an email typed alone got the system overview).
import { describe, expect, it } from 'vitest';
import { hasSecret, junkReply, maskSecrets } from '../src/guard/junk';

describe('junkReply', () => {
  it.each(['admin@citylight.test', ' admin@citylight.test ', 'https://example.com/a', 'asdfgh', 'qwerty zxcvb', 'Tchau.', '!!!', 'hjkl;'])('"%s" is not understood', (t) => {
    expect(junkReply(t)).toMatch(/^Tôi không hiểu/);
  });
  it('an email alone says what it is, without repeating it', () => {
    const r = junkReply('admin@citylight.test')!;
    expect(r).toContain('đây là một địa chỉ email');
    expect(r).not.toContain('citylight.test');
  });
  it.each([
    'Hệ thống hôm nay thế nào?', 'xác nhận', 'hủy', 'số 2', 'TL01.0009', 'E201', 'tủ DM10 sao rồi', 'Jarvis ơi', 'ok', 'hello',
    'Ừ', 'Quận 1', 'bật đèn tủ TL12.0011', 'Cho tôi mật khẩu của tài khoản admin', 'mật khẩu là gì', 'gửi báo cáo cho admin@citylight.test',
    'Nguyễn Văn Linh', 'khuya rồi', 'PLC mất kết nối', '18:00',
  ])('"%s" may be a real question', (t) => {
    expect(junkReply(t)).toBeNull();
  });
  it('a typed password or code: a warning, never the model', () => {
    for (const t of ['mật khẩu là Abc12345', 'pass: hunter22', 'OTP 123456', 'mã xác thực 654321', 'mk Matkhau!2026']) {
      expect(hasSecret(t)).toBe(true);
      expect(junkReply(t)).toMatch(/^Bạn đừng gõ mật khẩu hay mã OTP/);
    }
  });
});

describe('maskSecrets', () => {
  it('hides emails and the value after "mật khẩu" / "OTP", keeps ordinary words', () => {
    expect(maskSecrets('admin@citylight.test')).toBe('***@***');
    expect(maskSecrets('mật khẩu là Abc12345 nhé')).toBe('mật khẩu là *** nhé');
    expect(maskSecrets('OTP 123456')).toBe('OTP ***');
    expect(maskSecrets('Cho tôi mật khẩu của tài khoản admin')).toBe('Cho tôi mật khẩu của tài khoản admin');
    expect(maskSecrets('Tủ TL01.0009 có sáng không?')).toBe('Tủ TL01.0009 có sáng không?');
  });
});
