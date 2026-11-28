import { describe, expect, it } from 'vitest';
import { READ_TOOLS, SPARE_TOOLS, viText } from '../src/tools/read';
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
  it('"đang có cảnh báo gì": one sentence with every group, worst first (user test 2026-11-28: 4 said, 3 read)', async () => {
    const a = (id: string, code: string, severity: string, cabinetCode: string, message: string) => ({ id, code, cabinetId: id, cabinetName: 'x', cabinetCode, districtName: 'Quận 1', type: 'x', severity, message, value: null, startedAt: '2026-11-25T08:31:00Z', endedAt: null, active: true, ackedBy: null, ackedAt: null });
    const items = [a('1', 'E203', 'major', 'TL07.0065', 'Mất kết nối CT_KEY'), a('2', 'E202', 'major', 'TL01.0052', 'Mất kết nối PM_KEY'), a('3', 'E204', 'critical', 'TL01.0039', 'Mất cả 3 slave RS485'), a('4', 'E201', 'critical', 'TL01.0026', 'Mất kết nối PLC_KEY')];
    const reads = { alarms: async () => ({ items, total: 4, page: 1, size: 100 }) };
    const tool = READ_TOOLS.find((t) => t.name === 'list_alarms')!;
    const out = (await tool.run({ reads, user: { id: 'alarm-sentence' }, focus: {}, userText: 'đang có cảnh báo gì' } as unknown as ToolContext, { active: true, limit: 10 })) as Record<string, any>;
    expect(out.cau_mau).toBe('4 cảnh báo đang mở (2 nghiêm trọng, 2 quan trọng): E204 Mất cả 3 slave RS485 (nghiêm trọng) ở tủ TL01.0039, Quận 1; E201 Mất kết nối PLC_KEY (nghiêm trọng) ở tủ TL01.0026, Quận 1; E203 Mất kết nối CT_KEY (quan trọng) ở tủ TL07.0065, Quận 1; E202 Mất kết nối PM_KEY (quan trọng) ở tủ TL01.0052, Quận 1.');
    const none = (await tool.run({ reads: { alarms: async () => ({ items: [], total: 0, page: 1, size: 100 }) }, user: { id: 'alarm-sentence' }, focus: {}, userText: 'có cảnh báo không' } as unknown as ToolContext, { active: true, limit: 10 })) as Record<string, any>;
    expect(none.cau_mau).toBe('Không có cảnh báo đang mở.');
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

describe('get_area_cabinets: user voice test 2 (2026-11-21)', () => {
  const tool = () => READ_TOOLS.find((t) => t.name === 'get_area_cabinets')!;
  const areas = [
    { id: 'td', name: 'TP Thủ Đức', kind: 'district', parentId: null }, { id: 'w', name: 'Phường An Khánh', kind: 'ward', parentId: 'td' },
    { id: 'q1', name: 'Quận 1', kind: 'district', parentId: null },
  ];
  const ctx = () => ({ reads: { areaTree: async () => ({ areas, unassigned: 0 }), areaCabinets: async () => [], mapCabinets: async () => Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, code: `TL01.${i}`, name: 'x', status: 'offline' })) }, user: { id: `u${Math.random()}` }, focus: {} }) as unknown as ToolContext;
  it('"khu đức" (misheard) is understood as TP Thủ Đức, and the answer says so', async () => {
    const out = (await tool().run(ctx(), { area: 'khu đức' })) as Record<string, any>;
    expect(out.khu_vuc).toBe('TP Thủ Đức');
    expect(out.ghi_chu_ten).toMatch(/hiểu là TP Thủ Đức/);
  });
  it('a name far from every area lists the districts', async () => {
    const out = (await tool().run(ctx(), { area: 'Hà Nội xa lắm' })) as Record<string, any>;
    expect(out.error).toBe('not_found');
    expect(out.cac_quan).toEqual(['TP Thủ Đức', 'Quận 1']);
  });
  it('39 cabinets asked: no schema maximum for Groq to refuse, at most 50 in code', async () => {
    expect(JSON.stringify(tool().schema)).not.toContain('maximum');
    const out = (await tool().run(ctx(), tool().input.parse({ state: 'mat_ket_noi', limit: 80 }) as never)) as Record<string, any>;
    expect(out.danh_sach).toHaveLength(50);
  });
});

describe('system prompt: allowed cabinets by area (2026-11-21: the model read "TL12" as "Quận 12")', () => {
  it('names the areas and warns that a code is not a district', async () => {
    const { systemPrompt } = await import('../src/brain/system-prompt');
    const user = { fullName: 'U', role: 'admin', scopeAll: true } as never;
    const p = systemPrompt(user, {}, new Date(), { allowlist: ['TL01.0009', 'TL12.0006'], allowedByArea: 'Quận 1: TL01.0009; TP Thủ Đức: 42 tủ, 3 đang kết nối' });
    expect(p).toContain('Jarvis may switch ONLY these cabinets: Quận 1: TL01.0009; TP Thủ Đức: 42 tủ, 3 đang kết nối.');
    expect(p).toContain('TL12 is not Quận 12');
  });
});

