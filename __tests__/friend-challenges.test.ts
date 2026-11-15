/**
 * Friend challenges (backend#249; owner demo queue 2026-11-01 item 8): the phone screen's contract
 * (mobile#260), wallet-only identity, points only, counts from chain readings. The route section uses a
 * real wallet JWT through the real authenticateToken; SQL is exercised on real PostgreSQL in CI
 * (BACKFILL_TEST_PG_URL).
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { JWT_AUDIENCE, JWT_ISSUER } from '../server/auth/jwt-constants';
import {
  assignTeam,
  challengeView,
  countPass,
  displayName,
  generateInviteCode,
  normalizeAddress,
  normalizeInviteCode,
  parseCreateInput,
  type Core4Get,
  type Query,
} from '../server/services/friend-challenges';
import { createFriendChallengeRouter } from '../server/routes/challenge-routes';

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const NOW = Date.parse('2026-11-02T12:00:00Z');
const bearer = (address: string, extra: object = {}) => `Bearer ${jwt.sign({ sub: address, address, role: 'wallet', type: 'access', ...extra },
  process.env.JWT_SECRET as string, { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: 600 })}`;

describe('input rules', () => {
  it('accepts the phone create form and refuses anything outside it', () => {
    expect(parseCreateInput({ title: ' Coast race ', description: 'Who logs more', format: 'headToHead', targetScore: 50, durationHours: 168 }))
      .toEqual({ title: 'Coast race', description: 'Who logs more', format: 'headToHead', targetScore: 50, durationHours: 168 });
    const code = (body: object) => { try { parseCreateInput(body); return 'ok'; } catch (e: any) { return e.code; } };
    const base = { title: 't', description: '', format: 'team', targetScore: 10, durationHours: 24 };
    expect(code(base)).toBe('ok');
    expect(code({ ...base, title: '' })).toBe('INVALID_TITLE');
    expect(code({ ...base, title: 'x'.repeat(61) })).toBe('INVALID_TITLE');
    expect(code({ ...base, description: 'x'.repeat(201) })).toBe('INVALID_DESCRIPTION');
    expect(code({ ...base, title: 'a\u0007b' })).toBe('INVALID_TEXT');
    expect(code({ ...base, format: 'duel' })).toBe('INVALID_FORMAT');
    expect(code({ ...base, targetScore: 0 })).toBe('INVALID_TARGET');
    expect(code({ ...base, targetScore: 1.5 })).toBe('INVALID_TARGET');
    expect(code({ ...base, durationHours: 0 })).toBe('INVALID_DURATION');
    expect(code({ ...base, durationHours: 24 * 31 })).toBe('INVALID_DURATION');
  });

  it('normalizes addresses and invite codes, and makes codes from an unambiguous alphabet', () => {
    expect(normalizeAddress(A.toUpperCase().replace('0X', '0x'))).toBe(A);
    expect(normalizeAddress('0x123')).toBeNull();
    expect(normalizeInviteCode(' abcd-2345 ')).toBe('ABCD-2345');
    expect(normalizeInviteCode('ABCD2345')).toBeNull();
    expect(generateInviteCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(generateInviteCode(() => Buffer.alloc(8, 0))).toBe('AAAA-AAAA');
    expect(displayName(A)).toBe('Collector A1A1');
  });

  it('balances teams like the phone did: host on North Front, then the smaller team', () => {
    expect(assignTeam([])).toBe('North Front');
    expect(assignTeam(['North Front'])).toBe('Rain Riders');
    expect(assignTeam(['North Front', 'Rain Riders'])).toBe('Rain Riders');
    expect(assignTeam(['North Front', 'Rain Riders', 'Rain Riders'])).toBe('North Front');
  });
});

describe('the phone ChallengeModel view', () => {
  const row = (over: object = {}) => ({ id: 'c1', title: 'Coast race', description: '', format: 'head_to_head', target_score: 50, invite_code: 'ABCD-2345',
    creator_address: A, starts_at: new Date(NOW - 3600e3), ends_at: new Date(NOW + 3600e3), completed_at: null, created_at: new Date(NOW - 3600e3),
    updated_at: new Date(NOW - 3600e3), ...over });
  const part = (address: string, score: number, over: object = {}) => ({ address, score, team_name: null, joined_at: new Date(NOW - 1800e3),
    score_updated_at: new Date(NOW - 60e3), stations: 1, ...over });

  it('is pending with one player, live with two, completed after the end or once frozen', () => {
    expect(challengeView(row(), [part(A, 0)], NOW).status).toBe('pending');
    const live = challengeView(row(), [part(A, 3), part(B, 7)], NOW);
    expect(live).toMatchObject({ status: 'live', format: 'headToHead', targetScore: 50, inviteCode: 'ABCD-2345', metricLabel: 'readings on chain',
      scoring: { source: 'chain', countedAt: new Date(NOW - 60e3).toISOString() } });
    expect(live.participants.map((p) => [p.id, p.name, p.score, p.subtitle])).toEqual([
      [B, 'Collector B2B2', 7, 'Joined by invite code'], [A, 'Collector A1A1', 3, 'Challenge host']]);
    expect(challengeView(row({ ends_at: new Date(NOW - 1) }), [part(A, 3), part(B, 7)], NOW).status).toBe('completed');
    expect(challengeView(row({ completed_at: new Date(NOW - 5) }), [part(A, 3), part(B, 50)], NOW).status).toBe('completed');
  });

  it('a team challenge needs two teams, and says when a wallet has no station', () => {
    const team = row({ format: 'team' });
    expect(challengeView(team, [part(A, 0, { team_name: 'North Front' }), part(B, 0, { team_name: 'North Front' })], NOW).status).toBe('pending');
    const v = challengeView(team, [part(A, 0, { team_name: 'North Front', stations: 0 }), part(B, 0, { team_name: 'Rain Riders' })], NOW);
    expect(v.status).toBe('live');
    expect(v.participants.find((p) => p.id === A)).toMatchObject({ teamName: 'North Front', stations: 0, score: 0 });
    expect(JSON.stringify(v)).not.toMatch(/reward|WRF|payout/i);
  });
});

describe('/api/challenges routes', () => {
  const saved = process.env.FRIEND_CHALLENGES_ENABLED;
  afterAll(() => { if (saved === undefined) delete process.env.FRIEND_CHALLENGES_ENABLED; else process.env.FRIEND_CHALLENGES_ENABLED = saved; });
  beforeEach(() => { process.env.FRIEND_CHALLENGES_ENABLED = 'true'; });

  const statements: string[] = [];
  const query: Query = async (sql) => { statements.push(sql); return { rows: [] }; };
  const app = () => {
    const a = express();
    a.use('/api/challenges', createFriendChallengeRouter({ query, now: () => NOW, rateLimit: (_q, _s, next) => next() }));
    return a;
  };

  it('is a 404 on every path while the flag is off, before any login check', async () => {
    process.env.FRIEND_CHALLENGES_ENABLED = 'false';
    for (const r of [request(app()).get('/api/challenges'), request(app()).post('/api/challenges').send({}), request(app()).get('/api/challenges/code/ABCD-2345')]) {
      expect((await r).status).toBe(404);
    }
  });

  it('needs a wallet login for the caller\'s list and every write; the token\'s wallet is the only identity', async () => {
    const before = statements.length;
    expect((await request(app()).get('/api/challenges')).status).toBe(401);
    expect((await request(app()).post('/api/challenges').send({ title: 't', format: 'team', targetScore: 1, durationHours: 1 })).status).toBe(401);
    expect((await request(app()).post('/api/challenges/join').send({ inviteCode: 'ABCD-2345' })).status).toBe(401);
    expect((await request(app()).post('/api/challenges/sync').send({ delta: 5 })).status).toBe(401);
    // A login token without a wallet address (an operator/session token) cannot act.
    const noWallet = await request(app()).get('/api/challenges').set('Authorization', bearer('unknown', { address: undefined }));
    expect([noWallet.status, noWallet.body.error.code]).toEqual([403, 'WALLET_LOGIN_REQUIRED']);
    expect(statements.length).toBe(before);
  });

  it('validates before touching the database', async () => {
    const before = statements.length;
    const bad = await request(app()).post('/api/challenges').set('Authorization', bearer(A)).send({ title: '', format: 'team', targetScore: 1, durationHours: 1 });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'INVALID_TITLE']);
    const code = await request(app()).post('/api/challenges/join').set('Authorization', bearer(A)).send({ inviteCode: 'nope' });
    expect([code.status, code.body.error.code]).toEqual([400, 'INVALID_CODE']);
    expect((await request(app()).get('/api/challenges/code/nope')).status).toBe(400);
    expect(statements.length).toBe(before);
  });

  it('a public board by code is a 404 when no challenge has it; the caller\'s list is empty at first', async () => {
    expect((await request(app()).get('/api/challenges/code/ABCD-2345')).status).toBe(404);
    const list = await request(app()).get('/api/challenges').set('Authorization', bearer(A));
    expect([list.status, list.body]).toEqual([200, { challenges: [] }]);
    expect(list.headers['cache-control']).toBe('no-store');
  });

  it('answers 503 (no detail) when the database is down', async () => {
    const a = express();
    a.use('/api/challenges', createFriendChallengeRouter({ query: async () => { throw new Error('ECONNREFUSED 127.0.0.1:5432 secret'); }, rateLimit: (_q, _s, next) => next() }));
    const res = await request(a).get('/api/challenges').set('Authorization', bearer(A));
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONN|secret/);
  });
});

describe('capabilities: challenges', () => {
  const saved = process.env.FRIEND_CHALLENGES_ENABLED;
  afterAll(() => { if (saved === undefined) delete process.env.FRIEND_CHALLENGES_ENABLED; else process.env.FRIEND_CHALLENGES_ENABLED = saved; });
  it('is unavailable (not_wired) while off and configured (unverified, never operational) when on', async () => {
    const { createCapabilitiesRouter } = require('../server/routes/capabilities-routes');
    const a = express();
    a.use('/api', createCapabilitiesRouter());
    process.env.FRIEND_CHALLENGES_ENABLED = 'false';
    expect((await request(a).get('/api/capabilities')).body.features.challenges).toEqual({ status: 'unavailable', reasonCode: 'not_wired' });
    process.env.FRIEND_CHALLENGES_ENABLED = 'true';
    expect((await request(a).get('/api/capabilities')).body.features.challenges).toEqual({ status: 'configured', reasonCode: 'unverified' });
  });
});

// ---------------------------------------------------------------------------------------------------
// Real PostgreSQL (CI exports BACKFILL_TEST_PG_URL): the migration applies twice, then two wallets play a
// head-to-head through the routes while the counting pass reads a fake node.
// ---------------------------------------------------------------------------------------------------
const PG_URL = process.env.BACKFILL_TEST_PG_URL;
(PG_URL ? describe : describe.skip)('0040_friend_challenges on real PostgreSQL', () => {
  const postgres = require('postgres');
  const { readFileSync } = require('node:fs');
  const schema = `fc_0040_${process.pid}`;
  let sql: any;
  let query: Query;

  beforeAll(async () => {
    sql = postgres(PG_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    await sql.unsafe('CREATE TABLE weather_stations (station_id text NOT NULL UNIQUE, owner_address text)');
    await sql.unsafe('CREATE TABLE mobile_station_registrations (station_id text NOT NULL UNIQUE, owner_address text NOT NULL)');
    const migration = readFileSync('drizzle/migrations/0040_friend_challenges.sql', 'utf8');
    for (let i = 0; i < 2; i += 1) for (const statement of migration.split('--> statement-breakpoint')) await sql.unsafe(statement);
    query = async (text, params = []) => ({ rows: await sql.unsafe(text, params as any[]) });
  });
  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('create, join, count chain readings, freeze at the target', async () => {
    process.env.FRIEND_CHALLENGES_ENABLED = 'true';
    let now = NOW;
    const a = express();
    a.use('/api/challenges', createFriendChallengeRouter({ query, now: () => now, rateLimit: (_q, _s, next) => next() }));
    await query('INSERT INTO weather_stations (station_id, owner_address) VALUES ($1, $2)', ['PWS-A-1', A.toUpperCase().replace('0X', '0x')]);
    await query('INSERT INTO mobile_station_registrations (station_id, owner_address) VALUES ($1, $2)', ['mobile-b', B]);

    const created = await request(a).post('/api/challenges').set('Authorization', bearer(A))
      .send({ title: 'Coast race', description: '', format: 'headToHead', targetScore: 3, durationHours: 24 });
    expect(created.status).toBe(201);
    const code = created.body.challenges[0].inviteCode;
    expect(created.body.challenges[0]).toMatchObject({ status: 'pending', participants: [{ id: A, stations: 1, score: 0 }] });
    expect((await request(a).post('/api/challenges/join').set('Authorization', bearer(A)).send({ inviteCode: code })).body.error.code).toBe('ALREADY_JOINED');
    const joined = await request(a).post('/api/challenges/join').set('Authorization', bearer(B)).send({ inviteCode: code.toLowerCase() });
    expect(joined.body.challenges[0].status).toBe('live');
    expect((await request(a).post('/api/challenges/join').set('Authorization', bearer('0x' + 'c3'.repeat(20))).send({ inviteCode: code })).body.error.code).toBe('CHALLENGE_FULL');

    // The node: A's station landed 2 readings in the window (+1 synthetic, +1 before the start); B's 3.
    const startSec = NOW / 1000;
    const items: Record<string, any[]> = {
      'PWS-A-1': [{ commit_id: 'a-old', height: 90, observed_at: startSec - 600 }, { commit_id: 'a1', height: 101, observed_at: startSec + 60 },
        { commit_id: 'a2', height: 102, observed_at: startSec + 120 }, { commit_id: 'a-syn', height: 103, observed_at: startSec + 130, provenance_class: 'synthetic' }],
      'mobile-b': [{ commit_id: 'b1', height: 101, observed_at: startSec + 60 }, { commit_id: 'b2', height: 104, observed_at: startSec + 70 },
        { commit_id: 'b3', height: 105, observed_at: startSec + 80 }],
    };
    const get: Core4Get = async (path, q) => {
      if (path === '/blockchain') return { ok: true, status: 200, payload: { ok: true, data: { height: 110 } } };
      const station = decodeURIComponent(path.split('/')[3]);
      const after = Number(q?.after);
      const page = (items[station] ?? []).filter((i) => i.height > after).map((i) => ({ provenance_class: 'real', ...i }));
      return { ok: true, status: 200, payload: { ok: true, data: { items: page, next_after: 110, next_offset: 0, has_more: false } } };
    };
    now = NOW + 600e3;
    expect(await countPass({ query, get, nowMs: now })).toMatchObject({ stations: 2, scanned: 2, failed: 0, recounted: 2, completed: 1 });
    const board = (await request(a).get(`/api/challenges/code/${code}`)).body.challenge;
    expect(board.status).toBe('completed');
    expect(board.participants.map((p: any) => [p.id, p.score])).toEqual([[B, 3], [A, 2]]);
    // Frozen: a later pass changes nothing.
    items['PWS-A-1'].push({ commit_id: 'a3', height: 106, observed_at: startSec + 200 });
    expect(await countPass({ query, get, nowMs: now + 600e3 })).toMatchObject({ stations: 0, recounted: 0, completed: 0 });
    const mine = (await request(a).get('/api/challenges').set('Authorization', bearer(B))).body.challenges;
    expect(mine.map((c: any) => c.inviteCode)).toEqual([code]);
  });
});
