/** Full committed journal and hand-created-index controls on disposable PG. */
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.BACKFILL_TEST_PG_URL;
if (process.env.ACHIEVEMENT_PAYOUT_REQUIRE_PG === '1' && !url) {
  throw new Error('Achievement payout migration PostgreSQL URL required');
}
const describePg = url ? describe : describe.skip;
const folder = 'drizzle/migrations';
const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8'));
const tag = '0030_achievement_payout_nonce_unique';
const position = journal.entries.findIndex((entry: any) => entry.tag === tag);
const migration = readFileSync(`${folder}/${tag}.sql`, 'utf8');
const indexName = 'idx_achievement_payout_nonce_unique';

describePg('achievement payout full-journal migrations (#1477)', () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let database: string;
  let prefixFolder: string;
  const migrateActual = () => migrate(drizzle(pool), { migrationsFolder: folder });
  const receipts = async () => (await pool.query(
    'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id'
  )).rows;
  const liabilities = async () => (await pool.query(
    'SELECT * FROM contributor_rewards ORDER BY id'
  )).rows;
  const index = async () => (await pool.query(`
    SELECT i.indisunique, i.indisvalid,
      pg_get_expr(i.indexprs, i.indrelid) AS expression,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i WHERE i.indexrelid = $1::regclass
  `, [`public.${indexName}`])).rows[0];

  beforeAll(async () => {
    // This is the same disposable loopback service URL as the existing CI
    // real-PG step; never run this CREATE/DROP DATABASE harness on a live DB.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url!).hostname)) {
      throw new Error('Achievement payout migration tests require disposable loopback PostgreSQL');
    }
    expect(position).toBe(30);
    expect(journal.entries.map((entry: any) => entry.idx)).toEqual(
      journal.entries.map((_: any, i: number) => i)
    );
    prefixFolder = mkdtempSync(join(tmpdir(), 'achievement-payout-full-journal-'));
    mkdirSync(join(prefixFolder, 'meta'));
    const prefix = journal.entries.slice(0, position);
    writeFileSync(join(prefixFolder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: prefix }));
    for (const entry of prefix) {
      writeFileSync(join(prefixFolder, `${entry.tag}.sql`), readFileSync(`${folder}/${entry.tag}.sql`));
    }
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
  });

  beforeEach(async () => {
    database = `sol5_1477_${process.pid}_${randomUUID().replace(/-/g, '')}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    const connection = new URL(url!);
    connection.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: connection.toString(), max: 2 });
    // No extracted baseline table or pre-created prerequisite: apply every
    // committed 0000..0029 SQL file, in journal order, through Drizzle.
    await migrate(drizzle(pool), { migrationsFolder: prefixFolder });
    const expected = readMigrationFiles({ migrationsFolder: prefixFolder });
    expect(await receipts()).toEqual(expected.map(entry => ({
      hash: entry.hash, created_at: String(entry.folderMillis),
    })));
    await pool.query("INSERT INTO users (id, username, wallet_address) VALUES (1, 'synthetic-1477', 'synthetic-wallet')");
    await pool.query(`INSERT INTO contributor_rewards (user_id, contributor_type, amount, metadata)
      VALUES (1, 'achievement', 10, $1::jsonb)`, [JSON.stringify({
      payoutAuthorization: { nonce: '01'.repeat(32) }, settlement: 'settled',
    })]);
  }, 30_000);

  afterEach(async () => {
    await pool?.end();
    if (database) await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  });
  afterAll(async () => {
    await admin?.end();
    if (prefixFolder) rmSync(prefixFolder, { recursive: true });
  });

  it('applies the full journal chain through 0030, preserves liabilities and journals once', async () => {
    const before = await liabilities();
    await migrateActual();
    const expected = readMigrationFiles({ migrationsFolder: folder });
    expect(await receipts()).toEqual(expected.map(entry => ({
      hash: entry.hash, created_at: String(entry.folderMillis),
    })));
    expect(await liabilities()).toEqual(before);
    expect(await index()).toMatchObject({ indisunique: true, indisvalid: true });
    const applied = await receipts();
    await migrateActual();
    expect(await receipts()).toEqual(applied);
    await expect(pool.query(`INSERT INTO contributor_rewards (user_id, contributor_type, amount, metadata)
      SELECT user_id, contributor_type, amount, metadata FROM contributor_rewards`))
      .rejects.toMatchObject({ code: '23505' });
    expect(await liabilities()).toEqual(before);
  });

  it.each(['matching', 'wrong'])('refuses a hand-created %s index without concealing drift; controlled replacement succeeds', async kind => {
    if (kind === 'matching') await pool.query(migration);
    else await pool.query(`CREATE INDEX "${indexName}" ON contributor_rewards (user_id)`);
    const originalIndex = await index();
    const before = await liabilities();
    const applied = await receipts();
    await expect(migrateActual()).rejects.toMatchObject({ cause: { code: '42P07' } });
    expect(await receipts()).toEqual(applied);
    expect(await liabilities()).toEqual(before);
    expect(await index()).toEqual(originalIndex);

    // Operator remedy only in this disposable control: pause all writers,
    // preserve/inspect the old definition, then replace via actual migration.
    await pool.query(`DROP INDEX "${indexName}"`);
    await migrateActual();
    expect(await receipts()).toHaveLength(journal.entries.length);
    expect(await liabilities()).toEqual(before);
    expect(await index()).toMatchObject({ indisunique: true, indisvalid: true });
    expect((await index()).expression).toContain('payoutAuthorization');
    expect((await index()).predicate).toContain('achievement');
    await expect(pool.query(`INSERT INTO contributor_rewards (user_id, contributor_type, amount, metadata)
      SELECT user_id, contributor_type, amount, metadata FROM contributor_rewards`))
      .rejects.toMatchObject({ code: '23505' });
  });
});