describe('find_schedule_mismatch (alarm E303, 2026-11-23)', () => {
  const cab = (i: number, status: string, districtId: string, wardId: string) => ({ id: `c${i}`, code: `TL01.${String(i).padStart(4, '0')}`, name: `Đường ${i}`, status, districtId, wardId });
  const cabinets = [cab(1, 'off', 'd1', 'w1'), cab(2, 'on', 'd1', 'w1'), cab(3, 'off', 'd2', 'w2'), cab(4, 'offline', 'd1', 'w1'), cab(5, 'offline', 'd2', 'w2'), cab(6, 'on', 'd1', 'w1')];
  const e303 = (i: number, message: string, startedAt: string) => ({
    id: `a${i}`, code: 'E303', cabinetId: `c${i}`, cabinetName: `Đường ${i}`, cabinetCode: `TL01.${String(i).padStart(4, '0')}`, districtName: i === 3 ? 'TP Thủ Đức' : 'Quận 1',
    type: 'schedule_mismatch', severity: 'major', message, value: null, startedAt, endedAt: null, active: true, ackedBy: null, ackedAt: null,
  });
  const alarms = [
    e303(1, 'nhánh 1 tắt trong lịch, nhánh 2 tắt trong lịch (lịch Chế độ 1)', '2026-11-23T11:30:00Z'),
    e303(2, 'nhánh 2 sáng ngoài lịch (lịch Chế độ 2)', '2026-11-23T03:00:00Z'),
    e303(3, 'nhánh 1 tắt trong lịch (lịch Chế độ 2)', '2026-11-23T11:40:00Z'),
    // another alarm type on a page the API should have filtered: never counted
    { ...e303(6, 'Mất kết nối PLC', '2026-11-23T10:00:00Z'), code: 'E201', type: 'plc_lost' },
  ];
  const areas = [{ id: 'd1', name: 'Quận 1', parentId: null, kind: 'district', cabinetCount: 4 }, { id: 'w1', name: 'Phường Bến Nghé', parentId: 'd1', kind: 'ward', cabinetCount: 4 }, { id: 'd2', name: 'TP Thủ Đức', parentId: null, kind: 'district', cabinetCount: 2 }, { id: 'w2', name: 'Phường Thảo Điền', parentId: 'd2', kind: 'ward', cabinetCount: 2 }];
  const asked: Record<string, unknown>[] = [];
  const ctx = () => ({
    reads: { mapCabinets: async () => cabinets, areaTree: async () => ({ areas, unassigned: 0 }), alarms: async (q: Record<string, unknown>) => { asked.push(q); return { items: alarms, total: alarms.length, page: 1, size: 200 }; } },
    user: {}, focus: {},
  }) as unknown as ToolContext;
  const tool = () => READ_TOOLS.find((t) => t.name === 'find_schedule_mismatch')!;

  it('whole system: both kinds, oldest first, offline cabinets counted as not checked', async () => {
    const out = (await tool().run(ctx(), {})) as Record<string, any>;
    expect(asked[0]).toMatchObject({ active: true, type: 'schedule_mismatch' });
    expect(out).toMatchObject({ khu_vuc: 'toàn hệ thống', lech_lich: 3, tat_trong_gio_lich: 2, sang_ngoai_gio_lich: 1, mat_ket_noi_khong_kiem_tra_duoc: 2, so_tu_kiem_tra: 4 });
    expect(out.danh_sach.map((r: any) => [r.code, r.lech])).toEqual([
      ['TL01.0002', 'nhánh 2 sáng ngoài giờ lịch'],
      ['TL01.0001', 'cả hai nhánh tắt trong giờ lịch'],
      ['TL01.0003', 'nhánh 1 tắt trong giờ lịch'],
    ]);
  });
  it('"lẽ ra phải sáng mà tắt" in one area: only that kind there', async () => {
    const out = (await tool().run(ctx(), { area: 'quận 1', kind: 'tat_trong_gio' })) as Record<string, any>;
    expect(out).toMatchObject({ khu_vuc: 'Quận 1', lech_lich: 2, so_tu_khop: 1, mat_ket_noi_khong_kiem_tra_duoc: 1 });
    expect(out.danh_sach.map((r: any) => r.code)).toEqual(['TL01.0001']);
  });
  it('none: says so plainly', async () => {
    const out = (await tool().run(ctx(), { area: 'Thủ Đức', kind: 'sang_ngoai_gio' })) as Record<string, any>;
    expect(out.so_tu_khop).toBe(0);
    expect(out.danh_sach).toEqual([]);
  });
});

