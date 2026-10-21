import { readFileSync } from 'node:fs';

const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const code = (s: string) => s.replace(/^\s*--.*$/gm, '');
const TAG = '0025_mobile_station_registrations';

describe('backend#1288 mobile_station_registrations migration', () => {
  const sql = code(readFileSync(`drizzle/migrations/${TAG}.sql`, 'utf8'));

  it('is registered after the journal tail with a later timestamp', () => {
    const entry = journal.entries.find((e) => e.tag === TAG)!;
    const previous = journal.entries.find((e) => e.tag === '0024_weather_data_freshness_index')!;
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(previous.idx + 1);
    expect(entry.when).toBeGreaterThan(previous.when);
    expect(journal.entries.filter((e) => e.idx === entry.idx)).toHaveLength(1);
  });

  it('enforces one station per wallet, lowercase owner, a status vocabulary and the cell range', () => {
    expect(sql).toMatch(/"owner_address"\s+text NOT NULL/);
    expect(sql).toMatch(/UNIQUE \("owner_address"\)/);
    expect(sql).toMatch(/"owner_address" = lower\("owner_address"\)/);
    expect(sql).toMatch(/"status" IN \('db_only', 'submitted', 'on_chain'\)/);
    expect(sql).toMatch(/"cell_lat_e1" BETWEEN -900 AND 900/);
    expect(sql).toMatch(/"cell_lon_e1" BETWEEN -1800 AND 1800/);
    expect(sql).toMatch(/"station_id"\s+text PRIMARY KEY/);
  });

  it('stores integer tenths only - no exact-position columns - and public proof material, never a private key', () => {
    expect(sql).toMatch(/"cell_lat_e1"\s+integer NOT NULL/);
    expect(sql).not.toMatch(/latitude|longitude|double precision|private|secret|seed/i);
    for (const col of ['owner_pubkey', 'registration_signature', 'ownership_signature']) {
      expect(sql).toContain(`"${col}"`);
    }
  });

  it('has a single-use, expiring nonce table and is replay-safe (IF NOT EXISTS, transaction-safe DDL)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "mobile_station_nonces"[\s\S]*"nonce"\s+text PRIMARY KEY/);
    expect(sql).toMatch(/"expires_at"\s+bigint NOT NULL/);
    expect(sql).toMatch(/"consumed_at"\s+timestamp with time zone/);
    expect(sql).not.toMatch(/CONCURRENTLY/i);
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
  });
});

describe('backend#1288 B6 collect_pubkey migration (0026)', () => {
  const TAG26 = '0026_mobile_station_collect_pubkey';
  const sql26 = code(readFileSync(`drizzle/migrations/${TAG26}.sql`, 'utf8'));

  it('is registered directly after 0025 with a later timestamp', () => {
    const e25 = journal.entries.find((e) => e.tag === TAG)!;
    const e26 = journal.entries.find((e) => e.tag === TAG26)!;
    expect(e26).toBeDefined();
    expect(e26.idx).toBe(e25.idx + 1);
    expect(e26.when).toBeGreaterThan(e25.when);
    expect(journal.entries.filter((e) => e.idx === e26.idx)).toHaveLength(1);
    // 0026 stays in place; later migrations (0027+) follow it.
    expect(journal.entries.findIndex((e) => e.tag === TAG26)).toBe(e26.idx);
  });

  it('adds collect_pubkey NOT NULL (no default), 64 lowercase hex, and different from the wallet key', () => {
    expect(sql26).toMatch(/ADD COLUMN IF NOT EXISTS "collect_pubkey" text NOT NULL;/);
    expect(sql26).not.toMatch(/DEFAULT/i);
    expect(sql26).toMatch(/"collect_pubkey" ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(sql26).toMatch(/"collect_pubkey" <> lower\("owner_pubkey"\)/);
    expect(sql26).not.toMatch(/CONCURRENTLY|DROP TABLE|DELETE FROM/i);
  });
});
