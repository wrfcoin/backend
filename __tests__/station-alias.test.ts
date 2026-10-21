/**
 * Owner ruling Q5 (2026-09-27): public station aliases.
 * - derivation is pinned (a drift would silently break every public link)
 * - collision handling fails closed
 * - anonymous detail reads accept ONLY an alias; raw id / unknown alias → 404
 * - anonymous list is keyed by alias, including its cursor
 * - the SQL derivation equals the JS one on a real PostgreSQL
 */

import express from 'express';
import request from 'supertest';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  STATION_ALIAS_SQL,
  stationAlias,
  isStationAlias,
  resolveStationAlias,
  findAliasCollisions,
} = require('../server/utils/station-alias');
import { createStationDetailRouter } from '../server/routes/station-detail-routes.js';

describe('stationAlias derivation', () => {
  test('pinned vectors (changing these breaks every public link)', () => {
    expect(stationAlias('PWS-TEST-A')).toBe('st_0e4f722514b9');
    expect(stationAlias('KDLH')).toBe('st_93955d28f3bf');
  });

  test('matches the documented formula and format', () => {
    const id = 'PWS-SOMEWHERE-01';
    const expected = 'st_' + createHash('sha256').update('wrfcoin-station-alias-v1:' + id).digest('hex').slice(0, 12);
    expect(stationAlias(id)).toBe(expected);
    expect(isStationAlias(stationAlias(id))).toBe(true);
    expect(stationAlias(id)).toMatch(/^[A-Za-z0-9_-]{1,64}$/); // the public edge's path regex
    expect(stationAlias(id)).not.toContain('SOMEWHERE');
  });

  test.each(['', 'st_', 'st_0E4F722514B9', 'st_0e4f722514b', 'st_0e4f722514b9a', 'PWS-TEST-A', '../x'])(
    'rejects %p as an alias',
    (value) => expect(isStationAlias(value)).toBe(false)
  );

  test('collision audit: 50,000 distinct ids produce no alias collision', () => {
    const ids = Array.from({ length: 50_000 }, (_, i) => `PWS-STATION-${i}`);
    expect(findAliasCollisions(ids)).toEqual([]);
  });

  test('collision audit reports a true collision, not a duplicate id', () => {
    expect(findAliasCollisions(['A', 'A'])).toEqual([]);
  });
});

