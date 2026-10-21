/**
 * backend#1220: /api/iotex served every device column (exact lat/lon, owner
 * wallet, publicKey, hardware id, geofence review state), raw readings,
 * attestation challenges and publisher keys to anonymous callers, and let
 * anonymous callers rewrite attestation status/location or submit
 * reward-bearing data.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const OPERATOR = 'test-operator-token-1220';
const IOT_ADMIN = 'test-iot-admin-token-1220';
process.env.IOT_GATEWAY_ADMIN_TOKEN = IOT_ADMIN;

const noop = () => {};
jest.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
}));

const DEVICE = {
  id: 'dev-1',
  name: 'Sensor A',
  type: 'WEATHER_STATION',
  attestationStatus: 'VERIFIED',
  attestationType: 'SIGNATURE',
  lastSeen: '2026-09-20T00:00:00.000Z',
  latitude: 10.123456,
  longitude: -20.987654,
  geohash: 'cbrh7x2k9q',
  geoFenceGrid: 'g-17',
  geoFenceStatus: 'clear',
  geoFenceReason: 'burst',
  geoFenceReviewedBy: 'iot-gateway-admin',
  metadata: { serial: 'SN-123' },
  owner: '0xOwnerWallet000000000000000000000000000001',
  publicKey: 'PUBKEY-SECRETISH',
  firmwareVersion: '1.2.3',
  hardwareId: 'HW-XYZ',
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
};
const PRIVATE_KEYS = [
  'owner', 'publicKey', 'hardwareId', 'firmwareVersion', 'geohash', 'geoFenceGrid',
  'geoFenceStatus', 'geoFenceReason', 'geoFenceReviewedBy', 'metadata',
];

const mockVerifySignature = jest.fn(async () => false);
const mockVerifySigned = jest.fn(async (..._args: unknown[]): Promise<{ ok: boolean; timestampSeconds?: number }> => ({ ok: false }));
const mockProcessWeatherData = jest.fn(async () => ({}));
const mockInsert = jest.fn();
const mockUpdate = jest.fn();

function listChain(): any {
  const chain: any = {
    from: () => chain,
    where: () => Promise.resolve([DEVICE]),
    orderBy: () => chain,
    limit: () => chain,
    offset: () => Promise.resolve([DEVICE]),
    then: (resolve: any) => resolve([{ total: 1 }]),
  };
  return chain;
}

jest.mock('../../server/db', () => ({
  db: {
    select: () => listChain(),
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return { values: () => ({ returning: () => Promise.resolve([{ id: 'entry-1' }]) }) };
    },
    update: (...args: unknown[]) => {
      mockUpdate(...args);
      return { set: () => ({ where: () => ({ returning: () => Promise.resolve([DEVICE]) }) }) };
    },
  },
}));
jest.mock('../../server/integrations/iotex/controller', () => ({
  verifySignature: (...args: unknown[]) => mockVerifySignature(...(args as [])),
  verifySignedSubmission: (...args: unknown[]) => mockVerifySigned(...args),
  normalizePublicKey: async (k: unknown) => (typeof k === 'string' ? k : null),
  processWeatherData: (...args: unknown[]) => mockProcessWeatherData(...(args as [])),
}));
jest.mock('../../shared/iot-gateway-geofence-service', () => ({
  IotGatewayGeoFenceService: class {},
  buildGeoFenceReviewUpdate: () => ({}),
  isRewardEligibleForGeoFence: () => true,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const iotexRouter = require('../../server/routes/iotex');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/iotex', iotexRouter.default || iotexRouter);
  return a;
}

beforeEach(() => {
  process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR;
  jest.clearAllMocks();
});

function expectAnonymous(device: Record<string, unknown>) {
  for (const key of PRIVATE_KEYS) {
    expect(device).not.toHaveProperty(key);
  }
  expect(device.latitude).toBe(10.1);
  expect(device.longitude).toBe(-21);
  // Owner ruling 2026-10-01: never finer than 0.1 degree for anonymous reads.
  for (const key of ['latitude', 'longitude']) {
    expect(String(device[key]).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(1);
  }
}

describe('anonymous device reads are a coarse, non-identifying projection', () => {
  it('GET /devices', async () => {
    const res = await request(app()).get('/api/iotex/devices').expect(200);
    expect(res.body.data).toHaveLength(1);
    expectAnonymous(res.body.data[0]);
    expect(JSON.stringify(res.body)).not.toMatch(/46\.786543|0xOwnerWallet|PUBKEY/);
  });

  it('GET /devices/:id', async () => {
    const res = await request(app()).get('/api/iotex/devices/dev-1').expect(200);
    expectAnonymous(res.body.device);
    expect(res.body.device.name).toBe('Sensor A');
  });

  it('a wrong bearer token is still anonymous', async () => {
    const res = await request(app())
      .get('/api/iotex/devices/dev-1')
      .set('Authorization', 'Bearer nope')
      .expect(200);
    expectAnonymous(res.body.device);
  });
});

describe('privileged callers see full rows', () => {
  it.each([
    ['operator bearer', { Authorization: `Bearer ${OPERATOR}` }],
    ['iot gateway admin', { 'x-iot-gateway-admin-token': IOT_ADMIN }],
  ])('%s', async (_label, headers) => {
    const list = await request(app()).get('/api/iotex/devices').set(headers).expect(200);
    const one = await request(app()).get('/api/iotex/devices/dev-1').set(headers).expect(200);
    expect(list.body.data[0]).toEqual(DEVICE);
    expect(one.body.device).toEqual(DEVICE);
  });
});

describe('raw readings, attestations and publisher data are operator/admin only', () => {
  it.each([
    '/api/iotex/devices/dev-1/data',
    '/api/iotex/devices/dev-1/attestations',
    '/api/iotex/w3bstream/publishers',
    '/api/iotex/w3bstream/publishers/pub-1/events',
  ])('anonymous GET %s → 401', async path => {
    const res = await request(app()).get(path);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('OPERATOR_AUTH_REQUIRED');
  });
});

describe('writes need device or admin auth', () => {
  it('anonymous PUT /devices/:id cannot set attestation status or location', async () => {
    const res = await request(app())
      .put('/api/iotex/devices/dev-1')
      .send({ attestationStatus: 'VERIFIED', latitude: 1, longitude: 2 });
    expect(res.status).toBe(401);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('unsigned POST /devices/:id/data is rejected before storage or reward processing', async () => {
    const res = await request(app()).post('/api/iotex/devices/dev-1/data').send({ data: { t: 1 } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('DEVICE_SIGNATURE_REQUIRED');
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockProcessWeatherData).not.toHaveBeenCalled();
  });

  // backend#1240: the verifier is real ed25519 now (proved end to end in
  // iotex-signature-forgery-1240.test.ts); here only the route contract with a
  // stubbed verifier: a signature it rejects is refused without any write.
  it('a signature the verifier rejects is refused without operator/admin auth', async () => {
    mockVerifySigned.mockResolvedValue({ ok: false });
    const res = await request(app())
      .post('/api/iotex/devices/dev-1/data')
      .send({ data: { t: 1 }, signature: '0xbad', timestamp: 1, nonce: 'nonce-12345' });
    expect(res.status).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockProcessWeatherData).not.toHaveBeenCalled();
  });

  it.each([
    ['operator bearer', { Authorization: `Bearer ${OPERATOR}` }],
    ['iot gateway admin', { 'x-iot-gateway-admin-token': IOT_ADMIN }],
  ])('%s may submit data', async (_label, headers) => {
    const res = await request(app()).post('/api/iotex/devices/dev-1/data').set(headers).send({ data: { t: 1 } });
    expect(res.status).toBe(201);
    expect(mockInsert).toHaveBeenCalled();
    expect(mockProcessWeatherData).toHaveBeenCalled();
  });
});
