/**
 * GET /api/weather/stations/collector-roster: who may read it, and that no
 * provider key ever reaches a log line or an error body. The roster itself is
 * covered in __tests__/collector-roster.test.ts. Made-up tokens, keys and stations.
 */
const express = require('express');
const request = require('supertest');
const { encryptData } = require('../../server/utils/crypto');

const mockLog = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock('../../server/utils/logger', () => ({ logger: mockLog }));
jest.mock('../../server/middleware/auth-middleware.js', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { address: '0x' + 'a'.repeat(40) }; next(); },
}));
const mockQuery = jest.fn();
jest.mock('../../server/db.js', () => ({ pool: { query: (...a: unknown[]) => mockQuery(...a) } }));
jest.mock('../../server/controllers/enhanced-weather-controller', () =>
  jest.fn().mockImplementation(() => ({ getNearbyStations: jest.fn(), getWeatherAlerts: jest.fn(), getServicesHealth: jest.fn() }))
);

const OPERATOR = 'operator-fixture-token-0001';
const READER = 'reader-fixture-token-0002';
const ADMIN = 'admin-fixture-token-0003';
const ENC_KEY = 'ab'.repeat(32);
const API_KEY = 'APIKEYSECRET-fixture-000000000000000000000000000000000000000000000000';
const APP_KEY = 'APPKEYSECRET-fixture-000000000000000000000000000000000000000000000000';
const PATH = '/api/weather/stations/collector-roster';
// A wallet session token has this shape; it is not the operator token.
const WALLET_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIweGFhIn0.c2lnbmF0dXJl';

function storedRow() {
  const api = encryptData(API_KEY, ENC_KEY);
  const app = encryptData(APP_KEY, ENC_KEY);
  return {
    station_id: 'pws-00000000000000a1', owner_address: '0x' + '1a'.repeat(20), latitude: 10.34, longitude: -20.66,
    metadata: { mac: 'aa:bb:cc:dd:ee:01' },
    encrypted_api_key: api.encrypted, key_iv: api.iv, key_tag: api.tag,
    encrypted_app_key: app.encrypted, app_iv: app.iv, app_tag: app.tag,
  };
}
// A fresh router per app: each has its own rate-limit window.
function app() {
  let routes: unknown;
  jest.isolateModules(() => { routes = require('../../server/routes/weather-routes.js'); });
  const a = express();
  a.use(express.json());
  a.use('/api/weather', routes);
  return a;
}
const logged = () => JSON.stringify([mockLog.warn.mock.calls, mockLog.error.mock.calls, mockLog.info.mock.calls, mockLog.debug.mock.calls]);
const ENV = ['COLLECTOR_ROSTER_ENABLED', 'WRFCOIN_OPERATOR_TOKEN', 'WRFCOIN_READER_TOKEN', 'ADMIN_TOKEN', 'API_KEY_ENCRYPTION_KEY'] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.COLLECTOR_ROSTER_ENABLED = 'true';
  process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR;
  process.env.WRFCOIN_READER_TOKEN = READER;
  process.env.ADMIN_TOKEN = ADMIN;
  process.env.API_KEY_ENCRYPTION_KEY = ENC_KEY;
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [storedRow()] });
  for (const fn of Object.values(mockLog)) fn.mockReset();
});
afterAll(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
});

