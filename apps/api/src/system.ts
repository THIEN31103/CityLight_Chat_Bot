import { Controller, Get, Inject, Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { STORAGE_POLICY } from '@citylight/shared';
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
      SELECT count(*) FILTER (WHERE s.online)::int AS online, count(*)::int AS total FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id WHERE c.active`;
    const ingest = JSON.parse((await this.redis.get('cl:ingest:stats')) ?? '{}') as { lastFlushMs?: number; queue?: number };
    // ingest refreshes this every 30 s; older than 90 s = ingest itself is not running
    const link = JSON.parse((await this.redis.get('cl:ingest:mqtt')) ?? 'null') as { connected: boolean; since: string | null; at: string } | null;
    const linkFresh = !!link && Date.now() - Date.parse(link.at) < 90_000;
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
      /** ingest <-> broker; null = no fresh report from ingest */
      brokerLink: linkFresh ? { connected: link!.connected, since: link!.since } : null,
      uptimeHours: Math.round((process.uptime() / 3600) * 10) / 10,
    };
  }

  /** S57: size of each time-series relation (with its retention / compression) and of everything else. */
  @Get('system/storage')
  @RequirePerm('system.view')
  async storage() {
    const rels = STORAGE_POLICY.map((p) => p.rel);
    const rows = await this.sql<{ rel: string; bytes: string | null; compressed: string | null }[]>`
      SELECT r.rel, hypertable_size(r.rel::regclass)::text AS bytes,
             (SELECT sum(after_compression_total_bytes) FROM hypertable_compression_stats(r.rel::regclass))::text AS compressed
      FROM unnest(${rels}::text[]) AS r(rel)`;
    const [db] = await this.sql<{ total: string }[]>`SELECT pg_database_size(current_database())::text AS total`;
    const items = STORAGE_POLICY.map((p) => {
      const r = rows.find((x) => x.rel === p.rel);
      return { name: p.rel, bytes: Number(r?.bytes ?? 0), compressedBytes: Number(r?.compressed ?? 0), keep: p.dropAfter ?? null, compressAfter: p.compressAfter ?? null };
    });
    const totalBytes = Number(db?.total ?? 0);
    return { items, otherBytes: Math.max(0, totalBytes - items.reduce((s, i) => s + i.bytes, 0)), totalBytes };
  }
}

@Module({ controllers: [SystemController] })
export class SystemModule {}
