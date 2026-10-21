import { readFileSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { weatherData } from '../shared/schema';

const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const indexDefinition = /CREATE INDEX IF NOT EXISTS "idx_weather_data_station_timestamp"\s+ON "weather_data"\s*\("station_id",\s*"timestamp"\)/;
const code = (s: string) => s.replace(/^\s*--.*$/gm, '');

describe('freshness query has an index in the deployed migration path', () => {
  it('creates the schema-declared station/timestamp index in an active migration', () => {
    const migrations = journal.entries.map(e => readFileSync(`drizzle/migrations/${e.tag}.sql`, 'utf8')).join('\n');
    expect(code(migrations)).toMatch(indexDefinition);
    const index = getTableConfig(weatherData).indexes.find(i => i.config.name === 'idx_weather_data_station_timestamp');
    expect(index?.config.columns.map(c => 'name' in c ? c.name : undefined)).toEqual(['station_id', 'timestamp']);
  });
  it('registers the incremental migration after the existing journal tail', () => {
    const entry = journal.entries.find(e => e.tag === '0024_weather_data_freshness_index');
    const previous = journal.entries.find(e => e.tag === '0023_referrals')!;
    expect(entry).toBeDefined();
    expect(entry!.idx).toBe(previous.idx + 1);
    expect(entry!.when).toBeGreaterThan(previous.when);
    expect(journal.entries.filter(e => e.idx === entry!.idx)).toHaveLength(1);
  });
  it('uses transaction-safe DDL with a matching manual concurrent pre-create option', () => {
    const migration = code(readFileSync('drizzle/migrations/0024_weather_data_freshness_index.sql','utf8'));
    const manual = code(readFileSync('drizzle/manual/1255-weather-data-freshness-index-concurrently.sql','utf8'));
    expect(migration).not.toMatch(/CONCURRENTLY/i);
    expect(manual).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
    expect(manual.replace(' CONCURRENTLY','').trim()).toBe(migration.trim());
  });
});