describe('get_shift_report (2026-11-23)', () => {
  const cab = (i: number, status: string, districtId: string, wardId: string) => ({ id: `c${i}`, code: `TL01.${String(i).padStart(4, '0')}`, name: `Đường ${i}`, status, districtId, wardId });
  const cabinets = [cab(1, 'on', 'd1', 'w1'), cab(2, 'off', 'd1', 'w1'), cab(3, 'fault', 'd1', 'w1'), cab(4, 'offline', 'd1', 'w1'), cab(5, 'on', 'd2', 'w2'), cab(6, 'offline', 'd2', 'w2')];
  const alarm = (i: number, code: string, type: string, severity: string, startedAt: string) => ({
    id: `a${i}${code}`, code, cabinetId: `c${i}`, cabinetName: `Đường ${i}`, cabinetCode: `TL01.${String(i).padStart(4, '0')}`, districtName: i >= 5 ? 'TP Thủ Đức' : 'Quận 1',
    type, severity, message: 'x', value: null, startedAt, endedAt: null, active: true, ackedBy: null, ackedAt: null,
  });
  const alarms = [
    alarm(3, 'E201', 'plc_lost', 'major', '2026-11-23T10:00:00Z'), alarm(3, 'E301', 'leak_current', 'critical', '2026-11-23T09:00:00Z'),
    alarm(1, 'E303', 'schedule_mismatch', 'major', '2026-11-23T11:00:00Z'), alarm(5, 'E105', 'door_open', 'minor', '2026-11-23T08:00:00Z'),
  ];
  const incidents = [
    { id: 'i1', code: 'SC-1', cabinetId: 'c2', cabinetName: 'Đường 2', category: 'Đèn tắt', status: 'assigned', deadline: '2026-11-20T00:00:00Z' },
    { id: 'i2', code: 'SC-2', cabinetId: 'c3', cabinetName: 'Đường 3', category: 'Cháy bóng', status: 'new', deadline: '2099-01-01T00:00:00Z' },
    { id: 'i3', code: 'SC-3', cabinetId: 'c5', cabinetName: 'Đường 5', category: 'Nghiêng cột', status: 'assigned', deadline: '2026-11-21T00:00:00Z' },
  ];
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const cmd = (i: number, cabinet: number, type: string, on: boolean, status: string, h: number, batchId: string | null = null) => ({
    id: `m${i}`, cabinetId: `c${cabinet}`, cabinetName: `Đường ${cabinet}`, type, params: { on }, batchId, status, requestedBy: 'Nguyễn Văn A', queuedAt: ago(h), sentAt: null, ackedAt: null, confirmedAt: null, error: null,
  });
  // newest first, like the API
  const commands = [
    cmd(1, 1, 'MANUAL_ALL', true, 'confirmed', 1), cmd(2, 5, 'MANUAL_ALL', false, 'failed', 2), cmd(3, 2, 'AUTO', false, 'queued', 3),
    cmd(4, 1, 'SET_SCHEDULE', false, 'confirmed', 4), cmd(5, 3, 'MANUAL_ALL', true, 'confirmed', 5, 'b1'), cmd(6, 1, 'MANUAL_ALL', true, 'confirmed', 13),
  ];
  const batches = [
    { id: 'b0', kind: 'control', command: { type: 'AUTO', params: {} }, scope: 'x', total: 9, succeeded: 9, failed: 0, offline: 0, pending: 0, requestedBy: 'x', createdAt: ago(20), finishedAt: ago(20) },
    { id: 'b1', kind: 'control', command: { type: 'MANUAL_ALL', params: { on: true } }, scope: 'x', total: 4, succeeded: 3, failed: 1, offline: 0, pending: 0, requestedBy: 'x', createdAt: ago(5), finishedAt: ago(5) },
    { id: 'b2', kind: 'schedule', command: null, scope: 'x', total: 2, succeeded: 2, failed: 0, offline: 0, pending: 0, requestedBy: 'x', createdAt: ago(1), finishedAt: null },
  ];
  const areas = [{ id: 'd1', name: 'Quận 1', parentId: null, kind: 'district', cabinetCount: 4 }, { id: 'w1', name: 'Phường Bến Nghé', parentId: 'd1', kind: 'ward', cabinetCount: 4 }, { id: 'd2', name: 'TP Thủ Đức', parentId: null, kind: 'district', cabinetCount: 2 }, { id: 'w2', name: 'Phường Thảo Điền', parentId: 'd2', kind: 'ward', cabinetCount: 2 }];
  const ctx = (over: Record<string, unknown> = {}) => ({
    reads: {
      mapCabinets: async () => cabinets, areaTree: async () => ({ areas, unassigned: 0 }),
      alarms: async () => ({ items: alarms, total: alarms.length, page: 1, size: 100 }),
      incidents: async () => ({ items: incidents, total: incidents.length, page: 1, size: 100 }),
      commandLog: async () => ({ items: commands, total: commands.length, page: 1, size: 100 }),
      batches: async () => batches,
      ...over,
    },
    user: {}, focus: {},
  }) as unknown as ToolContext;
  const tool = () => READ_TOOLS.find((t) => t.name === 'get_shift_report')!;

  it('whole system: cabinets, alarms worst first, incidents overdue first, off schedule, busiest areas', async () => {
    const out = (await tool().run(ctx(), {})) as Record<string, any>;
    expect(out.tu).toEqual({ tong_so: 6, truc_tuyen: 4, mat_ket_noi: 2, dang_sang: 2, dang_tat: 1, dang_loi: 1 });
    expect(out.canh_bao).toMatchObject({ tong_so: 4, nghiem_trong: 1, quan_trong: 2, nhe: 1 });
    expect(out.canh_bao.nang_nhat.map((a: any) => a.code)).toEqual(['E301', 'E303', 'E201']);
    // a sentence the model reads out: it named one of the three, or none (tests 2026-11-24)
    expect(out.canh_bao.cau_mau).toBe('4 cảnh báo đang mở (1 nghiêm trọng, 2 quan trọng, 1 nhẹ); nặng nhất: E301 x ở tủ TL01.0003; E303 x ở tủ TL01.0001; E201 x ở tủ TL01.0003.');
    expect(out.su_co).toMatchObject({ dang_mo: 3, qua_han: 2 });
    expect(out.su_co.qua_han_lau_nhat.map((i: any) => i.code)).toEqual(['SC-1', 'SC-3']);
    expect(out.lech_lich).toEqual({ so_tu: 1, tu: ['TL01.0001'] });
    expect(out.khu_vuc_nhieu_canh_bao[0]).toEqual({ khu_vuc: 'Quận 1', so_canh_bao: 3 });
  });
  it('commands of the last 12 hours (no schedule sends, never who sent them) and control batches', async () => {
    const out = (await tool().run(ctx(), {})) as Record<string, any>;
    expect(out.lenh_12_gio).toMatchObject({ tong_so: 4, xong: 2, loi: 1, dang_cho: 1 });
    expect(out.lenh_12_gio.gan_nhat.map((c: any) => c.lenh)).toEqual(['Bật tay cả hai nhánh', 'Tắt tay cả hai nhánh', 'Trả về chạy theo lịch']);
    expect(JSON.stringify(out)).not.toContain('Nguyễn Văn A');
    expect(out.lo_lenh_12_gio).toMatchObject({ so_lo: 1, gan_nhat: [{ lenh: 'Bật tay cả hai nhánh', so_tu: 4, thanh_cong: 3, loi: 1, xong: 'đã xong' }] });
    expect(out.lenh_12_gio.cau_mau).toBe('12 giờ qua có 4 lệnh: 2 xong, 1 lỗi, 1 đang chờ.');
    expect(out.lo_lenh_12_gio.cau_mau).toMatch(/^1 lô lệnh nhiều tủ; gần nhất lúc .+: bật tay cả hai nhánh 4 tủ, 3 tủ đã nhận, 1 lỗi, 0 mất kết nối.$/);
    const area = (await tool().run(ctx(), { area: 'Thủ Đức' })) as Record<string, any>;
    expect(area.lenh_12_gio).toMatchObject({ tong_so: 1, loi: 1 });
    expect(area.lo_lenh_12_gio).toBeUndefined();
  });
  it('cabinets left in manual mode: only online ones are read, one that cannot be read is said (2026-11-25)', async () => {
    const asked: string[] = [];
    const cabinet = async (id: string) => {
      asked.push(id);
      if (id === 'c3') throw new Error('down');
      return { state: { manualMode: id === 'c1' || id === 'c5' } };
    };
    const out = (await tool().run(ctx({ cabinet }), {})) as Record<string, any>;
    expect(asked.sort()).toEqual(['c1', 'c2', 'c3', 'c5']);
    expect(out.chay_tay).toMatchObject({ so_tu: 2, tu: ['TL01.0001', 'TL01.0005'], ghi_chu: '1 tủ không đọc được trạng thái.' });
    expect(out.chay_tay.cau_mau).toBe('2 tủ đang chạy tay (sẽ tự về lịch ở mốc bật / tắt kế tiếp): TL01.0001, TL01.0005.');
    const area = (await tool().run(ctx({ cabinet }), { area: 'Thủ Đức' })) as Record<string, any>;
    expect(area.chay_tay).toMatchObject({ so_tu: 1, tu: ['TL01.0005'] });
  });
  it('a role without the command log: that part says so', async () => {
    const { ApiProblem } = await import('../src/api/client');
    const out = (await tool().run(ctx({ commandLog: async () => { throw new ApiProblem(403, 'forbidden', 'x'); } }), {})) as Record<string, any>;
    expect(out.lenh_12_gio).toBe('không có quyền xem nhật ký lệnh');
    expect(out.tu.tong_so).toBe(6);
  });
  it('one area: only its cabinets, alarms and incidents', async () => {
    const out = (await tool().run(ctx(), { area: 'Thủ Đức' })) as Record<string, any>;
    expect(out.khu_vuc).toBe('TP Thủ Đức');
    expect(out.tu).toMatchObject({ tong_so: 2, mat_ket_noi: 1 });
    expect(out.canh_bao).toMatchObject({ tong_so: 1, nhe: 1 });
    expect(out.su_co).toMatchObject({ dang_mo: 1, qua_han: 1 });
    expect(out.lech_lich).toMatchObject({ so_tu: 0 });
    expect(out.khu_vuc_nhieu_canh_bao).toBeUndefined();
  });
  it('the whole report in sentences, first in the result, so a cut result still has it (user test 2026-11-28)', async () => {
    const { shrink } = await import('../src/tools/registry');
    const out = (await tool().run(ctx(), {})) as Record<string, any>;
    expect(Object.keys(out).slice(0, 3)).toEqual(['khu_vuc', 'ban_tin', 'ghi_chu']);
    const lines = out.ban_tin.split('\n');
    expect(lines[0]).toBe('Bản tin đầu ca toàn hệ thống:');
    expect(lines[1]).toBe('- 6 tủ: 4 trực tuyến, 2 mất kết nối, 2 đang sáng, 1 đang tắt, 1 có lỗi.');
    expect(out.ban_tin).toContain(`- ${out.canh_bao.cau_mau}`);
    expect(out.ban_tin).toContain('- 3 sự cố đang mở, 2 quá hạn (lâu nhất: SC-1 ở tủ Đường 2');
    expect(out.ban_tin).toContain('- 1 tủ lệch lịch: TL01.0001.');
    expect(out.ban_tin).toContain(`- ${out.lenh_12_gio.cau_mau}`);
    expect(out.ban_tin).toContain(`- ${out.lo_lenh_12_gio.cau_mau}`);
    expect(out.ban_tin).toContain('- Khu vực nhiều cảnh báo nhất: Quận 1 (3), TP Thủ Đức (1).');
    expect(JSON.stringify(shrink(out, 1200))).toContain('Bản tin đầu ca toàn hệ thống:');
    const area = (await tool().run(ctx(), { area: 'Thủ Đức' })) as Record<string, any>;
    expect(area.ban_tin).toMatch(/^Bản tin đầu ca TP Thủ Đức:\n/);
    expect(area.ban_tin).not.toContain('Khu vực nhiều cảnh báo nhất');
  });
  it('"phường thảo điền thủ đức": a district named without "TP" after the ward (user test 2026-11-28)', async () => {
    const out = (await tool().run(ctx(), { area: 'phường thảo điền thủ đức' })) as Record<string, any>;
    expect(out.khu_vuc).toBe('Phường Thảo Điền (TP Thủ Đức)');
  });
  it('a role without the right to incidents: that part says so, the rest is still there', async () => {
    const { ApiProblem } = await import('../src/api/client');
    const out = (await tool().run(ctx({ incidents: async () => { throw new ApiProblem(403, 'forbidden', 'x'); } }), {})) as Record<string, any>;
    expect(out.su_co).toBe('không có quyền xem sự cố');
    expect(out.canh_bao.tong_so).toBe(4);
  });
});

