import { describe, expect, it } from 'vitest';
import { READ_TOOLS } from '../src/tools/read';
import type { ToolContext } from '../src/tools/registry';

describe('get_system_overview', () => {
  it('counts alarms by severity from the API totals, not from one page of items (486 critical, 100 per page)', async () => {
    const alarm = { id: 'a', code: 'E101', cabinetId: 'c', cabinetName: 'Tủ', cabinetCode: 'TL01.0001', districtName: 'Quận 1', type: 'offline', severity: 'critical', message: 'Mất kết nối', value: null, startedAt: '2026-11-15T00:00:00Z', endedAt: null, active: true, ackedBy: null, ackedAt: null };
    const totals: Record<string, number> = { critical: 486, major: 0, minor: 0 };
    const reads = {
      mapStats: async () => ({ cabinets: { total: 510, offline: 491, on: 19, off: 0, fault: 0, dimming: 0, unknown: 0 }, onlinePct: 3.7, overdueIncidents: 0 }),
      alarms: async (q: { severity?: string; size?: number }) =>
        q.severity ? { items: [], total: totals[q.severity], page: 1, size: 1 } : { items: Array.from({ length: 100 }, (_, i) => ({ ...alarm, id: `a${i}` })), total: 486, page: 1, size: 100 },
    };
    const tool = READ_TOOLS.find((t) => t.name === 'get_system_overview')!;
    const out = (await tool.run({ reads, user: {}, focus: {} } as unknown as ToolContext, {})) as { openAlarms: { total: number; bySeverity: Record<string, number>; top: unknown[] } };
    expect(out.openAlarms.total).toBe(486);
    expect(out.openAlarms.bySeverity).toEqual({ nghiem_trong: 486, quan_trong: 0, nhe: 0 });
    expect(out.openAlarms.top).toHaveLength(3);
  });
});

describe('list_alarms', () => {
  it('names the API total plainly and counts groups over every page', async () => {
    const alarm = { code: 'E101', cabinetId: 'c', cabinetName: 'Tủ', cabinetCode: 'TL01.0001', districtName: 'Quận 3', type: 'offline', severity: 'critical', message: 'Mất kết nối', value: null, startedAt: '2026-11-15T00:00:00Z', endedAt: null, active: true, ackedBy: null, ackedAt: null };
    // 486 open alarms served 100 per page, Quận 3 holds most of them overall but none on the first page
    const all = Array.from({ length: 486 }, (_, i) => ({ ...alarm, id: `a${i}`, districtName: i < 100 ? `Quận ${i % 10 === 3 ? 1 : i % 10}` : 'Quận 3' }));
    const asked: number[] = [];
    const reads = { alarms: async (q: { page?: number; size?: number }) => {
      asked.push(q.page ?? 1);
      const from = ((q.page ?? 1) - 1) * (q.size ?? 100);
      return { items: all.slice(from, from + (q.size ?? 100)), total: 486, page: q.page ?? 1, size: q.size ?? 100 };
    } };
    const tool = READ_TOOLS.find((t) => t.name === 'list_alarms')!;
    const out = (await tool.run({ reads, user: {}, focus: {}, userText: 'Có bao nhiêu cảnh báo nghiêm trọng?' } as unknown as ToolContext, { severity: 'critical', active: true, limit: 10 })) as Record<string, unknown>;
    expect(out.tong_so_canh_bao).toBe(486);
    expect(out.muc_do).toBe('nghiêm trọng');
    expect(String(out.ghi_chu)).toContain('486');
    expect(asked).toEqual([1, 2, 3, 4, 5]);
    const groups = out.nhom_lon_nhat as { district: string; count: number }[];
    expect(groups[0]).toMatchObject({ district: 'Quận 3', count: 386 });
  });
});
