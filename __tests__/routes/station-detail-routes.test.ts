import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { createStationDetailRouter } from '../../server/routes/station-detail-routes.js';

type Row = Record<string, unknown>;
function makeDb(sequences: Row[][]) {
  let index = 0;
  return { execute: jest.fn(async () => ({ rows: sequences[index++] ?? [] })) };
}
function makeApp(db: ReturnType<typeof makeDb>, fetchCore4Json = jest.fn<any>()) {
  const app = express();
  app.use('/api', createStationDetailRouter({ db, fetchCore4Json, isAuthenticated: () => true } as any));
  return app;
}

// Verbatim shape of core4 origin/main native-chain launch_api
// routes/transactions.rs get_station_observations (items.push json! +
// envelope_success), wrapped by helpers.rs LawBookEnvelope {ok,data,error,meta}.
// Item values mirror native-chain/tests/transactions_routes.rs
// observation_tx (legacy payload with temperature_c 20.5, humidity_percent 45,
// observed_at 1700000000); unreported Option<f64> values serialize as null.
const CORE4_OBSERVATIONS_BODY = {
  ok: true,
  data: {
    items: [{
      commit_id: 'c0ffee01', station_id: 'station-read', height: 1, observed_at: 1700000000,
      values: {
        temperature_c: 20.5, humidity_percent: 45.0, pressure_hpa: null,
        wind_speed_ms: null, precipitation_mm: null, dewpoint_c: null,
      },
      provenance_class: null, attestation: null,
    }],
    limit: 1, next_after: 0, next_offset: 1, has_more: true, chain_height: 2,
    state_tip: 'ab'.repeat(32), scanned_transactions: 1,
  },
  error: null,
  meta: { request_id: 'req_1', timestamp: '2026-09-23T00:00:00Z', api_version: 'v1' },
};
function core4(status: number, payload: unknown) {
  return jest.fn<any>().mockResolvedValue({ ok: status >= 200 && status < 300, status, payload });
}
function appWithToken(db: ReturnType<typeof makeDb>, fetchCore4Json: any, token: string | null = 'reader-token') {
  const app = express();
  app.use('/api', createStationDetailRouter({ db, fetchCore4Json, readerToken: () => token ?? undefined, isAuthenticated: () => true } as any));
  return app;
}

