/**
 * POST /api/weather/stations/:id/ownership-proof and the chainRegistration field on
 * reward-progress: both are off unless WEBSITE_STATION_CHAIN_REGISTRATION_ENABLED=true,
 * both need the owner's session, and the proof route passes the JWT address (never a
 * body field) to the service. Made-up ids and addresses only.
 */
const express = require('express');
const request = require('supertest');
const { stationAlias } = require('../../server/utils/station-alias');

jest.mock('../../server/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

let mockUser: { address: string } | null = null;
jest.mock('../../server/middleware/auth-middleware.js', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    if (!mockUser) return res.status(401).json({ error: 'unauthenticated' });
    req.user = mockUser;
    return next();
  },
}));

const mockQuery = jest.fn();
jest.mock('../../server/db.js', () => ({ pool: { query: (...a: unknown[]) => mockQuery(...a) } }));

class MockNotFound extends Error {}
const mockProgress = jest.fn();
jest.mock('../../server/services/station-reward-progress.js', () => ({
  getStationRewardProgress: (...a: unknown[]) => mockProgress(...a),
  StationRewardProgressNotFound: MockNotFound,
}));

let mockEnabled = true;
let mockChain: { chainId: string; networkId: string } | null = { chainId: '888', networkId: 'testnet' };
const mockSubmit = jest.fn();
const mockStatus = jest.fn();
jest.mock('../../server/services/website-station-chain-registration.js', () => ({
  websiteStationChainRegistrationEnabled: () => mockEnabled,
  resolveWebsiteStationChain: () => mockChain,
  newNeutralStationId: () => 'pws-0123456789abcdef',
  submitOwnershipProof: (...a: unknown[]) => mockSubmit(...a),
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

const RAW = 'pws-fixture-garden-a1b2c3';
const OWNER = '0x' + 'a'.repeat(40);
const PROOF = { owner_pubkey: 'ab'.repeat(32), owner_signature: 'cd'.repeat(64) };
const post = (id: string) => request(app()).post(`/api/weather/stations/${id}/ownership-proof`);

beforeEach(() => {
  mockUser = { address: OWNER };
  mockEnabled = true;
  mockChain = { chainId: '888', networkId: 'testnet' };
  mockQuery.mockReset();
  mockProgress.mockReset();
  mockSubmit.mockReset();
  mockStatus.mockReset();
});

describe('POST /stations/:id/ownership-proof', () => {
  test('switched off: 404 and the service is never called', async () => {
    mockEnabled = false;
    await post(RAW).send(PROOF).expect(404);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  test('switched off and signed out: still 404, so the route cannot be told apart from no route', async () => {
    mockEnabled = false;
    mockUser = null;
    await post(RAW).send(PROOF).expect(404);
  });

  test('no chain configured: refused with 503 and a code; the signature is never checked against a guess', async () => {
    mockChain = null;
    const res = await post(RAW).send(PROOF).expect(503);
    expect(res.body.error?.code ?? res.body.code).toBe('CHAIN_NOT_CONFIGURED');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  test('the service is given the configured chain', async () => {
    mockSubmit.mockResolvedValue({ status: 200, body: {} });
    await post(RAW).send(PROOF).expect(200);
    expect(mockSubmit.mock.calls[0][4]).toEqual({ chainId: '888', networkId: 'testnet' });
  });

  test('no session: 401 before anything else', async () => {
    mockUser = null;
    await post(RAW).send(PROOF).expect(401);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  test('the owner is the session wallet, never a body field', async () => {
    mockSubmit.mockResolvedValue({ status: 200, body: { chainRegistration: { state: 'waiting', stationId: RAW } } });
    const res = await post(RAW).send({ ...PROOF, ownerAddress: '0x' + 'b'.repeat(40) }).expect(200);
    expect(res.body).toEqual({ success: true, chainRegistration: { state: 'waiting', stationId: RAW } });
    expect(mockSubmit.mock.calls[0][1]).toBe(OWNER);
    expect(mockSubmit.mock.calls[0][2]).toBe(RAW);
  });

  test('the public alias resolves to the raw id for the service', async () => {
    mockQuery.mockResolvedValue({ rows: [{ station_id: RAW }] });
    mockSubmit.mockResolvedValue({ status: 200, body: { chainRegistration: { state: 'waiting', stationId: RAW } } });
    await post(stationAlias(RAW)).send(PROOF).expect(200);
    expect(mockSubmit.mock.calls[0][2]).toBe(RAW);
  });

  test('an unknown alias and a bad id never reach the service', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await post(stationAlias('nope')).send(PROOF).expect(404);
    await post('bad.id').send(PROOF).expect(400);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  test('a service refusal is passed through with its status and body', async () => {
    const body = { success: false, error: { code: 'OWNERSHIP_SIGNATURE_INVALID', message: 'x' } };
    mockSubmit.mockResolvedValue({ status: 400, body });
    const res = await post(RAW).send(PROOF).expect(400);
    expect(res.body).toEqual(body);
  });

  test('a database failure is a plain 503 with no detail', async () => {
    mockSubmit.mockRejectedValue(new Error('connection to 10.0.0.9 refused'));
    const res = await post(RAW).send(PROOF).expect(503);
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.9');
  });
});

describe('reward-progress carries chainRegistration for the owner', () => {
  test('switched on: the field is added', async () => {
    mockProgress.mockResolvedValue({ state: 'awaiting_observation' });
    mockStatus.mockResolvedValue({ state: 'waiting', stationId: RAW });
    const res = await request(app()).get(`/api/weather/stations/${RAW}/reward-progress`).expect(200);
    expect(res.body).toEqual({ state: 'awaiting_observation', chainRegistration: { state: 'waiting', stationId: RAW } });
    expect(mockStatus.mock.calls[0][1]).toBe(RAW);
    expect(mockStatus.mock.calls[0][2]).toBe(OWNER);
    expect(mockStatus.mock.calls[0][3]).toEqual({ chainId: '888', networkId: 'testnet' });
  });

  test('no chain configured: the field is null and nothing is read', async () => {
    mockChain = null;
    mockProgress.mockResolvedValue({ state: 'awaiting_observation' });
    const res = await request(app()).get(`/api/weather/stations/${RAW}/reward-progress`).expect(200);
    expect(res.body).toEqual({ state: 'awaiting_observation', chainRegistration: null });
    expect(mockStatus).not.toHaveBeenCalled();
  });

  test('switched off: the response is exactly what it was', async () => {
    mockEnabled = false;
    mockProgress.mockResolvedValue({ state: 'awaiting_observation' });
    const res = await request(app()).get(`/api/weather/stations/${RAW}/reward-progress`).expect(200);
    expect(res.body).toEqual({ state: 'awaiting_observation' });
    expect(mockStatus).not.toHaveBeenCalled();
  });

  test('a missing table does not break reward-progress: the field is null', async () => {
    mockProgress.mockResolvedValue({ state: 'rewarded' });
    mockStatus.mockRejectedValue(new Error('relation does not exist'));
    const res = await request(app()).get(`/api/weather/stations/${RAW}/reward-progress`).expect(200);
    expect(res.body).toEqual({ state: 'rewarded', chainRegistration: null });
  });
});
