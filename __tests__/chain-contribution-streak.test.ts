/**
 * The leaderboard's streak tab: which address had a real weather contribution settle in a block, the
 * backfill of blocks indexed before that was recorded, and (with CHAIN_REWARD_TEST_PORT, CI service
 * container) the streak SQL against real PostgreSQL.
 */
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { parseContributionBlock } from '../server/services/chain-rewards/contribution-parser.js';
import { runRewardIndexOnce } from '../server/services/chain-rewards/indexer.js';
import { withRewardStore, type IndexStore } from '../server/services/chain-rewards/store.js';
import { createWeatherLeaderboardRouter } from '../server/routes/weather-leaderboard-routes.js';

const hash = (n: number) => n.toString(16).padStart(64, '0');
const genesis = hash(1);
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const bytes = (a: string) => Array.from(Buffer.from(a.slice(2), 'hex'));
const entry = (id: string, who: string, over: Record<string, unknown> = {}) => ({ address: bytes(who), amount: 5, reason: `contribution:${id}`, station_id: 'st', provenance_class: 'real', ...over });
const settlement = (id: string, h: number) => ({ decision_id: id, finalization_height: h, allocations: [{ attester_id: 'c'.repeat(40), amount: 1 }] });
function wire(h: number, entries: unknown[], settled: string[], timestamp = '2026-11-02T12:00:00Z'): string {
  const metadata = settled.length === 0 ? {} : { reward_entries: JSON.stringify(entries), attester_settlements: JSON.stringify(settled.map(id => settlement(id, h))) };
  return JSON.stringify({ data: { height: h, hash: hash(h), prev_block_hash: hash(h - 1), timestamp, metadata } });
}

describe('parseContributionBlock', () => {
  test('returns the address of a settled real contribution', () => {
    expect(parseContributionBlock(wire(2, [entry('a', addr(0xa1))], ['a']), 2).payees).toEqual([addr(0xa1)]);
  });
  test('a pending decision with no settlement in this block is not a payee', () => {
    expect(parseContributionBlock(wire(2, [entry('a', addr(0xa1)), entry('b', addr(0xb2))], ['a']), 2).payees).toEqual([addr(0xa1)]);
  });
  test('synthetic, unclassified, zero-amount and forecast records are not payees', () => {
    const entries = [
      entry('s', addr(1), { provenance_class: 'synthetic' }), entry('u', addr(2), { provenance_class: 'unclassified' }),
      entry('z', addr(3), { amount: 0 }), { ...entry('f', addr(4)), reason: 'forecast:f' },
    ];
    expect(parseContributionBlock(wire(2, entries, ['s', 'u', 'z', 'f']), 2).payees).toEqual([]);
  });
  test('one address settling twice in a block counts once, and addresses are normalised', () => {
    const entries = [entry('a', addr(0xa1)), entry('b', addr(0xa1), { address: addr(0xa1).toUpperCase().replace('0X', '0x') })];
    expect(parseContributionBlock(wire(2, entries, ['a', 'b']), 2).payees).toEqual([addr(0xa1)]);
  });
  test('malformed input never throws', () => {
    expect(parseContributionBlock('not json', 2).payees).toEqual([]);
    expect(parseContributionBlock(wire(3, [entry('a', addr(1))], ['a']), 2).payees).toEqual([]);
    expect(parseContributionBlock(JSON.stringify({ data: { height: 2, metadata: { reward_entries: '{', attester_settlements: '[]' } } }), 2).payees).toEqual([]);
    expect(parseContributionBlock(wire(2, ['junk', { reason: 7 }, entry('a', addr(1), { address: 'nope' })], ['a']), 2).payees).toEqual([]);
  });
});

