/**
 * backend#1288 story B4: GET /api/weather/stations/mobile - the caller's OWN
 * registration status, or 404. Synthetic wallets and cells only.
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
jest.mock('../shared/core4-route-client.js', () => ({
  fetchCore4Json: jest.fn(),
  extractCore4Data: (p: any) => p?.data ?? p,
  forwardCore4Headers: jest.fn(() => ({})),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const weatherRoutes = require('../server/routes/weather-routes');
import { deriveMobileStationId } from '../shared/mobile-station-messages';
import { getMobileStationStatus } from '../server/services/mobile-station-registration-service';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const CREATED = new Date('2026-09-01T10:00:00.000Z');
const UPDATED = new Date('2026-09-02T11:30:00.000Z');

function seed(owner: string, status: 'db_only' | 'submitted' | 'on_chain' = 'db_only') {
  const stationId = deriveMobileStationId(owner);
  mockStore.registrations.set(owner, {
    stationId, ownerAddress: owner, ownerPubkey: 'aa'.repeat(32), collectPubkey: 'dd'.repeat(32), cellLatE1: 123, cellLonE1: -456,
    deviceClass: 'phone-barometer', registrationNonce: 'n'.repeat(16), registrationExpiresAt: 1,
    registrationSignature: 'bb'.repeat(64), ownershipSignature: 'cc'.repeat(64), status,
    createdAt: CREATED, updatedAt: UPDATED,
  });
  return stationId;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/weather', weatherRoutes.default ?? weatherRoutes);
  return app;
}

beforeEach(() => {
  mockStore.nonces.clear();
  mockStore.registrations.clear();
  mockStore.stations.clear();
});

describe('GET /api/weather/stations/mobile (B4)', () => {
  it('requires a wallet session', async () => {
    expect((await request(buildApp()).get('/api/weather/stations/mobile')).status).toBe(401);
  });

  it('404s when the caller has no registration', async () => {
    const res = await request(buildApp()).get('/api/weather/stations/mobile').set('x-test-wallet', addr(1));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_REGISTERED');
  });

  it.each(['db_only', 'submitted', 'on_chain'] as const)('returns the caller\'s own row (%s)', async (status) => {
    const owner = addr(2);
    const stationId = seed(owner, status);
    const res = await request(buildApp()).get('/api/weather/stations/mobile').set('x-test-wallet', owner);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      stationId,
      status,
      cell: { latE1: 123, lonE1: -456 },
      createdAt: CREATED.toISOString(),
      updatedAt: UPDATED.toISOString(),
    });
  });

  it("never returns another wallet's row, and leaks no proof material or owner", async () => {
    const other = addr(3);
    seed(other);
    const mine = addr(4);
    expect((await request(buildApp()).get('/api/weather/stations/mobile').set('x-test-wallet', mine)).status).toBe(404);

    seed(mine);
    const res = await request(buildApp()).get('/api/weather/stations/mobile').set('x-test-wallet', mine);
    expect(res.body.stationId).toBe(deriveMobileStationId(mine));
    const text = JSON.stringify(res.body);
    for (const secret of ['aa'.repeat(32), 'bb'.repeat(64), 'cc'.repeat(64), mine, other]) {
      expect(text).not.toContain(secret);
    }
  });

  it("ignores another wallet's id sent by query, path or body: only the caller's own row is ever looked up", async () => {
    const victim = addr(5);
    const victimId = seed(victim);
    const caller = addr(6); // authenticated, but has no row of their own
    const app = buildApp();
    const asCaller = (r: request.Test) => r.set('x-test-wallet', caller);

    const viaQuery = [
      `?wallet=${victim}`, `?address=${victim}`, `?walletAddress=${victim}`, `?owner=${victim}`,
      `?stationId=${victimId}`, `?station_id=${victimId}`, `?id=${victimId}`,
    ];
    for (const qs of viaQuery) {
      const res = await asCaller(request(app).get(`/api/weather/stations/mobile${qs}`));
      expect([qs, res.status, res.body?.error?.code]).toEqual([qs, 404, 'NOT_REGISTERED']);
      expect(JSON.stringify(res.body)).not.toContain(victimId);
    }

    const viaBody = await asCaller(request(app).get('/api/weather/stations/mobile'))
      .send({ wallet: victim, address: victim, walletAddress: victim, stationId: victimId });
    expect([viaBody.status, viaBody.body?.error?.code]).toEqual([404, 'NOT_REGISTERED']);
    expect(JSON.stringify(viaBody.body)).not.toContain(victimId);

    for (const path of [`/api/weather/stations/mobile/${victim}`, `/api/weather/stations/mobile/${victimId}`]) {
      const res = await asCaller(request(app).get(path));
      expect(res.status).not.toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(victimId);
    }

    // With a row of their own, the caller still gets only their own, whatever they send.
    const mineId = seed(caller);
    const res = await asCaller(request(app).get(`/api/weather/stations/mobile?wallet=${victim}&stationId=${victimId}`))
      .send({ wallet: victim });
    expect(res.status).toBe(200);
    expect(res.body.stationId).toBe(mineId);
    expect(JSON.stringify(res.body)).not.toContain(victimId);
  });

  it('normalises the caller address case (the row is keyed lowercase)', async () => {
    const owner = addr(0xabc);
    seed(owner);
    const res = await request(buildApp()).get('/api/weather/stations/mobile').set('x-test-wallet', owner.toUpperCase().replace('0X', '0x'));
    expect(res.status).toBe(200);
  });

  it('service: a non-address caller is 401, never a lookup', async () => {
    expect((await getMobileStationStatus(mockStore, 'not-an-address')).status).toBe(401);
    expect((await getMobileStationStatus(mockStore, undefined)).status).toBe(401);
  });
});
