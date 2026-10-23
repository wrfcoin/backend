/**
 * Forecaster track record (wrfcoin/core4#3604, Phase A item A4): tolerant forecast extraction from the
 * reward indexer's block reads, the read model's honesty rules, and the public route's anonymity rules.
 * The real-PostgreSQL section runs only with CHAIN_REWARD_TEST_PORT (CI service container).
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { parseForecastBlock, forecasterAddress } from '../server/services/chain-rewards/forecast-parser.js';
import { parseRewardBlock, type RewardBlock } from '../server/services/chain-rewards/parser.js';
import { runRewardIndexOnce } from '../server/services/chain-rewards/indexer.js';
import { withRewardStore, type IndexStore } from '../server/services/chain-rewards/store.js';
import { passDelayMs } from '../server/services/chain-rewards/scheduling.js';
import { createForecasterStatsSource, SKILL_REASON, type ForecasterStatsSource } from '../server/services/chain-rewards/forecaster-stats.js';
import { createForecastersRouter } from '../server/routes/forecasters-routes.js';
import { createCapabilitiesRouter } from '../server/routes/capabilities-routes.js';
import { profileKeyFor, shortAddress } from '../server/utils/contributor-alias.js';
const { stationAlias } = require('../server/utils/station-alias.js');

const hash = (n: number) => n.toString(16).padStart(64, '0');
const genesis = hash(1);
const key = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const bytes = (address: string) => Array.from(Buffer.from(address.slice(2), 'hex'));
const entry = (over: Record<string, unknown> = {}) => ({ address: bytes(addr(0xa1)), amount: 123456789, reason: 'forecast:c1', station_id: 'st-1', provenance_class: 'real', ...over });
function wire(h: number, metadata: Record<string, unknown> = {}, timestamp = '2026-10-11T00:00:00Z', blockHash = hash(h), prev = hash(h - 1)): string {
  return JSON.stringify({ data: { height: h, hash: blockHash, prev_block_hash: prev, timestamp, producer_pubkey: [...Buffer.from(key, 'hex')], metadata } });
}
const withEntries = (h: number, entries: unknown[], extra: Record<string, unknown> = {}, timestamp?: string) =>
  wire(h, { reward_entries: JSON.stringify(entries), ...extra }, timestamp);

const saved = { ...process.env };
beforeEach(() => { process.env.CHAIN_REWARD_INDEX_ENABLED = 'true'; process.env.WRFCOIN_PUBLIC_ALIAS_SECRET = 'synthetic-public-alias-secret-for-a4-tests'; process.env.JWT_SECRET = 'synthetic-jwt-secret-for-a4-tests-0123456789'; });
afterAll(() => { for (const k of ['CHAIN_REWARD_INDEX_ENABLED', 'WRFCOIN_PUBLIC_ALIAS_SECRET', 'JWT_SECRET', 'WRFCOIN_OPERATOR_TOKEN']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('forecast extraction from reward_entries (tolerant)', () => {
  test('address accepts the chain byte array and a hex string, lowercased', () => {
    expect(forecasterAddress(bytes(addr(0xa1)))).toBe(addr(0xa1));
    expect(forecasterAddress('0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1')).toBe('0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1');
    expect(forecasterAddress(bytes(addr(1)).slice(1))).toBeNull();
    expect(forecasterAddress([...bytes(addr(1)).slice(1), 256])).toBeNull();
    expect(forecasterAddress('0x12')).toBeNull();
  });
  test('forecast decisions are extracted; contribution decisions are ignored; receipt fields are null when absent', () => {
    const b = parseForecastBlock(withEntries(2, [entry(), entry({ reason: 'contribution:x', station_id: 'st-2' }), entry({ reason: 'forecast:c2', address: addr(0xb2), amount: '5', provenance_class: 'synthetic' })]), 2);
    expect(b.skipped).toBe(0);
    expect(b.decisions).toEqual([
      { commitId: 'c1', forecaster: addr(0xa1), stationId: 'st-1', amount: '123456789', provenanceClass: 'real', skillScore: null, rmse: null, mae: null, bias: null, horizonHours: null, variables: null },
      { commitId: 'c2', forecaster: addr(0xb2), stationId: 'st-1', amount: '5', provenanceClass: 'synthetic', skillScore: null, rmse: null, mae: null, bias: null, horizonHours: null, variables: null },
    ]);
  });
  test('u128 amounts stay exact; a repeated commit within one block is one observation', () => {
    const big = (1n << 100n).toString();
    const b = parseForecastBlock(withEntries(2, [entry({ amount: BigInt(big) }), entry()].map(e => ({ ...e, amount: e.amount.toString() }))), 2);
    // JSON.stringify of a string amount: the parser accepts the digit string too.
    expect(b.decisions.map(d => d.amount)).toEqual([big]);
  });
  test.each([
    [{ reason: 'forecast:' }], [{ address: 'nope' }], [{ amount: -1 }], [{ amount: 1.5 }], [{ provenance_class: 'maybe' }], [{ station_id: 7 }], ['not an object'],
  ])('a malformed forecast record is skipped and counted, never thrown: %j', (bad) => {
    const b = parseForecastBlock(withEntries(2, [typeof bad === 'string' ? bad : entry(bad), entry({ reason: 'forecast:ok' })]), 2);
    expect(b.skipped).toBe(1);
    expect(b.decisions.map(d => d.commitId)).toEqual(['ok']);
  });
  test('malformed reward_entries or envelope never throw', () => {
    expect(parseForecastBlock(wire(2, { reward_entries: '{' }), 2)).toMatchObject({ decisions: [], skipped: 1 });
    expect(parseForecastBlock(wire(2, { reward_entries: 5 as any }), 2)).toMatchObject({ decisions: [], skipped: 1 });
    expect(parseForecastBlock('{', 2)).toMatchObject({ decisions: [], skipped: 1 });
    expect(parseForecastBlock(wire(3), 2)).toMatchObject({ decisions: [], skipped: 1 });
    expect(parseForecastBlock(wire(2), 2)).toEqual({ decisions: [], skipped: 0, stats: { mintedCount: null, mintedTotal: null, withReceiptCount: null, baselineCount: null } });
  });
  test('block counters are copied as digit strings; a malformed counter is skipped', () => {
    const b = parseForecastBlock(wire(2, { forecast_rewards_decided_count: '3', forecast_rewards_decided_total: '900', forecast_rewards_with_receipt_count: '1', forecast_rewards_baseline_count: 'two' }), 2);
    expect(b.stats).toEqual({ mintedCount: '3', mintedTotal: '900', withReceiptCount: '1', baselineCount: null });
    expect(b.skipped).toBe(1);
  });
  test('receipt metrics and manifest are read when a future node exposes them', () => {
    const b = parseForecastBlock(withEntries(2, [entry({ verification_receipt: { metrics: { skill_score: 0.75, rmse: 1.5, mae: 1.25, bias: -0.1 } }, manifest: { horizon_hours: 24, output_variables: ['temperature_c'] } })]), 2);
    expect(b.decisions[0]).toMatchObject({ skillScore: 0.75, rmse: 1.5, mae: 1.25, bias: -0.1, horizonHours: 24, variables: ['temperature_c'] });
    expect(parseForecastBlock(withEntries(2, [entry({ verification_receipt: { metrics: { skill_score: 1.5 } } })]), 2).decisions[0].skillScore).toBeNull();
  });
  test('the money parser is unchanged by forecast metadata', () => {
    const raw = withEntries(2, [entry()], { forecast_rewards_decided_count: '1' });
    expect(parseRewardBlock(raw, 2).payouts).toEqual([]);
    expect(parseRewardBlock(raw, 2)).not.toHaveProperty('forecast');
  });
});

class MemoryStore implements IndexStore {
  blocks = new Map<number, RewardBlock>(); states: string[] = [];
  async state() { const height = Math.max(0, ...this.blocks.keys()); return { height, hash: this.blocks.get(height)?.hash ?? null, ready: true, probe: null }; }
  async block(h: number) { return this.blocks.get(h) ?? null; }
  async beginPass() {} async finishPass(status: string, lag: number | null) { this.states.push(status); return passDelayMs(status, lag, 1, 0, 0); }
  async reserveRead() {} async probe() {} async rewind(h: number) { for (const n of this.blocks.keys()) if (n > h) this.blocks.delete(n); }
  async append(b: RewardBlock) { this.blocks.set(b.height, b); } async status(s: string) { this.states.push(s); }
}

describe('indexer attaches the forecast extraction to every appended block', () => {
  test('decisions ride along with the reward block; a skipped record does not stop the pass', async () => {
    const store = new MemoryStore();
    const blocks: Record<number, string> = { 1: wire(1), 2: withEntries(2, [entry(), 'junk']), 3: withEntries(3, [entry({ reason: 'forecast:c3' })], { forecast_rewards_decided_count: '1', forecast_rewards_decided_total: '77' }) };
    const summary = await runRewardIndexOnce({ store, read: async h => ({ status: 200, raw: blocks[h] }), genesis, tip: async () => 3, sleep: async () => {} });
    expect(summary.status).toBe('ok');
    expect(store.blocks.get(1)!.forecast).toEqual({ decisions: [], skipped: 0, stats: { mintedCount: null, mintedTotal: null, withReceiptCount: null, baselineCount: null } });
    expect(store.blocks.get(2)!.forecast).toMatchObject({ skipped: 1, decisions: [{ commitId: 'c1' }] });
    expect(store.blocks.get(3)!.forecast).toMatchObject({ decisions: [{ commitId: 'c3' }], stats: { mintedCount: '1', mintedTotal: '77' } });
  });
});

function fakeSource(over: Partial<ForecasterStatsSource> = {}): ForecasterStatsSource {
  const header = { units: { currency: 'WRF', decimals: 8, scale: '100000000' }, coverage: { fromHeight: '1', throughHeight: '9', complete: true, skippedRecords: '0' }, asOf: { height: '9', hash: hash(9), time: '2026-10-11T00:00:00.000000Z', checkedAt: '2026-10-11T00:00:01.000Z' }, finalityPolicy: 'confirmed-canonical-with-rollback' };
  return {
    leaderboard: async (period, limit) => ({ ...header, period, status: 'available', rows: [{ rank: 1, address: addr(0xa1), forecasts: '3', forecastsPrevious: '1', forecastsDelta: '2', firstActiveAt: 't', lastActiveAt: 't', skill: { status: 'not_yet_available', reason: SKILL_REASON }, paid: { status: 'not_yet_available', reason: 'x' } }].slice(0, limit) }),
    trackRecord: async address => ({ ...header, address, status: 'available', totals: { forecasts: '3' }, recent: [{ commitId: 'c1', stationId: 'PWS-TOWN-FIRSTNAME-1', blockHeight: '9' }] }),
    resolveAddress: async input => (input.startsWith('0x') ? input.toLowerCase() : input === profileKeyFor(addr(0xa1)) ? addr(0xa1) : null),
    ...over,
  };
}
const app = (source = fakeSource()) => { const a = express(); a.use('/api/forecasters', createForecastersRouter({ source, rateLimit: null })); return a; };
const bearer = (address: string) => `Bearer ${jwt.sign({ sub: address, type: 'access' }, process.env.JWT_SECRET!, { algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '5m' })}`;

describe('GET /api/forecasters', () => {
  test.each([undefined, 'false', 'TRUE'])('default OFF (%s): 503 and the source is never read', async flag => {
    if (flag === undefined) delete process.env.CHAIN_REWARD_INDEX_ENABLED; else process.env.CHAIN_REWARD_INDEX_ENABLED = flag;
    const source = fakeSource({ leaderboard: jest.fn() as any, trackRecord: jest.fn() as any });
    expect((await request(app(source)).get('/api/forecasters')).status).toBe(503);
    expect((await request(app(source)).get(`/api/forecasters/${addr(1)}`)).status).toBe(503);
    expect(source.leaderboard).not.toHaveBeenCalled(); expect(source.trackRecord).not.toHaveBeenCalled();
  });
  test.each(['period=week', 'limit=0', 'limit=101', 'limit=abc'])('invalid query %s is 400', async q => {
    expect((await request(app()).get(`/api/forecasters?${q}`)).status).toBe(400);
  });
  test('anonymous rows carry the short address and profile key, never the full address; skill is honest', async () => {
    const r = await request(app()).get('/api/forecasters?period=30d&limit=10');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=60');
    expect(r.body.period).toBe('30d');
    expect(r.body.rows[0]).toMatchObject({ rank: 1, address: null, isYou: false, shortAddress: shortAddress(addr(0xa1)), profileKey: profileKeyFor(addr(0xa1)), forecasts: '3', forecastsDelta: '2', skill: { status: 'not_yet_available' } });
    expect(JSON.stringify(r.body)).not.toContain(addr(0xa1));
  });
  test('the wallet\'s own login sees its full address and isYou; the operator bearer sees every address', async () => {
    const own = await request(app()).get('/api/forecasters').set('Authorization', bearer(addr(0xa1)));
    expect(own.status).toBe(200); expect(own.body.rows[0]).toMatchObject({ address: addr(0xa1), isYou: true }); expect(own.headers['cache-control']).toBe('private, no-store');
    const other = await request(app()).get('/api/forecasters').set('Authorization', bearer(addr(0xb2)));
    expect(other.body.rows[0]).toMatchObject({ address: null, isYou: false });
    process.env.WRFCOIN_OPERATOR_TOKEN = 'test-operator-token-a4-0123456789abcdef';
    const op = await request(app()).get('/api/forecasters').set('Authorization', `Bearer ${process.env.WRFCOIN_OPERATOR_TOKEN}`);
    expect(op.body.rows[0]).toMatchObject({ address: addr(0xa1), isYou: false });
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
  });
  test('a source failure is 503, never a partial body', async () => {
    const r = await request(app(fakeSource({ leaderboard: async () => { throw new Error('down'); } }))).get('/api/forecasters');
    expect(r.status).toBe(503); expect(r.body).toEqual({ status: 'unavailable', error: { code: 'FORECASTERS_UNAVAILABLE' }, reason: expect.any(String) });
  });
});

describe('GET /api/forecasters/:keyOrAddress', () => {
  test('resolves a profile key or an address; anonymous answer has no full address', async () => {
    const byKey = await request(app()).get(`/api/forecasters/${profileKeyFor(addr(0xa1))}`);
    expect(byKey.status).toBe(200);
    expect(byKey.body).toMatchObject({ totals: { forecasts: '3' }, address: null, shortAddress: shortAddress(addr(0xa1)), profileKey: profileKeyFor(addr(0xa1)), isYou: false });
    expect(JSON.stringify(byKey.body)).not.toContain(addr(0xa1));
    // Station ids can carry personal names: anonymous callers get the opaque st_ alias, the owner the raw id.
    expect(byKey.body.recent[0]).toEqual({ commitId: 'c1', stationId: stationAlias('PWS-TOWN-FIRSTNAME-1'), stationIdIsAlias: true, blockHeight: '9' });
    expect(JSON.stringify(byKey.body)).not.toContain('FIRSTNAME');
    const own = await request(app()).get(`/api/forecasters/${profileKeyFor(addr(0xa1))}`).set('Authorization', bearer(addr(0xa1)));
    expect(own.status).toBe(200); expect(own.body).toMatchObject({ address: addr(0xa1), isYou: true });
    expect(own.body.recent[0]).toMatchObject({ stationId: 'PWS-TOWN-FIRSTNAME-1', stationIdIsAlias: false });
  });
  test('a raw address is never an address -> profileKey oracle: anonymous and wallet callers get the unknown-key 404', async () => {
    const source = fakeSource({ resolveAddress: jest.fn() as any, trackRecord: jest.fn() as any });
    const target = addr(0xa1);
    const unknownKey = await request(app()).get('/api/forecasters/c_000000000000000000000000');
    expect(unknownKey.status).toBe(404);
    for (const auth of [undefined, bearer(target), bearer(addr(0xb2))]) {
      for (const seg of [target, target.toUpperCase().replace('0X', '0x')]) {
        const req = request(app(source)).get(`/api/forecasters/${seg}`);
        const r = auth ? await req.set('Authorization', auth) : await req;
        expect(r.status).toBe(404);
        expect(r.body).toEqual(unknownKey.body);
        expect(JSON.stringify(r.body)).not.toContain(profileKeyFor(target));
        expect(r.body.profileKey).toBeUndefined();
      }
    }
    expect(source.resolveAddress).not.toHaveBeenCalled();
    expect(source.trackRecord).not.toHaveBeenCalled();
  });
  test('the operator bearer may look a forecaster up by address and sees the full record', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'test-operator-token-a4-0123456789abcdef';
    try {
      const r = await request(app()).get(`/api/forecasters/${addr(0xa1)}`).set('Authorization', `Bearer ${process.env.WRFCOIN_OPERATOR_TOKEN}`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ address: addr(0xa1), profileKey: profileKeyFor(addr(0xa1)), isYou: false });
      expect(r.headers['cache-control']).toBe('private, no-store');
    } finally { delete process.env.WRFCOIN_OPERATOR_TOKEN; }
  });
  test.each(['c_000000000000000000000000', 'nonsense', '0x12', 'wrf' + 'a'.repeat(40)])('unknown key or malformed segment %s is 404 without reading the record', async seg => {
    const source = fakeSource({ trackRecord: jest.fn() as any });
    expect((await request(app(source)).get(`/api/forecasters/${seg}`)).status).toBe(404);
    expect(source.trackRecord).not.toHaveBeenCalled();
  });
});

describe('capabilities', () => {
  test('forecastersRead is unavailable while the index is off and configured (unverified) when on', async () => {
    const a = express(); a.use('/api', createCapabilitiesRouter());
    process.env.CHAIN_REWARD_INDEX_ENABLED = 'false';
    expect((await request(a).get('/api/capabilities')).body.features.forecastersRead).toMatchObject({ status: 'unavailable', reasonCode: 'not_wired' });
    process.env.CHAIN_REWARD_INDEX_ENABLED = 'true';
    expect((await request(a).get('/api/capabilities')).body.features.forecastersRead.status).toBe('configured');
  });
});

const port = process.env.CHAIN_REWARD_TEST_PORT;
(port ? describe : describe.skip)('real PostgreSQL: index, rewind cascade and the read model', () => {
  const schema = 'chain_forecast_a4_test';
  const pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres', options: `-c search_path=${schema},public` });
  const now = Date.parse('2026-10-11T12:00:00Z');
  const source = createForecasterStatsSource(pool, '777', genesis, () => now, profileKeyFor);
  const T = (daysAgo: number) => new Date(now - daysAgo * 86400000).toISOString();
  const blocks: Record<number, string> = {
    1: wire(1, {}, T(40)),
    2: withEntries(2, [entry({ reason: 'forecast:old', address: addr(0xa1) })], { forecast_rewards_decided_count: '1', forecast_rewards_decided_total: '100' }, T(35)),
    3: withEntries(3, [entry({ reason: 'forecast:p1', address: addr(0xa1) }), entry({ reason: 'forecast:q1', address: addr(0xb2) })], {}, T(20)),
    4: withEntries(4, [entry({ reason: 'forecast:p1', address: addr(0xa1), amount: 50 }), entry({ reason: 'forecast:q2', address: addr(0xb2) }), entry({ reason: 'forecast:s1', address: addr(0xc3), provenance_class: 'synthetic' }), 'junk'],
      { forecast_rewards_decided_count: '2', forecast_rewards_decided_total: '300', forecast_rewards_with_receipt_count: '1', forecast_rewards_baseline_count: '1' }, T(3)),
    5: withEntries(5, [entry({ reason: 'forecast:p2', address: addr(0xa1) })], { forecast_rewards_decided_count: '1', forecast_rewards_decided_total: '5' }, T(1)),
  };
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    for (const f of ['0031_chain_role_reward_index', '0032_operator_role_labels', '0033_chain_role_payee_aliases', '0034_chain_reward_catchup_schedule', '0035_chain_forecast_index']) {
      await pool.query(readFileSync(`drizzle/migrations/${f}.sql`, 'utf8'));
    }
  }, 60000);
  afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
  const index = (tip: number) => withRewardStore(pool, '777', genesis, store => runRewardIndexOnce({ store, read: async h => ({ status: 200, raw: blocks[h] }), genesis, tip: async () => tip, sleep: async () => {} }));

  test('indexes decisions and counters, serves windows by first observation, cascades on rewind', async () => {
    expect((await index(5))!.status).toBe('ok');
    await pool.query("UPDATE chain_reward_index_state SET checked_at=$1 WHERE chain_id='777'", [new Date(now)]);
    const events = (await pool.query('SELECT height, commit_id, forecaster_address, amount::text AS amount FROM chain_forecast_decision_events ORDER BY height, commit_id')).rows;
    expect(events).toEqual([
      { height: '2', commit_id: 'old', forecaster_address: addr(0xa1), amount: '123456789' },
      { height: '3', commit_id: 'p1', forecaster_address: addr(0xa1), amount: '123456789' }, { height: '3', commit_id: 'q1', forecaster_address: addr(0xb2), amount: '123456789' },
      { height: '4', commit_id: 'p1', forecaster_address: addr(0xa1), amount: '50' }, { height: '4', commit_id: 'q2', forecaster_address: addr(0xb2), amount: '123456789' }, { height: '4', commit_id: 's1', forecaster_address: addr(0xc3), amount: '123456789' },
      { height: '5', commit_id: 'p2', forecaster_address: addr(0xa1), amount: '123456789' },
    ]);
    expect((await pool.query('SELECT height, skipped_records, minted_count FROM chain_forecast_block_stats ORDER BY height')).rows.map(r => [r.height, r.skipped_records, r.minted_count]))
      .toEqual([['1', 0, null], ['2', 0, '1'], ['3', 0, null], ['4', 1, '2'], ['5', 0, '1']]);

    const week = await source.leaderboard('7d', 25);
    // p2 (1 day ago) and q2 (3 days ago) are first seen inside 7 days; p1 was first seen 20 days ago and does not re-count at height 4; s1 is synthetic.
    // Ties break by earliest activity in the window (q2 before p2), then by address.
    expect(week.rows.map((r: any) => [r.address, r.forecasts, r.forecastsPrevious, r.forecastsDelta])).toEqual([[addr(0xb2), '1', '0', '1'], [addr(0xa1), '1', '0', '1']]);
    expect(week.network).toMatchObject({ forecasters: '2', forecasts: '2', rewardsMintedCount: '3', rewardsMintedBaseUnits: '305', rewardsMintedDisplay: '0.00000305', rewardsWithReceiptCount: '1', rewardsBaselineCount: '1', blocksWithoutCounters: '0', blocks: '2' });
    expect(week.coverage).toEqual({ fromHeight: '1', throughHeight: '5', complete: true, skippedRecords: '1' });
    expect(week.rows[0].skill).toEqual({ status: 'not_yet_available', reason: SKILL_REASON });

    const month = await source.leaderboard('30d', 25);
    expect(month.rows.map((r: any) => [r.address, r.forecasts, r.forecastsPrevious])).toEqual([[addr(0xa1), '2', '1'], [addr(0xb2), '2', '0']]);
    const all = await source.leaderboard('all', 1);
    expect(all.rows.map((r: any) => [r.address, r.forecasts, r.forecastsPrevious, r.forecastsDelta])).toEqual([[addr(0xa1), '3', null, null]]);

    const record = await source.trackRecord(addr(0xa1));
    expect(record.totals).toMatchObject({ forecasts: '3', byProvenance: { real: '3', synthetic: '0', unclassified: '0' }, meanSkill: { status: 'not_yet_available' } });
    expect(record.recent.map((r: any) => [r.commitId, r.blockHeight, r.lastHeight, r.timesSeen, r.receipt])).toEqual([['p2', '5', '5', '1', 'not_exposed'], ['p1', '3', '4', '2', 'not_exposed'], ['old', '2', '2', '1', 'not_exposed']]);
    expect(record.series.map((r: any) => r.forecasts)).toEqual(['1', '1']); // p1 (20d) and p2 (1d); old is outside 30 days
    expect(await source.trackRecord(addr(0xc3))).toMatchObject({ totals: { forecasts: '1', byProvenance: { synthetic: '1' } } });
    expect((await source.trackRecord(addr(0x99))).totals).toMatchObject({ forecasts: '0', firstActiveAt: null, lastActiveAt: null });
    expect(await source.resolveAddress(profileKeyFor(addr(0xb2))!)).toBe(addr(0xb2));
    expect(await source.resolveAddress(profileKeyFor(addr(0x99))!)).toBeNull();

    // Reorg: heights 4-5 replaced -> their forecast rows cascade with the blocks.
    const c = await pool.connect();
    try { await withRewardStore(pool, '777', genesis, async store => { await store.rewind(3, hash(3)); }); } finally { c.release(); }
    expect((await pool.query('SELECT count(*)::int AS n FROM chain_forecast_decision_events WHERE height>3')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM chain_forecast_block_stats WHERE height>3')).rows[0].n).toBe(0);
  }, 60000);

  test('a stale or incomplete index is unavailable, never a partial answer', async () => {
    await pool.query("UPDATE chain_reward_index_state SET checked_at=$1 WHERE chain_id='777'", [new Date(now - 3600_000)]);
    await expect(source.leaderboard('7d', 25)).rejects.toThrow('FORECASTERS_UNAVAILABLE');
  });

  test('migration 0035 is reversible: the documented down drops only its tables and the up re-applies', async () => {
    const up = readFileSync('drizzle/migrations/0035_chain_forecast_index.sql', 'utf8');
    const down = /^-- Down \(reversible\): (.+)$/m.exec(up)?.[1];
    expect(down).toBe('DROP TABLE chain_forecast_block_stats; DROP TABLE chain_forecast_decision_events;');
    const tables = async () => (await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'chain_%' ORDER BY table_name", [schema])).rows.map(r => r.table_name);
    const before = await tables();
    expect(before).toEqual(expect.arrayContaining(['chain_forecast_block_stats', 'chain_forecast_decision_events', 'chain_reward_blocks']));
    await pool.query(down!);
    expect(await tables()).toEqual(before.filter(t => !t.startsWith('chain_forecast_')));
    await pool.query(up);
    expect(await tables()).toEqual(before);
  });
});