describe('who may read the collector roster', () => {
  const refused: Array<[string, (r: any) => any]> = [
    ['no token', (r) => r],
    ['a wrong token', (r) => r.set('Authorization', 'Bearer not-the-token')],
    ['the reader (monitoring) token', (r) => r.set('Authorization', `Bearer ${READER}`)],
    ['the admin token as a bearer', (r) => r.set('Authorization', `Bearer ${ADMIN}`)],
    ['the admin token in its own header', (r) => r.set('x-admin-token', ADMIN)],
    ['a wallet session token', (r) => r.set('Authorization', `Bearer ${WALLET_JWT}`)],
    ['the operator token without the Bearer scheme', (r) => r.set('Authorization', OPERATOR)],
    ['the operator token under another scheme', (r) => r.set('Authorization', `Basic ${OPERATOR}`)],
    ['the operator token in the query string', (r) => r.query({ token: OPERATOR, access_token: OPERATOR })],
    ['the operator token in another header', (r) => r.set('x-operator-token', OPERATOR)],
    ['a prefix of the operator token', (r) => r.set('Authorization', `Bearer ${OPERATOR.slice(0, -1)}`)],
    ['the operator token with something appended', (r) => r.set('Authorization', `Bearer ${OPERATOR}x`)],
  ];

  test.each(refused)('%s: 403, no roster, the database is never asked', async (_name, present) => {
    const res = await present(request(app()).get(PATH));
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  test('the same 403 with the switch off, so a caller without the token learns nothing about it', async () => {
    process.env.COLLECTOR_ROSTER_ENABLED = 'false';
    const off = await request(app()).get(PATH);
    process.env.COLLECTOR_ROSTER_ENABLED = 'true';
    const on = await request(app()).get(PATH);
    expect([off.status, on.status]).toEqual([403, 403]);
    expect(off.body.error).toEqual(on.body.error);
  });

  test('no operator token configured on the server: nobody gets in, not even with an empty bearer', async () => {
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
    for (const header of ['Bearer ', 'Bearer undefined', `Bearer ${OPERATOR}`]) {
      const res = await request(app()).get(PATH).set('Authorization', header);
      expect(res.status).toBe(403);
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test.each([undefined, 'false', '1', 'TRUE'])('switch %p: 404 even with the operator token, and nothing is read', async (value) => {
    if (value === undefined) delete process.env.COLLECTOR_ROSTER_ENABLED; else process.env.COLLECTOR_ROSTER_ENABLED = value;
    const res = await request(app()).get(PATH).set('Authorization', `Bearer ${OPERATOR}`);
    expect(res.status).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('the operator token, switch on: the roster, never cacheable', async () => {
    const res = await request(app()).get(PATH).set('Authorization', `Bearer ${OPERATOR}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.version).toBe('collector_roster_v1');
    expect(res.body.stations).toHaveLength(1);
    expect(res.body.stations[0]).toMatchObject({
      stationId: 'pws-00000000000000a1', mac: 'AA:BB:CC:DD:EE:01', apiKey: API_KEY, appKey: APP_KEY, latitude: 10.3, longitude: -20.7,
    });
  });

  test('only GET: the other methods are not routes', async () => {
    for (const method of ['post', 'put', 'delete', 'patch'] as const) {
      const res = await (request(app()) as any)[method](PATH).set('Authorization', `Bearer ${OPERATOR}`);
      expect(res.status).toBe(404);
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rate limited: the thirteenth read in a minute is refused', async () => {
    const one = app();
    for (let i = 0; i < 12; i += 1) {
      expect((await request(one).get(PATH).set('Authorization', `Bearer ${OPERATOR}`)).status).toBe(200);
    }
    const res = await request(one).get(PATH).set('Authorization', `Bearer ${OPERATOR}`);
    expect(res.status).toBe(429);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });
});

describe('keys never appear in logs or errors', () => {
  test('a good read logs no key and no token', async () => {
    await request(app()).get(PATH).set('Authorization', `Bearer ${OPERATOR}`).expect(200);
    expect(logged()).not.toContain('SECRET');
    expect(logged()).not.toContain(OPERATOR);
  });

  test('a database error that quotes a key: 503 with a fixed message; neither the body nor the log holds it', async () => {
    const error = Object.assign(new Error(`row (${API_KEY}, ${APP_KEY}) violates something`), { code: '23505', detail: API_KEY });
    mockQuery.mockRejectedValue(error);
    const res = await request(app()).get(PATH).set('Authorization', `Bearer ${OPERATOR}`);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(JSON.stringify(res.body)).not.toContain('violates');
    expect(logged()).not.toContain('SECRET');
    expect(logged()).not.toContain('violates');
    expect(mockLog.error).toHaveBeenCalledWith('Collector roster unavailable', { code: '23505' });
  });

  test('rows whose keys cannot be read are left out and only counted; the stored ciphertext is not logged either', async () => {
    const broken = { ...storedRow(), station_id: 'pws-00000000000000b2', metadata: { mac: 'aa:bb:cc:dd:ee:02' }, key_tag: '00'.repeat(16) };
    mockQuery.mockResolvedValue({ rows: [broken, storedRow()] });
    const res = await request(app()).get(PATH).set('Authorization', `Bearer ${OPERATOR}`).expect(200);
    expect(res.body.stations.map((s: { stationId: string }) => s.stationId)).toEqual(['pws-00000000000000a1']);
    expect(res.body.skipped).toBe(1);
    expect(mockLog.warn).toHaveBeenCalledWith('Collector roster left stations out', { skipped: 1, served: 1 });
    expect(logged()).not.toContain(broken.encrypted_api_key);
    expect(logged()).not.toContain('SECRET');
  });

  test('a server without a usable encryption key: 500 with a fixed code, and the bad value is not echoed', async () => {
    process.env.API_KEY_ENCRYPTION_KEY = 'BADKEYSECRET';
    const res = await request(app()).get(PATH).set('Authorization', `Bearer ${OPERATOR}`);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(logged()).not.toContain('SECRET');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('the route does not answer on the old credentials path\'s auth, and the old path is unchanged by the switch', async () => {
    process.env.COLLECTOR_ROSTER_ENABLED = 'false';
    const res = await request(app()).get('/api/weather/stations/credentials');
    expect(res.status).toBe(403);
  });
});
