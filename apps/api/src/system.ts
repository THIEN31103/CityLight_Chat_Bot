import { Controller, Get, Inject, Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Public, RequirePerm } from './auth';
import { REDIS, SQL, type Sql } from './infra';

@Controller()
export class SystemController {
  constructor(@Inject(SQL) private readonly sql: Sql, @Inject(REDIS) private readonly redis: Redis) {}

  @Public()
  @Get('health')
  async health() {
    const db = await this.sql`SELECT 1`.then(() => 'ok').catch(() => 'down');
    const redis = await this.redis.ping().then(() => 'ok').catch(() => 'down');
    return { status: db === 'ok' && redis === 'ok' ? 'ok' : 'degraded', db, redis, at: new Date().toISOString() };
  }

  @Public()
  @Get('server-time')
  time() {
    return { now: new Date().toISOString() };
  }

  @Get('system/stats')
  @RequirePerm('system.view')
  async stats() {
    const c = await this.sql<{ online: number; total: number }[]>`
      SELECT count(*) FILTER (WHERE s.online)::int AS online, count(*)::int AS total FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id`;
    const ingest = JSON.parse((await this.redis.get('cl:ingest:stats')) ?? '{}') as { lastFlushMs?: number; queue?: number };
    const size = await this.sql<{ gb: number }[]>`SELECT round(pg_database_size(current_database()) / 1024.0 / 1024 / 1024, 2)::float AS gb`;
    const rate = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM telemetry WHERE ts > now() - interval '1 minute'`;
    const cmd = await this.sql<{ open: number; errors: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'queued' OR deadline_at IS NOT NULL)::int AS open,
             count(*) FILTER (WHERE status IN ('failed', 'timeout') AND queued_at > now() - interval '24 hours')::int AS errors
      FROM commands WHERE queued_at > now() - interval '24 hours' OR status = 'queued' OR deadline_at IS NOT NULL`;
    return {
      cabinetsOnline: c[0]?.online ?? 0,
      cabinetsTotal: c[0]?.total ?? 0,
      msgPerSec: Math.round(((rate[0]?.n ?? 0) / 60) * 10) / 10,
      ingestLagMs: ingest.lastFlushMs ?? null,
      commandQueue: cmd[0]?.open ?? 0,
      ackErrors24h: cmd[0]?.errors ?? 0,
      dbSizeGb: size[0]?.gb ?? 0,
      brokerConnections: c[0]?.online ?? 0,
      uptimeHours: Math.round((process.uptime() / 3600) * 10) / 10,
    };
  }
}

@Module({ controllers: [SystemController] })
export class SystemModule {}
