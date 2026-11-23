import { describe, expect, it } from 'vitest';
import { sanitizeForLlm, sanitizeText } from '../src/sanitize/llm';

// spec 11: admin data with ltid, a CoreIF frame, email and phone nested in arrays
const ADMIN_ROW = {
  cabinet: {
    id: 'c1',
    code: 'DM0010',
    name: 'Tủ demo 10',
    ltid: 'CTY0005',
    imei: '861234567890123',
    otherImei: '861234567890999',
    simIccid: '8984012345678901234',
    location: { lat: 10.776889123, lng: 106.700806456 },
  },
  lastFrame: "*#LTID'CTY0005&LIME'861234567890123&LPAS'secret$",
  log: ['LTID CTY0005 đổi mã', { note: 'liên hệ ops@citylight.vn hoặc 0912 345 678' }],
  people: [{ fullName: 'Nguyễn Văn A', email: 'a@citylight.vn', phone: '+84912345678', telegramChatId: 12345, ip: '1.2.3.4' }],
  signingKeyId: 'k1',
  csrfToken: 'abc',
  requestedBy: 'b@citylight.vn',
};

const LEAKS = ['CTY0005', '861234567890123', '861234567890999', '8984012345678901234', 'secret', 'ops@citylight.vn', 'a@citylight.vn', 'b@citylight.vn', '0912 345 678', '+84912345678', '1.2.3.4', '12345'];

describe('sanitizeForLlm', () => {
  const out = sanitizeForLlm(ADMIN_ROW);
  const text = JSON.stringify(out);

  it.each(LEAKS)('removes %s', (leak) => {
    expect(text).not.toContain(leak);
  });

  it('keeps what the operator needs', () => {
    expect(out.cabinet.code).toBe('DM0010');
    expect(out.cabinet.name).toBe('Tủ demo 10');
    // a person's name is account data since 2026-11-23: dropped like the email
    expect(out.people[0]!.fullName).toBeUndefined();
  });

  it('drops identity keys entirely', () => {
    for (const k of ['ltid', 'imei', 'otherImei', 'simIccid']) expect(out.cabinet).not.toHaveProperty(k);
    for (const k of ['email', 'phone', 'telegramChatId', 'ip']) expect(out.people[0]).not.toHaveProperty(k);
    expect(out).not.toHaveProperty('signingKeyId');
    expect(out).not.toHaveProperty('csrfToken');
  });

  it('rounds coordinates to 3 decimals unless asked not to', () => {
    expect(out.cabinet.location).toEqual({ lat: 10.777, lng: 106.701 });
    expect(sanitizeForLlm(ADMIN_ROW, { preciseCoords: true }).cabinet.location.lat).toBe(10.776889123);
  });

  it('blanks frame values but keeps the keys readable', () => {
    expect(out.lastFrame).toBe("*#LTID'***&LIME'***&LPAS'***$");
  });

  it('does not mutate its input', () => {
    expect(ADMIN_ROW.cabinet.ltid).toBe('CTY0005');
    expect(ADMIN_ROW.people[0]!.email).toBe('a@citylight.vn');
  });

  it('leaves ordinary numbers and cabinet codes alone', () => {
    expect(sanitizeText('Tủ DM0010 dòng 12.5 A, 230 V, mã E201, lúc 17:05')).toBe('Tủ DM0010 dòng 12.5 A, 230 V, mã E201, lúc 17:05');
    expect(sanitizeForLlm({ leakMa: 30, pTotalKw: 1.25 })).toEqual({ leakMa: 30, pTotalKw: 1.25 });
  });

  it('a sentence that only mentions LTID stays readable', () => {
    expect(sanitizeText('LTID của tủ đã đổi')).toBe('LTID của tủ đã đổi');
  });
});
