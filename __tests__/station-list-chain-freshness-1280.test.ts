/**
 * backend#1280: the public station list derives status/lastDataUpdate from the
 * newest CHAIN observation as well as weather_data. On testnet nothing writes
 * weather_data (collectors submit to the core4 node), so a registered station
 * with zero rows must still read `live` when it reveals on chain.
 */
import { describe, expect, it, jest } from '@jest/globals';
import {
  listRegisteredStations,
  STATION_LIVE_WINDOW_MS,
  type QueryablePool,
} from '../server/services/station-registration-service.js';
import { createChainTailReader, TAIL_MAX_CALLS } from '../server/services/chain-station-tail.js';
import { fakeCore4Chain } from './fixtures/fake-core4-chain.js';

const STATION = 'alice-backyard-ws';

/** One registered station and zero weather_data rows (last_data_update NULL). */
function poolWithStation(lastDataUpdate: unknown = null): QueryablePool {
  return {
    query: jest.fn(async () => ({
      rows: [{
        station_id: STATION, name: 'Backyard', owner_address: '0x' + 'a'.repeat(40), location: 'x',
        latitude: 46.78, longitude: -92.1, is_active: true, quality_score: null, total_rewards: '0',
        last_data_update: lastDataUpdate,
      }],
    })),
  } as unknown as QueryablePool;
}

function reader(chainHeight: number, reveals: Array<{ height: number; observedAt: number }>) {
  const fetchCore4Json = fakeCore4Chain(chainHeight, reveals.map((r) => ({ station: STATION, ...r })));
  return {
    fetchCore4Json,
    tail: createChainTailReader({ fetchCore4Json: fetchCore4Json as any, readerToken: () => 'reader-token' }),
  };
}

describe('station list freshness from the chain (backend#1280)', () => {
  it('registered + 0 weather_data rows + a recent chain reveal → live, lastDataUpdate = that reveal', async () => {
    const observedAt = Math.floor((Date.now() - 120_000) / 1000);
    const { tail } = reader(25382, [{ height: 25380, observedAt }]);
    const page = await listRegisteredStations(poolWithStation(), { chainLastSeen: tail.lastSeenMs });
    expect(page.stations[0]).toMatchObject({
      status: 'live',
      lastDataUpdate: new Date(observedAt * 1000).toISOString(),
    });
  });

  it('no reveals on chain and no rows → registered, lastDataUpdate null', async () => {
    const { tail, fetchCore4Json } = reader(25382, []);
    const page = await listRegisteredStations(poolWithStation(), { chainLastSeen: tail.lastSeenMs });
    expect(page.stations[0]).toMatchObject({ status: 'registered', lastDataUpdate: null });
    expect(fetchCore4Json.mock.calls.length).toBeLessThanOrEqual(TAIL_MAX_CALLS);
  });

  it('only an old reveal inside the walk-back → stale', async () => {
    const observedAt = Math.floor((Date.now() - STATION_LIVE_WINDOW_MS - 3_600_000) / 1000);
    const { tail } = reader(25382, [{ height: 25382 - 150, observedAt }]);
    const page = await listRegisteredStations(poolWithStation(), { chainLastSeen: tail.lastSeenMs });
    expect(page.stations[0]).toMatchObject({ status: 'stale', lastDataUpdate: new Date(observedAt * 1000).toISOString() });
  });

  it('the newer of weather_data and chain wins', async () => {
    const chainAt = Math.floor((Date.now() - 3_600_000) / 1000);
    const dbAt = new Date(Date.now() - 60_000);
    const { tail } = reader(1000, [{ height: 999, observedAt: chainAt }]);
    const page = await listRegisteredStations(poolWithStation(dbAt), { chainLastSeen: tail.lastSeenMs });
    expect(page.stations[0]).toMatchObject({ status: 'live', lastDataUpdate: dbAt.toISOString() });
  });

  it('core4 down → degrades to the database answer without throwing', async () => {
    const tail = createChainTailReader({
      fetchCore4Json: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as any,
      readerToken: () => 'reader-token',
    });
    const page = await listRegisteredStations(poolWithStation(), { chainLastSeen: tail.lastSeenMs });
    expect(page.stations[0]).toMatchObject({ status: 'registered', lastDataUpdate: null });
  });

  it('a throwing chainLastSeen never fails the list', async () => {
    const chainLastSeen = jest.fn(async () => { throw new Error('boom'); });
    const page = await listRegisteredStations(poolWithStation(), { chainLastSeen });
    expect(page.stations[0]).toMatchObject({ status: 'registered' });
  });

  it('no reader credential → no core4 call, database answer', async () => {
    const fetchCore4Json = jest.fn();
    const tail = createChainTailReader({ fetchCore4Json: fetchCore4Json as any, readerToken: () => undefined });
    const page = await listRegisteredStations(poolWithStation(), { chainLastSeen: tail.lastSeenMs });
    expect(page.stations[0]).toMatchObject({ status: 'registered' });
    expect(fetchCore4Json).not.toHaveBeenCalled();
  });

  it('a reveal stamped in the future is not liveness', async () => {
    const { tail } = reader(100, [{ height: 99, observedAt: Math.floor(Date.now() / 1000) + 3600 }]);
    const page = await listRegisteredStations(poolWithStation(), { chainLastSeen: tail.lastSeenMs });
    expect(page.stations[0]).toMatchObject({ status: 'registered', lastDataUpdate: null });
  });

  it('repeated list polling is served from the cache', async () => {
    const { tail, fetchCore4Json } = reader(500, [{ height: 499, observedAt: Math.floor(Date.now() / 1000) }]);
    await listRegisteredStations(poolWithStation(), { chainLastSeen: tail.lastSeenMs });
    const calls = fetchCore4Json.mock.calls.length;
    await Promise.all([1, 2, 3].map(() => listRegisteredStations(poolWithStation(), { chainLastSeen: tail.lastSeenMs })));
    expect(fetchCore4Json.mock.calls.length).toBe(calls);
  });
});
