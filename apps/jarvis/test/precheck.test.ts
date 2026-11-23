// The note before a command card (2026-11-23): open alarms and unfinished field incidents, never a block.
import type { Alarm, Incident } from '@citylight/shared';
import { describe, expect, it } from 'vitest';
import { precheck } from '../src/guard/propose';
import type { ToolContext } from '../src/tools/registry';

const CAB = { id: 'c1', code: 'TL01.0009' };
const alarm = (over: Partial<Alarm>): Alarm => ({
  id: 'a', code: 'E201', cabinetId: CAB.id, cabinetName: 'Lý Thường Kiệt 9', cabinetCode: CAB.code, districtName: 'Quận 1', type: 'plc_lost',
  severity: 'major', message: 'Mất kết nối PLC', value: null, startedAt: '2026-11-23T07:20:00Z', endedAt: null, active: true, ackedBy: null, ackedAt: null, ...over,
} as Alarm);
const incident = (over: Partial<Incident>): Incident => ({
  id: 'i', code: 'SC-0012', cabinetId: CAB.id, cabinetName: 'Lý Thường Kiệt 9', districtName: 'Quận 1', wardName: 'Bến Nghé', source: 'manual',
  category: 'Đèn chập chờn', content: '', location: { lat: 0, lng: 0 }, reportedBy: 'x', reportedAt: '2026-11-22T01:00:00Z', status: 'assigned',
  assignee: null, deadline: '2026-11-22T10:00:00Z', resolution: null, ...over,
} as Incident);
const ctx = (alarms: Alarm[] | Error, incidents: Incident[] | Error) => ({
  signal: undefined,
  reads: {
    cabinetAlarms: async () => { if (alarms instanceof Error) throw alarms; return alarms; },
    incidents: async () => { if (incidents instanceof Error) throw incidents; return { items: incidents, total: incidents.length, page: 1, size: 100 }; },
  },
}) as unknown as ToolContext;
const ON = { type: 'MANUAL_ALL', params: { on: true } } as const;
const OFF = { type: 'MANUAL_ALL', params: { on: false } } as const;
const NOW = Date.parse('2026-11-23T08:00:00Z');

describe('precheck', () => {
  it('nothing open: no note', async () => {
    expect(await precheck(ctx([alarm({ active: false })], [incident({ status: 'resolved' })]), CAB, ON, NOW)).toBe('');
  });
  it('reads that fail (no right to incidents, API down) add nothing and never throw', async () => {
    expect(await precheck(ctx(new Error('down'), new Error('403')), CAB, ON, NOW)).toBe('');
  });
  it('names the worst alarms first and the cabinet\'s own open incident, overdue', async () => {
    const note = await precheck(ctx(
      [alarm({ code: 'E105', severity: 'minor', message: 'Cửa tủ mở' }), alarm({ code: 'E301', type: 'leak_current', severity: 'critical', message: 'Dòng rò cao' }), alarm({})],
      [incident({}), incident({ cabinetId: 'other', code: 'SC-0099' })],
    ), CAB, OFF, NOW);
    expect(note).toMatch(/^Lưu ý trước khi gửi: tủ đang có 3 cảnh báo: E301 Dòng rò cao \(nghiêm trọng, từ .+\); E201 Mất kết nối PLC \(quan trọng, từ .+\) và 1 cảnh báo khác\./);
    expect(note).toContain('Có sự cố hiện trường chưa xong: SC-0012 Đèn chập chờn (đã giao, quá hạn).');
    expect(note).not.toContain('SC-0099');
    // turning the lights off near a leak is no extra risk
    expect(note).not.toContain('kiểm tra hiện trường');
  });
  it('switching ON with a leak: advises a field check, still only a note', async () => {
    const note = await precheck(ctx([alarm({ code: 'E301', type: 'leak_current', severity: 'critical', message: 'Dòng rò cao' })], []), CAB, ON, NOW);
    expect(note).toMatch(/Nên kiểm tra hiện trường trước khi bật đèn\.$/);
  });
});