describe('area names said in a shift report (user test 2026-11-23)', () => {
  // two "Phường 2" in two districts, and no Quận 2
  const areas = [
    { id: 'd1', name: 'Quận 1', parentId: null, kind: 'district', cabinetCount: 2 }, { id: 'd3', name: 'Quận 3', parentId: null, kind: 'district', cabinetCount: 2 },
    { id: 'w12', name: 'Phường 2', parentId: 'd1', kind: 'ward', cabinetCount: 1 }, { id: 'w32', name: 'Phường 2', parentId: 'd3', kind: 'ward', cabinetCount: 1 },
    { id: 'w312', name: 'Phường 12', parentId: 'd3', kind: 'ward', cabinetCount: 0 }, { id: 'w324', name: 'Phường 24', parentId: 'd3', kind: 'ward', cabinetCount: 0 },
  ];
  const cabinets = [{ id: 'c1', code: 'TL01.0001', name: 'A 1', status: 'on', districtId: 'd1', wardId: 'w12' }, { id: 'c2', code: 'TL03.0001', name: 'B 1', status: 'off', districtId: 'd3', wardId: 'w32' }];
  const ctx = () => ({
    reads: { mapCabinets: async () => cabinets, areaTree: async () => ({ areas, unassigned: 0 }), alarms: async () => ({ items: [], total: 0, page: 1, size: 100 }), incidents: async () => ({ items: [], total: 0, page: 1, size: 100 }) },
    // its own user: the area tree is cached a minute per user, another test's tree must not be reused
    user: { id: 'area-names-test' }, focus: {},
  }) as unknown as ToolContext;
  const run = (area: string) => READ_TOOLS.find((t) => t.name === 'get_shift_report')!.run(ctx(), { area }) as Promise<Record<string, any>>;

  it('"Quận 2" does not exist: said so with the real districts, not a list of Phường 2 … Phường 24', async () => {
    const out = await run('Quận 2');
    expect(out.error).toBe('not_found');
    expect(out.message).toContain('Không có "Quận 2"');
    expect(out.cac_quan).toEqual(['Quận 1', 'Quận 3']);
  });
  it('"Phường 2" in two districts: the choices carry their district', async () => {
    const out = await run('Phường 2');
    expect(out.error).toBe('ambiguous');
    expect(out.choices).toEqual(['Phường 2 (Quận 1)', 'Phường 2 (Quận 3)']);
    // the question is built here, its example one of the choices (the model said "Quận 9", user test 2026-11-28)
    expect(out.cau_hoi).toBe('Có 2 khu vực tên "Phường 2": Phường 2 (Quận 1), Phường 2 (Quận 3). Bạn muốn khu vực nào? Ví dụ trả lời "Phường 2 Quận 1".');
  });
  it.each(['phường 2 quận 3', 'Phường 2, Quận 3', 'phường 2 của quận 3', 'Phường 2 (Quận 3)'])('"%s" is that ward', async (q) => {
    const out = await run(q);
    expect(out.khu_vuc).toBe('Phường 2 (Quận 3)');
    expect(out.tu.tong_so).toBe(1);
  });
  it('"phường 2 quận 2": no such district, said plainly', async () => {
    const out = await run('phường 2 quận 2');
    expect(out.error).toBe('not_found');
    expect(out.cac_quan).toEqual(['Quận 1', 'Quận 3']);
  });
  it('"Quận 1" is still the district', async () => {
    expect((await run('Quận 1')).khu_vuc).toBe('Quận 1');
  });
});

