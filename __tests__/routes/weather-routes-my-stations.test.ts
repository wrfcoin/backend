/**
 * GET /api/weather/stations/mine (owner decision 2026-11-10, "my stations"): off unless
 * MY_STATIONS_ENABLED=true; a signed-in wallet sees only its own stations, read by the
 * JWT address; passkey sessions wait for Phase 2; rate limited per wallet. Made-up ids
 * and addresses only.
 */
const express = require('express');
const request = require('supertest');
const { stationAlias } = require('../../server/utils/station-alias');

jest.mock('../../server/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

let mockUser: { address: string; walletScheme?: string } | null = null;
jest.mock('../../server/middleware/auth-middleware.js', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    if (!mockUser) return res.status(401).json({ error: 'unauthenticated' });
    req.user = mockUser;
    return next();
  },
}));

const ALICE = '0x' + 'a'.repeat(40);
const BOB = '0x' + 'b'.repeat(40);
// The fake table: the SQL's owner filter is applied here to the first parameter, so a
// route that asked for the wrong owner (or none) would get the wrong rows back.
const ROWS = [
  { station_id: 'pws-00000000000000a1', name: 'Garden 46.8123,-123.4567', owner_address: ALICE.toUpperCase().replace('0X', '0x'), last_data_update: null },
  { station_id: 'pws-00000000000000a2', name: 'Roof', owner_address: ALICE, last_data_update: new Date(Date.now() - 60_000) },
  { station_id: 'pws-00000000000000b1', name: 'Bob shed', owner_address: BOB, last_data_update: null },
];
const mockQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
  if (/FROM weather_stations\s+WHERE lower\(owner_address\) = \$1/.test(sql)) {
    const owner = String(params[0]);
    return { rows: ROWS.filter((r) => r.owner_address.toLowerCase() === owner).slice(0, Number(params[1])) };
  }
  return { rows: [] };
});
jest.mock('../../server/db.js', () => ({ pool: { query: (...a: [string, unknown[]]) => mockQuery(...a) } }));

jest.mock('../../server/services/chain-station-tail.js', () => ({
  getDefaultChainTailReader: () => ({ lastSeenMs: async () => null }),
}));

let mockChainOn = false;
const mockStatus = jest.fn();
jest.mock('../../server/services/website-station-chain-registration.js', () => ({
  websiteStationChainRegistrationEnabled: () => mockChainOn,
  resolveWebsiteStationChain: () => ({ chainId: '888', networkId: 'testnet' }),
  getChainRegistrationStatus: (...a: unknown[]) => mockStatus(...a),
}));

jest.mock('../../server/controllers/enhanced-weather-controller', () =>
  jest.fn().mockImplementation(() => ({ getNearbyStations: jest.fn(), getWeatherAlerts: jest.fn(), getServicesHealth: jest.fn() }))
);

const weatherRoutes = require('../../server/routes/weather-routes.js');
const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/api/weather', weatherRoutes);
  return a;
};
const get = (path = '/api/weather/stations/mine') => request(app()).get(path);

const ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...ENV, MY_STATIONS_ENABLED: 'true' };
  delete process.env.MY_STATIONS_PASSKEY_ENABLED;
  mockUser = { address: ALICE, walletScheme: 'ed25519' };
  mockChainOn = false;
  mockQuery.mockClear();
  mockStatus.mockReset();
});
afterAll(() => {
  process.env = ENV;
});