describe('contribution backfill in the index pass', () => {
  const tipBlock = (h: number) => JSON.stringify({ data: { height: h, hash: hash(h), prev_block_hash: hash(h - 1), timestamp: '2026-11-02T12:00:00Z', producer_pubkey: [], metadata: {} } });
  function fakeStore(unscanned: number[]) {
    const scanned: number[] = [];
    const delays: Array<number | null> = [];
    const store: IndexStore = {
      state: async () => ({ height: 5, hash: hash(5), ready: true, probe: null }),
      block: async h => ({ hash: hash(h) }), beginPass: async () => {}, reserveRead: async () => {}, probe: async () => {}, rewind: async () => {}, append: async () => {}, status: async () => {},
      finishPass: async (_status, lag) => { delays.push(lag); return 0; },
      unscannedContributionBlocks: async limit => ({ heights: unscanned.slice(0, limit), remaining: unscanned.length }),
      scanContributionBlock: async b => { scanned.push(b.height); },
    };
    return { store, scanned, delays };
  }
  const run = (store: IndexStore, read: (h: number) => Promise<{ status: number; raw: string }>) =>
    runRewardIndexOnce({ store, read, genesis: hash(1), tip: async () => 5, sleep: async () => {} });
  const ok = async (h: number) => ({ status: 200, raw: tipBlock(h) });

  test('scans what the read budget allows and reports the rest as lag', async () => {
    const heights = Array.from({ length: 100 }, (_, i) => i + 1);
    const { store, scanned, delays } = fakeStore(heights);
    const result = await run(store, ok);
    expect(result.status).toBe('ok');
    expect(result.reads).toBeLessThanOrEqual(30);
    expect(scanned.length).toBe(27);
    expect(delays).toEqual([73]);
  });
  test('a block that will not parse stops the backfill, not the pass', async () => {
    const { store, scanned } = fakeStore([3, 4]);
    const result = await run(store, async h => (h === 3 ? { status: 200, raw: 'not json' } : ok(h)));
    expect(result.status).toBe('ok');
    expect(scanned).toEqual([]);
  });
  test('a rate-limited node backs the pass off as usual', async () => {
    const { store } = fakeStore([3]);
    const result = await run(store, async h => (h === 3 ? { status: 429, raw: '' } : ok(h)));
    expect(result.status).toBe('rate_limited');
  });
  test('a store without the backfill methods is unaffected', async () => {
    const { store } = fakeStore([]);
    delete store.unscannedContributionBlocks; delete store.scanContributionBlock;
    expect((await run(store, ok)).status).toBe('ok');
  });
});