describe('station detail reads', () => {
  it('maps the real core4 observations envelope (items, observed_at, nested values)', async () => {
    const fetchCore4Json = core4(200, CORE4_OBSERVATIONS_BODY);
    const db = makeDb([]);
    const res = await request(appWithToken(db, fetchCore4Json)).get('/api/stations/station-read/observations?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('core4');
    expect(res.body.observations).toEqual([{
      timestamp: '2023-11-14T22:13:20.000Z', observedAt: 1700000000, height: 1, commitId: 'c0ffee01',
      temperatureC: 20.5, humidityPct: 45, pressureHpa: null, windSpeedMs: null,
      windDirectionDeg: null, rainRateMmHr: null, precipitationMm: null, dewpointC: null,
      uvIndex: null, pm25UgM3: null, provenanceClass: null, attestation: null,
    }]);
    // backend#1280: an uncursored read is a tail read, newest first.
    expect(res.body.order).toBe('descending-height');
    expect(res.body.cursor).toEqual({ nextAfter: null, nextOffset: null, hasMore: null, chainHeight: 2 });
    expect(db.execute).not.toHaveBeenCalled();
    expect(fetchCore4Json).toHaveBeenCalledWith(
      '/transactions/contributions/station-read/observations',
      expect.objectContaining({ headers: { authorization: 'Bearer reader-token' } }),
    );
  });

  it('forwards the core4 cursor and returns an empty window without a database fallback', async () => {
    const empty = { ...CORE4_OBSERVATIONS_BODY, data: { ...CORE4_OBSERVATIONS_BODY.data, items: [], next_after: 64, next_offset: 0 } };
    const fetchCore4Json = core4(200, empty);
    const db = makeDb([[{ timestamp: '2026-09-19T00:00:00Z', humidity: '55.2' }]]);
    const res = await request(appWithToken(db, fetchCore4Json)).get('/api/stations/station-read/observations?after=0&offset=0');
    expect(res.body).toMatchObject({ source: 'core4', observations: [], cursor: { nextAfter: 64, hasMore: true } });
    expect(db.execute).not.toHaveBeenCalled();
    expect(fetchCore4Json.mock.calls[0][1]).toMatchObject({ query: { after: 0, offset: 0 } });
  });

  it('surfaces a core4 200 in any other shape as contract drift, not a silent database read', async () => {
    const fetchCore4Json = core4(200, { observations: [{ timestamp: '2026-09-20T00:00:00Z', temperature_c: 12.5 }] });
    const db = makeDb([[{ humidity: '55.2' }]]);
    const res = await request(appWithToken(db, fetchCore4Json)).get('/api/stations/KDLH/observations');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('CORE4_CONTRACT_MISMATCH');
    expect(db.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['core4 5xx', core4(503, null), 'CORE4_HTTP_503'],
    ['route missing on an older node', core4(404, null), 'CORE4_HTTP_404'],
    ['Reader credential rejected', core4(403, { ok: false, error: { code: 'FORBIDDEN' } }), 'CORE4_HTTP_403'],
    ['core4 unreachable', jest.fn<any>().mockRejectedValue(new Error('ECONNREFUSED')), 'CORE4_UNREACHABLE'],
  ])('falls back to labelled database rows when %s', async (_label, fetchCore4Json, reason) => {
    const db = makeDb([[{ timestamp: '2026-09-19T00:00:00Z', humidity: '55.2' }]]);
    const res = await request(appWithToken(db, fetchCore4Json)).get('/api/stations/KDLH/observations?limit=5');
    expect(res.body).toMatchObject({
      source: 'backend-db', core4Unavailable: reason,
      observations: [{ humidityPct: 55.2, temperatureC: null }],
    });
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining('FROM weather_data'), ['KDLH', 5]);
  });

  it('does not call core4 without a Reader credential and labels the database fallback', async () => {
    const fetchCore4Json = core4(200, CORE4_OBSERVATIONS_BODY);
    const db = makeDb([[]]);
    const res = await request(appWithToken(db, fetchCore4Json, null)).get('/api/stations/KDLH/observations');
    expect(fetchCore4Json).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      observations: [], source: 'backend-db',
      core4Unavailable: 'CORE4_READER_CREDENTIAL_UNCONFIGURED', unavailable: ['observations'],
    });
  });

  it('passes a core4 request rejection through instead of substituting database rows', async () => {
    const fetchCore4Json = core4(400, { ok: false, data: null, error: { code: 'INVALID_CURSOR', message: 'offset exceeds' } });
    const db = makeDb([[{ humidity: '1' }]]);
    const res = await request(appWithToken(db, fetchCore4Json)).get('/api/stations/KDLH/observations?offset=9');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
    expect(db.execute).not.toHaveBeenCalled();
    const bad = await request(appWithToken(db, fetchCore4Json)).get('/api/stations/KDLH/observations?after=-1');
    expect(bad.status).toBe(400);
    expect(fetchCore4Json).toHaveBeenCalledTimes(1);
  });

  it('returns an honest unavailable quality envelope when no source row exists', async () => {
    const res = await request(makeApp(makeDb([[]]))).get('/api/stations/KDLH/quality');
    expect(res.body).toEqual({ overall: null, dimensions: [], advisory: true, source: 'backend-db', unavailable: ['quality'] });
  });

  it('paginates submissions, includes chain status, and never exposes contributor identity', async () => {
    const db = makeDb([[{
      id: 7, commitment_hash: 'abc', status: 'revealed', created_at: '2026-09-20T00:00:00Z',
      reveal_deadline: 99, contributor: '0xsecret',
    }]]);
    const fetchCore4Json = jest.fn<any>().mockResolvedValue({ ok: true, status: 200, payload: { status: 'settled', reward: 42 } });
    const res = await request(makeApp(db, fetchCore4Json)).get('/api/stations/KDLH/submissions?limit=2&offset=4');
    expect(res.body.submissions[0]).toMatchObject({ id: 7, commitmentHash: 'abc', status: 'revealed', chainStatus: 'settled' });
    expect(JSON.stringify(res.body)).not.toContain('0xsecret');
    expect(JSON.stringify(res.body)).not.toContain('reward');
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining('LIMIT $2 OFFSET $3'), ['KDLH', 2, 4]);
  });

  it('returns earnings as unavailable and never fabricates a number when core4 cannot be read', async () => {
    const res = await request(makeApp(makeDb([]))).get('/api/stations/KDLH/earnings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      earnings: [], source: null, unavailable: ['earnings'],
      reason: 'the core4 reader credential is not configured',
      amountUnits: {
        denomination: 'WRF', baseUnitDecimals: 8, baseUnitsPerUnit: '100000000', available: false,
        fields: {
          'earnings[].amountBaseUnits': 'base_units', 'earnings[].amountWrf': 'display_units',
          'totals.rewardedBaseUnits': 'base_units', 'totals.rewardedWrf': 'display_units',
        },
      },
    });
    expect(res.body.totals).toBeUndefined();
    expect(res.body.earnings).toEqual([]);
  });

  it('is mounted on the deployed entrypoint and garbage subpaths remain 404', async () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server/enhanced_unified_api_optimized.ts'), 'utf8');
    expect(source).toContain("app.use('/api', createStationDetailRouter());");
    const res = await request(makeApp(makeDb([]))).get('/api/stations/x/nonexistent-zzz');
    expect(res.status).toBe(404);
  });
});