describe('leakReport (2026-11-23)', () => {
  const pt = (h: number, leak: number, kw: number) => ({ ts: new Date(Date.UTC(2026, 10, 23, h)).toISOString(), leakMa: leak, pTotalKw: kw });
  const detail = (over: Record<string, unknown> = {}) => ({ thresholds: { leakMa: { enabled: true, value: 30 } }, state: { branch1On: true, branch2On: true, iL1: 3 }, ...over });

  it('rising leakage over the cabinet threshold: counted, first and last time, the trend', async () => {
    const { leakReport } = await import('../src/tools/read');
    const points = [pt(0, 5, 0), pt(1, 6, 0), pt(2, 6, 0), pt(10, 12, 2), pt(11, 20, 2), pt(12, 25, 2), pt(18, 31, 2), pt(19, 35, 2), pt(20, 40, 2)];
    const r = leakReport(points, detail(), 0.5);
    expect(r).toMatchObject({ nguong_mA: 30, cao_nhat_mA: 40, so_lan_vuot_nguong: 3 });
    expect(r.xu_huong).toMatch(/^tăng dần/);
    expect(r.ro_trung_binh).toEqual({ khi_den_sang_mA: 27.2, khi_den_tat_mA: 5.7 });
    expect(r.dong_khi_tat).toBeUndefined();
  });
  it('steady and under the threshold: nothing over, "ổn định"', async () => {
    const { leakReport } = await import('../src/tools/read');
    const r = leakReport([0, 1, 2, 3, 4, 5].map((h) => pt(h, 8, 2)), detail(), 0.5);
    expect(r).toMatchObject({ so_lan_vuot_nguong: 0, xu_huong: 'ổn định' });
  });
  it('both branches off but a current flows now: says to check the contactor', async () => {
    const { leakReport } = await import('../src/tools/read');
    const r = leakReport([pt(0, 4, 0)], detail({ state: { branch1On: false, branch2On: false, iL1: 2.4, iL2: 0 } }), 0.5);
    expect(r.dong_khi_tat).toMatch(/^Cả hai nhánh đang tắt nhưng vẫn có dòng 2.4 A/);
  });
  it('no threshold set, no data: said, not guessed', async () => {
    const { leakReport } = await import('../src/tools/read');
    const r = leakReport([], { thresholds: { leakMa: { enabled: false, value: 30 } } }, 0.5);
    expect(r).toMatchObject({ nguong_mA: 'tủ chưa đặt ngưỡng rò', du_lieu: 'không có số đo dòng rò trong khoảng thời gian này' });
  });
});

