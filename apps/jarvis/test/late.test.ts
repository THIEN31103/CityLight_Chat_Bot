// Commands Jarvis stopped following (60 s) are told when they end (spec 7 P1), at most 15 minutes later.
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../src/api/client';
import type { CityLightReads } from '../src/api/read';
import { LATE_MS, LateResults } from '../src/console/late';
import { sendAndFollow, type PendingAction } from '../src/guard/pending';
import { outcomeText } from '../src/guard/propose';

const T0 = Date.parse('2026-11-24T12:00:00Z');
const one = { id: 'jv-1', command: { type: 'MANUAL_ALL', params: { on: true } }, cabinet: { id: 'c1', code: 'TL01.0009', name: 'Lý Thường Kiệt 9' }, summary: 'Bật tay cả hai nhánh đèn tủ TL01.0009', tier: 'T1', createdAt: T0, expiresAt: T0 + 60_000 } as unknown as PendingAction;
const lot = { ...one, id: 'jv-2', tier: 'T3', summary: 'Bật tay đèn 40 tủ ở Quận 1', batch: { area: 'Quận 1', codes: ['A'], total: 40, offline: 0, skipped: 0 } } as unknown as PendingAction;

describe('sendAndFollow says when it stopped before the end', () => {
  it('a command still "sent" after the follow time is unfinished; one that ended is not', async () => {
    const api = (status: string) => ({ post: async () => ({ id: 'cmd-1', status: 'sent' }), get: async () => ({ id: 'cmd-1', status }) }) as unknown as ApiClient;
    const cut = await sendAndFollow(api('sent'), one, { followMs: 30, pollMs: 10 });
    expect(cut).toMatchObject({ status: 'timeout', commandId: 'cmd-1', unfinished: true });
    expect(outcomeText(one, cut)).toMatch(/Có kết quả trong 15 phút tới thì tôi báo lại\.$/);
    // one promise, not two ("theo dõi trên web" next to "tôi báo lại", test 2026-11-25)
    expect(outcomeText(one, cut)).not.toMatch(/web CityLight/);
    const ended = await sendAndFollow(api('timeout'), one, { followMs: 30, pollMs: 10 });
    expect(ended.unfinished).toBeUndefined();
    expect(outcomeText(one, ended)).not.toMatch(/báo lại/);
  });
});

describe('LateResults', () => {
  const reads = (status: string, error: string | null = null) => ({ command: async () => ({ id: 'cmd-1', status, error }) }) as unknown as CityLightReads;
  const api = (b: Record<string, unknown> | null) => ({ get: async () => { if (!b) throw new Error('down'); return b; } }) as unknown as ApiClient;

  it('a command: nothing while it travels, then its result once, with the time it was sent', async () => {
    const late = new LateResults();
    late.add('cmd-1', one, T0);
    expect(await late.check(api(null), reads('acked'), T0 + 70_000)).toEqual([]);
    expect(late.has('cmd-1')).toBe(true);
    const said = await late.check(api(null), reads('confirmed'), T0 + 90_000);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^Kết quả lệnh "Bật tay cả hai nhánh đèn tủ TL01\.0009" gửi lúc .+: Đã xác nhận: tủ TL01\.0009 đã bật cả hai nhánh \(chạy tay\)\.$/);
    expect(late.size).toBe(0);
    expect(await late.check(api(null), reads('confirmed'), T0 + 95_000)).toEqual([]);
  });

  it('failed with the reason; the server timing it out is said plainly', async () => {
    const a = new LateResults();
    a.add('cmd-1', one, T0);
    expect((await a.check(api(null), reads('failed', 'Tủ mất kết nối'), T0 + 1000))[0]).toMatch(/Lệnh tới tủ TL01\.0009 thất bại: Tủ mất kết nối\.$/);
    const b = new LateResults();
    b.add('cmd-1', one, T0);
    expect((await b.check(api(null), reads('timeout'), T0 + 1000))[0]).toMatch(/Tủ TL01\.0009 không phản hồi, máy chủ đã dừng lệnh\.$/);
  });

  it('a batch: told when finished, with its counts', async () => {
    const late = new LateResults();
    late.add('batch-9', lot, T0);
    expect(await late.check(api({ id: 'batch-9', total: 40, succeeded: 30, failed: 0, offline: 2, pending: 8, finishedAt: null }), reads('sent'), T0 + 1000)).toEqual([]);
    const said = await late.check(api({ id: 'batch-9', total: 40, succeeded: 37, failed: 1, offline: 2, pending: 0, finishedAt: new Date(T0).toISOString() }), reads('sent'), T0 + 2000);
    expect(said[0]).toMatch(/Lệnh nhiều tủ ở Quận 1: 37 tủ đã nhận, 1 lỗi, 2 mất kết nối\.$/);
  });

  it('given up after 15 minutes, nothing said', async () => {
    const late = new LateResults();
    late.add('cmd-1', one, T0);
    expect(await late.check(api(null), reads('confirmed'), T0 + LATE_MS + 1)).toEqual([]);
    expect(late.size).toBe(0);
  });
});
