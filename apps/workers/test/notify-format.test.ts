import { describe, expect, it } from 'vitest';
import { botText, botTextBoth, formatBatch, formatIncident, formatLinked, formatSecurity, type IncidentEvent, type Item } from '../src/notify-format';

const alarm = (n: number, over: Partial<Item['a']> = {}): Item['a'] => ({
  id: `a${n}`, code: 'E101', type: 'offline', severity: 'critical', cabinetId: `c${n}`, cabinetCode: `TL01.${n}`, cabinetName: `Tủ ${n}`,
  message: 'Không nhận frame telemetry quá 60 s', startedAt: '2026-10-18T12:00:00Z', endedAt: null, ...over,
});
const area = (id: string) => (Number(id.slice(1)) % 2 ? 'Quận 1' : 'Quận 3');

describe('formatBatch', () => {
  it('lists a few alarms one by one, with local time and area', () => {
    const t = formatBatch([{ kind: 'raised', a: alarm(1) }, { kind: 'cleared', a: alarm(2, { endedAt: '2026-10-18T12:05:00Z' }) }], area, 5, 'https://cl.example/');
    expect(t).toContain('🔴 E101 Mất kết nối tủ');
    expect(t).toContain('TL01.1 - Tủ 1 (Quận 1) · 19:00');
    expect(t).toContain('✅ Hết: E101');
    expect(t).toContain('19:05');
    expect(t).toContain('https://cl.example/alarms');
  });

  it('adds a Google Maps directions line to raised alarms only', () => {
    const loc = (id: string) => (id === 'c1' ? { lat: 10.7769, lng: 106.7009 } : { lat: 0, lng: 0 });
    const t = formatBatch([{ kind: 'raised', a: alarm(1) }, { kind: 'raised', a: alarm(2) }, { kind: 'cleared', a: alarm(1, { endedAt: '2026-10-18T12:05:00Z' }) }], area, 5, '', loc);
    expect(t.match(/Chỉ đường: /g)).toHaveLength(1); // c2 has no location, the cleared alarm gets none
    expect(t).toContain('Chỉ đường: https://www.google.com/maps/dir/?api=1&destination=10.776900,106.700900');
  });

  it('summarises a burst by type and area', () => {
    const items: Item[] = Array.from({ length: 37 }, (_, i) => ({ kind: 'raised', a: alarm(i) }));
    items.push({ kind: 'raised', a: alarm(99, { code: 'E501', type: 'leak_current', cabinetId: 'c1' }) });
    items.push({ kind: 'cleared', a: alarm(98) });
    const t = formatBatch(items, area);
    expect(t).toContain('38 cảnh báo mới trên 37 tủ, 1 cảnh báo đã hết');
    expect(t).toContain('E101 Mất kết nối tủ: 37');
    expect(t).toContain('E501 Rò dòng: 1');
    expect(t).toMatch(/Quận 1: 1[89]/);
    expect(t.length).toBeLessThan(4000);
  });
});

