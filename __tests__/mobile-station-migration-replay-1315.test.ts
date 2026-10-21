/** backend#1315: actual migration replay and CHECK semantics, never a SQL mock.
 * MOBILE_STATION_PG_URL must name a disposable database (CI provides one).
 * Each run owns a random schema; the existing CI REQUIRE flag forbids skipping.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const url = process.env.MOBILE_STATION_PG_URL;
const realPg = url ? describe : describe.skip;
if (!url && process.env.MOBILE_STATION_REQUIRE_PG === '1') {
  it('requires a disposable Postgres URL for migration replay (#1315)', () => {
    throw new Error('MOBILE_STATION_PG_URL is required; real migration checks cannot skip in CI');
  });
}

realPg('mobile-station migration replay against real Postgres (#1315)', () => {
  const schema = `mobile_replay_${randomUUID().replace(/-/g, '')}`;
  let pool: Pool;
  let schemaCreated = false;
  const migrations = ['0025_mobile_station_registrations.sql', '0026_mobile_station_collect_pubkey.sql'];

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
  });
  afterAll(async () => {
    try {
      if (schemaCreated) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      if (pool) await pool.end();
    }
  });

  async function applyMigrations() {
    for (const file of migrations) {
      await pool.query(readFileSync(join(__dirname, '../drizzle/migrations', file), 'utf8'));
    }
  }
  function insert(stationId: string, ownerPubkey: string, collectPubkey: string) {
    return pool.query(`INSERT INTO mobile_station_registrations
      (station_id, owner_address, owner_pubkey, collect_pubkey, cell_lat_e1, cell_lon_e1,
       registration_nonce, registration_expires_at, registration_signature, ownership_signature)
      VALUES ($1, $2, $3, $4, 0, 0, 'test-nonce', 1, 'test-proof', 'test-proof')`,
    [stationId, `0x${createHash('sha256').update(stationId).digest('hex').slice(0, 40)}`,
      ownerPubkey, collectPubkey]);
  }

  it('replays 0025 + 0026 on populated tables and both CHECK constraints reject bad rows', async () => {
    await applyMigrations();
    await insert('valid', 'a'.repeat(64), 'b'.repeat(64));
    // The second pass must preserve a real row, not require another empty table.
    await applyMigrations();
    expect((await pool.query('SELECT station_id FROM mobile_station_registrations')).rows)
      .toEqual([{ station_id: 'valid' }]);

    const constraints = await pool.query(`SELECT conname FROM pg_constraint
      WHERE conrelid = 'mobile_station_registrations'::regclass
      AND conname IN ('mobile_station_registrations_collect_pubkey_shape_check',
                     'mobile_station_registrations_collect_not_owner_check')`);
    expect(constraints.rows.map(row => row.conname).sort()).toEqual([
      'mobile_station_registrations_collect_not_owner_check',
      'mobile_station_registrations_collect_pubkey_shape_check',
    ]);
    for (const [stationId, badKey] of [['short', 'b'.repeat(63)], ['uppercase', 'B'.repeat(64)]]) {
      await expect(insert(stationId, 'a'.repeat(64), badKey)).rejects.toMatchObject({
        code: '23514', constraint: 'mobile_station_registrations_collect_pubkey_shape_check',
      });
    }
    for (const [stationId, ownerKey] of [['same-key', 'a'.repeat(64)], ['same-key-case', 'A'.repeat(64)]]) {
      await expect(insert(stationId, ownerKey, 'a'.repeat(64))).rejects.toMatchObject({
        code: '23514', constraint: 'mobile_station_registrations_collect_not_owner_check',
      });
    }
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM mobile_station_registrations')).rows)
      .toEqual([{ count: 1 }]);
  });
});
