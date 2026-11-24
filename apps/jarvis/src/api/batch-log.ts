// The batch log, read only (GET /command-batches, log.view), for the shift report. Kept out of api/read.ts so that
// file never names a batch endpoint (static guard, spec 6.10); test/rules.test.ts checks this file only reads.
import type { CommandBatch } from '@citylight/shared';
import type { ApiClient, RequestOptions } from './client';

export function readBatchLog(api: ApiClient, o?: RequestOptions): Promise<CommandBatch[]> {
  return api.get<CommandBatch[]>('command-batches', undefined, o);
}

/** one batch's progress (GET /command-batches/:id), to tell its result after Jarvis stopped following it */
export async function readBatch(api: ApiClient, id: string, o?: RequestOptions) {
  type B = { id: string; total: number; succeeded: number; failed: number; offline: number; pending: number; finishedAt: string | null };
  // the server answers { batch, items } (apps/api/src/schedules.ts detail)
  const r = await api.get<B | { batch: B }>(`command-batches/${encodeURIComponent(id)}`, undefined, o);
  return 'batch' in r ? r.batch : r;
}
