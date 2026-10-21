/**
 * backend#1171 — 0022_iotex_tables creates exactly what shared/schema-iotex.ts
 * declares, so the mounted /api/iotex routes stop answering 500.
 *
 * Columns, NOT NULL, indexes, foreign keys and enum values are read from the
 * drizzle table objects themselves (getTableConfig), not restated here, so the
 * migration and the schema cannot drift apart silently.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import drizzleConfig from '../drizzle.config';
import * as iotex from '../shared/schema-iotex';

const migrationSql = readFileSync(resolve(process.cwd(), 'drizzle/migrations/0022_iotex_tables.sql'), 'utf8');
const journal = JSON.parse(readFileSync(resolve(process.cwd(), 'drizzle/migrations/meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};

const tables = [iotex.devices, iotex.deviceData, iotex.attestationRequests, iotex.w3bstreamPublishers, iotex.w3bstreamEvents];
const enums = [iotex.deviceTypeEnum, iotex.attestationStatusEnum, iotex.attestationTypeEnum];

function createTableBlock(sql: string, table: string): string {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\(([\\s\\S]*?)\\n\\);`));
  if (!match) throw new Error(`no CREATE TABLE IF NOT EXISTS "${table}" in the migration`);
  return match[1];
}

function assertMigrationMatchesSchema(sql: string): void {
  for (const table of tables) {
    const config = getTableConfig(table);
    const block = createTableBlock(sql, config.name);
    for (const column of config.columns) {
      const line = block.split('\n').find((l) => l.trim().startsWith(`"${column.name}" `));
      if (!line) throw new Error(`${config.name}.${column.name} missing from the migration`);
      if (column.notNull !== /NOT NULL|PRIMARY KEY/.test(line)) {
        throw new Error(`${config.name}.${column.name} nullability differs from the schema`);
      }
    }
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      const column = ref.columns[0].name;
      const target = getTableConfig(ref.foreignTable).name;
      if (!new RegExp(`FOREIGN KEY \\("${column}"\\) REFERENCES "${target}"\\("${ref.foreignColumns[0].name}"\\)`).test(block)) {
        throw new Error(`${config.name}.${column} foreign key to ${target} missing`);
      }
    }
    for (const idx of config.indexes) {
      if (!sql.includes(`CREATE INDEX IF NOT EXISTS "${idx.config.name}" ON "${config.name}"`)) {
        throw new Error(`index ${idx.config.name} missing`);
      }
    }
  }
  for (const pgEnum of enums) {
    const match = sql.match(new RegExp(`CREATE TYPE ${pgEnum.enumName} AS ENUM \\(([\\s\\S]*?)\\);`));
    if (!match) throw new Error(`enum ${pgEnum.enumName} missing`);
    const values = [...match[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    if (JSON.stringify(values) !== JSON.stringify(pgEnum.enumValues)) {
      throw new Error(`enum ${pgEnum.enumName} values differ from the schema`);
    }
  }
}

describe('0022_iotex_tables migration (backend#1171)', () => {
  it('is registered in the drizzle journal directly after 0021', () => {
    const entry = journal.entries.find((e) => e.tag === '0022_iotex_tables');
    const prev = journal.entries.find((e) => e.tag === '0021_owner_address_lower_indexes');
    expect(entry).toBeDefined();
    expect(prev).toBeDefined();
    expect(entry!.idx).toBe(prev!.idx + 1);
    expect(entry!.when).toBeGreaterThan(prev!.when);
    // backend#1178 appended 0023_referrals; 0022 need no longer be the tail.
    expect(journal.entries.filter((e) => e.idx === entry!.idx)).toHaveLength(1);
  });

  it('creates all five iotex_* tables the routes query', () => {
    expect(tables.map((t) => getTableConfig(t).name)).toEqual([
      'iotex_devices',
      'iotex_device_data',
      'iotex_attestation_requests',
      'iotex_w3bstream_publishers',
      'iotex_w3bstream_events',
    ]);
    for (const table of tables) createTableBlock(migrationSql, getTableConfig(table).name);
  });

  it('matches shared/schema-iotex.ts: columns, nullability, foreign keys, indexes and enum values', () => {
    expect(() => assertMigrationMatchesSchema(migrationSql)).not.toThrow();
  });

  it('creates the enum types idempotently and never uses CONCURRENTLY (one transaction)', () => {
    for (const pgEnum of enums) {
      expect(migrationSql).toContain(`IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${pgEnum.enumName}')`);
    }
    expect(migrationSql).not.toMatch(/CONCURRENTLY/i);
  });

  it('registers shared/schema-iotex.ts with drizzle', () => {
    expect(drizzleConfig.schema).toContain('./shared/schema-iotex.ts');
  });

  it.each([
    ['a dropped table', (sql: string) => sql.replace(/CREATE TABLE IF NOT EXISTS "iotex_w3bstream_events"[\s\S]*?\n\);/, '')],
    ['a dropped column', (sql: string) => sql.replace(/\n {2}"geo_fence_status"[^\n]*/, '')],
    ['a relaxed NOT NULL', (sql: string) => sql.replace('"challenge" text NOT NULL', '"challenge" text')],
    ['a missing foreign key', (sql: string) => sql.replace(/,\n {2}CONSTRAINT "iotex_device_data_device_id_iotex_devices_id_fk"\n[^\n]*/, '')],
    ['a missing enum value', (sql: string) => sql.replace(', \'REVOKED\'', '')],
  ])('the drift check rejects %s', (_name, mutate) => {
    const mutated = mutate(migrationSql);
    expect(mutated).not.toBe(migrationSql);
    expect(() => assertMigrationMatchesSchema(mutated)).toThrow();
  });
});
