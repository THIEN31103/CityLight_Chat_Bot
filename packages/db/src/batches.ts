// Command batches (M6): DTO shared by apps/api and the command-worker (progress events).
import type postgres from 'postgres';
import type { CommandBatch } from '@citylight/shared';

type Sql = postgres.Sql;

/** requested_by of commands the scheduler sends on its own (no FK on commands.requested_by). */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
/** Redis channel: a schedule changed (zone / cabinet), the scheduler reconciles now. */
export const SCHEDULES_CHANNEL = 'cl:schedules';

interface Row {
  id: string; kind: CommandBatch['kind']; command_type: string | null; params: Record<string, unknown> | null; scope: string; total: number; requested_by: string; email: string | null;
  created_at: Date; finished_at: Date | null; ok: number; failed: number; offline: number; pending: number;
}

export async function selectBatches(sql: Sql, tail: postgres.PendingQuery<postgres.Row[]> | null = null): Promise<(CommandBatch & { requestedById: string })[]> {
  const rows = await sql<Row[]>`
    SELECT b.id, b.kind, b.command_type, b.params, b.scope, b.total, b.requested_by, u.email, b.created_at, b.finished_at,
           count(*) FILTER (WHERE i.result = 'ok')::int AS ok, count(*) FILTER (WHERE i.result = 'failed')::int AS failed,
           count(*) FILTER (WHERE i.result = 'offline')::int AS offline, count(*) FILTER (WHERE i.result = 'pending')::int AS pending
    FROM command_batches b LEFT JOIN command_batch_items i ON i.batch_id = b.id LEFT JOIN users u ON u.id = b.requested_by
    ${tail ?? sql`GROUP BY b.id, u.email ORDER BY b.created_at DESC`}`;
  return rows.map((r) => ({
    id: r.id, kind: r.kind,
    command: r.command_type ? { type: r.command_type as NonNullable<CommandBatch['command']>['type'], params: r.params ?? {} } : null,
    scope: r.scope, total: r.total, succeeded: r.ok, failed: r.failed, offline: r.offline, pending: r.pending,
    requestedBy: r.email ?? 'Hệ thống', requestedById: r.requested_by, createdAt: r.created_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
  }));
}

export async function batchById(sql: Sql, id: string) {
  return (await selectBatches(sql, sql`WHERE b.id = ${id} GROUP BY b.id, u.email`))[0] ?? null;
}
