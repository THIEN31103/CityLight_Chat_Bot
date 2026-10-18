// Activity log reader (spec S15): every service writes activity_logs; this pages through them.
// Users who see the whole system read every entry; area-scoped users read only their own actions,
// since entries name cabinets / zones outside their areas.
import { Controller, Get, Inject, Injectable, Module, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { ActivityLog, Page } from '@citylight/shared';
import { RequirePerm, type AuthedRequest, type SessionUser } from './auth';
import { SQL, type Sql } from './infra';

const LogQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  user: z.string().trim().max(200).optional(),
  q: z.string().trim().max(100).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

@Injectable()
export class LogsService {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  async activity(u: SessionUser, query: unknown): Promise<Page<ActivityLog>> {
    const p = LogQuery.parse(query);
    const like = p.q ? `%${p.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where = this.sql`
      WHERE true
        ${u.scope.all ? this.sql`` : this.sql`AND user_id = ${u.id}`}
        ${p.user ? this.sql`AND user_email = ${p.user}` : this.sql``}
        ${like ? this.sql`AND (action ILIKE ${like} OR target_name ILIKE ${like})` : this.sql``}
        ${p.from ? this.sql`AND ts >= ${p.from}` : this.sql``}
        ${p.to ? this.sql`AND ts <= ${p.to}` : this.sql``}`;
    const [rows, total] = await Promise.all([
      this.sql<{ id: string; user_email: string; action: string; target_type: string; target_name: string | null; old_value: string | null; new_value: string | null; ip: string | null; ts: Date }[]>`
        SELECT id::text, user_email, action, target_type, target_name, old_value, new_value, ip, ts FROM activity_logs
        ${where} ORDER BY ts DESC, id DESC LIMIT ${p.size} OFFSET ${(p.page - 1) * p.size}`,
      this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM activity_logs ${where}`,
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id, userEmail: r.user_email, action: r.action, targetType: r.target_type, targetName: r.target_name ?? '',
        oldValue: r.old_value, newValue: r.new_value, ip: r.ip ?? '', ts: r.ts.toISOString(),
      })),
      total: total[0]?.n ?? 0, page: p.page, size: p.size,
    };
  }
}

@Controller('logs')
export class LogsController {
  constructor(@Inject(LogsService) private readonly svc: LogsService) {}

  @Get('activity') @RequirePerm('log.view')
  activity(@Req() r: AuthedRequest, @Query() q: Record<string, string>) {
    return this.svc.activity(r.user!, q);
  }
}

@Module({ controllers: [LogsController], providers: [LogsService] })
export class LogsModule {}
