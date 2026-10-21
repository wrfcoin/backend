/**
 * backend#1178 — 0023_referrals creates exactly the `referrals` table that
 * shared/schema-engagement.ts declares (and nothing for the deferred growth
 * tables). Columns, NOT NULL, defaults of note, and indexes are read from the
 * drizzle table object (getTableConfig), not restated here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import drizzleConfig from '../drizzle.config';
import { referrals } from '../shared/schema-engagement';

const migrationSql = readFileSync(resolve(process.cwd(), 'drizzle/migrations/0023_referrals.sql'), 'utf8');
const journal = JSON.parse(readFileSync(resolve(process.cwd(), 'drizzle/migrations/meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};

function tableBlock(sql: string): string {
  const match = sql.match(/CREATE TABLE IF NOT EXISTS "referrals" \(([\s\S]*?)\n\);/);
  if (!match) throw new Error('no CREATE TABLE IF NOT EXISTS "referrals" in the migration');
  return match[1];
}

function assertMatchesSchema(sql: string): void {
  const config = getTableConfig(referrals);
  const block = tableBlock(sql);
  for (const column of config.columns) {
    const line = block.split('\n').find((l) => l.trim().startsWith(`"${column.name}" `));
    if (!line) throw new Error(`referrals.${column.name} missing from the migration`);
    if (column.notNull !== /NOT NULL|PRIMARY KEY/.test(line)) {
      throw new Error(`referrals.${column.name} nullability differs from the schema`);
    }
    if (column.isUnique && !new RegExp(`UNIQUE \\("${column.name}"\\)`).test(block)) {
      throw new Error(`referrals.${column.name} unique constraint missing`);
    }
  }
  for (const idx of config.indexes) {
    const unique = idx.config.unique ? 'UNIQUE ' : '';
    if (!sql.includes(`CREATE ${unique}INDEX IF NOT EXISTS "${idx.config.name}" ON "referrals"`)) {
      throw new Error(`index ${idx.config.name} missing`);
    }
  }
}

describe('0023_referrals migration (backend#1178)', () => {
  it('is the journal entry directly after 0022_iotex_tables', () => {
    const entry = journal.entries.find((e) => e.tag === '0023_referrals');
    const prev = journal.entries.find((e) => e.tag === '0022_iotex_tables');
    expect(entry).toBeDefined();
    expect(prev).toBeDefined();
    expect(entry!.idx).toBe(prev!.idx + 1);
    expect(entry!.when).toBeGreaterThan(prev!.when);
    expect(journal.entries.filter((e) => e.idx === entry!.idx)).toHaveLength(1);
  });

  it('matches shared/schema-engagement.ts referrals: columns, nullability, uniqueness, indexes', () => {
    expect(getTableConfig(referrals).name).toBe('referrals');
    expect(() => assertMatchesSchema(migrationSql)).not.toThrow();
  });

  it('creates only referrals — none of the deferred growth tables — and no CONCURRENTLY', () => {
    const created = [...migrationSql.matchAll(/CREATE TABLE IF NOT EXISTS "([a-z_]+)"/g)].map((m) => m[1]);
    expect(created).toEqual(['referrals']);
    expect(migrationSql).not.toMatch(/CONCURRENTLY/i);
  });

  it('leaves schema-engagement.ts out of drizzle.config (it also declares the deferred tables)', () => {
    expect(drizzleConfig.schema).not.toContain('./shared/schema-engagement.ts');
  });

  it.each([
    ['a dropped column', (sql: string) => sql.replace(/\n {2}"referee_address"[^\n]*/, '')],
    ['a relaxed NOT NULL', (sql: string) => sql.replace('"referrer_address" varchar(255) NOT NULL', '"referrer_address" varchar(255)')],
    ['a missing index', (sql: string) => sql.replace(/CREATE INDEX IF NOT EXISTS "referrals_status_idx"[^\n]*\n/, '')],
    ['a missing unique constraint', (sql: string) => sql.replace(/,\n {2}CONSTRAINT "referrals_referral_code_unique" UNIQUE \("referral_code"\)/, '')],
  ])('the drift check rejects %s', (_name, mutate) => {
    const mutated = mutate(migrationSql);
    expect(mutated).not.toBe(migrationSql);
    expect(() => assertMatchesSchema(mutated)).toThrow();
  });
});
