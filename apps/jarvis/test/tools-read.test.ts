import { describe, expect, it } from 'vitest';
import { READ_TOOLS, viText } from '../src/tools/read';
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

describe('viText', () => {
  it.each([
    ['Mất kết nối telemetry', 'Mất kết nối dữ liệu đo'],
    ['không nhận frame telemetry trong 60 giây', 'không nhận gói tin dữ liệu đo trong 60 giây'],
    ['Tủ offline', 'Tủ mất kết nối'],
    ['Lỗi PLC_KEY', 'Lỗi PLC_KEY'],
  ])('%s -> %s', (a, b) => expect(viText(a)).toBe(b));
});

describe('get_area_cabinets', () => {
  const cab = (i: number, status: string) => ({ id: `c${i}`, code: `TL01.${String(i).padStart(4, '0')}`, name: `Tủ ${i}`, status });
  const all = [cab(1, 'offline'), cab(2, 'on'), cab(3, 'fault'), cab(4, 'off'), cab(5, 'on'), cab(6, 'dimming')];
  const tool = () => READ_TOOLS.find((t) => t.name === 'get_area_cabinets')!;
  const ctx = () => ({ reads: { mapCabinets: async () => all }, user: {}, focus: {} }) as unknown as ToolContext;

  it('with no area: the whole system, from the map list, without asking which area', async () => {
    const out = (await tool().run(ctx(), {})) as Record<string, any>;
    expect(out.khu_vuc).toBe('toàn hệ thống');
    expect(out.tong_so_tu).toBe(6);
    expect(out.danh_sach[0]).toEqual({ code: 'TL01.0003', name: 'Tủ 3', status: 'có lỗi' });
  });
  it('"bình thường" = connected and without fault, and the limit holds', async () => {
    const out = (await tool().run(ctx(), { state: 'binh_thuong', limit: 3 })) as Record<string, any>;
    expect(out.so_tu_khop).toBe(4);
    expect(out.danh_sach.map((c: { code: string }) => c.code)).toEqual(['TL01.0002', 'TL01.0004', 'TL01.0005']);
  });
  it('the model may leave area empty: area is optional in the schema', () => {
    expect((tool().schema as { required: string[] }).required).toEqual([]);
    expect(tool().input.safeParse({}).success).toBe(true);
  });
  it('"quận 1" is the district, not "Phường 1" nor "Quận 10"', async () => {
    const areas = [
      { id: 'd1', name: 'Quận 1', kind: 'district', parentId: null }, { id: 'd10', name: 'Quận 10', kind: 'district', parentId: null },
      { id: 'w1', name: 'Phường 1', kind: 'ward', parentId: 'd10' }, { id: 'w2', name: 'Phường Bến Nghé', kind: 'ward', parentId: 'd1' },
    ];
    const asked: string[] = [];
    const reads = { areaTree: async () => ({ areas, unassigned: 0 }), areaCabinets: async (id: string) => (asked.push(id), [cab(1, 'offline')]) };
    const run = (area: string) => tool().run({ reads, user: {}, focus: {} } as unknown as ToolContext, { area, state: 'mat_ket_noi' }) as Promise<Record<string, any>>;
    expect((await run('quận 1')).khu_vuc).toBe('Quận 1');
    expect(asked).toEqual(['w2']);
    expect((await run('phường 1')).khu_vuc).toBe('Phường 1');
  });
  it('a state with no cabinet says so, with the counts (no "Không biết.")', async () => {
    const out = (await tool().run(ctx(), { state: 'binh_thuong' })) as Record<string, any>;
    expect(out.ghi_chu).toBeUndefined();
    const none = { reads: { mapCabinets: async () => [cab(1, 'offline'), cab(2, 'offline')] }, user: {}, focus: {} } as unknown as ToolContext;
    const empty = (await tool().run(none, { state: 'co_loi' })) as Record<string, any>;
    expect(empty.so_tu_khop).toBe(0);
    expect(empty.ghi_chu).toBe('Không có tủ nào có lỗi. Hiện có: 2 tủ mất kết nối. Nói cả hai ý này.');
    expect(empty.theo_trang_thai).toEqual({ 'mất kết nối': 2 });
  });
});

describe('system prompt: which cabinets Jarvis may switch', () => {
  it('names the allowlist and says the others go through the web', async () => {
    const { systemPrompt } = await import('../src/brain/system-prompt');
    const user = { fullName: 'U', role: 'admin', scopeAll: true } as never;
    const p = systemPrompt(user, {}, new Date(), { allowlist: ['TL01.0009', 'TL01.0016'] });
    expect(p).toContain('Jarvis may switch ONLY these cabinets: TL01.0009, TL01.0016.');
    expect(p).toContain('CityLight web');
    expect(systemPrompt(user, {}, new Date())).not.toContain('switch ONLY');
  });
});
