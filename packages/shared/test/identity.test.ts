import { describe, expect, it } from 'vitest';
import { FrameBudget, checkImei, normImei, shortUserAgent } from '../src';

const A = '861553070006339';
const B = '861234567890123';

describe('checkImei', () => {
  it('learns the first IMEI, then requires it', () => {
    expect(checkImei(null, A)).toBe('learn');
    expect(checkImei(null, null)).toBe('ok');
    expect(checkImei(A, A)).toBe('ok');
    expect(checkImei(A, B)).toBe('mismatch');
  });
  it('a missing or junk IMEI is a mismatch once one is registered (a spoofer would omit it)', () => {
    expect(checkImei(A, null)).toBe('mismatch');
    expect(checkImei(A, 'X')).toBe('mismatch');
    expect(checkImei(A, '12')).toBe('mismatch');
    expect(checkImei(null, 'X')).toBe('ok');
  });
  it('normalises', () => {
    expect(normImei(` ${A} `)).toBe(A);
    expect(normImei('86155307000633x')).toBeNull();
  });
});

describe('FrameBudget', () => {
  it('lets a burst through, then one per second', () => {
    const b = new FrameBudget(5, 1);
    const t = 1_000_000;
    const first = Array.from({ length: 8 }, () => b.take('CTY1', t));
    expect(first.filter(Boolean)).toHaveLength(5);
    expect(b.take('CTY1', t + 500)).toBe(false);
    expect(b.take('CTY1', t + 1000)).toBe(true);
    expect(b.take('CTY2', t)).toBe(true); // per key
  });
  it('never throttles the firmware rhythm (>= 1 s apart)', () => {
    const b = new FrameBudget(5, 1);
    for (let i = 0; i < 100; i++) expect(b.take('CTY1', 1000 * i)).toBe(true);
  });
  it('keeps memory bounded under random keys', () => {
    const b = new FrameBudget(5, 1, 100);
    for (let i = 0; i < 1000; i++) b.take(`R${i}`, i * 10_000);
    expect((b as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(100);
  });
});

describe('shortUserAgent', () => {
  it('names browser and OS without versions', () => {
    expect(shortUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36')).toBe('Chrome / Android');
    expect(shortUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari / iOS');
    expect(shortUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0')).toBe('Edge / Windows');
    expect(shortUserAgent('curl/8.5.0')).toBe('công cụ dòng lệnh');
    expect(shortUserAgent(null)).toBe('không rõ trình duyệt');
  });
});
