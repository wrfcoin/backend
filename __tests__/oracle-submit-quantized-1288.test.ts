/**
 * backend#1288: the submit path sends the QUANTIZED payload (prepare and submit agree on
 * the commit id), logs core4's rejection code/message safely, and answers a core4 replay
 * rejection with a terminal 409 COMMIT_ALREADY_SUBMITTED instead of a retryable 502.
 */
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
import { computeCommitId } from '../shared/commit-reveal-hash';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/weather', weatherRoutes.default ?? weatherRoutes);
  app.use('/api/oracle', oracleSubmitRoutes);
  return app;
}
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

const OWNER = '0xabc0000000000000000000000000000000000001';
const STATION = 'pws-quant-1';
const submit = (app: express.Express, body: object) =>
  request(app).post('/api/oracle/submit-data').set('x-test-wallet', OWNER).send(body);
const prepare = (app: express.Express, body: object) =>
  request(app).post('/api/oracle/submit-data/prepare').set('x-test-wallet', OWNER).send(body);
const longReading = () => ({
  dataType: 'pressure',
  location: { stationId: STATION, lat: 10.0, lon: 20.0 },
  value: 1008.2767333984375,
  timestamp: '2026-05-29T12:00:00.000Z',
  source: 'mobile',
  nonce: 'n-quant',
});
beforeEach(() => {
  mockStore.stations.set(STATION, { owner: OWNER });
});

describe('quantized payload on the submit path', () => {
  it('prepare and submit use the same quantized commit id, and the reveal carries the quantized object', async () => {
    const app = buildApp();
    const prep = await prepare(app, longReading());
    expect(prep.status).toBe(200);
    const sub = await submit(app, longReading());
    expect(sub.status).toBe(200);
    const reveal = mockFetchCore4Json.mock.calls.find((c) => c[0] === '/transactions/contribution/reveal')![1].body;
    const commit = mockFetchCore4Json.mock.calls.find((c) => c[0] === '/transactions/contribution/commit')![1].body;
    expect(reveal.payload.pressure_hpa).toBe(1008.28);
    for (const v of Object.values(reveal.payload)) expect(Math.round((v as number) * 100) / 100).toBe(v);
    expect(commit.commit_hash).toBe(prep.body.commitId);
    expect(reveal.commit_hash).toBe(prep.body.commitId);
    expect(prep.body.commitId).toBe(
      computeCommitId({ data: reveal.payload, nonce: 'n-quant', stationId: STATION, timestamp: reveal.timestamp })
    );
  });
});

describe('core4 rejection attribution', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    const { blockchainLogger } = require('../server/utils/logger');
    warn = jest.spyOn(blockchainLogger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const reject = (path: string, status: number, payload: unknown) =>
    mockFetchCore4Json.mockImplementation(async (p: string) =>
      p === path
        ? { ok: false, status, payload }
        : { ok: true, status: 200, payload: { data: { tx_id: 't' } } }
    );

  it('a reveal 422 logs core4 code/message and station id, never coordinates or addresses', async () => {
    reject('/transactions/contribution/reveal', 422, {
      success: false,
      error: { code: 'REVEAL_MISMATCH', message: `Reveal payload does not match commit_hash for ${OWNER}0000000000 at 10.5` },
    });
    const res = await submit(buildApp(), longReading());
    expect(res.status).toBe(502);
    const call = warn.mock.calls.find((c) => String(c[0]).includes('reveal rejected'))!;
    expect(call[1]).toMatchObject({ stationId: STATION, status: 422, code: 'REVEAL_MISMATCH' });
    expect(call[1].message).toMatch(/does not match commit_hash/);
    const logged = JSON.stringify(call);
    expect(logged).not.toContain(OWNER);
    expect(logged).not.toContain('10.5');
  });

  it.each([
    'latitude=.1234567', 'latitude=1234567e-7', 'lat -12.5 lon +3.25E+2', 'at 0.1234567,-0.7654321', 'lat=12345678',
  ])('coordinate spellings (%s) are scrubbed at BOTH rejection sites', async (spelling) => {
    for (const path of ['/transactions/contribution/commit', '/transactions/contribution/reveal']) {
      warn.mockClear();
      reject(path, path.endsWith('commit') ? 422 : 422, { error: { code: 'BAD', message: `rejected ${spelling} here` } });
      await submit(buildApp(), longReading());
      const call = warn.mock.calls.find((c) => /rejected/.test(String(c[0])) && c[1]?.code === 'BAD')!;
      expect(call[1].code).toBe('BAD');
      expect(call[1].message).toMatch(/^rejected .* here$/);
      expect(String(call[1].message)).not.toMatch(/\d{3,}|\.\d|\d\.|[eE][-+]?\d/);
      expect(call[1].message.length).toBeLessThanOrEqual(200);
    }
  });

  it('a plain-string core4 error body is captured too', async () => {
    reject('/transactions/contribution/commit', 400, 'bad commit');
    const res = await submit(buildApp(), longReading());
    expect(res.status).toBe(502);
    expect(warn.mock.calls.find((c) => String(c[0]).includes('commit rejected'))![1]).toMatchObject({ status: 400, message: 'bad commit' });
  });

  it.each([
    [{ error: 'Launch protocol replay detected' }],
    [{ success: false, error: { code: 'X', message: 'Launch protocol replay detected: commit seen' } }],
  ])('a commit 400 "Launch protocol replay detected" is a terminal 409, no reveal attempted', async (payload) => {
    reject('/transactions/contribution/commit', 400, payload);
    const res = await submit(buildApp(), longReading());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COMMIT_ALREADY_SUBMITTED');
    expect(mockFetchCore4Json.mock.calls.some((c) => c[0] === '/transactions/contribution/reveal')).toBe(false);
  });

  it('other commit failures (and a replay-worded 500) stay 502', async () => {
    reject('/transactions/contribution/commit', 400, { error: 'Invalid signature' });
    expect((await submit(buildApp(), longReading())).status).toBe(502);
    reject('/transactions/contribution/commit', 500, { error: 'Launch protocol replay detected' });
    expect((await submit(buildApp(), longReading())).status).toBe(502);
  });
});
