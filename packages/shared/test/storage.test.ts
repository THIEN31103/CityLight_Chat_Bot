import { describe, expect, it } from 'vitest';
import { RAW_TELEMETRY_DAYS, RawSampler, STORAGE_POLICY, policyStatements, type RelationState } from '../src/storage';

const policy = (rel: string) => STORAGE_POLICY.find((p) => p.rel === rel)!;
const inLine = (rel: string): RelationState => ({ rel, compressionEnabled: true, chunkMatches: true, compressAfterMatches: true, dropAfterMatches: true });

describe('storage policy (S57)', () => {
  it('keeps raw telemetry 30 days, compressed after 6 h in 6 h chunks', () => {
    expect(policy('telemetry')).toMatchObject({ chunk: '6 hours', compressAfter: '6 hours', dropAfter: `${RAW_TELEMETRY_DAYS} days` });
    expect(RAW_TELEMETRY_DAYS).toBe(30);
  });

  it('nothing to do when the database already matches', () => {
    for (const p of STORAGE_POLICY) {
      const s = inLine(p.rel);
      if (!p.compressAfter) s.compressAfterMatches = null;
      if (!p.dropAfter) s.dropAfterMatches = null;
      expect(policyStatements(p, s)).toEqual([]);
    }
  });

  it('replaces a policy with another interval (remove, then add)', () => {
    const st = policyStatements(policy('telemetry'), { ...inLine('telemetry'), chunkMatches: false, compressAfterMatches: false, dropAfterMatches: false });
    expect(st).toEqual([
      "SELECT set_chunk_time_interval('telemetry', INTERVAL '6 hours')",
      "SELECT remove_compression_policy('telemetry', if_exists => true)",
      "SELECT add_compression_policy('telemetry', compress_after => INTERVAL '6 hours')",
      "SELECT remove_retention_policy('telemetry', if_exists => true)",
      "SELECT add_retention_policy('telemetry', drop_after => INTERVAL '30 days')",
    ]);
  });

  it('switches compression on first (hypertable with segmentby, aggregate with ALTER MATERIALIZED VIEW)', () => {
    const fresh = (rel: string): RelationState => ({ rel, compressionEnabled: false, chunkMatches: true, compressAfterMatches: null, dropAfterMatches: null });
    expect(policyStatements(policy('frames_raw'), fresh('frames_raw'))[0]).toBe(
      "ALTER TABLE frames_raw SET (timescaledb.compress, timescaledb.compress_segmentby = 'ltid', timescaledb.compress_orderby = 'ts DESC')",
    );
    expect(policyStatements(policy('telemetry_5m'), fresh('telemetry_5m'))).toEqual([
      'ALTER MATERIALIZED VIEW telemetry_5m SET (timescaledb.compress = true)',
      "SELECT add_compression_policy('telemetry_5m', compress_after => INTERVAL '7 days')",
      "SELECT add_retention_policy('telemetry_5m', drop_after => INTERVAL '400 days')",
    ]);
  });

  it('removes a retention policy when the relation is kept for good', () => {
    expect(policyStatements(policy('telemetry_1h'), { ...inLine('telemetry_1h'), dropAfterMatches: false })).toEqual([
      "SELECT remove_retention_policy('telemetry_1h', if_exists => true)",
    ]);
  });

  it('aggregates never get a chunk interval change', () => {
    expect(policyStatements(policy('telemetry_1h'), { ...inLine('telemetry_1h'), chunkMatches: false, dropAfterMatches: null })).toEqual([]);
  });
});

describe('RawSampler', () => {
  it('keeps one frame per LTID per period, every important frame, all when the period is 0', () => {
    const s = new RawSampler(10);
    const t0 = 1_000_000;
    expect(s.keep('A', t0, false)).toBe(true);
    expect(s.keep('A', t0 + 10_000, false)).toBe(false);
    expect(s.keep('B', t0 + 10_000, false)).toBe(true);
    expect(s.keep('A', t0 + 20_000, true)).toBe(true); // note / unknown cabinet: always kept
    expect(s.keep('A', t0 + 20_000 + 9 * 60_000, false)).toBe(false);
    expect(s.keep('A', t0 + 20_000 + 10 * 60_000, false)).toBe(true);
    const all = new RawSampler(0);
    expect([1, 2, 3].every((i) => all.keep('A', t0 + i, false))).toBe(true);
  });
});
