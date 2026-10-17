import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export * as schema from './schema';

export function createDb(url = process.env.DATABASE_URL ?? 'postgres://citylight:citylight@localhost:5432/citylight') {
  const client = postgres(url, { max: 10, onnotice: () => undefined });
  return { db: drizzle(client, { schema }), client };
}

export type Db = ReturnType<typeof createDb>['db'];

/**
 * Plain postgres.js client for hot paths with hand-written SQL (ingest batch writes).
 * Do NOT reuse the client from createDb(): drizzle replaces its date serializers, so raw queries
 * passing Date values fail there.
 */
export function createSql(url = process.env.DATABASE_URL ?? 'postgres://citylight:citylight@localhost:5432/citylight', max = 10) {
  return postgres(url, { max, onnotice: () => undefined });
}