describe('get_cabinet_interventions (2026-11-23)', () => {
  const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const cab = { id: 'c1', code: 'TL01.0009', name: 'Lý Thường Kiệt 9', status: 'on' };
  const commands = [
    { id: 'k1', type: 'MANUAL_ALL', params: { on: true }, status: 'confirmed', queuedAt: day(1), requestedBy: 'secret-user' },
    { id: 'k2', type: 'MANUAL_BRANCH', params: { on: false, branch: 1 }, status: 'failed', queuedAt: day(3), requestedBy: 'secret-user' },
    { id: 'k3', type: 'MANUAL_ALL', params: { on: true }, status: 'confirmed', queuedAt: day(10), requestedBy: 'secret-user' },
    { id: 'k4', type: 'AUTO', params: {}, status: 'confirmed', queuedAt: day(45), requestedBy: 'secret-user' },
  ];
  const alarms = [
    { id: 'a1', code: 'E201', message: 'Mất kết nối PLC', startedAt: day(2), active: true, ackedBy: 'secret-user' },
    { id: 'a2', code: 'E201', message: 'Mất kết nối PLC', startedAt: day(20), active: false },
    { id: 'a3', code: 'E301', message: 'Dòng rò cao', startedAt: day(40), active: false },
  ];
  const incidents = [{ id: 'i1', code: 'SC-1', cabinetId: 'c1', category: 'Đèn tắt', status: 'resolved', reportedAt: day(5), assignee: 'secret-user', reportedBy: 'secret-user' }, { id: 'i2', code: 'SC-9', cabinetId: 'other', category: 'x', status: 'new', reportedAt: day(1) }];
  const ctx = () => ({
    reads: {
      search: async () => [cab], cabinetCommands: async () => commands, cabinetAlarms: async () => alarms,
      incidents: async () => ({ items: incidents, total: 2, page: 1, size: 100 }),
    },
    user: { id: 'interventions-test' }, focus: {},
  }) as unknown as ToolContext;
  const tool = () => READ_TOOLS.find((t) => t.name === 'get_cabinet_interventions')!;

  it('30 days: commands by kind with failures, alarms by code with the open ones, this cabinet\'s incidents; never who', async () => {
    const out = (await tool().run(ctx(), { cabinet: 'TL01.0009', days: 30 })) as Record<string, any>;
    expect(out.lenh).toMatchObject({ tong_so: 3, that_bai: 1, theo_loai: { 'Bật tay cả hai nhánh': 2, 'Tắt tay nhánh 1': 1 } });
    expect(out.canh_bao).toMatchObject({ tong_so: 2, theo_ma: { 'E201 Mất kết nối PLC': 2 }, dang_mo: ['E201'] });
    expect(out.su_co.map((i: any) => i.code)).toEqual(['SC-1']);
    expect(JSON.stringify(out)).not.toContain('secret-user');
  });
  it('90 days takes the older ones too', async () => {
    const out = (await tool().run(ctx(), { cabinet: 'TL01.0009', days: 90 })) as Record<string, any>;
    expect(out.lenh.tong_so).toBe(4);
    expect(out.canh_bao.tong_so).toBe(3);
  });
});

