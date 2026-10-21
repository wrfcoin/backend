import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';
import { createStationDetailRouter, CHAIN_STATUS_INFLIGHT_DEADLINE_MS } from '../../server/routes/station-detail-routes.js';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { stationAlias } = require('../../server/utils/station-alias');

const rows = Array.from({ length: 25 }, (_, i) => ({ id: i, commitment_hash: `commit-${i}`, status: 'pending' }));
function appFor(fetchCore4Json: any, clock = () => Date.now(), data = rows, cacheMaxEntries = 2048) {
  const app = express();
  app.use('/api', createStationDetailRouter({
    // #1258: anonymous callers address the station by its public alias.
    db: { execute: async (sql: string) => (sql.includes('sha256(') ? { rows: [{ station_id: 'public-station' }] } : { rows: data }) },
    fetchCore4Json,
    now: clock, chainStatusCacheMaxEntries: cacheMaxEntries,
  } as any));
  return app;
}
const url = `/api/stations/${stationAlias('public-station')}/submissions`;
// Real core4 contribution statuses: anonymous chainStatus is enum-validated (#1258).
const pending = { ok: true, status: 200, payload: { data: { status: 'committed_pending_reveal' } } };

describe('anonymous submission status cache', () => {
  it('reuses 25 cached statuses without additional core4 calls, then refreshes expired values', async () => {
    let now = 1000;
    const fetchCore4Json = jest.fn<any>().mockResolvedValue(pending);
    const app = appFor(fetchCore4Json, () => now);
    const first = await request(app).get(url);
    expect(first.status).toBe(200);
    expect(first.body.submissions).toHaveLength(25);
    expect(fetchCore4Json).toHaveBeenCalledTimes(25);
    const second = await request(app).get(url);
    expect(second.body).toEqual(first.body);
    expect(fetchCore4Json).toHaveBeenCalledTimes(25);
    now += 20_001;
    fetchCore4Json.mockResolvedValue({ ok: true, status: 200, payload: { status: 'reward_finalized' } });
    const refreshed = await request(app).get(url);
    expect(fetchCore4Json).toHaveBeenCalledTimes(50);
    expect(refreshed.body.submissions.every((s: any) => s.chainStatus === 'reward_finalized')).toBe(true);
  });

  it('coalesces concurrent requests and duplicate commitment hashes', async () => {
    let release!: (value: any) => void;
    const upstream = new Promise(resolve => { release = resolve; });
    const fetchCore4Json = jest.fn<any>().mockReturnValue(upstream);
    const app = appFor(fetchCore4Json, () => 0, rows.map(r => ({ ...r, commitment_hash: 'same' })));
    const reads = [request(app).get(url).then(r => r), request(app).get(url).then(r => r)];
    for (let i = 0; i < 100 && !fetchCore4Json.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
    release(pending);
    const responses = await Promise.all(reads);
    expect(responses.every(r => r.status === 200)).toBe(true);
    expect(fetchCore4Json).toHaveBeenCalledTimes(1);
  });

  it('briefly caches unavailable status as null, then retries instead of keeping an outage forever', async () => {
    let now = 0;
    const fetchCore4Json = jest.fn<any>().mockRejectedValue(new Error('offline'));
    const app = appFor(fetchCore4Json, () => now, rows.slice(0, 1));
    const first = await request(app).get(url);
    expect(first.body.submissions[0].chainStatus).toBeNull();
    await request(app).get(url);
    expect(fetchCore4Json).toHaveBeenCalledTimes(1);
    now = 5_001;
    fetchCore4Json.mockResolvedValue(pending);
    expect((await request(app).get(url)).body.submissions[0].chainStatus).toBe('committed_pending_reveal');
    expect(fetchCore4Json).toHaveBeenCalledTimes(2);
  });

  it('an in-flight entry that never settles expires at a finite deadline and is re-requested (#1264)', async () => {
    let now = 0;
    let releaseHung!: (value: any) => void;
    const fetchCore4Json = jest.fn<any>().mockReturnValueOnce(new Promise(resolve => { releaseHung = resolve; })); // hung until released
    const app = appFor(fetchCore4Json, () => now, rows.slice(0, 1));
    const hung = request(app).get(url).then(() => undefined, () => undefined);
    for (let i = 0; i < 100 && !fetchCore4Json.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
    expect(fetchCore4Json).toHaveBeenCalledTimes(1);
    // before the deadline a second request still shares the in-flight read
    now = CHAIN_STATUS_INFLIGHT_DEADLINE_MS - 1;
    const sharing = request(app).get(url).then(() => undefined, () => undefined);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fetchCore4Json).toHaveBeenCalledTimes(1);
    // past it, the entry is stale and a new read is made
    now = CHAIN_STATUS_INFLIGHT_DEADLINE_MS + 1;
    fetchCore4Json.mockResolvedValue(pending);
    const res = await request(app).get(url);
    expect(fetchCore4Json).toHaveBeenCalledTimes(2);
    expect(res.body.submissions[0].chainStatus).toBe('committed_pending_reveal');
    releaseHung(pending); // let the two requests on the hung read finish so no handle leaks
    await Promise.all([hung, sharing]);
  });

  it('a settled status still uses its own TTL, not the in-flight deadline (#1264)', async () => {
    let now = 0;
    const fetchCore4Json = jest.fn<any>().mockResolvedValue(pending);
    const app = appFor(fetchCore4Json, () => now, rows.slice(0, 1));
    await request(app).get(url);
    now = CHAIN_STATUS_INFLIGHT_DEADLINE_MS + 1; // past the deadline but inside the 20 s status TTL
    await request(app).get(url);
    expect(fetchCore4Json).toHaveBeenCalledTimes(1);
  });

  it('bounds cache entries and keeps different router instances isolated', async () => {
    const fetchCore4Json = jest.fn<any>().mockResolvedValue(pending);
    const app = appFor(fetchCore4Json, () => 0, rows.slice(0, 3), 2);
    await request(app).get(url);
    await request(app).get(url);
    // Cap 2, three rows, two requests: 3 misses, then every row misses again in
    // order (each insert evicts the oldest), so exactly 6 calls (#1264).
    expect(fetchCore4Json).toHaveBeenCalledTimes(6);
    const other = appFor(fetchCore4Json, () => 0, rows.slice(0, 1));
    const before = fetchCore4Json.mock.calls.length;
    await request(other).get(url);
    expect(fetchCore4Json).toHaveBeenCalledTimes(before + 1);
  });
});
