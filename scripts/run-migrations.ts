/**
 * Standalone database migration runner.
 *
 * Applies any pending Drizzle migrations in `drizzle/migrations/` against the
 * database pointed to by DATABASE_URL. Exits 0 on success, non-zero on
 * failure. Safe to call before starting an API server (e.g., from a Docker
 * entrypoint or a `npm run db:migrate:startup` script).
 *
 * Gated by RUN_MIGRATIONS_ON_STARTUP so environments that manage schema
 * out-of-band (CI, staging with manual control) can skip it.
 *
 * Operator runbook: docs/ops/database-migrations.md
 *
 * Closes #752 (startup migration runner).
 */

import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { attachMigrationNoticeLogging } from './migration-notices.js';

async function main(): Promise<void> {
  const gate = process.env.RUN_MIGRATIONS_ON_STARTUP;
  if (gate && gate.toLowerCase() === 'false') {
    console.log('[migrate] RUN_MIGRATIONS_ON_STARTUP=false — skipping');
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  console.log('[migrate] applying pending migrations from ./drizzle/migrations');
  const pool = new Pool({ connectionString: databaseUrl });
  // Surface RAISE NOTICE / RAISE WARNING from migrations in the deploy log
  // (e.g. 0020's owner-address collision report); pg drops them otherwise.
  attachMigrationNoticeLogging(pool);
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: './drizzle/migrations' });
    console.log('[migrate] migrations applied successfully');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
