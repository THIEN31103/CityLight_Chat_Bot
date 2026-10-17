// Applies migrations in order: extensions -> tables (drizzle-kit) -> timescale (custom SQL),
// then the post scripts that TimescaleDB refuses to run inside a transaction (continuous aggregates).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './index';

const { db, client } = createDb();
await migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
console.log('[db] migrations applied');

const postDir = fileURLToPath(new URL('../sql/post', import.meta.url));
for (const file of readdirSync(postDir).filter((f) => f.endsWith('.sql')).sort()) {
  const text = readFileSync(`${postDir}/${file}`, 'utf8');
  // statements end with ';' at end of line; each runs on its own (autocommit)
  const statements = text
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
  for (const st of statements) await client.unsafe(st);
  console.log(`[db] post script ${file}: ${statements.length} statements`);
}
await client.end();