describe('resolveStationAlias', () => {
  const alias = stationAlias('PWS-TEST-A');

  test('found only when the row hashes back to the alias', async () => {
    expect(await resolveStationAlias(async () => [{ station_id: 'PWS-TEST-A' }], alias)).toEqual({
      status: 'found',
      stationId: 'PWS-TEST-A',
    });
    expect(await resolveStationAlias(async () => [{ station_id: 'SOMETHING-ELSE' }], alias)).toEqual({
      status: 'not-found',
    });
  });

  test('two rows on one alias (a collision) fail closed', async () => {
    expect(
      await resolveStationAlias(async () => [{ station_id: 'PWS-TEST-A' }, { station_id: 'PWS-OTHER' }], alias)
    ).toEqual({ status: 'ambiguous' });
  });

  test('a malformed alias never reaches the database', async () => {
    const query = jest.fn();
    expect(await resolveStationAlias(query, 'PWS-TEST-A')).toEqual({ status: 'not-found' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /api/stations/:stationId/* alias resolution', () => {
  const REAL = 'PWS-TEST-A';
  const ALIAS = stationAlias(REAL);

  function appWith(opts: { authenticated: boolean; aliasRows?: Array<{ station_id: string }>; lookupThrows?: boolean }) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      execute: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('sha256(')) {
          if (opts.lookupThrows) throw new Error('connection reset');
          return { rows: opts.aliasRows ?? [{ station_id: REAL }] };
        }
        if (sql.includes('weather_data_quality')) {
          return { rows: [{ quality_score: 88, confidence: 0.9, factors: {} }] };
        }
        return { rows: [] };
      }),
    };
    const app = express();
    app.use('/api', createStationDetailRouter({
      db,
      readerToken: () => undefined,
      fetchCore4Json: jest.fn(),
      isAuthenticated: () => opts.authenticated,
    } as any));
    return { app, calls };
  }

  test('anonymous + alias → served, queried with the internal id, body carries no id', async () => {
    const { app, calls } = appWith({ authenticated: false });
    const res = await request(app).get(`/api/stations/${ALIAS}/quality`).expect(200);
    expect(res.body.overall).toBe(88);
    const qualityCall = calls.find((c) => c.sql.includes('weather_data_quality'))!;
    expect(qualityCall.params).toEqual([REAL]);
    expect(JSON.stringify(res.body)).not.toContain(REAL);
  });

  test.each(['observations', 'quality', 'submissions', 'earnings'])(
    'anonymous + raw station id → 404 on %s, and no data query runs',
    async (route) => {
      const { app, calls } = appWith({ authenticated: false });
      const res = await request(app).get(`/api/stations/${REAL}/${route}`).expect(404);
      expect(res.body.error.code).toBe('STATION_NOT_FOUND');
      expect(calls).toEqual([]);
    }
  );

  test('anonymous + unknown alias → 404', async () => {
    const { app } = appWith({ authenticated: false, aliasRows: [] });
    const res = await request(app).get(`/api/stations/${stationAlias('NOPE')}/quality`).expect(404);
    expect(res.body.error.code).toBe('STATION_NOT_FOUND');
  });

  test('colliding alias → 404 (fail closed), no data query', async () => {
    const { app, calls } = appWith({ authenticated: false, aliasRows: [{ station_id: REAL }, { station_id: 'PWS-OTHER' }] });
    await request(app).get(`/api/stations/${ALIAS}/quality`).expect(404);
    expect(calls.some((c) => c.sql.includes('weather_data_quality'))).toBe(false);
  });

  test('authenticated callers may use either the raw id or the alias', async () => {
    const raw = appWith({ authenticated: true });
    await request(raw.app).get(`/api/stations/${REAL}/quality`).expect(200);
    expect(raw.calls.some((c) => c.sql.includes('sha256('))).toBe(false);
    const aliased = appWith({ authenticated: true });
    await request(aliased.app).get(`/api/stations/${ALIAS}/quality`).expect(200);
  });

  test('a failing alias lookup is a 503 with a fixed message', async () => {
    const { app } = appWith({ authenticated: false, lookupThrows: true });
    const res = await request(app).get(`/api/stations/${ALIAS}/quality`).expect(503);
    expect(res.body.error.code).toBe('STATION_LOOKUP_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('connection reset');
  });
});

// ---------------------------------------------------------------------------
// JS == SQL on a real PostgreSQL. Uses the same disposable-database variable
// CT102 CI exports for the real-PG suites (BACKFILL_TEST_PG_URL).
// ---------------------------------------------------------------------------
const PG_URL = process.env.BACKFILL_TEST_PG_URL;
const describePg = PG_URL ? describe : describe.skip;

describePg('station alias SQL derivation on real PostgreSQL', () => {
  const schema = `alias_q5_${process.pid}`;
  let sql: ReturnType<typeof postgres>;
  const IDS = ['PWS-TEST-A', 'KDLH', 'PWS-DULUTH-X-WS5000', 'station with spaces', 'ünïcødé-🌧'];

  beforeAll(async () => {
    sql = postgres(PG_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    await sql.unsafe(`CREATE TABLE weather_stations (station_id text NOT NULL UNIQUE)`);
    for (const id of IDS) await sql.unsafe(`INSERT INTO weather_stations (station_id) VALUES ($1)`, [id]);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  test('SQL alias equals JS alias for every row (incl. spaces and non-ASCII)', async () => {
    const rows = await sql.unsafe(`SELECT station_id, ${STATION_ALIAS_SQL} AS alias FROM weather_stations`);
    expect(rows.length).toBe(IDS.length);
    for (const row of rows) expect(row.alias).toBe(stationAlias(row.station_id));
  });

  test('resolveStationAlias finds each row through the SQL expression', async () => {
    const query = async (text: string, params: unknown[]) => Array.from(await sql.unsafe(text, params as any[]));
    for (const id of IDS) {
      expect(await resolveStationAlias(query, stationAlias(id))).toEqual({ status: 'found', stationId: id });
    }
    expect(await resolveStationAlias(query, stationAlias('absent'))).toEqual({ status: 'not-found' });
  });
});

// #1258 review (codex round 58) + stage15 ack point 3: no anonymous response
// body may carry the raw station id, whatever the upstream or DB row contains.
describe('anonymous detail bodies never carry the raw station id (canary)', () => {
  const RAW = 'PWS-REVIEW-JANE-01';
  const ALIAS = stationAlias(RAW);

  function build(opts: { authenticated?: boolean; core4?: any; readerToken?: string | undefined }) {
    const core4Calls: string[] = [];
    const db = {
      execute: jest.fn(async (sql: string) => {
        if (sql.includes('sha256(')) return { rows: [{ station_id: RAW }] };
        if (sql.includes('FROM weather_data')) {
          return { rows: [{ timestamp: 't', temperature: 20, station_id: RAW, note: `from ${RAW}` }] };
        }
        if (sql.includes('weather_commitments')) {
          return { rows: [{ id: 1, commitment_hash: 'c1', status: 'revealed', created_at: 't', reveal_deadline: 't', station_id: RAW }] };
        }
        return { rows: [] };
      }),
    };
    const fetchCore4Json = jest.fn(async (path: string) => {
      core4Calls.push(path);
      return opts.core4 ?? { ok: false, status: 503, payload: {} };
    });
    const app = express();
    app.use('/api', createStationDetailRouter({
      db,
      fetchCore4Json,
      readerToken: () => opts.readerToken,
      isAuthenticated: () => opts.authenticated ?? false,
    } as any));
    return { app, core4Calls };
  }

  test('core4 observations: item station_id is dropped; upstream is called with the INTERNAL id', async () => {
    const item = {
      commit_id: 'c1', station_id: RAW, height: 7, observed_at: 1, values: { temperature_c: 20 },
      provenance_class: 'real', attestation: { approvals: 2, has_quorum: true }, memo: RAW,
    };
    const { app, core4Calls } = build({
      readerToken: 'r',
      core4: { ok: true, status: 200, payload: { ok: true, data: { items: [item], has_more: false } } },
    });
    const res = await request(app).get(`/api/stations/${ALIAS}/observations`).expect(200);
    expect(res.body.source).toBe('core4');
    expect(res.body.observations[0].temperatureC).toBe(20);
    expect(JSON.stringify(res.body)).not.toContain(RAW);
    expect(core4Calls[0]).toBe(`/transactions/contributions/${encodeURIComponent(RAW)}/observations`);
  });

  test('DB-fallback observations never carry the raw id', async () => {
    const { app } = build({ readerToken: undefined });
    const res = await request(app).get(`/api/stations/${ALIAS}/observations`).expect(200);
    expect(res.body.source).toBe('backend-db');
    expect(res.body.observations.length).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain(RAW);
  });

  test('submissions never carry the raw id', async () => {
    const { app } = build({});
    const res = await request(app).get(`/api/stations/${ALIAS}/submissions`).expect(200);
    expect(res.body.submissions.length).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain(RAW);
  });

  test.each([
    ['allowlisted code', 'UNPROCESSABLE_ENTITY', 422, 'UNPROCESSABLE_ENTITY', 422],
    ['unlisted code', `STATION_${RAW}_INVALID`, 422, 'CORE4_REQUEST_REJECTED', 422],
    ['odd status', 'NOT_FOUND', 418, 'NOT_FOUND', 502],
  ])('anonymous upstream 4xx (%s): fixed message, no raw id', async (_l, upstreamCode, upstreamStatus, code, status) => {
    const { app } = build({
      readerToken: 'r',
      core4: { ok: false, status: upstreamStatus, payload: { error: { code: upstreamCode, message: `invalid station ${RAW}` } } },
    });
    const res = await request(app).get(`/api/stations/${ALIAS}/observations`).expect(status);
    expect(res.body).toEqual({ error: { code, message: 'the observations request was rejected' } });
    expect(JSON.stringify(res.body)).not.toContain(RAW);
  });

  test('authenticated upstream 4xx is passed through unchanged', async () => {
    const { app } = build({
      authenticated: true,
      readerToken: 'r',
      core4: { ok: false, status: 422, payload: { error: { code: 'X', message: `invalid station ${RAW}` } } },
    });
    const res = await request(app).get(`/api/stations/${RAW}/observations`).expect(422);
    expect(res.body.error).toEqual({ code: 'X', message: `invalid station ${RAW}` });
  });
});

// #1258 review round 60: anonymous alias responses are ALLOWLIST projections;
// canaries injected upstream/DB (any case, nested keys and values) never leak.
describe('round 60: anonymous allowlist projections (canaries in nested data)', () => {
  const RAW = 'PWS-REVIEW-JANE-01';
  const ALIAS = stationAlias(RAW);
  const VARIANTS = [RAW, RAW.toLowerCase(), 'pws-Review-JANE-01'];
  const noLeak = (body: unknown) => {
    const text = JSON.stringify(body).toLowerCase();
    expect(text).not.toContain(RAW.toLowerCase());
  };

  function build(opts: { authenticated?: boolean; core4Item?: any; qualityRow?: any; commitStatus?: any; commitRow?: any }) {
    const db = {
      execute: jest.fn(async (sql: string) => {
        if (sql.includes('sha256(')) return { rows: [{ station_id: RAW }] };
        if (sql.includes('weather_data_quality')) return { rows: [opts.qualityRow] };
        if (sql.includes('weather_commitments')) return { rows: [opts.commitRow] };
        return { rows: [] };
      }),
    };
    const fetchCore4Json = jest.fn(async (path: string) => {
      if (path.includes('/observations')) {
        return { ok: true, status: 200, payload: { ok: true, data: { items: [opts.core4Item], has_more: false } } };
      }
      return { ok: true, status: 200, payload: opts.commitStatus };
    });
    const app = express();
    app.use('/api', createStationDetailRouter({
      db, fetchCore4Json, readerToken: () => 'r', isAuthenticated: () => opts.authenticated ?? false,
    } as any));
    return app;
  }

  test.each(VARIANTS)('observations[].attestation carries only {approvals, has_quorum} (canary %s)', async (canary) => {
    const core4Item = {
      commit_id: 'abcdef0123456789', station_id: canary, height: 7, observed_at: 1,
      values: { temperature_c: 20, [canary]: 1 },
      provenance_class: canary,
      attestation: { approvals: 2, has_quorum: true, station_id: canary, nested: { [canary]: canary } },
    };
    const res = await request(build({ core4Item })).get(`/api/stations/${ALIAS}/observations`).expect(200);
    const o = res.body.observations[0];
    expect(o.attestation).toEqual({ approvals: 2, has_quorum: true });
    expect(o.provenanceClass).toBeNull();
    expect(o.commitId).toBe('abcdef0123456789');
    expect(o.temperatureC).toBe(20);
    noLeak(res.body);
  });

  test('observations: a malformed attestation becomes null', async () => {
    const core4Item = { commit_id: `x-${RAW}`, observed_at: 1, values: {}, attestation: { approvals: '2', has_quorum: 'yes' } };
    const res = await request(build({ core4Item })).get(`/api/stations/${ALIAS}/observations`).expect(200);
    expect(res.body.observations[0].attestation).toBeNull();
    expect(res.body.observations[0].commitId).toBeNull();
    noLeak(res.body);
  });

  test.each(VARIANTS)('quality: only allowlisted dimensions; tier validated (canary %s)', async (canary) => {
    const qualityRow = {
      quality_score: 90, confidence: 0.9,
      factors: { freshness: 0.8, [canary]: 1, [`${canary}_x`]: 1, stationQuality: canary, submittedBy: 'owner', range: 97 },
      advisory_tier: canary,
    };
    const res = await request(build({ qualityRow })).get(`/api/stations/${ALIAS}/quality`).expect(200);
    expect(res.body.dimensions).toEqual([
      { key: 'freshness', label: 'freshness', score: 0.8 },
      { key: 'range', label: 'range', score: 97 },
    ]);
    expect(res.body.advisoryTier).toBeNull();
    noLeak(res.body);
  });

  test.each(VARIANTS)('submissions: chainStatus is a validated enum, never an object (canary %s)', async (canary) => {
    const commitRow = {
      id: 1, commitment_hash: 'abcdef0123456789', status: canary, created_at: new Date('2026-09-27T00:00:00Z'), reveal_deadline: canary,
    };
    const commitStatus = { status: { state: 'revealed_attested', station_id: canary } };
    const res = await request(build({ commitRow, commitStatus })).get(`/api/stations/${ALIAS}/submissions`).expect(200);
    const s0 = res.body.submissions[0];
    expect(s0).toEqual({
      id: 1, commitmentHash: 'abcdef0123456789', status: null, chainStatus: null,
      createdAt: '2026-09-27T00:00:00.000Z', revealDeadline: null,
    });
    noLeak(res.body);
  });

  test('submissions: a valid core4 status string passes', async () => {
    const commitRow = { id: 1, commitment_hash: 'abcdef0123456789', status: 'revealed', created_at: 't', reveal_deadline: null };
    const res = await request(build({ commitRow, commitStatus: { status: 'revealed_attested' } }))
      .get(`/api/stations/${ALIAS}/submissions`).expect(200);
    expect(res.body.submissions[0].chainStatus).toBe('revealed_attested');
    expect(res.body.submissions[0].status).toBe('revealed');
  });

  test('authenticated projections are unchanged (pass-through kept)', async () => {
    const core4Item = { commit_id: 'c1', station_id: RAW, observed_at: 1, values: {}, attestation: { approvals: 1, has_quorum: false, station_id: RAW } };
    const res = await request(build({ authenticated: true, core4Item })).get(`/api/stations/${RAW}/observations`).expect(200);
    expect(res.body.observations[0].attestation).toEqual({ approvals: 1, has_quorum: false, station_id: RAW });
  });
});

describe('scrubRawId', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { scrubRawId } = require('../server/routes/station-detail-routes');
  test('drops keys and nulls string values containing the id, any case, at any depth', () => {
    const input = { a: 'ok', b: 'has PWS-X-01 inside', c: [{ 'pws-x-01': 1, d: 'pws-X-01' }], e: 5, f: null };
    expect(scrubRawId(input, 'PWS-X-01')).toEqual({ a: 'ok', b: null, c: [{ d: null }], e: 5, f: null });
  });
});

// #1258 review P3: very short raw ids (core4 allows "a", "st", "1") must not
// strip unrelated keys or null the alias; the pin and shape stay intact.
describe('scrubRawId with very short ids', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { scrubRawId: scrub, stationAlias: aliasOf, SCRUB_SUBSTRING_MIN_LENGTH } = require('../server/utils/station-alias');
  const item = (id: string) => ({
    alias: aliasOf(id), name: 'Neutral label', latitude: 1, longitude: 2,
    status: 'live', lastDataUpdate: '2026-09-27T00:29:00.000Z', isActive: true, qualityScore: 90,
  });

  test.each(['a', 'st', '1', 'S', 'live'])('id %p keeps every allowlisted key and the alias', (id) => {
    const input = item(id);
    const out = scrub(input, id);
    expect(Object.keys(out).sort()).toEqual(Object.keys(input).sort());
    expect(out.alias).toBe(aliasOf(id));
  });

  test('a short id is still removed on an EXACT (case-insensitive) match', () => {
    expect(scrub({ name: 'ST', note: 'st', other: 'first', st: 1 }, 'st')).toEqual({ name: null, note: null, other: 'first' });
  });

  test('ids at the threshold and above keep substring matching', () => {
    expect(SCRUB_SUBSTRING_MIN_LENGTH).toBe(6);
    expect(scrub({ a: 'x PWS-01 y', alias: 'st_000000000000' }, 'PWS-01')).toEqual({ a: null, alias: 'st_000000000000' });
  });

  test('the alias key is never scrubbed, even if its hex contains the id', () => {
    const alias = aliasOf('PWS-TEST-A'); // st_0e4f722514b9
    expect(scrub({ alias }, '0e4f72')).toEqual({ alias });
  });
});
