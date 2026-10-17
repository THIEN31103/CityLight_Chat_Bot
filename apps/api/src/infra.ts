// Shared providers: plain SQL client, Redis. Tokens are explicit (no emitDecoratorMetadata under tsx).
import { Global, Module, type OnApplicationShutdown, Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { createSql } from '@citylight/db';

export const SQL = Symbol('SQL');
export const REDIS = Symbol('REDIS');
export type Sql = ReturnType<typeof createSql>;

@Injectable()
class Closer implements OnApplicationShutdown {
  constructor(@Inject(SQL) private readonly sql: Sql, @Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown() {
    await this.sql.end({ timeout: 5 });
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [
    { provide: SQL, useFactory: () => createSql(process.env.DATABASE_URL, 20) },
    { provide: REDIS, useFactory: () => new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 2 }) },
    Closer,
  ],
  exports: [SQL, REDIS],
})
export class InfraModule {}

/** RFC 9457 problem body (spec 11). */
export function problem(status: number, code: string, detail: string) {
  return { type: `https://citylight.local/errors/${code}`, title: code, status, detail, code };
}
