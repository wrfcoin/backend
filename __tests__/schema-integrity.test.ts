/**
 * Schema integrity smoke test (#467)
 *
 * Reads every SQL migration file under drizzle/migrations/ and the
 * companion _journal.json, then asserts:
 *
 *   1. All critical tables appear in at least one CREATE TABLE statement.
 *   2. The migration journal contains the expected minimum number of entries.
 *
 * No database connection is required — this is a pure file-parse check that
 * catches accidentally deleted or truncated migration files at test time
 * rather than at runtime.
 */

import * as fs from 'fs';
import * as path from 'path';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'drizzle', 'migrations');
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');

/** Collect every table name from `CREATE TABLE [IF NOT EXISTS] "name"` / name */
function extractCreatedTables(sql: string): string[] {
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
  const tables: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    tables.push(m[1].toLowerCase());
  }
  return tables;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('drizzle migration schema integrity (#467)', () => {
  let allSql: string;
  let createdTables: string[];
  let sqlFiles: string[];

  beforeAll(() => {
    sqlFiles = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    allSql = sqlFiles
      .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'))
      .join('\n');

    createdTables = extractCreatedTables(allSql);
  });

  /* ---- critical tables ---- */

  /**
   * These are the tables that backend services depend on at runtime.
   * If any migration that creates one of these is deleted, the server
   * will fail with a "relation does not exist" error on first query.
   *
   * Note: some issue-listed tables (iot_gateway_geofence_checks,
   * sensor_ingest_log) were planned but never materialised as CREATE
   * TABLE statements. Migration 0005 adds columns via ALTER TABLE and
   * migration 0002 creates weather_submissions instead.  The list
   * below reflects the actual schema.
   */
  const CRITICAL_TABLES: string[] = [
    // 0000 baseline
    'weather_stations',
    // 0001 streak / social / gas
    'gas_sponsor_log',
    'streak_milestones_claimed',
    'social_accounts',
    // 0002 sensor ingest (actual table name)
    'weather_submissions',
    // 0003 bridge / social / streak
    'streak_checkins',
    'streak_badge_claims',
    // 0004 weather commit/reveal
    'weather_commitments',
  ];

  it.each(CRITICAL_TABLES)(
    'CREATE TABLE for "%s" exists in the migrations',
    (table) => {
      expect(createdTables).toContain(table);
    },
  );

  /* ---- migration file count ---- */

  it('contains at least 9 migration SQL files (0000 through 0008)', () => {
    expect(sqlFiles.length).toBeGreaterThanOrEqual(9);
  });

  /* ---- journal sanity ---- */

  it('_journal.json exists and is valid JSON', () => {
    expect(fs.existsSync(JOURNAL_PATH)).toBe(true);
    const raw = fs.readFileSync(JOURNAL_PATH, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('_journal.json contains at least 2 migration entries', () => {
    const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf-8'));
    expect(Array.isArray(journal.entries)).toBe(true);
    expect(journal.entries.length).toBeGreaterThanOrEqual(2);
  });

  it('every journal entry has the required fields', () => {
    const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf-8'));
    for (const entry of journal.entries) {
      expect(entry).toHaveProperty('idx');
      expect(entry).toHaveProperty('tag');
      expect(entry).toHaveProperty('when');
    }
  });

  /* ---- no duplicate CREATE TABLE ---- */

  it('no table is created more than once across all migrations', () => {
    const seen = new Map<string, number>();
    for (const t of createdTables) {
      seen.set(t, (seen.get(t) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name);
    expect(duplicates).toEqual([]);
  });
});