const port = process.env.CHAIN_REWARD_TEST_PORT;
(port ? describe : describe.skip)('real PostgreSQL: streak rows and the leaderboard SQL', () => {
  const schema = 'chain_contribution_streak_test';
  const pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres', options: `-c search_path=${schema},public` });
  const day = (ago: number) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
  const wallet = (byte: string) => `0x${byte.repeat(20)}`;
  const [A, B, C, D] = ['a1', 'b2', 'c3', 'd4'].map(wallet);
  const name = (a: string) => `WeatherNode-${a.slice(2, 8).toUpperCase()}`;
  // A: 3 days ending today, after a gap. B: 2 days ending yesterday. C: last settled 2 days ago, so broken.
  // D: 9 days ending today, longer than a 7d board. A's today settles twice, which must count once.
  const plan: Array<[string, number]> = [[A, 6], [A, 2], [A, 1], [A, 0], [A, 0], [B, 2], [B, 1], [C, 2], ...[8, 7, 6, 5, 4, 3, 2, 1, 0].map((ago): [string, number] => [D, ago])];
  const app = express();
  app.use('/lb', createWeatherLeaderboardRouter({
    db: { execute: async (sql, params) => pool.query(sql, params as any[]) as any },
    cache: null, rateLimit: null, fetchCore4Json: async () => ({ ok: false, status: 503, payload: {} }), readerToken: () => undefined,
    rewardChain: () => ({ chainId: '888', genesis }),
  }));
  const board = async (q = '') => (await request(app).get(`/lb?metric=streak${q}`)).body.entries.map((e: any) => [e.value, e.rank, e.displayName]);

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE users (id serial PRIMARY KEY, wallet_address text, display_name text);
      CREATE TABLE weather_submissions (id serial PRIMARY KEY, user_id int, country text, city text, latitude numeric, longitude numeric, submitted_at timestamptz DEFAULT now());`);
    for (const f of ['0031_chain_role_reward_index', '0032_operator_role_labels', '0033_chain_role_payee_aliases', '0034_chain_reward_catchup_schedule', '0035_chain_forecast_index', '0042_chain_contribution_payees']) {
      await pool.query(readFileSync(`drizzle/migrations/${f}.sql`, 'utf8'));
    }
    await pool.query(`INSERT INTO chain_reward_index_state(chain_id,genesis_hash) VALUES ('888',$1)`, [genesis]);
    let height = 1;
    for (const [who, ago] of plan) {
      await pool.query(`INSERT INTO chain_reward_blocks(chain_id,genesis_hash,height,block_hash,prev_hash,block_time,parser_version,contribution_scanned) VALUES ('888',$1,$2,$3,$4,$5,1,true)`, [genesis, height, hash(height), hash(height - 1), `${day(ago)}T12:00:00Z`]);
      await pool.query(`INSERT INTO chain_contribution_payees(chain_id,genesis_hash,height,block_hash,contributor_address,day) VALUES ('888',$1,$2,$3,$4,$5)`, [genesis, height, hash(height), who, day(ago)]);
      height++;
    }
  }, 60000);
  afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });

  test('current streak: consecutive days ending today or yesterday; a broken run is gone', async () => {
    expect(await board('&period=30d')).toEqual([[9, 1, name(D)], [3, 2, name(A)], [2, 3, name(B)]]);
  });
  test('the period limits the days counted', async () => {
    expect(await board('&period=7d')).toEqual([[7, 1, name(D)], [3, 2, name(A)], [2, 3, name(B)]]);
    expect(await board('&period=all')).toEqual(await board('&period=30d'));
  });
  test('a geo filter keeps only addresses with a submission there; names and geo come from the user row', async () => {
    const { rows } = await pool.query(`INSERT INTO users(wallet_address, display_name) VALUES ($1, 'Rain gauge') RETURNING id`, [A.toUpperCase().replace('0X', '0x')]);
    await pool.query(`INSERT INTO weather_submissions(user_id, country, city) VALUES ($1, 'NO', 'Bergen')`, [rows[0].id]);
    expect(await board('&period=30d&country=NO')).toEqual([[3, 1, 'Rain gauge']]);
    const res = await request(app).get('/lb?metric=streak&period=30d&country=NO');
    expect(res.body.entries[0]).toMatchObject({ country: 'NO', city: 'Bergen', streak: 3 });
    expect(await board('&period=30d&country=SE')).toEqual([]);
  });
  test('no rows while any block of this chain is unscanned', async () => {
    await pool.query(`UPDATE chain_reward_blocks SET contribution_scanned=false WHERE height=1`);
    expect(await board('&period=30d')).toEqual([]);
    await pool.query(`UPDATE chain_reward_blocks SET contribution_scanned=true WHERE height=1`);
    expect((await board('&period=30d')).length).toBe(3);
  });
  test('a reorg rewind removes the payee rows with their block', async () => {
    await pool.query(`DELETE FROM chain_reward_blocks WHERE chain_id='888' AND height=1`);
    expect((await pool.query('SELECT count(*)::int AS n FROM chain_contribution_payees WHERE height=1')).rows[0].n).toBe(0);
  });
  test('the indexer records payees on append, and the backfill restores a block indexed without them', async () => {
    const other = hash(2);
    const blocks: Record<number, string> = {
      1: wire(1, [], []).replace(`"hash":"${hash(1)}"`, `"hash":"${other}"`),
      2: wire(2, [entry('x', A)], ['x']).replace(`"prev_block_hash":"${hash(1)}"`, `"prev_block_hash":"${other}"`).replace(`"hash":"${hash(2)}"`, `"hash":"${hash(22)}"`),
    };
    const index = () => withRewardStore(pool, '999', other, store => runRewardIndexOnce({ store, read: async h => ({ status: 200, raw: blocks[h] }), genesis: other, tip: async () => 2, sleep: async () => {} }));
    expect((await index())!.status).toBe('ok');
    const payees = () => pool.query(`SELECT height::int, contributor_address, day::text FROM chain_contribution_payees WHERE chain_id='999'`);
    expect((await payees()).rows).toEqual([{ height: 2, contributor_address: A, day: '2026-11-02' }]);

    await pool.query(`DELETE FROM chain_contribution_payees WHERE chain_id='999'`);
    await pool.query(`UPDATE chain_reward_blocks SET contribution_scanned=false WHERE chain_id='999'`);
    await pool.query(`UPDATE chain_reward_index_state SET next_run_at=now() WHERE chain_id='999'`);
    expect((await index())!.status).toBe('ok');
    expect((await payees()).rows).toEqual([{ height: 2, contributor_address: A, day: '2026-11-02' }]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM chain_reward_blocks WHERE chain_id='999' AND NOT contribution_scanned`)).rows[0].n).toBe(0);
  }, 60000);
});
