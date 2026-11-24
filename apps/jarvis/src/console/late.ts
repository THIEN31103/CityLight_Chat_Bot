// Commands and batches Jarvis stopped following before they ended (60 s, guard/pending.ts): their result is told
// when it comes, at the console's next look (spec 7 P1: "lệnh của phiên này xong / lỗi, lô lệnh xong"). Only the
// session's own commands, read over REST; given up after 15 minutes.
import { readBatch } from '../api/batch-log';
import type { ApiClient } from '../api/client';
import type { CityLightReads } from '../api/read';
import { isDone, type Outcome, type PendingAction } from '../guard/pending';
import { outcomeText } from '../guard/propose';
import { vnTime } from '../tools/read';

export const LATE_MS = 15 * 60_000;

export class LateResults {
  private readonly waiting = new Map<string, { p: PendingAction; at: number }>();

  /** id: the command's id, or the batch's for a batch */
  add(id: string, p: PendingAction, now = Date.now()) {
    this.waiting.set(id, { p, at: now });
  }

  has(id: string) {
    return this.waiting.has(id);
  }

  get size() {
    return this.waiting.size;
  }

  /** the sentences of those that ended since the last check; those past 15 minutes are dropped */
  async check(api: ApiClient, reads: CityLightReads, now = Date.now()): Promise<string[]> {
    const out: string[] = [];
    for (const [id, { p, at }] of [...this.waiting]) {
      if (now - at > LATE_MS) {
        this.waiting.delete(id);
        continue;
      }
      let o: Outcome | null = null;
      if (p.batch) {
        const b = await readBatch(api, id).catch(() => null);
        if (b && (b.finishedAt || b.pending === 0))
          o = { status: 'confirmed', batch: { id: b.id, total: b.total, succeeded: b.succeeded, failed: b.failed, offline: b.offline, pending: b.pending } };
      } else {
        const c = await reads.command(id).catch(() => null);
        if (c && isDone(p.command.type, c.status)) o = { status: c.status, commandId: id, error: c.error ?? undefined };
      }
      if (!o) continue;
      this.waiting.delete(id);
      const said = o.status === 'timeout' ? `Tủ ${p.cabinet.code} không phản hồi, máy chủ đã dừng lệnh.` : outcomeText(p, o);
      out.push(`Kết quả lệnh "${p.summary}" gửi lúc ${vnTime(new Date(at).toISOString())}: ${said}`);
    }
    return out;
  }
}
