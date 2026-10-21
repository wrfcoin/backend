/**
 * Owner ruling 2026-09-30 (backend#1288): a `mob-` station that is not yet
 * `on_chain` is unknown to core4, so the backend must not forward its
 * contribution commit/reveal (or the phone-signed prepare/submit) — core4 would
 * reject them (commit 400 / reveal 422) and log ~12 error lines per Collect.
 * Answer 409 STATION_NOT_ACTIVE instead. Non-mobile stations are unchanged.
 */
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { FakeStore } from './helpers/mobile-station-fake-store';

const mockStore = new FakeStore();
function fakeAuth(req: any, res: any, next: any) {
  const wallet = req.headers['x-test-wallet'];
  if (!wallet) return res.status(401).json({ error: 'Bearer Token Required' });
  req.user = { address: wallet, walletAddress: wallet, id: 'u' };
  return next();
}
jest.mock('../server/middleware/auth-middleware.js', () => ({ authenticateToken: fakeAuth }));
jest.mock('../server/middleware/authMiddleware', () => ({ requireAuth: fakeAuth }));
jest.mock('../server/db', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../server/services/mobile-station-registration-service', () => {
  const actual = jest.requireActual('../server/services/mobile-station-registration-service');
  return { ...actual, PgMobileStationStore: class { constructor() { return mockStore; } } };
});
jest.mock('../database/connection.js', () => ({
  executeQuery: jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM mobile_station_registrations')) {
      const [stationId, owner] = params as string[];
      const row = [...mockStore.registrations.values()].find(
        (r) => r.stationId === stationId && r.ownerAddress === owner
      );
      return { rows: row ? [{ collect_pubkey: row.collectPubkey, status: row.status }] : [] };
    }
    const row = mockStore.stations.get(String(params[0]));
    return { rows: row ? [{ owner_address: row.owner }] : [] };
  }),
}));
const mockFetchCore4Json = jest.fn();
jest.mock('../shared/core4-route-client.js', () => ({
  fetchCore4Json: (...args: unknown[]) => mockFetchCore4Json(...args),
  extractCore4Data: (p: any) => p?.data ?? p,
  forwardCore4Headers: jest.fn(() => ({})),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const weatherRoutes = require('../server/routes/weather-routes');
import oracleSubmitRoutes from '../server/routes/oracle-submit-routes';
import { deriveMobileStationId } from '../shared/mobile-station-messages';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function keypair(seed: number) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32).toString('hex');
  const address = `0x${crypto.createHash('sha3-256').update(Buffer.from(publicKey, 'hex')).digest('hex').slice(0, 40)}`;
  return { publicKey, address };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/weather', weatherRoutes.default ?? weatherRoutes);
  app.use('/api/oracle', oracleSubmitRoutes);
  return app;
}
// Fake coordinates only.
const reading = (stationId: string, extra: Record<string, unknown> = {}) => ({
  dataType: 'temperature',
  location: { stationId, lat: 10.0, lon: 20.0 },
  value: 72.5,
  timestamp: '2026-05-29T12:00:00.000Z',
  source: 'mobile',
  nonce: 'mobile-nonce',
  ...extra,
});
const SIG = '11'.repeat(64);
const submit = (app: express.Express, w: { address: string }, body: object) =>
  request(app).post('/api/oracle/submit-data').set('x-test-wallet', w.address).send(body);
const prepare = (app: express.Express, w: { address: string }, body: object) =>
  request(app).post('/api/oracle/submit-data/prepare').set('x-test-wallet', w.address).send(body);

beforeEach(() => {
  mockStore.nonces.clear();
  mockStore.registrations.clear();
  mockStore.stations.clear();
  mockFetchCore4Json.mockReset();
  mockFetchCore4Json.mockImplementation(async (path: string) => ({
    ok: true,
    status: 200,
    payload: { data: path.includes('/status') ? { status: 'revealed_pending_attestation' } : { tx_id: 'tx-1' } },
  }));
  process.env.WRFCOIN_CONTRIBUTOR_TOKEN = 'test-contributor';
  process.env.WRFCOIN_READER_TOKEN = 'test-reader';
});

// ---------------------------------------------------------------------------
// Owner ruling 2026-09-30: a mob- station that is not `on_chain` is never forwarded.
// ---------------------------------------------------------------------------
describe('STATION_NOT_ACTIVE: no core4 forward until the station is on_chain', () => {
  let w: ReturnType<typeof keypair>;
  let phone: ReturnType<typeof keypair>;
  let sid: string;
  let n = 10;
  beforeEach(() => {
    [w, phone] = [1, 2].map((i) => keypair(n + i)) as any;
    n += 4;
    sid = deriveMobileStationId(w.address);
  });
  // Direct store seed: the per-wallet registration limiter is module state shared with the file.
  const seedStation = (status: string) => {
    mockStore.stations.set(sid, { owner: w.address });
    mockStore.registrations.set(w.address, {
      stationId: sid, ownerAddress: w.address, ownerPubkey: w.publicKey, collectPubkey: phone.publicKey,
      cellLatE1: 100, cellLonE1: -200, deviceClass: 'phone-barometer', status,
    } as any);
  };
  const key = () => ({ auth_pubkey: phone.publicKey, auth_signature: SIG });

  it.each(['db_only', 'submitted'])('%s: submit AND prepare answer 409, zero core4 calls', async (status) => {
    const app = buildApp();
    seedStation('db_only');
    mockStore.registrations.get(w.address)!.status = status as any;
    const sub = await submit(app, w, reading(sid, key()));
    expect(sub.status).toBe(409);
    expect(sub.body).toMatchObject({
      success: false,
      error: { code: 'STATION_NOT_ACTIVE', message: 'Station awaiting activation' },
    });
    const prep = await prepare(app, w, reading(sid, key()));
    expect(prep.status).toBe(409);
    expect(prep.body.error.code).toBe('STATION_NOT_ACTIVE');
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it('on_chain proceeds to core4', async () => {
    const app = buildApp();
    seedStation('db_only');
    mockStore.registrations.get(w.address)!.status = 'on_chain';
    expect((await submit(app, w, reading(sid, key()))).status).toBe(200);
    expect(mockFetchCore4Json).toHaveBeenCalled();
  });

  it('a non-owner still gets 403 (status is not disclosed) and a wrong key still 403 before 409', async () => {
    const app = buildApp();
    seedStation('db_only');
    const other = keypair(n + 3);
    expect((await submit(app, other, reading(sid, key()))).body.error.code).toBe('STATION_NOT_OWNED');
    const wrong = await submit(app, w, reading(sid, { auth_pubkey: w.publicKey, auth_signature: SIG }));
    expect(wrong.body.error.code).toBe('COLLECT_KEY_MISMATCH');
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it('logs at most one info line per rejection, station id only', async () => {
    const { blockchainLogger } = require('../server/utils/logger');
    const info = jest.spyOn(blockchainLogger, 'log').mockImplementation(() => undefined);
    const app = buildApp();
    seedStation('db_only');
    info.mockClear();
    expect((await submit(app, w, reading(sid, key()))).status).toBe(409);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe('info');
    const logged = JSON.stringify(info.mock.calls[0]);
    expect(logged).toContain(sid);
    expect(logged).not.toContain(w.address);
    expect(logged).not.toContain('41.9');
    info.mockRestore();
  });

  it('GET /stations/mobile (registration status) still works while db_only', async () => {
    const app = buildApp();
    seedStation('db_only');
    const res = await request(app).get('/api/weather/stations/mobile').set('x-test-wallet', w.address);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stationId: sid, status: 'db_only' });
  });
});
