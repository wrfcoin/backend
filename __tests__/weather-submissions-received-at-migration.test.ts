/**
 * Migration 0027 (Refs wrfcoin/backend#1382): trusted server-received time.
 * File-level checks; the behaviour (backfill, default, NOT NULL) is proven against
 * real PostgreSQL in weather-temperature-history-pg.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TAG = '0027_weather_submissions_received_at';
const journal = JSON.parse(readFileSync(resolve(process.cwd(), 'drizzle/migrations/meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const sql = readFileSync(resolve(process.cwd(), `drizzle/migrations/${TAG}.sql`), 'utf8');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe('migration 0027 weather_submissions.received_at', () => {
  it('is registered directly after 0026 with a later timestamp and a unique idx', () => {
    const e26 = journal.entries.find((e) => e.tag === '0026_mobile_station_collect_pubkey')!;
    const e27 = journal.entries.find((e) => e.tag === TAG)!;
    expect(e27).toBeDefined();
    expect(e27.idx).toBe(e26.idx + 1);
    expect(e27.when).toBeGreaterThan(e26.when);
    expect(journal.entries.filter((e) => e.idx === e27.idx)).toHaveLength(1);
  });

  it('adds the column, backfills from reading time (never a future time), then SET DEFAULT, then SET NOT NULL, in that order', () => {
    const add = code.indexOf('ADD COLUMN IF NOT EXISTS "received_at" timestamptz;');
    const backfill = code.indexOf('SET "received_at" = LEAST("submitted_at", now())');
    const def = code.indexOf('ALTER COLUMN "received_at" SET DEFAULT now()');
    const notNull = code.indexOf('ALTER COLUMN "received_at" SET NOT NULL');
    expect([add, backfill, def, notNull].every((i) => i >= 0)).toBe(true);
    expect(add).toBeLessThan(backfill);
    expect(backfill).toBeLessThan(def);
    expect(def).toBeLessThan(notNull);
    expect(code).toMatch(/WHERE "received_at" IS NULL/);
  });

  it('is destructive-free, online-safe for a transaction and documents the owner ruling', () => {
    expect(code).not.toMatch(/CONCURRENTLY|DROP TABLE|DELETE FROM|TRUNCATE/i);
    expect(sql).toMatch(/owner ruling/i);
    expect(sql).toMatch(/Backfill from reading time/);
  });

  it('creates the frozen-release table: composite primary key, all-or-none NULLs, cell range checks', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS "weather_temperature_daily_release"/);
    expect(code).toMatch(/PRIMARY KEY \("lat_e1", "lon_e1", "day"\)/);
    expect(code).toMatch(/"lat_e1"\s+integer NOT NULL CHECK \("lat_e1" BETWEEN -900 AND 900\)/);
    expect(code).toMatch(/"lon_e1"\s+integer NOT NULL CHECK \("lon_e1" BETWEEN -1800 AND 1800\)/);
    expect(code).toMatch(/"released_at"\s+timestamptz NOT NULL DEFAULT now\(\)/);
    expect(code).toMatch(/weather_temperature_daily_release_all_or_none/);
    expect(code).not.toMatch(/CREATE TRIGGER|DROP TABLE(?! IF NOT)/i);
  });
});
