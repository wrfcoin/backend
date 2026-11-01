/**
 * Free-play forecast duels (backend#228, #1424; owner demo queue 2026-11-01 item 10): no stakes, wallet
 * JWT for writes, commits linked before the lock, records proven by hash after the reveal, and the chain's
 * finalized forecast reward as the judge. SQL runs on real PostgreSQL in CI (BACKFILL_TEST_PG_URL).
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { JWT_AUDIENCE, JWT_ISSUER } from '../server/auth/jwt-constants';
import { forecastCommitId } from '../server/services/forecast-commit-record';
import { chainReward, duelView, parseCreate, resolvePass, type Core4Get, type Query } from '../server/services/forecast-duels';
import { createDuelRouter } from '../server/routes/duel-routes';

const { stationAlias } = require('../server/utils/station-alias.js');

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const STATION = 'PWS-DULUTH-JANEDOE-01';
const ALIAS = stationAlias(STATION);
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-02T12:00:00Z');
const TARGET = NOW + 10 * HOUR;
const bearer = (address: string) => `Bearer ${jwt.sign({ sub: address, address, role: 'wallet', type: 'access' },
  process.env.JWT_SECRET as string, { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: 600 })}`;
const reply = (status: number, payload: unknown) => ({ ok: status >= 200 && status < 300, status, payload });

describe('rules', () => {
  it('a duel is a known-shape station alias and a target hour 7 h to 7 days out, never a stake', () => {
    expect(parseCreate({ stationAlias: ALIAS, targetAt: new Date(TARGET).toISOString(), opponent: B.toUpperCase().replace('0X', '0x'), stakeAmount: 100 }, NOW))
      .toEqual({ stationAlias: ALIAS, targetAt: TARGET, opponent: B });
    const code = (body: object) => { try { parseCreate(body, NOW); return 'ok'; } catch (e: any) { return e.code; } };
    expect(code({ stationAlias: 'PWS-RAW', targetAt: new Date(TARGET).toISOString() })).toBe('INVALID_STATION');
    expect(code({ stationAlias: ALIAS, targetAt: new Date(TARGET + 60_000).toISOString() })).toBe('INVALID_TARGET');
    expect(code({ stationAlias: ALIAS, targetAt: new Date(NOW + 6 * HOUR).toISOString() })).toBe('INVALID_TARGET');
    expect(code({ stationAlias: ALIAS, targetAt: new Date(NOW + 8 * 24 * HOUR).toISOString() })).toBe('INVALID_TARGET');
    expect(code({ stationAlias: ALIAS, targetAt: new Date(TARGET).toISOString(), opponent: 'bob' })).toBe('INVALID_OPPONENT');
  });

  it('reads the chain judge from reward-evidence and refuses a reward record for another commit', async () => {
    const C = 'c0'.repeat(32);
    const ev = (reward: object | null) => async () => reply(200, { commit_id: C, reward });
    expect(await chainReward(ev({ address: A, amount: '1000', reason: `forecast:${C}`, finalized: true }) as Core4Get, C)).toEqual({ amount: '1000', finalized: true, address: A });
    expect(await chainReward(ev(null) as Core4Get, C)).toBeNull();
    expect(await chainReward(ev({ address: A, amount: '1000', reason: 'contribution:x', finalized: true }) as Core4Get, C)).toBe('upstream');
    expect(await chainReward((async () => reply(404, {})) as Core4Get, C)).toBeNull();
    expect(await chainReward((async () => { throw new Error('down'); }) as Core4Get, C)).toBe('upstream');
  });

  it('the view says free play, hides an invited opponent\'s entry until accepted, and shows forecasts only after a verified record', () => {
    const d = { id: 'x', station_alias: ALIAS, target_at: new Date(TARGET), lock_at: new Date(TARGET - 6 * HOUR), creator_address: A, opponent_address: B,
      status: 'open', outcome: null, created_at: new Date(NOW) };
    const v = duelView(d, [{ address: A, commit_id: 'c'.repeat(64), record_ok: false, forecast_values: { temperature_c: 3 }, entry_status: 'linked' }], NOW);
    expect(v).toMatchObject({ mode: 'free_play', stakes: null, phase: 'open', opponent: null, invitedOpponent: B,
      creator: { address: A, commitId: 'c'.repeat(64), recordVerified: false, forecast: null } });
    expect(duelView({ ...d, status: 'matched' }, [], TARGET - 5 * HOUR).phase).toBe('waiting_for_target');
    expect(duelView({ ...d, status: 'matched' }, [], TARGET + 1).phase).toBe('judging');
    expect(JSON.stringify(v)).not.toMatch(/stakeAmount|escrow|WRF/);
  });
});

describe('/api/duels routes', () => {
  const saved = process.env.FORECAST_DUELS_ENABLED;
  afterAll(() => { if (saved === undefined) delete process.env.FORECAST_DUELS_ENABLED; else process.env.FORECAST_DUELS_ENABLED = saved; });
  beforeEach(() => { process.env.FORECAST_DUELS_ENABLED = 'true'; });
  const statements: string[] = [];
  const query: Query = async (sql) => { statements.push(sql); return { rows: [] }; };
  const app = (get: Core4Get = async () => reply(404, {})) => {
    const a = express();
    a.use('/api/duels', createDuelRouter({ query, get, now: () => NOW, rateLimit: (_q, _s, next) => next() }));
    return a;
  };

  it('is a 404 everywhere while the flag is off', async () => {
    process.env.FORECAST_DUELS_ENABLED = 'false';
    expect((await request(app()).get('/api/duels')).status).toBe(404);
    expect((await request(app()).post('/api/duels').send({})).status).toBe(404);
  });

  it('needs a wallet login to open, accept, link or list mine; validates before the database', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const r of [request(app()).get('/api/duels/mine'), request(app()).post('/api/duels').send({}), request(app()).post(`/api/duels/${id}/accept`),
      request(app()).post(`/api/duels/${id}/forecast`).send({ commitId: 'c'.repeat(64) })]) expect((await r).status).toBe(401);
    const before = statements.length;
    expect((await request(app()).post('/api/duels').set('Authorization', bearer(A)).send({ stationAlias: 'x' })).body.error.code).toBe('INVALID_STATION');
    expect((await request(app()).get('/api/duels/not-a-uuid')).body.error.code).toBe('INVALID_DUEL_ID');
    expect((await request(app()).post(`/api/duels/${id}/record`).send({ commitId: 'bad' })).body.error.code).toBe('INVALID_COMMIT_ID');
    expect(statements.length).toBe(before);
  });

  it('the public board answers from the database', async () => {
    const res = await request(app()).get('/api/duels');
    expect([res.status, res.body]).toEqual([200, { open: [], live: [], finished: [] }]);
  });
});

describe('capabilities: duels', () => {
  const saved = process.env.FORECAST_DUELS_ENABLED;
  afterAll(() => { if (saved === undefined) delete process.env.FORECAST_DUELS_ENABLED; else process.env.FORECAST_DUELS_ENABLED = saved; });
  it('is unavailable (not_wired) while off and configured (unverified, never operational) when on', async () => {
    const { createCapabilitiesRouter } = require('../server/routes/capabilities-routes');
    const a = express();
    a.use('/api', createCapabilitiesRouter());
    process.env.FORECAST_DUELS_ENABLED = 'false';
    expect((await request(a).get('/api/capabilities')).body.features.duels).toEqual({ status: 'unavailable', reasonCode: 'not_wired' });
    process.env.FORECAST_DUELS_ENABLED = 'true';
    expect((await request(a).get('/api/capabilities')).body.features.duels).toEqual({ status: 'configured', reasonCode: 'unverified' });
  });
});

// ---------------------------------------------------------------------------------------------------
// Real PostgreSQL (CI exports BACKFILL_TEST_PG_URL): the migration applies twice; a full duel runs
// through the routes and the resolver against a fake node.
// ---------------------------------------------------------------------------------------------------
const PG_URL = process.env.BACKFILL_TEST_PG_URL;
(PG_URL ? describe : describe.skip)('0041_forecast_duels on real PostgreSQL', () => {
  const postgres = require('postgres');
  const { readFileSync } = require('node:fs');
  const schema = `fd_0041_${process.pid}`;
  let sql: any;
  let query: Query;

  beforeAll(async () => {
    sql = postgres(PG_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    await sql.unsafe('CREATE TABLE weather_stations (station_id text NOT NULL UNIQUE)');
    const migration = readFileSync('drizzle/migrations/0041_forecast_duels.sql', 'utf8');
    for (let i = 0; i < 2; i += 1) for (const statement of migration.split('--> statement-breakpoint')) await sql.unsafe(statement);
    query = async (text, params = []) => ({ rows: await sql.unsafe(text, params as any[]) });
    await query('INSERT INTO weather_stations (station_id) VALUES ($1)', [STATION]);
  });
  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  const record = (forecaster: string, temp: number) => {
    const issued = TARGET / 1000 - 6 * 3600;
    const data = JSON.stringify({ horizon_hours: 6, issued_at: issued, model_id: 'persistence-trend/v1', station_id: STATION, valid_at: TARGET / 1000, values: { temperature_c: temp } });
    const nonce = `kit-${forecaster.slice(2, 10)}-${issued}`;
    return { commitId: forecastCommitId(data, nonce, STATION, issued), nonce, timestamp: issued, data };
  };

  it('open, accept, link before the lock, record after the reveal, judged by the chain reward', async () => {
    process.env.FORECAST_DUELS_ENABLED = 'true';
    const rA = record(A, 4.5);
    const rB = record(B, 6.25);
    const chain: Record<string, { status: string; amount: string | null; finalized: boolean; address: string }> = {
      [rA.commitId]: { status: 'committed_pending_reveal', amount: null, finalized: false, address: A },
      [rB.commitId]: { status: 'committed_pending_reveal', amount: null, finalized: false, address: B },
    };
    const get: Core4Get = async (path) => {
      const id = path.split('/')[3];
      const c = chain[id];
      if (!c) return reply(404, {});
      if (path.endsWith('/status')) return reply(200, { commit_id: id, station_id: STATION, contribution_type: 'forecast', status: c.status });
      return reply(200, { commit_id: id, reward: c.amount === null ? null : { address: c.address, amount: c.amount, reason: `forecast:${id}`, finalized: c.finalized } });
    };
    let now = NOW;
    const a = express();
    a.use('/api/duels', createDuelRouter({ query, get, now: () => now, rateLimit: (_q, _s, next) => next() }));

    const opened = await request(a).post('/api/duels').set('Authorization', bearer(A)).send({ stationAlias: ALIAS, targetAt: new Date(TARGET).toISOString() });
    expect(opened.status).toBe(201);
    const id = opened.body.duel.id;
    expect((await request(a).post('/api/duels').set('Authorization', bearer(A)).send({ stationAlias: 'st_000000000000', targetAt: new Date(TARGET).toISOString() })).body.error.code).toBe('UNKNOWN_STATION');
    expect((await request(a).post(`/api/duels/${id}/accept`).set('Authorization', bearer(A))).body.error.code).toBe('OWN_DUEL');
    expect((await request(a).post(`/api/duels/${id}/forecast`).set('Authorization', bearer(B)).send({ commitId: rB.commitId })).body.error.code).toBe('NOT_A_PLAYER');
    expect((await request(a).post(`/api/duels/${id}/accept`).set('Authorization', bearer(B))).body.duel).toMatchObject({ status: 'matched', phase: 'committing' });
    expect((await request(a).get('/api/duels')).body.live.map((d: any) => d.id)).toEqual([id]);

    expect((await request(a).post(`/api/duels/${id}/forecast`).set('Authorization', bearer(A)).send({ commitId: rA.commitId })).status).toBe(200);
    expect((await request(a).post(`/api/duels/${id}/forecast`).set('Authorization', bearer(A)).send({ commitId: rB.commitId })).body.error.code).toBe('ALREADY_LINKED');
    expect((await request(a).post(`/api/duels/${id}/forecast`).set('Authorization', bearer(B)).send({ commitId: rB.commitId })).status).toBe(200);
    // Records before the reveal are refused.
    expect((await request(a).post(`/api/duels/${id}/record`).send(rA)).body.error.code).toBe('NOT_REVEALED');

    // After the target: both revealed; the chain paid A more (A's oracle receipt scored higher).
    now = TARGET + HOUR;
    chain[rA.commitId] = { status: 'reward_finalized', amount: '700000', finalized: true, address: A };
    chain[rB.commitId] = { status: 'reward_finalized', amount: '100000', finalized: false, address: B };
    expect((await request(a).post(`/api/duels/${id}/record`).send({ ...rA, data: `${rA.data}\n` })).body.duel.creator).toMatchObject({ recordVerified: true, forecast: { temperature_c: 4.5 } });
    expect((await request(a).post(`/api/duels/${id}/record`).send(rB)).status).toBe(200);
    // B's reward is not final yet: wait.
    expect(await resolvePass({ query, get, nowMs: now })).toEqual({ voided: 0, resolved: 0, waiting: 1, failed: 0 });
    chain[rB.commitId].finalized = true;
    expect(await resolvePass({ query, get, nowMs: now })).toEqual({ voided: 0, resolved: 1, waiting: 0, failed: 0 });
    const done = (await request(a).get(`/api/duels/${id}`)).body.duel;
    expect(done).toMatchObject({ status: 'resolved', outcome: { result: 'creator', winner: A, reason: 'higher_chain_reward' },
      creator: { chainReward: '700000', chainRewardFinalized: true }, opponent: { chainReward: '100000' } });
    expect((await request(a).get('/api/duels/mine').set('Authorization', bearer(B))).body.duels.map((d: any) => d.id)).toEqual([id]);
  });

  it('voids a duel nobody accepted, and a draw when the chain paid both the baseline', async () => {
    let now = NOW;
    const a = express();
    const rA = record(A, 1);
    const rB = record(B, 2);
    const get: Core4Get = async (path) => {
      const id = path.split('/')[3];
      if (path.endsWith('/status')) return reply(200, { commit_id: id, station_id: STATION, contribution_type: 'forecast', status: now > TARGET ? 'reward_finalized' : 'committed_pending_reveal' });
      return reply(200, { commit_id: id, reward: { address: id === rA.commitId ? A : B, amount: '100000', reason: `forecast:${id}`, finalized: true } });
    };
    a.use('/api/duels', createDuelRouter({ query, get, now: () => now, rateLimit: (_q, _s, next) => next() }));
    const lonely = (await request(a).post('/api/duels').set('Authorization', bearer(A)).send({ stationAlias: ALIAS, targetAt: new Date(TARGET + HOUR).toISOString() })).body.duel.id;
    const id = (await request(a).post('/api/duels').set('Authorization', bearer(A)).send({ stationAlias: ALIAS, targetAt: new Date(TARGET).toISOString(), opponent: B })).body.duel.id;
    // An invited duel cannot be taken by a third wallet.
    expect((await request(a).post(`/api/duels/${id}/accept`).set('Authorization', bearer('0x' + 'c3'.repeat(20)))).body.error.code).toBe('NOT_INVITED');
    await request(a).post(`/api/duels/${id}/accept`).set('Authorization', bearer(B));
    for (const [w, r] of [[A, rA], [B, rB]] as const) {
      expect((await request(a).post(`/api/duels/${id}/forecast`).set('Authorization', bearer(w)).send({ commitId: r.commitId })).status).toBe(200);
    }
    now = TARGET + 3 * HOUR;
    for (const r of [rA, rB]) expect((await request(a).post(`/api/duels/${id}/record`).send(r)).status).toBe(200);
    expect(await resolvePass({ query, get, nowMs: now })).toEqual({ voided: 1, resolved: 1, waiting: 0, failed: 0 });
    expect((await request(a).get(`/api/duels/${lonely}`)).body.duel.outcome).toMatchObject({ result: 'void', reason: 'no_opponent' });
    const draw = (await request(a).get(`/api/duels/${id}`)).body.duel;
    expect(draw.outcome).toMatchObject({ result: 'draw', winner: null, reason: 'equal_chain_reward' });
    expect(draw.outcome.note).toMatch(/0\.1 baseline/);
  });
});