describe('formatSecurity', () => {
  const base = { userId: 'u1', email: 'op@citylight.local', ip: '203.0.113.7', by: null, detail: null, at: '2026-10-20T09:05:00Z' };
  it('sign-in alert: account, IP, browser, local time and a hint for the owner', () => {
    const t = formatSecurity({ ...base, kind: 'new_ip', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' }, 'https://cl.example');
    expect(t).toContain('🔐 Đăng nhập từ IP mới');
    expect(t).toContain('Tài khoản: op@citylight.local');
    expect(t).toContain('IP 203.0.113.7 · Chrome / Windows · ');
    expect(t).toContain('16:05 20/10');
    expect(t).toContain('Không phải chủ tài khoản');
    expect(t).toContain('https://cl.example/logs/activity');
  });
  it('user administration: who did it and what, no owner hint', () => {
    const t = formatSecurity({ ...base, kind: 'role_changed', ua: null, by: 'admin@citylight.local', detail: 'viewer → admin' });
    expect(t).toContain('Đổi vai trò người dùng');
    expect(t).toContain('viewer → admin');
    expect(t).toContain('Bởi: admin@citylight.local');
    expect(t).not.toContain('trình duyệt');
    expect(t).not.toContain('Không phải chủ tài khoản');
  });
});

describe('English (S49: recipient language)', () => {
  it('formatBatch: alarm titles, cleared and links in English; stored message unchanged', () => {
    const loc = (id: string) => (id === 'c1' ? { lat: 10.7769, lng: 106.7009 } : null);
    const t = formatBatch([{ kind: 'raised', a: alarm(1) }, { kind: 'cleared', a: alarm(2, { endedAt: '2026-10-18T12:05:00Z' }) }], area, 5, 'https://cl.example/', loc, 'en');
    expect(t).toContain('🔴 E101 Cabinet offline');
    expect(t).toContain('TL01.1 - Tủ 1 (Quận 1) · 19:00');
    expect(t).toContain('Không nhận frame telemetry quá 60 s'); // data stays as stored
    expect(t).toContain('Directions: https://www.google.com/maps/dir/');
    expect(t).toContain('✅ Cleared: E101 Cabinet offline');
    expect(t).toContain('View: https://cl.example/alarms');
    expect(t).not.toMatch(/Hết|Xem|Chỉ đường/);
  });

  it('formatBatch: English summary with plurals and area fallback', () => {
    const items: Item[] = Array.from({ length: 6 }, (_, i) => ({ kind: 'raised', a: alarm(i) }));
    items.push({ kind: 'cleared', a: alarm(98) });
    const t = formatBatch(items, () => null, 5, '', undefined, 'en');
    expect(t).toContain('CityLight: 6 new alarms on 6 cabinets, 1 alarm cleared');
    expect(t).toContain('By type:\n🔴 E101 Cabinet offline: 6');
    expect(t).toContain('By area:\nNo area: 6');
    const many: Item[] = Array.from({ length: 8 }, (_, i) => ({ kind: 'raised', a: alarm(i) }));
    expect(formatBatch(many, (id) => `D${id}`, 5, '', undefined, 'en')).toContain('… and 3 more areas');
    expect(formatBatch(many.slice(0, 6), (id) => `D${id}`, 5, '', undefined, 'en')).toContain('… and 1 more area');
  });

  it('formatSecurity in English', () => {
    const base = { userId: 'u1', email: 'op@citylight.local', ip: '203.0.113.7', by: null, detail: null, at: '2026-10-20T09:05:00Z' };
    const t = formatSecurity({ ...base, kind: 'new_ip', ua: null }, 'https://cl.example', 'en');
    expect(t).toContain('CityLight · Security');
    expect(t).toContain('🔐 Sign-in from a new IP');
    expect(t).toContain('Account: op@citylight.local');
    expect(t).toContain('IP 203.0.113.7 · unknown browser · 16:05 20/10');
    expect(t).toContain('Not you signing in?');
    expect(t).toContain('View: https://cl.example/logs/activity');
    const a = formatSecurity({ ...base, kind: 'role_changed', ua: null, by: 'admin@citylight.local', detail: 'viewer → admin' }, '', 'en');
    expect(a).toContain('User role changed');
    expect(a).toContain('By: admin@citylight.local');
    expect(a).not.toContain('Not you');
  });

  const inc: IncidentEvent = {
    id: 'i1', code: 'SC00012', cabinetName: 'Tủ 1', districtName: 'Quận 1', category: 'Rò điện', content: 'E501: rò 45 mA',
    deadline: '2026-10-21T10:00:00Z', assigneeId: 'u2', by: 'Nguyễn Văn A',
  };
  it('formatIncident: Vietnamese as before, English with the category label', () => {
    const at = { lat: 10.7769, lng: 106.7009 };
    expect(formatIncident('assigned', inc, at, 'https://cl.example/')).toBe(
      'CityLight\n📋 Sự cố SC00012 giao cho bạn (bởi Nguyễn Văn A)\n   Tủ 1 (Quận 1)\n   Rò điện: E501: rò 45 mA\n   Hạn: 17:00 21/10'
        + '\n   Chỉ đường: https://www.google.com/maps/dir/?api=1&destination=10.776900,106.700900\nXem: https://cl.example/incidents/i1',
    );
    expect(formatIncident('overdue', inc, null)).toBe('CityLight\n⏰ Sự cố SC00012 đã quá hạn xử lý\n   Tủ 1 (Quận 1)\n   Rò điện: E501: rò 45 mA\n   Hạn: 17:00 21/10');
    const en = formatIncident('assigned', inc, at, 'https://cl.example', 'en');
    expect(en).toContain('📋 Incident SC00012 assigned to you (by Nguyễn Văn A)');
    expect(en).toContain('Electrical leakage: E501: rò 45 mA');
    expect(en).toContain('Deadline: 17:00 21/10');
    expect(en).toContain('Directions: https://');
    expect(en).toContain('View: https://cl.example/incidents/i1');
    expect(formatIncident('overdue', inc, null, '', 'en')).toContain('⏰ Incident SC00012 is overdue');
  });

  it('bot replies', () => {
    expect(formatLinked('op@citylight.local')).toBe(
      'Đã liên kết CityLight với tài khoản op@citylight.local. Bạn sẽ nhận cảnh báo mức "Cao" và "Nghiêm trọng" trong khu vực được phân quyền; đổi mức ở trang Tài khoản.',
    );
    expect(formatLinked('op@citylight.local', 'en')).toContain('You will get "High" and "Critical" alarms');
    expect(botText('stopped')).toBe('Đã tắt thông báo CityLight. Bật lại ở trang Tài khoản.');
    expect(botText('stopped', 'en')).toBe('CityLight notifications are off. Turn them on again on the My account page.');
    const both = botTextBoth('badLink');
    expect(both).toContain('Mã liên kết không đúng hoặc đã hết hạn.');
    expect(both).toContain('The link code is wrong or has expired.');
  });
});