describe('get_alarm_trends (2026-11-23)', () => {
  const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const a = (i: number, code: string, district: string, cabinetId: string, start: number, end: number | null) => ({
    id: `t${i}`, code, cabinetId, cabinetCode: `TL.${cabinetId}`, cabinetName: cabinetId, districtName: district, type: 'x', severity: 'major', message: code === 'E201' ? 'Mất kết nối PLC' : 'Cửa tủ mở',
    value: null, startedAt: ago(start), endedAt: end === null ? null : ago(end), active: end === null, ackedBy: null, ackedAt: null,
  });
  const alarms = [
    a(1, 'E201', 'Quận 1', 'c1', 1, null), a(2, 'E201', 'Quận 1', 'c1', 2, 1.9), a(3, 'E201', 'Quận 1', 'c2', 3, 2.5), a(4, 'E105', 'Quận 3', 'c3', 4, 3.9),
    a(5, 'E105', 'Quận 1', 'c2', 9, 8), a(6, 'E201', 'Quận 3', 'c3', 20, 19), a(7, 'E201', 'Quận 3', 'c3', 40, 39),
  ];
  const areas = [{ id: 'd1', name: 'Quận 1', parentId: null, kind: 'district', cabinetCount: 2 }, { id: 'w1', name: 'Phường Bến Nghé', parentId: 'd1', kind: 'ward', cabinetCount: 1 }, { id: 'w2', name: 'Phường Đa Kao', parentId: 'd1', kind: 'ward', cabinetCount: 1 }, { id: 'd3', name: 'Quận 3', parentId: null, kind: 'district', cabinetCount: 1 }];
  const cabinets = [{ id: 'c1', code: 'TL.c1', districtId: 'd1', wardId: 'w1', status: 'on' }, { id: 'c2', code: 'TL.c2', districtId: 'd1', wardId: 'w2', status: 'on' }, { id: 'c3', code: 'TL.c3', districtId: 'd3', wardId: null, status: 'on' }];
  const asked: Record<string, unknown>[] = [];
  const ctx = () => ({
    reads: { alarms: async (q: Record<string, unknown>) => { asked.push(q); return { items: alarms, total: alarms.length, page: 1, size: 100 }; }, areaTree: async () => ({ areas, unassigned: 0 }), mapCabinets: async () => cabinets },
    user: { id: 'trends-test' }, focus: {},
  }) as unknown as ToolContext;
  const tool = () => READ_TOOLS.find((t) => t.name === 'get_alarm_trends')!;

  it('30 days, whole system: by district and code, last 7 against the 7 before, still open', async () => {
    const out = (await tool().run(ctx(), { days: 30 })) as Record<string, any>;
    expect(typeof asked[0]!.from).toBe('string');
    expect(out.tong_so_canh_bao).toBe(6);
    expect(out.nhieu_nhat_theo_khu_vuc[0]).toEqual({ ten: 'Quận 1', so: 4 });
    expect(out.nhieu_nhat_theo_ma[0]).toEqual({ ten: 'E201 Mất kết nối PLC', so: 4 });
    expect(out.bay_ngay_qua_so_voi_bay_ngay_truoc).toEqual({ bay_ngay_qua: 4, bay_ngay_truoc: 1, xu_huong: 'tăng' });
    expect(out.con_mo).toBe(1);
  });
  it('one district: by ward', async () => {
    const out = (await tool().run(ctx(), { area: 'Quận 1', days: 30 })) as Record<string, any>;
    expect(out.khu_vuc).toBe('Quận 1');
    expect(out.tong_so_canh_bao).toBe(4);
    expect(out.nhieu_nhat_theo_khu_vuc).toEqual([{ ten: 'Phường Bến Nghé', so: 2 }, { ten: 'Phường Đa Kao', so: 2 }]);
  });
});

