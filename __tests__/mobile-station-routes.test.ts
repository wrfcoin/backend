/**
 * backend#1288: route wiring for POST /api/weather/stations/mobile[/challenge]
 * on the REAL weather router, and the end-to-end property the feature exists
 * for: after registration the #1284 owner guard in oracle-submit-routes passes
 * for the derived station id (it returned STATION_NOT_OWNED before).
 */
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { FakeStore } from './helpers/mobile-station-fake-store';

const mockStore = new FakeStore();

// Auth: the wallet is whatever the test puts in x-test-wallet (401 without it).
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
// The owner guard's lookup reads the same weather_stations rows the registration wrote.
jest.mock('../database/connection.js', () => ({
  executeQuery: jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM mobile_station_registrations')) {
      // B6: the collect-key lookup (prepare passes when no auth_pubkey is sent yet)
      const reg = [...mockStore.registrations.values()].find((r) => r.stationId === params[0] && r.ownerAddress === params[1]);
      return { rows: reg ? [{ collect_pubkey: reg.collectPubkey, status: reg.status }] : [] };
    }
    const row = mockStore.stations.get(String(params[0]));
    return { rows: row ? [{ owner_address: row.owner }] : [] };
  }),
}));
jest.mock('../shared/core4-route-client.js', () => ({
  fetchCore4Json: jest.fn(),
  extractCore4Data: (p: any) => p?.data ?? p,
  forwardCore4Headers: jest.fn(() => ({})),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const weatherRoutes = require('../server/routes/weather-routes');
import oracleSubmitRoutes from '../server/routes/oracle-submit-routes';
import {
  buildMobileStationRegistrationMessage,
  buildStationOwnershipMessage,
  deriveMobileStationId,
} from '../shared/mobile-station-messages';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function wallet(seed: number) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32).toString('hex');
  const address = `0x${crypto.createHash('sha3-256').update(Buffer.from(publicKey, 'hex')).digest('hex').slice(0, 40)}`;
  return { publicKey, address, sign: (m: Buffer) => crypto.sign(null, m, key).toString('hex') };
}
const carol = wallet(31);
const carolCollect = wallet(131);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/weather', weatherRoutes.default ?? weatherRoutes);
  app.use('/api/oracle', oracleSubmitRoutes);
  return app;
}

async function register(app: express.Express, w = carol, cell = { latE1: 100, lonE1: -200 }) {
  const ch = await request(app).post('/api/weather/stations/mobile/challenge').set('x-test-wallet', w.address);
  expect(ch.status).toBe(200);
  const { nonce, expiresAt, stationId } = ch.body;
  const chain = { chainId: ch.body.chainId, networkId: ch.body.networkId };
  const body = {
    nonce, expiresAt, publicKey: w.publicKey, collectPubkey: carolCollect.publicKey, cell, deviceClass: 'phone-barometer',
    registrationSignature: w.sign(buildMobileStationRegistrationMessage({
      ...chain, stationId, ownerAddress: w.address, collectPubkey: carolCollect.publicKey, latE1: cell.latE1, lonE1: cell.lonE1, nonce, expiresAt,
    })),
    ownershipSignature: w.sign(buildStationOwnershipMessage({ ...chain, stationId, ownerAddress: w.address })),
  };
  return { ch, res: await request(app).post('/api/weather/stations/mobile').set('x-test-wallet', w.address).send(body), body };
}

const submitBody = (stationId: string) => ({
  dataType: 'temperature',
  location: { stationId, lat: 41.9, lon: -87.6 },
  value: 72.5,
  timestamp: '2026-05-29T12:00:00.000Z',
  source: 'mobile',
  nonce: 'mobile-nonce',
});

beforeEach(() => {
  mockStore.nonces.clear();
  mockStore.registrations.clear();
  mockStore.stations.clear();
  delete process.env.WRFCOIN_CHAIN_ID;
  delete process.env.WRFCOIN_NETWORK_ID;
});

describe('mobile station routes on the real weather router', () => {
  it('requires a wallet session on both endpoints', async () => {
    const app = buildApp();
    expect((await request(app).post('/api/weather/stations/mobile/challenge')).status).toBe(401);
    expect((await request(app).post('/api/weather/stations/mobile').send({})).status).toBe(401);
  });

  it('challenge → register → 201 with the derived id; success envelope; default chain 777/testnet', async () => {
    const app = buildApp();
    const { ch, res } = await register(app);
    expect(ch.body).toMatchObject({ success: true, chainId: '777', networkId: 'testnet' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      stationId: deriveMobileStationId(carol.address),
      status: 'db_only',
      created: true,
    });
  });

  it('the #1284 owner guard fails before registration and passes after (submit-data/prepare)', async () => {
    const app = buildApp();
    const stationId = deriveMobileStationId(carol.address);
    const before = await request(app)
      .post('/api/oracle/submit-data/prepare').set('x-test-wallet', carol.address).send(submitBody(stationId));
    expect(before.status).toBe(403);
    expect(before.body.error.code).toBe('STATION_NOT_OWNED');

    expect((await register(app)).res.status).toBe(201);
    mockStore.registrations.get(carol.address)!.status = 'on_chain';

    const after = await request(app)
      .post('/api/oracle/submit-data/prepare').set('x-test-wallet', carol.address).send(submitBody(stationId));
    expect(after.status).toBe(200);
    expect(after.body.stationId).toBe(stationId);
  });

  it("another wallet still cannot submit for the registered phone's station", async () => {
    const app = buildApp();
    await register(app);
    const mallory = wallet(32);
    const res = await request(app)
      .post('/api/oracle/submit-data/prepare').set('x-test-wallet', mallory.address)
      .send(submitBody(deriveMobileStationId(carol.address)));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('STATION_NOT_OWNED');
  });

  it('honours the node chain identity env in the challenge', async () => {
    process.env.WRFCOIN_CHAIN_ID = '778';
    process.env.WRFCOIN_NETWORK_ID = 'staging';
    const ch = await request(buildApp()).post('/api/weather/stations/mobile/challenge').set('x-test-wallet', wallet(33).address);
    expect(ch.body).toMatchObject({ chainId: '778', networkId: 'staging' });
  });

  it('rate-limits challenges per wallet (5/hour), not per IP', async () => {
    const app = buildApp();
    const w = wallet(34);
    const other = wallet(35);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await request(app).post('/api/weather/stations/mobile/challenge').set('x-test-wallet', w.address)).status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    // same IP, different wallet: unaffected by the first wallet's budget
    expect((await request(app).post('/api/weather/stations/mobile/challenge').set('x-test-wallet', other.address)).status).toBe(200);
  });
});
