/**
 * With website station registration switched on, the route hands registerStation an id
 * generator, and a NEW station always gets that neutral id: a station id is public on chain for
 * good, so it must not hold the name the owner typed. A client-supplied id is honoured only for
 * a station the wallet already owns. Made-up values only.
 */
import { jest } from '@jest/globals';
import {
  registerStation,
  type FetchLike,
  type QueryablePool,
} from '../server/services/station-registration-service.js';

const ENC_KEY = 'a'.repeat(64);
const OWNER = '0x' + '11'.repeat(20);
const NEUTRAL = 'pws-0123456789abcdef';
const fetchFn: FetchLike = async () => ({ ok: true, status: 200, json: async () => [{ macAddress: 'AA:BB:CC:DD:EE:01' }] }) as any;
const input = { name: 'Jane Doe back yard', latitude: 10.3, longitude: -20.7, provider: 'ambient', ambientApiKey: 'k', ambientAppKey: 'a' };

/** `owned` = station ids this owner already has. Records every statement. */
function pool(owned: string[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const p: QueryablePool = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
      if (sql.includes('SELECT 1 FROM weather_stations WHERE station_id = $1 AND lower(owner_address) = $2')) {
        return { rows: owned.includes(params[0] as string) ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('SELECT owner_address FROM weather_stations WHERE station_id = $1')) {
        return { rows: owned.includes(params[0] as string) ? [{ owner_address: OWNER }] : [] };
      }
      return { rows: [] };
    }) as any,
  };
  const inserted = () => calls.find((c) => c.sql.includes('INSERT INTO weather_stations'))?.params[0];
  return { p, inserted };
}
const run = (p: QueryablePool, body: Record<string, unknown>, options: Record<string, unknown>) =>
  registerStation(body, OWNER, { pool: p, fetchFn, encryptionKey: ENC_KEY }, () => 'abc123', options);

describe('registerStation: neutral station ids', () => {
  it('a new station gets the neutral id, with nothing of its name in it', async () => {
    const { p, inserted } = pool();
    const res = await run(p, input, { neutralStationId: () => NEUTRAL });
    expect(res.status).toBeLessThan(300);
    expect(res.body.stationId).toBe(NEUTRAL);
    expect(inserted()).toBe(NEUTRAL);
    expect(String(inserted())).not.toMatch(/jane|doe|yard/i);
  });

  it('a client-supplied id for a station the wallet does not have is ignored', async () => {
    for (const stationId of ['pws-jane-doe-000001', 'pws-ffffffffffffffff', 'somebody-elses-station']) {
      const { p, inserted } = pool();
      const res = await run(p, { ...input, stationId }, { neutralStationId: () => NEUTRAL });
      expect(res.body.stationId).toBe(NEUTRAL);
      expect(inserted()).toBe(NEUTRAL);
    }
  });

  it('a client-supplied id is kept when it is the wallet\'s own station (an update)', async () => {
    const mine = 'pws-jane-doe-000001';
    const { p, inserted } = pool([mine]);
    const res = await run(p, { ...input, stationId: mine }, { neutralStationId: () => NEUTRAL });
    expect(res.body.stationId).toBe(mine);
    expect(inserted()).toBe(mine);
  });

  it('an admin override keeps the id it names', async () => {
    const { p, inserted } = pool();
    await run(p, { ...input, stationId: 'reference-station-01' }, { neutralStationId: () => NEUTRAL, isAdminOverride: true });
    expect(inserted()).toBe('reference-station-01');
  });

  it('without the generator (switch off) the behaviour is what it was', async () => {
    const named = pool();
    await run(named.p, input, {});
    expect(named.inserted()).toBe('pws-jane-doe-back-yard-abc123');
    const chosen = pool();
    await run(chosen.p, { ...input, stationId: 'my-own-id' }, {});
    expect(chosen.inserted()).toBe('my-own-id');
  });
});