describe('alarmLabel: an alarm said to a person (test 2026-11-24)', () => {
  it('the title from the rules, then the detail without the raw device fields', async () => {
    const { alarmLabel } = await import('../src/tools/read');
    const titles = new Map([['E202', 'Mất kết nối PM_KEY'], ['E405', 'Lệch tải giữa các pha'], ['E201', 'Mất kết nối PLC_KEY']]);
    expect(alarmLabel({ code: 'E202', message: 'LCLI=2, MCON=0: LTE không đọc được PM_KEY' }, titles)).toBe('E202 Mất kết nối PM_KEY (LTE không đọc được PM_KEY)');
    expect(alarmLabel({ code: 'E405', message: 'Dòng L1 19,9 · L2 22 · L3 14,6 A, lệch 34 %' }, titles)).toBe('E405 Lệch tải giữa các pha (Dòng L1 19,9 · L2 22 · L3 14,6 A, lệch 34 %)');
    expect(alarmLabel({ code: 'E201', message: 'Mất kết nối PLC_KEY' }, titles)).toBe('E201 Mất kết nối PLC_KEY');
    // no rules (no right, server down): the message as before, still without the raw fields
    expect(alarmLabel({ code: 'E202', message: 'LCLI=2, MCON=0: LTE không đọc được PM_KEY' })).toBe('E202 LTE không đọc được PM_KEY');
    expect(alarmLabel({ code: 'E101', message: 'Mất dữ liệu telemetry' })).toBe('E101 Mất dữ liệu đo');
  });
});

describe('find_cabinets by a cabinet name that does not exist (user test 2026-11-28)', () => {
  const tool = () => SPARE_TOOLS.find((t) => t.name === 'find_cabinets')!;
  const cab = (code: string, name: string) => ({ id: code, code, name, status: 'on' });
  const search = async (q: string) => (q === 'Hoàng Diệu' ? [cab('TL01.0031', 'Hoàng Diệu 1'), cab('TL01.0033', 'Hoàng Diệu 3')] : []);
  const ctx = () => ({ reads: { search }, user: { id: 'find-street' }, focus: {} }) as unknown as ToolContext;
  it('"Hoàng Diệu 2": none of that name, the cabinets of that street instead', async () => {
    const out = (await tool().run(ctx(), { query: 'Hoàng Diệu 2' })) as Record<string, any>;
    expect(out.cau_mau).toBe('Không có tủ tên "Hoàng Diệu 2". Trên đường Hoàng Diệu có 2 tủ: Hoàng Diệu 1 (TL01.0031), Hoàng Diệu 3 (TL01.0033).');
  });
  it('a street with no cabinet at all: plain not found', async () => {
    const out = (await tool().run(ctx(), { query: 'Pasteur 4' })) as Record<string, any>;
    expect(out.error).toBe('not_found');
    expect(out.cau_mau).toBeUndefined();
  });
});

describe('get_cabinet says it in one sentence (user test 2026-11-28)', () => {
  const tool = () => READ_TOOLS.find((t) => t.name === 'get_cabinet')!;
  const reads = (alarms: unknown[], diagItems: unknown[] | null) => ({
    search: async () => [{ id: 'c9', code: 'TL01.0009', name: 'Lý Thường Kiệt 9', status: 'off' }],
    cabinet: async () => ({ cabinet: { code: 'TL01.0009', name: 'Lý Thường Kiệt 9' }, state: { status: 'off', online: true, branch1On: false, branch2On: false, manualMode: false } }),
    diagnostics: async () => (diagItems ? { items: diagItems } : Promise.reject(new Error('x'))),
    cabinetAlarms: async () => alarms,
  });
  const ctx = (r: unknown) => ({ reads: r, user: { id: 'cab-sentence' }, focus: {} }) as unknown as ToolContext;
  it('no alarm said once, and the diagnosis is in it', async () => {
    const out = (await tool().run(ctx(reads([], [{ subsystem: 'PLC', status: 'ok' }, { subsystem: 'PM', status: 'ok' }])), { cabinet: 'TL01.0009' })) as Record<string, any>;
    expect(out.cau_mau).toBe('Tủ TL01.0009 (Lý Thường Kiệt 9) trực tuyến, cả hai nhánh đang tắt, chạy theo lịch. Không có cảnh báo đang mở. Chẩn đoán bình thường cả 2 mục.');
  });
  it('open alarms named with their level', async () => {
    const a = { id: 'a', code: 'E201', severity: 'major', message: 'Mất kết nối PLC_KEY', startedAt: '2026-11-25T08:31:00Z', active: true };
    const out = (await tool().run(ctx(reads([a], null)), { cabinet: 'TL01.0009' })) as Record<string, any>;
    expect(out.cau_mau).toContain('1 cảnh báo đang mở: E201 Mất kết nối PLC_KEY (quan trọng). Chưa đọc được kết quả chẩn đoán.');
  });
});
