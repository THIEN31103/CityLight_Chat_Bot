// Command rows -> the Command DTO browsers see (shared by apps/api and the command-worker).
// The raw frame never leaves the server.
import type postgres from 'postgres';
import type { Command, CommandStatus, CommandType } from '@citylight/shared';

type Sql = postgres.Sql;

/** Postgres NOTIFY channel: API -> command-worker "new command queued". */
export const COMMANDS_NOTIFY = 'cl_commands';
/** Redis pub/sub channel read by the API's Socket.IO gateway (same as apps/workers/src/events.ts). */
export const EVENTS_CHANNEL = 'cl:events';

interface CommandRow {
  id: string; cabinet_id: string; code: string; name: string; type: CommandType; params: Record<string, unknown>;
  batch_id: string | null; status: CommandStatus; email: string | null; queued_at: Date; sent_at: Date | null;
  acked_at: Date | null; confirmed_at: Date | null; error: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function dto(r: CommandRow): Command {
  return {
    id: r.id, cabinetId: r.cabinet_id, cabinetName: `${r.code} - ${r.name}`, type: r.type, params: r.params, batchId: r.batch_id,
    status: r.status, requestedBy: r.email ?? '—', queuedAt: r.queued_at.toISOString(), sentAt: iso(r.sent_at),
    ackedAt: iso(r.acked_at), confirmedAt: iso(r.confirmed_at), error: r.error,
  };
}

/** SELECT with an optional extra condition / tail, e.g. sql`WHERE m.id = ${id}`. Table alias: m (commands), c (cabinets). */
export async function selectCommands(sql: Sql, tail: postgres.PendingQuery<postgres.Row[]> | null = null): Promise<Command[]> {
  const rows = await sql<CommandRow[]>`
    SELECT m.id, m.cabinet_id, c.code, c.name, m.type, m.params, m.batch_id, m.status, u.email,
           m.queued_at, m.sent_at, m.acked_at, m.confirmed_at, m.error
    FROM commands m JOIN cabinets c ON c.id = m.cabinet_id LEFT JOIN users u ON u.id = m.requested_by
    ${tail ?? sql``}`;
  return rows.map(dto);
}

export async function commandById(sql: Sql, id: string): Promise<Command | null> {
  return (await selectCommands(sql, sql`WHERE m.id = ${id}`))[0] ?? null;
}
