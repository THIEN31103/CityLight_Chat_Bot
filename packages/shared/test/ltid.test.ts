import { describe, expect, it } from 'vitest';
import { canSeeLtid, scrubLtid, stripLtid } from '../src';

describe('LTID visibility', () => {
  it('only the provider role may see it', () => {
    expect(canSeeLtid('admin')).toBe(true);
    for (const r of ['manager', 'operator', 'viewer', 'maintenance'] as const) expect(canSeeLtid(r)).toBe(false);
    expect(canSeeLtid(undefined)).toBe(false);
  });

  it('blanks values in stored text', () => {
    expect(scrubLtid('LTID ABC123, IMEI 861000000000001')).toBe('LTID ***, IMEI 861000000000001');
    expect(scrubLtid('Frame mang LTID ZZZ4445 với IMEI 1 khác IMEI đã ghi nhận 2')).toBe('Frame mang LTID *** với IMEI 1 khác IMEI đã ghi nhận 2');
    expect(scrubLtid('Thiết bị LTID e2e_1-a ký sai')).toBe('Thiết bị LTID *** ký sai');
    expect(scrubLtid('LTID QWERT12')).toBe('LTID ***');
    expect(scrubLtid('{"ltid":"ABC123","code":"TM1"}')).toBe('{"ltid":"***","code":"TM1"}');
  });

  it('leaves sentences that only mention the word', () => {
    for (const s of ['Frame mang LTID của tủ với IMEI 1', 'Board thay thế phải có LTID mới', 'Firmware cũ không lọc LTID', 'Old firmware without LTID filter'])
      expect(scrubLtid(s)).toBe(s);
  });

  it('removes the field at any depth and does not touch the original', () => {
    const at = new Date(0);
    const row = { id: 'a', ltid: 'ABC123', at, nested: [{ LTID: 'x', note: 'LTID ABC123, IMEI 1' }], none: null };
    expect(stripLtid(row)).toEqual({ id: 'a', at, nested: [{ note: 'LTID ***, IMEI 1' }], none: null });
    expect(row.ltid).toBe('ABC123');
    expect(row.nested[0]!.note).toBe('LTID ABC123, IMEI 1');
  });

  it('passes non-plain values through', () => {
    const buf = Buffer.from('LTID ABC123');
    expect(stripLtid(buf)).toBe(buf);
    expect(stripLtid(undefined)).toBeUndefined();
  });
});
