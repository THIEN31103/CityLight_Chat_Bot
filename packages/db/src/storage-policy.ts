// Applies STORAGE_POLICY (S57, packages/shared/src/storage.ts) to the live database: chunk interval, compression
// and retention of the telemetry hypertables and aggregates. Idempotent: compares with timescaledb_information
// and only changes what differs, so every `migrate` (local and VPS deploy) can run it.
import type postgres from 'postgres';
import { STORAGE_POLICY, policyStatements, type RelationPolicy, type RelationState } from '@citylight/shared';

async function stateOf(sql: postgres.Sql, p: RelationPolicy): Promise<RelationState> {
  const [r] = await sql<{ compression: boolean | null; chunk_ok: boolean | null; compress_ok: boolean | null; drop_ok: boolean | null }[]>`
    SELECT
      CASE WHEN ${!!p.cagg}
        THEN (SELECT compression_enabled FROM timescaledb_information.continuous_aggregates WHERE view_name = ${p.rel})
        ELSE (SELECT compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_name = ${p.rel}) END AS compression,
      (SELECT time_interval = ${p.chunk ?? '0'}::interval FROM timescaledb_information.dimensions WHERE hypertable_name = ${p.rel} LIMIT 1) AS chunk_ok,
      (SELECT (config->>'compress_after')::interval = ${p.compressAfter ?? '0'}::interval FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_compression' AND hypertable_name = ${p.rel} LIMIT 1) AS compress_ok,
      (SELECT (config->>'drop_after')::interval = ${p.dropAfter ?? '0'}::interval FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_retention' AND hypertable_name = ${p.rel} LIMIT 1) AS drop_ok`;
  if (r?.compression === null || r?.compression === undefined) throw new Error(`storage policy: ${p.rel} is not a hypertable / continuous aggregate`);
  return { rel: p.rel, compressionEnabled: r.compression, chunkMatches: r.chunk_ok !== false, compressAfterMatches: r.compress_ok, dropAfterMatches: r.drop_ok };
}

/** Returns the statements it ran (empty = already in line). */
export async function syncStoragePolicy(sql: postgres.Sql): Promise<string[]> {
  const ran: string[] = [];
  for (const p of STORAGE_POLICY) {
    for (const st of policyStatements(p, await stateOf(sql, p))) {
      await sql.unsafe(st);
      ran.push(st);
    }
  }
  return ran;
}
