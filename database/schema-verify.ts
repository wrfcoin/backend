/**
 * Startup schema integrity verifier.
 *
 * Queries information_schema to confirm that critical tables exist in the
 * public schema.  Returns a report — never throws — so the server can boot
 * even when the database is incomplete (e.g. first deploy before migrations).
 */

import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';

/** Tables that MUST exist for the backend to operate correctly. */
const REQUIRED_TABLES: readonly string[] = [
  'users',
  'blocks',
  'transactions',
  'wallets',
  'weather_data',
  'weather_submissions',
  'governance_proposals',
  'treasury_consolidated',
] as const;

export interface SchemaVerifyResult {
  ok: boolean;
  missing: string[];
}

/**
 * Check that all required tables exist in the public schema.
 *
 * @param db  A drizzle `db` instance that exposes `.execute()`.
 */
export async function verifySchemaIntegrity(
  db: { execute: (query: ReturnType<typeof sql>) => Promise<any> },
): Promise<SchemaVerifyResult> {
  try {
    const rows: { table_name: string }[] = await db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );

    const existing = new Set(rows.map((r) => r.table_name));
    const missing = REQUIRED_TABLES.filter((t) => !existing.has(t));

    if (missing.length > 0) {
      logger.warn('Schema integrity check: missing tables', { missing });
    } else {
      logger.info('Schema integrity check passed — all required tables present');
    }

    return { ok: missing.length === 0, missing };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Schema integrity check skipped — query failed', {
      error: message,
    });
    return { ok: false, missing: [...REQUIRED_TABLES] };
  }
}
