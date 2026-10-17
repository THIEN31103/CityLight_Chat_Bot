import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export * as schema from './schema';

export function createDb(url = process.env.DATABASE_URL ?? 'postgres://citylight:citylight@localhost:5432/citylight') {
  const client = postgres(url, { max: 10, onnotice: () => undefined });
  return { db: drizzle(client, { schema }), client };
}

export type Db = ReturnType<typeof createDb>['db'];
