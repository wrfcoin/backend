/**
 * Weekly forecast competition (backend#251): ISO week arithmetic, the public route's flags and anonymity
 * rules, the capability flip, and (with CHAIN_REWARD_TEST_PORT, CI service container) the real-SQL read
 * model: points from first observations, open/scoring/final, freezing, and un-freezing on a reorg rewind.
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { runRewardIndexOnce } from '../server/services/chain-rewards/indexer.js';
import { withRewardStore } from '../server/services/chain-rewards/store.js';
import {
  COMPETITION_RULE, FINALIZE_GRACE_MS, createCompetitionSource, parseWeek, weekLabel, weekStart, weekWindow,
  type CompetitionSource, type Standings,
} from '../server/services/chain-rewards/competition-stats.js';
import { createCompetitionRouter } from '../server/routes/competition-routes.js';
import { createCapabilitiesRouter } from '../server/routes/capabilities-routes.js';
import { profileKeyFor, shortAddress } from '../server/utils/contributor-alias.js';

const hash = (n: number) => n.toString(16).padStart(64, '0');
const genesis = hash(1);
const key = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const bytes = (address: string) => Array.from(Buffer.from(address.slice(2), 'hex'));
const entry = (over: Record<string, unknown> = {}) => ({ address: bytes(addr(0xa1)), amount: 1000, reason: 'forecast:c1', station_id: 'st-1', provenance_class: 'real', ...over });
function wire(h: number, metadata: Record<string, unknown>, timestamp: string, blockHash = hash(h), prev = hash(h - 1)): string {
  return JSON.stringify({ data: { height: h, hash: blockHash, prev_block_hash: prev, timestamp, producer_pubkey: [...Buffer.from(key, 'hex')], metadata } });
}
const withEntries = (h: number, entries: unknown[], timestamp: string, blockHash?: string, prev?: string) =>
  wire(h, { reward_entries: JSON.stringify(entries) }, timestamp, blockHash, prev);

const FLAGS = ['CHAIN_REWARD_INDEX_ENABLED', 'FORECAST_COMPETITIONS_ENABLED', 'WRFCOIN_PUBLIC_ALIAS_SECRET', 'JWT_SECRET', 'WRFCOIN_OPERATOR_TOKEN'];
const saved: Record<string, string | undefined> = Object.fromEntries(FLAGS.map(k => [k, process.env[k]]));
beforeEach(() => {
  process.env.CHAIN_REWARD_INDEX_ENABLED = 'true';
  process.env.FORECAST_COMPETITIONS_ENABLED = 'true';
  process.env.WRFCOIN_PUBLIC_ALIAS_SECRET = 'synthetic-public-alias-secret-for-competition-tests';
  process.env.JWT_SECRET = 'synthetic-jwt-secret-for-competition-tests-0123456789';
});
afterAll(() => { for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('ISO weeks (UTC)', () => {
  test.each([
    ['2026-10-31T23:59:59Z', '2026-W44', '2026-10-26T00:00:00.000Z'], // Saturday
    ['2026-11-02T00:00:00Z', '2026-W45', '2026-11-02T00:00:00.000Z'], // Monday midnight starts a week
    ['2026-11-01T23:59:59.999Z', '2026-W44', '2026-10-26T00:00:00.000Z'], // Sunday is the last day
    ['2027-01-01T12:00:00Z', '2026-W53', '2026-12-28T00:00:00.000Z'], // 2026 has 53 ISO weeks
    ['2025-12-29T00:00:00Z', '2026-W01', '2025-12-29T00:00:00.000Z'], // week 1 can start in December
  ])('%s is %s starting %s', (at, label, monday) => {
    expect(weekLabel(Date.parse(at))).toBe(label);
    expect(new Date(weekStart(Date.parse(at))).toISOString()).toBe(monday);
    expect(new Date(parseWeek(label)!).toISOString()).toBe(monday);
  });
  test('windows are exactly seven days, half-open', () => {
    expect(weekWindow('2026-W45')).toEqual({ week: '2026-W45', from: '2026-11-02T00:00:00.000Z', until: '2026-11-09T00:00:00.000Z' });
  });
  test.each(['2025-W53', '2026-W00', '2026-W54', '2026-45', '1999-W10', 'week'])('%s is not a real ISO week', label => {
    expect(parseWeek(label)).toBeNull();
    expect(weekWindow(label)).toBeNull();
  });
});

function standings(over: Partial<Standings> = {}): Standings {
  return {
    competition: { ...weekWindow('2026-W44')!, title: 'Week 44, 2026 forecast competition', status: 'open', rule: COMPETITION_RULE, final: null },
    asOf: { height: '9', hash: hash(9), time: '2026-10-31T00:00:00.000000Z', checkedAt: '2026-10-31T00:00:01.000Z' },
    coverage: { fromHeight: '1', throughHeight: '9', complete: true, skippedRecords: '0' },
    entrants: 2, forecasts: '5',
    rows: [
      { rank: 1, address: addr(0xa1), points: '3', forecasts: '3', firstAt: 't1', lastAt: 't2' },
      { rank: 2, address: addr(0xb2), points: '2', forecasts: '2', firstAt: 't1', lastAt: 't3' },
    ],
    ...over,
  };
}
function fakeSource(over: Partial<CompetitionSource> = {}): CompetitionSource {
  return {
    standings: async week => (week === '2026-W44' ? standings() : null),
    recent: async () => ({ current: '2026-W44', weeks: [{ ...weekWindow('2026-W44')!, title: 't', status: 'open', entrants: 2, forecasts: '5', leaders: standings().rows }] }),
    currentWeek: () => '2026-W44',
    ...over,
  };
}
const app = (source = fakeSource()) => { const a = express(); a.use('/api/competitions', createCompetitionRouter({ source, rateLimit: null })); return a; };
const bearer = (address: string) => `Bearer ${jwt.sign({ sub: address, type: 'access' }, process.env.JWT_SECRET!, { algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '5m' })}`;

describe('GET /api/competitions', () => {
  test.each([
    ['index off', 'false', 'true'], ['competitions flag unset', 'true', undefined], ['competitions flag not exactly true', 'true', 'TRUE'],
  ])('default OFF (%s): 503 and the source is never read', async (_name, index, comp) => {
    process.env.CHAIN_REWARD_INDEX_ENABLED = index;
    if (comp === undefined) delete process.env.FORECAST_COMPETITIONS_ENABLED; else process.env.FORECAST_COMPETITIONS_ENABLED = comp;
    const source = fakeSource({ standings: jest.fn() as any, recent: jest.fn() as any });
    for (const path of ['/api/competitions', '/api/competitions/current', '/api/competitions/2026-W44']) {
      const r = await request(app(source)).get(path);
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('COMPETITIONS_DISABLED');
    }
    expect(source.standings).not.toHaveBeenCalled(); expect(source.recent).not.toHaveBeenCalled();
  });
  test('current week: anonymous rows have the short address and profile key only, plus the rule', async () => {
    const r = await request(app()).get('/api/competitions/current');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=60');
    expect(r.body.competition).toMatchObject({ week: '2026-W44', status: 'open', rule: { id: 'scored-forecasts-v1' } });
    expect(r.body.competition.rule.prizes).toMatch(/Points only/);
    expect(r.body.rows[0]).toMatchObject({ rank: 1, points: '3', address: null, isYou: false, shortAddress: shortAddress(addr(0xa1)), profileKey: profileKeyFor(addr(0xa1)) });
    expect(r.body.you).toBeNull();
    expect(JSON.stringify(r.body)).not.toContain(addr(0xa1));
    expect(JSON.stringify(r.body)).not.toContain(addr(0xb2));
  });
  test('the wallet\'s own login sees its own row in full, even outside the requested top', async () => {
    const r = await request(app()).get('/api/competitions/current?limit=1').set('Authorization', bearer(addr(0xb2)));
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.body.rows).toHaveLength(1);
    expect(r.body.rows[0]).toMatchObject({ address: null, isYou: false });
    expect(r.body.you).toMatchObject({ rank: 2, address: addr(0xb2), isYou: true });
  });
  test('the operator bearer sees every address', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'test-operator-token-competitions-0123456789';
    const r = await request(app()).get('/api/competitions/2026-W44').set('Authorization', `Bearer ${process.env.WRFCOIN_OPERATOR_TOKEN}`);
    expect(r.body.rows.map((x: any) => x.address)).toEqual([addr(0xa1), addr(0xb2)]);
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
  });
  test('the week list projects its leaders the same way', async () => {
    const r = await request(app()).get('/api/competitions');
    expect(r.status).toBe(200);
    expect(r.body.current).toBe('2026-W44');
    expect(r.body.weeks[0].leaders[0]).toMatchObject({ address: null, profileKey: profileKeyFor(addr(0xa1)) });
    expect(JSON.stringify(r.body)).not.toContain(addr(0xa1));
  });
  test.each(['limit=0', 'limit=101', 'limit=x'])('invalid %s is 400', async q => {
    expect((await request(app()).get(`/api/competitions/current?${q}`)).status).toBe(400);
  });
  test.each(['2026-W99', '2030-W01', 'week-44', '2026-w44'])('unknown or malformed week %s is 404', async week => {
    expect((await request(app()).get(`/api/competitions/${week}`)).status).toBe(404);
  });
  test('a source failure is 503, never a partial body', async () => {
    const down = fakeSource({ standings: async () => { throw new Error('down'); }, recent: async () => { throw new Error('down'); } });
    for (const path of ['/api/competitions', '/api/competitions/current']) {
      const r = await request(app(down)).get(path);
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ status: 'unavailable', error: { code: 'COMPETITIONS_UNAVAILABLE' }, reason: expect.any(String) });
    }
  });
});

describe('capabilities', () => {
  test('competitions is unavailable until both flags are on, then configured (never operational without evidence)', async () => {
    const a = express(); a.use('/api', createCapabilitiesRouter());
    delete process.env.FORECAST_COMPETITIONS_ENABLED;
    expect((await request(a).get('/api/capabilities')).body.features.competitions).toEqual({ status: 'unavailable', reasonCode: 'not_wired' });
    process.env.FORECAST_COMPETITIONS_ENABLED = 'true';
    process.env.CHAIN_REWARD_INDEX_ENABLED = 'false';
    expect((await request(a).get('/api/capabilities')).body.features.competitions.status).toBe('unavailable');
    process.env.CHAIN_REWARD_INDEX_ENABLED = 'true';
    const body = (await request(a).get('/api/capabilities')).body;
    expect(body.features.competitions.status).toBe('configured');
    expect(body.publicReleaseReadiness.requiredCapabilities).not.toContain('competitions');
  });
});

const port = process.env.CHAIN_REWARD_TEST_PORT;
(port ? describe : describe.skip)('real PostgreSQL: weekly competition read model', () => {
  const schema = 'forecast_competition_251_test';
  const pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres', options: `-c search_path=${schema},public` });
  // Chain began Wednesday of W43; "now" is Wednesday of W45.
  let now = Date.parse('2026-11-04T12:00:00Z');
  const source = createCompetitionSource(pool, '777', genesis, () => now);
  const blocks: Record<number, string> = {
    1: wire(1, {}, '2026-10-21T00:00:00Z'),
    // W44: a1 two forecasts, b2 two forecasts but reached 2 later; c3 synthetic never scores.
    2: withEntries(2, [entry({ reason: 'forecast:a-1' }), entry({ reason: 'forecast:b-1', address: bytes(addr(0xb2)) })], '2026-10-27T10:00:00Z'),
    3: withEntries(3, [entry({ reason: 'forecast:a-2' }), entry({ reason: 'forecast:s-1', address: bytes(addr(0xc3)), provenance_class: 'synthetic' })], '2026-10-28T10:00:00Z'),
    4: withEntries(4, [entry({ reason: 'forecast:b-2', address: bytes(addr(0xb2)) }), entry({ reason: 'forecast:a-2' })], '2026-10-29T10:00:00Z'),
    // W45: a-2 is repeated (pending) and must not re-count; b2 one new forecast.
    5: withEntries(5, [entry({ reason: 'forecast:a-2' }), entry({ reason: 'forecast:b-3', address: bytes(addr(0xb2)) })], '2026-11-03T10:00:00Z'),
    6: wire(6, {}, '2026-11-04T11:00:00Z'),
  };
  const index = (tip: number) => withRewardStore(pool, '777', genesis, store => runRewardIndexOnce({ store, read: async h => ({ status: 200, raw: blocks[h] }), genesis, tip: async () => tip, sleep: async () => {} }));
  const fresh = () => pool.query("UPDATE chain_reward_index_state SET checked_at=$1 WHERE chain_id='777'", [new Date(now)]);

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    for (const f of ['0031_chain_role_reward_index', '0032_operator_role_labels', '0033_chain_role_payee_aliases', '0034_chain_reward_catchup_schedule', '0035_chain_forecast_index', '0036_forecast_competitions']) {
      await pool.query(readFileSync(`drizzle/migrations/${f}.sql`, 'utf8'));
    }
  }, 60000);
  afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });

  test('points from first observations; open week live; ended week freezes once indexed past the grace; list stops at genesis', async () => {
    expect((await index(6))!.status).toBe('ok');
    await fresh();

    const w44 = (await source.standings('2026-W44'))!;
    // Block 6 is 2026-11-04T11:00Z, well past W44's end + grace: frozen through height 6.
    expect(w44.competition).toMatchObject({ status: 'final', final: { throughHeight: '6', throughHash: hash(6) } });
    expect(w44.rows.map(r => [r.rank, r.address, r.points])).toEqual([[1, addr(0xa1), '2'], [2, addr(0xb2), '2']]);
    expect(w44).toMatchObject({ entrants: 2, forecasts: '4' });
    expect((await pool.query('SELECT count(*)::int AS n FROM forecast_competition_results')).rows[0].n).toBe(2);

    const w45 = (await source.standings('2026-W45'))!;
    expect(w45.competition).toMatchObject({ status: 'open', final: null });
    expect(w45.rows.map(r => [r.address, r.points])).toEqual([[addr(0xb2), '1']]);
    expect(w45.asOf).toMatchObject({ height: '6' });

    expect(await source.standings('2026-W46')).toBeNull(); // the future
    expect(await source.standings('2026-W42')).toBeNull(); // before the chain's first block
    const w43 = (await source.standings('2026-W43'))!;
    expect(w43.competition.status).toBe('final');
    expect(w43.entrants).toBe(0);

    const list = await source.recent(6);
    expect(list.current).toBe('2026-W45');
    expect(list.weeks.map(w => [w.week, w.status, w.entrants])).toEqual([['2026-W45', 'open', 1], ['2026-W44', 'final', 2], ['2026-W43', 'final', 0]]);
    expect(list.weeks[1].leaders.map(r => r.address)).toEqual([addr(0xa1), addr(0xb2)]);

    // A frozen week is served from its stored rows even while the index is stale.
    await pool.query("UPDATE chain_reward_index_state SET checked_at=$1 WHERE chain_id='777'", [new Date(now - 3600_000)]);
    expect((await source.standings('2026-W44'))!.competition.status).toBe('final');
    await expect(source.standings('2026-W45')).rejects.toThrow('FORECASTERS_UNAVAILABLE');
    await fresh();
  }, 60000);

  test('a week that ended but is not indexed past the grace is `scoring` and is not stored', async () => {
    now = Date.parse('2026-11-09T00:30:00Z'); // W45 ended 30 minutes ago; newest indexed block is 11-04
    await fresh();
    const w45 = (await source.standings('2026-W45'))!;
    expect(w45.competition).toMatchObject({ status: 'scoring', final: null });
    expect((await pool.query("SELECT count(*)::int AS n FROM forecast_competitions WHERE week_label='2026-W45'")).rows[0].n).toBe(0);
    expect(FINALIZE_GRACE_MS).toBe(3600_000);
    now = Date.parse('2026-11-04T12:00:00Z');
    await fresh();
  });

  test('a reorg rewind below the freeze block un-freezes the week; it is recomputed from the replacement chain', async () => {
    await withRewardStore(pool, '777', genesis, async store => { await store.rewind(3, hash(3)); });
    expect((await pool.query("SELECT count(*)::int AS n FROM forecast_competitions WHERE week_label='2026-W44'")).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM forecast_competition_results')).rows[0].n).toBe(0);
    // Replacement 4..6: b2's second forecast vanished.
    blocks[4] = withEntries(4, [entry({ reason: 'forecast:a-2' })], '2026-10-29T10:00:00Z', hash(0x404));
    blocks[5] = withEntries(5, [entry({ reason: 'forecast:b-3', address: bytes(addr(0xb2)) })], '2026-11-03T10:00:00Z', hash(0x405), hash(0x404));
    blocks[6] = wire(6, {}, '2026-11-04T11:00:00Z', hash(0x406), hash(0x405));
    await pool.query("UPDATE chain_reward_index_state SET next_run_at='-infinity'");
    expect((await index(6))!.status).toBe('ok');
    await fresh();
    const w44 = (await source.standings('2026-W44'))!;
    expect(w44.competition).toMatchObject({ status: 'final', final: { throughHeight: '6', throughHash: hash(0x406) } });
    expect(w44.rows.map(r => [r.address, r.points])).toEqual([[addr(0xa1), '2'], [addr(0xb2), '1']]);
  }, 60000);

  test('migration 0036 is reversible: the documented down drops only its tables and the up re-applies', async () => {
    const up = readFileSync('drizzle/migrations/0036_forecast_competitions.sql', 'utf8');
    const down = /^-- Down \(reversible\): (.+)$/m.exec(up)?.[1];
    expect(down).toBe('DROP TABLE forecast_competition_results; DROP TABLE forecast_competitions;');
    const tables = async () => (await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name", [schema])).rows.map(r => r.table_name);
    const before = await tables();
    expect(before).toEqual(expect.arrayContaining(['forecast_competition_results', 'forecast_competitions', 'chain_forecast_decision_events']));
    await pool.query(down!);
    expect(await tables()).toEqual(before.filter(t => !t.startsWith('forecast_competition')));
    await pool.query(up);
    expect(await tables()).toEqual(before);
  });
});