describe('GET /stations/mine', () => {
  test('switched off: a signed-in wallet gets 404, a signed-out caller 401, and nothing is read', async () => {
    delete process.env.MY_STATIONS_ENABLED;
    await get().expect(404);
    process.env.MY_STATIONS_ENABLED = '1';
    await get().expect(404);
    mockUser = null;
    await get().expect(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('unauthenticated: refused with 401 and nothing is read', async () => {
    mockUser = null;
    await get().expect(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a session without a wallet address is refused', async () => {
    mockUser = { address: 'unknown' };
    await get().expect(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("only the caller's stations, matched case-insensitively", async () => {
    const res = await get().expect(200);
    const aliases = res.body.stations.map((s: any) => s.alias);
    expect(aliases).toEqual([stationAlias('pws-00000000000000a1'), stationAlias('pws-00000000000000a2')]);
    expect(aliases).not.toContain(stationAlias('pws-00000000000000b1'));
    expect(JSON.stringify(res.body)).not.toContain('Bob shed');
    expect(res.headers['cache-control']).toBe('no-store');

    mockUser = { address: BOB.toUpperCase().replace('0X', '0x'), walletScheme: 'ed25519' };
    const bob = await get().expect(200);
    expect(bob.body.stations.map((s: any) => s.alias)).toEqual([stationAlias('pws-00000000000000b1')]);
  });

  test('the owner is the session wallet: a query or body owner is ignored', async () => {
    const res = await get(`/api/weather/stations/mine?owner=${BOB}&address=${BOB}`).expect(200);
    expect(res.body.stations).toHaveLength(2);
    const ownerQueries = mockQuery.mock.calls.filter(([sql]) => /lower\(owner_address\) = \$1/.test(sql));
    expect(ownerQueries.every(([, params]) => params[0] === ALICE)).toBe(true);
  });

  test('rows carry no raw id, no coordinates, and the name is coarsened', async () => {
    const res = await get().expect(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('pws-00000000000000a');
    expect(body).not.toContain('46.8123');
    expect(body).not.toContain('123.4567');
    for (const s of res.body.stations) {
      expect(Object.keys(s).sort()).toEqual(['alias', 'lastReadingAt', 'name', 'status']);
    }
    const roof = res.body.stations[1];
    expect(roof.status).toBe('live');
    expect(typeof roof.lastReadingAt).toBe('string');
    expect(res.body.stations[0].status).toBe('registered');
    expect(res.body.stations[0].lastReadingAt).toBeNull();
  });

  test('the on-chain step is added when station chain registration is on, without the raw id', async () => {
    mockChainOn = true;
    mockStatus.mockImplementation(async (_pool: unknown, id: string, owner: string) =>
      owner === ALICE ? { state: id.endsWith('a1') ? 'earning' : 'waiting', stationId: id, chainId: '888', networkId: 'testnet', waitingFor: 'batch' } : null
    );
    const res = await get().expect(200);
    expect(res.body.stations[0].onChain).toEqual({ state: 'earning', waitingFor: 'batch' });
    expect(res.body.stations[1].onChain).toEqual({ state: 'waiting', waitingFor: 'batch' });
    expect(JSON.stringify(res.body)).not.toContain('pws-');
    expect(JSON.stringify(res.body)).not.toContain('888');
  });

  test('passkey sessions get an empty list until Phase 2 is switched on', async () => {
    mockUser = { address: ALICE, walletScheme: 'passkey' };
    const res = await get().expect(200);
    expect(res.body).toEqual({ success: true, stations: [], truncated: false, passkey: 'later' });
    expect(mockQuery).not.toHaveBeenCalled();
    process.env.MY_STATIONS_PASSKEY_ENABLED = 'true';
    const on = await get().expect(200);
    expect(on.body.stations).toHaveLength(2);
  });

  test('a database failure is a plain 503 with no detail', async () => {
    mockQuery.mockImplementationOnce(async () => { throw new Error('connection to 10.0.0.9 refused'); });
    const res = await get().expect(503);
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.9');
  });

  test('rate limited per wallet: the 61st read in an hour is refused', async () => {
    mockUser = { address: '0x' + 'c'.repeat(40), walletScheme: 'ed25519' };
    const a = app();
    for (let i = 0; i < 60; i += 1) await request(a).get('/api/weather/stations/mine').expect(200);
    const res = await request(a).get('/api/weather/stations/mine').expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    // Another wallet is not affected.
    mockUser = { address: '0x' + 'd'.repeat(40), walletScheme: 'ed25519' };
    await request(a).get('/api/weather/stations/mine').expect(200);
  });
});
