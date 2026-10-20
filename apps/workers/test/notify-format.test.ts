import { describe, expect, it } from 'vitest';
import { formatBatch, type Item } from '../src/notify-format';

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
