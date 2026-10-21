/**
 * backend#1210 migration 0020: lowercases stored owner addresses. Its runtime
 * behaviour (idempotent, collisions reported and left unchanged, immutable
 * oracle work untouched) was exercised on real Postgres 15 — see the PR. These
 * checks pin the properties that make it safe to run on the live DB.
 */
import { readFileSync } from 'node:fs';

const sql = readFileSync('drizzle/migrations/0020_owner_address_lowercase.sql', 'utf8');
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');
const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};

describe('0020_owner_address_lowercase migration (backend#1210)', () => {
  it('is registered in the drizzle journal after 0019', () => {
    const entry = journal.entries.find((e) => e.tag === '0020_owner_address_lowercase');
    const prev = journal.entries.find((e) => e.tag === '0019_governance_consolidated');
    expect(entry?.idx).toBe(20);
    expect(entry!.when).toBeGreaterThan(prev!.when);
  });

  it('normalises the owner columns named in the issue', () => {
    for (const target of [
      "('weather_stations', 'owner_address')",
      "('station_reward_cycles', 'owner_address')",
      "('station_reward_cycles', 'reward_address')",
      "('devices_consolidated', 'owner_address')",
    ]) {
      expect(code).toContain(target);
    }
  });

  it('never rewrites immutable oracle work items', () => {
    expect(code).not.toMatch(/oracle_work_items/);
  });

  it('is idempotent and never merges a case collision silently', () => {
    // Only rows that differ from their lowercase form are touched...
    expect(code).toContain('<> lower(t.%1$I)');
    // ...and never a row whose owner has another case variant stored.
    expect(code).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM %2\$I AS c\s*WHERE lower\(c\.%1\$I\) = lower\(t\.%1\$I\)\s*AND c\.%1\$I <> t\.%1\$I\)/);
    expect(code).toContain('RAISE WARNING');
  });

  it('skips a table that does not exist instead of failing the migration', () => {
    expect(code).toContain('to_regclass');
  });
});

/**
 * name -> normalised `ON "table" (...)` definition for every CREATE INDEX in
 * [text] (with or without CONCURRENTLY, including statements inside
 * EXECUTE '...'). Whitespace is collapsed and doubled quotes unescaped, so
 * formatting differences don't matter but any change to the table, a
 * column, an expression, or ASC/DESC does.
 */
function indexDefinitions(text: string): Record<string, string> {
  const defs: Record<string, string> = {};
  const re = /CREATE\s+INDEX\s+(?:CONCURRENTLY\s+)?IF NOT EXISTS\s+"([^"]+)"\s+ON\s+"([^"]+)"\s*\(/gi;
  for (const m of text.matchAll(re)) {
    const open = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = open;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth += 1;
      if (text[i] === ')') depth -= 1;
      i += 1;
    }
    const columns = text.slice(open, i - 1).replace(/\s+/g, ' ').trim();
    defs[m[1]] = `ON "${m[2]}" (${columns})`;
  }
  return defs;
}

describe('0021_owner_address_lower_indexes migration (backend#1210 follow-up)', () => {
  const sql21 = readFileSync('drizzle/migrations/0021_owner_address_lower_indexes.sql', 'utf8');
  const code21 = sql21
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  it('is registered in the drizzle journal after 0020', () => {
    const entry = journal.entries.find((e) => e.tag === '0021_owner_address_lower_indexes');
    const prev = journal.entries.find((e) => e.tag === '0020_owner_address_lowercase');
    expect(entry?.idx).toBe(21);
    expect(entry!.when).toBeGreaterThan(prev!.when);
  });

  it('indexes lower(owner_address) for every table the case-insensitive reads use', () => {
    expect(code21).toMatch(/CREATE INDEX IF NOT EXISTS "idx_weather_stations_owner_lower"\s+ON "weather_stations" \(lower\("owner_address"\)\)/);
    expect(code21).toMatch(/CREATE INDEX IF NOT EXISTS "idx_station_reward_cycles_owner_lower_station"\s+ON "station_reward_cycles" \(lower\("owner_address"\), "station_id", "observation_accepted_at" DESC\)/);
    expect(code21).toContain('"idx_devices_consolidated_owner_lower" ON "devices_consolidated" (lower("owner_address"))');
    expect(code21).toContain("to_regclass('devices_consolidated')");
  });

  it('never uses CONCURRENTLY (drizzle runs migrations inside one transaction)', () => {
    expect(code21).not.toMatch(/CONCURRENTLY/i);
  });

  it('the manual pre-create file builds the same indexes CONCURRENTLY', () => {
    const manual = readFileSync('drizzle/manual/1210-owner-lower-indexes-concurrently.sql', 'utf8');
    expect(manual).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_weather_stations_owner_lower"');
    expect(manual).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_station_reward_cycles_owner_lower_station"');
  });

  // IF NOT EXISTS matches by NAME only: if the manual file's definition drifted
  // from 0021's, a pre-created index would silently win. Pin the full
  // ON "table" (...) definition of every index, including the devices index
  // (0021 builds it inside EXECUTE '...'; the manual file carries it as a
  // commented-out template).
  it("the manual file's index definitions equal 0021's (table, columns, expressions, order)", () => {
    const manual = readFileSync('drizzle/manual/1210-owner-lower-indexes-concurrently.sql', 'utf8');
    const manualDefs = indexDefinitions(manual.replace(/^--\s?(?=\s*(CREATE INDEX|ON ))/gm, ''));
    const migrationDefs = indexDefinitions(sql21);
    expect(Object.keys(migrationDefs).sort()).toEqual([
      'idx_devices_consolidated_owner_lower',
      'idx_station_reward_cycles_owner_lower_station',
      'idx_weather_stations_owner_lower',
    ]);
    expect(manualDefs).toEqual(migrationDefs);
  });

  it('the manual file documents the INVALID-index check', () => {
    const manual = readFileSync('drizzle/manual/1210-owner-lower-indexes-concurrently.sql', 'utf8');
    expect(manual).toMatch(/FROM pg_index\s*\n--\s+WHERE NOT indisvalid/);
  });
});
