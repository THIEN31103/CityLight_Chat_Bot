// Storage policy (S57): how long each time-series relation is kept and when it is compressed.
// Measured locally 2026-10-27 (200 cabinets x 1 day, 1 frame / 10 s): telemetry 222 -> 23 B/row (9.3x),
// frames_raw 496 -> 28 B/row (17.8x). Estimate for 1,000 cabinets: ~9 GB in steady state (was ~60 GB / year
// growing for good). packages/db applies it on every migrate (syncStoragePolicy); reports and charts read the
// constants so nothing asks for rows that are gone.

/** Raw telemetry (every frame) is kept this long; older data only exists as 5 min / 1 h / 1 day aggregates. */
export const RAW_TELEMETRY_DAYS = 30;
/** telemetry_5m is kept this long (the report range limit is 400 days too). */
export const TELEMETRY_5M_DAYS = 400;
/** frames_raw keeps 1 telemetry frame per cabinet per this many minutes (plus every other frame, see ingest). */
export const RAW_SAMPLE_MIN_DEFAULT = 10;

export interface RelationPolicy {
  rel: string;
  /** continuous aggregate (compression is switched on with ALTER MATERIALIZED VIEW) */
  cagg?: boolean;
  /** chunk interval for new chunks (hypertables only; existing chunks keep theirs) */
  chunk?: string;
  /** hypertables: compression settings when compression is not on yet */
  compress?: { segmentby: string; orderby: string };
  compressAfter?: string;
  /** undefined = kept for good */
  dropAfter?: string;
}

export const STORAGE_POLICY: RelationPolicy[] = [
  { rel: 'telemetry', chunk: '6 hours', compressAfter: '6 hours', dropAfter: `${RAW_TELEMETRY_DAYS} days` },
  { rel: 'frames_raw', chunk: '1 day', compress: { segmentby: 'ltid', orderby: 'ts DESC' }, compressAfter: '1 day', dropAfter: '7 days' },
  // compress_after / drop_after must stay beyond each aggregate's refresh start_offset (1 day / 3 days / 10 days)
  { rel: 'telemetry_5m', cagg: true, compressAfter: '7 days', dropAfter: `${TELEMETRY_5M_DAYS} days` },
  { rel: 'telemetry_1h', cagg: true, compressAfter: '30 days' },
  { rel: 'telemetry_1d', cagg: true },
];

/** What the database has now for one relation (intervals as Postgres prints them, compared in SQL by the caller). */
export interface RelationState {
  rel: string;
  compressionEnabled: boolean;
  chunkMatches: boolean;
  compressAfterMatches: boolean | null; // null = no compression policy
  dropAfterMatches: boolean | null; // null = no retention policy
}

/** Statements that bring one relation to its policy; empty when it already matches (idempotent). */
export function policyStatements(p: RelationPolicy, s: RelationState): string[] {
  const out: string[] = [];
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const rel = lit(p.rel);
  if (p.chunk && !p.cagg && !s.chunkMatches) out.push(`SELECT set_chunk_time_interval(${rel}, INTERVAL ${lit(p.chunk)})`);
  if (p.compressAfter && !s.compressionEnabled) {
    out.push(
      p.cagg
        ? `ALTER MATERIALIZED VIEW ${p.rel} SET (timescaledb.compress = true)`
        : `ALTER TABLE ${p.rel} SET (timescaledb.compress${p.compress ? `, timescaledb.compress_segmentby = ${lit(p.compress.segmentby)}, timescaledb.compress_orderby = ${lit(p.compress.orderby)}` : ''})`,
    );
  }
  if (p.compressAfter ? s.compressAfterMatches !== true : s.compressAfterMatches !== null) {
    if (s.compressAfterMatches !== null) out.push(`SELECT remove_compression_policy(${rel}, if_exists => true)`);
    if (p.compressAfter) out.push(`SELECT add_compression_policy(${rel}, compress_after => INTERVAL ${lit(p.compressAfter)})`);
  }
  if (p.dropAfter ? s.dropAfterMatches !== true : s.dropAfterMatches !== null) {
    if (s.dropAfterMatches !== null) out.push(`SELECT remove_retention_policy(${rel}, if_exists => true)`);
    if (p.dropAfter) out.push(`SELECT add_retention_policy(${rel}, drop_after => INTERVAL ${lit(p.dropAfter)})`);
  }
  return out;
}

/**
 * Keep this telemetry frame in frames_raw? Every frame with a note (parse error, dropped values, foreign IMEI)
 * and every frame of an unregistered LTID is kept; otherwise one per LTID per `everyMin` minutes (0 = all).
 */
export class RawSampler {
  private readonly last = new Map<string, number>();
  constructor(private readonly everyMin: number) {}
  keep(ltid: string, nowMs: number, important: boolean): boolean {
    if (this.everyMin <= 0) return true;
    const prev = this.last.get(ltid);
    if (!important && prev !== undefined && nowMs - prev < this.everyMin * 60_000) return false;
    this.last.set(ltid, nowMs);
    if (this.last.size > 50_000) this.last.clear(); // LTID flood: worst case a few extra samples
    return true;
  }
}
