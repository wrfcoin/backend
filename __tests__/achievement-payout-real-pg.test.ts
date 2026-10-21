/** Disposable PostgreSQL, actual migration + production Drizzle admission SQL. */
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contributorRewards } from '../shared/schema.js';
import { authorizeNewPayout, payoutPreimage } from '../server/services/achievement-payout-authorization.js';

const url = process.env.BACKFILL_TEST_PG_URL;
if (process.env.ACHIEVEMENT_PAYOUT_REQUIRE_PG === '1' && !url) {
  throw new Error('Achievement payout PostgreSQL URL required');
}
const describePg = url ? describe : describe.skip;
const tag = '0030_achievement_payout_nonce_unique';
const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8'));
const entry = journal.entries.find((e: any) => e.tag === tag);
const migration = readFileSync(`drizzle/migrations/${tag}.sql`, 'utf8');
it('registers an unambiguous migration after 0029', () => {
  expect(entry.idx).toBe(30);
  expect(entry.when).toBeGreaterThan(journal.entries.find((e: any) => e.idx === 29).when);
  expect(journal.entries.filter((e: any) => e.idx === 30)).toHaveLength(1);
  expect(journal.entries.filter((e: any) => e.tag.startsWith('0030_'))).toHaveLength(1);
});

describePg('achievement payout against real PostgreSQL (#1475)', () => {
  const schema = `achievement_payout_1475_${process.pid}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let folder: string;
  const keys = generateKeyPairSync('ed25519');
  const configKeys = ['ACHIEVEMENT_PAYOUT_CHAIN_ID', 'ACHIEVEMENT_PAYOUT_PUBLIC_KEY', 'ACHIEVEMENT_PAYOUT_SIGNED_ENABLED'];
  const prior = Object.fromEntries(configKeys.map(k => [k, process.env[k]]));
  const tuple = { achievementId: 'award', claimId: 'ach:v1:1:award', address: 'ab'.repeat(20), amountBaseUnits: 1_000_000_000n };
  const nonce = '01'.repeat(32);
  const auth = { chainId: '777', nonce, signature: sign(null, payoutPreimage(tuple, { chainId: '777', nonce }), keys.privateKey).toString('hex') };
  const metadata = (state = 'pending', address = tuple.address, n = nonce) => ({
    ...tuple, amountBaseUnits: tuple.amountBaseUnits.toString(), address,
    payoutAuthorization: { ...auth, nonce: n }, settlement: state,
  });
  const migrateActual = () => migrate(drizzle(pool), { migrationsFolder: folder, migrationsSchema: schema });
  async function insert(meta: any, amount = 10, userId = 1, type = 'achievement', created = new Date()) {
    return drizzle(pool).insert(contributorRewards).values({ userId, contributorType: type, amount, metadata: meta, createdAt: created }).returning();
  }
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, max: 5, options: `-c search_path=${schema}` });
    await pool.query('CREATE TABLE users (id integer PRIMARY KEY)');
    await pool.query('INSERT INTO users VALUES (1), (2)');
    const baseline = readFileSync('drizzle/migrations/0000_baseline_schema.sql', 'utf8');
    const table = baseline.match(/CREATE TABLE IF NOT EXISTS "contributor_rewards" \([\s\S]*?\n\);/)![0];
    await pool.query(table);
    // Start at the existing reward-table boundary; apply the exact new SQL
    // through the production migrator/journal, without replaying unrelated DDL.
    folder = mkdtempSync(join(tmpdir(), 'achievement-payout-migration-'));
    mkdirSync(join(folder, 'meta'));
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: [entry] }));
    writeFileSync(join(folder, `${tag}.sql`), migration);
    await migrateActual();
    process.env.ACHIEVEMENT_PAYOUT_CHAIN_ID = '777';
    process.env.ACHIEVEMENT_PAYOUT_PUBLIC_KEY = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    process.env.ACHIEVEMENT_PAYOUT_SIGNED_ENABLED = 'true';
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE contributor_rewards');
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    if (folder) rmSync(folder, { recursive: true });
  });
  it('migration journals once and refuses a nonce reused by a different user/recipient/chain', async () => {
    await migrateActual();
    expect((await pool.query(`SELECT * FROM ${schema}.__drizzle_migrations`)).rows).toHaveLength(1);
    await insert(metadata());
    await expect(insert({ ...metadata('pending', 'cd'.repeat(20)), payoutAuthorization: { ...auth, chainId: '778' } }, 10, 2)).rejects.toMatchObject({ cause: { code: '23505' } });
  });
  it('unsigned legacy rows and other contribution types remain outside the nonce index with flag OFF', async () => {
    process.env.ACHIEVEMENT_PAYOUT_SIGNED_ENABLED = 'false';
    try {
      await insert({ settlement: 'settled' });
      await insert(null, 10, 2);
      await insert(metadata(), 10, 1, 'weather');
      await insert(metadata(), 10, 2, 'weather');
      expect((await pool.query('SELECT * FROM contributor_rewards')).rows).toHaveLength(4);
    } finally { process.env.ACHIEVEMENT_PAYOUT_SIGNED_ENABLED = 'true'; }
  });
  it('migration refuses pre-existing duplicate signed nonces without deleting liabilities', async () => {
    await pool.query('DROP INDEX idx_achievement_payout_nonce_unique');
    await pool.query(`TRUNCATE ${schema}.__drizzle_migrations`);
    try {
      await insert(metadata());
      await insert(metadata(), 10, 2);
      await expect(migrateActual()).rejects.toMatchObject({ cause: { code: '23505' } });
      expect((await pool.query('SELECT * FROM contributor_rewards')).rows).toHaveLength(2);
      expect((await pool.query(`SELECT * FROM ${schema}.__drizzle_migrations`)).rows).toHaveLength(0);
    } finally {
      await pool.query('TRUNCATE contributor_rewards');
      await migrateActual();
    }
  });
  it.each(['failed', 'reversed'])('%s liability retains its nonce reservation', async state => {
    await insert(metadata(state));
    await expect(authorizeNewPayout(drizzle(pool), tuple, auth)).rejects.toThrow('authorization refused');
    await expect(insert(metadata(), 10, 2)).rejects.toMatchObject({ cause: { code: '23505' } });
  });
  it.each(['failed', 'reversed'])('%s liabilities retain daily, lifetime and global cap headroom reservations', async state => {
    const cases = [
      { amount: 20, address: tuple.address, created: new Date() },
      { amount: 100, address: tuple.address, created: new Date(Date.now() - 48 * 3600_000) },
      { amount: 250, address: 'cd'.repeat(20), created: new Date() },
    ];
    for (const testCase of cases) {
      await pool.query('TRUNCATE contributor_rewards');
      await insert(metadata(state, testCase.address, '02'.repeat(32)), testCase.amount, 2, 'achievement', testCase.created);
      await expect(authorizeNewPayout(drizzle(pool), tuple, auth)).rejects.toThrow('authorization refused');
    }
  });
  it('empty liabilities permit a new signed reservation through the production SQL', async () => {
    await expect(authorizeNewPayout(drizzle(pool), tuple, auth)).resolves.toEqual(auth);
  });
  it('two admitted transactions with the same nonce and no advisory lock commit exactly one liability', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    let second: Promise<any> | undefined;
    try {
      await Promise.all([a.query('BEGIN'), b.query('BEGIN')]);
      await b.query("SET LOCAL lock_timeout = '5s'");
      const [{ rows: [{ pid: aPid }] }, { rows: [{ pid: bPid }] }] = await Promise.all([
        a.query('SELECT pg_backend_pid() AS pid'), b.query('SELECT pg_backend_pid() AS pid'),
      ]);
      const other = { ...tuple, claimId: 'ach:v1:2:award', address: 'cd'.repeat(20) };
      const otherAuth = { ...auth, signature: sign(null, payoutPreimage(other, auth), keys.privateKey).toString('hex') };
      // Both see an unused nonce before either writes: mocks cannot prove this.
      await Promise.all([authorizeNewPayout(drizzle(a), tuple, auth), authorizeNewPayout(drizzle(b), other, otherAuth)]);
      const first = await drizzle(a).insert(contributorRewards).values({ userId: 1, contributorType: 'achievement', amount: 10, metadata: metadata() }).returning();
      second = drizzle(b).insert(contributorRewards).values({ userId: 2, contributorType: 'achievement', amount: 10, metadata: { ...metadata(), ...other, amountBaseUnits: other.amountBaseUnits.toString(), payoutAuthorization: otherAuth } }).returning().then(
        rows => ({ rows, code: undefined }), error => ({ rows: [], code: error.cause?.code })
      );
      const deadline = Date.now() + 4000;
      let blocked = false;
      while (Date.now() < deadline) {
        const result = await pool.query('SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked', [aPid, bPid]);
        if (result.rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true); // Prove overlap on the DB lock, not timing luck.
      await a.query('COMMIT');
      const loser = await second;
      expect(first).toHaveLength(1);
      expect(loser).toEqual({ rows: [], code: '23505' });
      await b.query('ROLLBACK');
      expect((await pool.query('SELECT user_id FROM contributor_rewards')).rows).toEqual([{ user_id: 1 }]);
    } finally {
      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
      if (second) await second;
      a.release(); b.release();
    }
  });
});
