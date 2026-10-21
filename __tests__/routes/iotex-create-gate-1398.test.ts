/**
 * backend#1398: POST /api/iotex/devices had no authentication gate, so any
 * anonymous caller could create device rows and attestation requests. It is
 * now operator/IoT-admin only, with the same refusal as PUT /devices/:id.
 * The database is a recorder here; the live-entrypoint, real-Postgres version
 * is iotex-create-gate-1398-live.test.ts.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const OPERATOR = 'test-operator-token-1398';
const IOT_ADMIN = 'test-iot-admin-token-1398';
process.env.IOT_GATEWAY_ADMIN_TOKEN = IOT_ADMIN;

const noop = () => {};
jest.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
}));

const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockEvaluate = jest.fn(async () => ({ status: 'clear' }));
const mockGenerateAttestation = jest.fn(async () => 'challenge-1398');

jest.mock('../../server/db', () => ({
  db: {
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return {
        values: (values: Record<string, unknown>) => ({
          returning: () => Promise.resolve([{ ...values, geoFenceStatus: 'clear' }]),
          then: (resolve: (v: unknown) => unknown) => resolve(undefined),
        }),
      };
    },
    update: (...args: unknown[]) => {
      mockUpdate(...args);
      return { set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) };
    },
  },
}));
jest.mock('../../server/integrations/iotex/controller', () => ({
  normalizePublicKey: async (k: unknown) => (typeof k === 'string' ? k : null),
  calculateGeohash: async () => 's3y0z0000',
  generateAttestation: (...args: unknown[]) => mockGenerateAttestation(...(args as [])),
}));
jest.mock('../../shared/iot-gateway-geofence-service', () => ({
  IotGatewayGeoFenceService: class {
    evaluateNewIdentity(...args: unknown[]) {
      return mockEvaluate(...(args as []));
    }
  },
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

const BODY = { name: 'Fake sensor', type: 'WEATHER_STATION', latitude: 10.0, longitude: 20.0 };

beforeEach(() => {
  process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR;
  jest.clearAllMocks();
});

describe('POST /api/iotex/devices is operator/IoT-admin only (backend#1398)', () => {
  it.each([
    ['no credentials', {}],
    ['a wrong bearer', { Authorization: 'Bearer not-the-operator' }],
    ['a wrong gateway admin token', { 'x-iot-gateway-admin-token': 'not-the-admin' }],
  ])('%s: refused with the PUT route\'s 401, before any write or side effect', async (_label, headers) => {
    const res = await request(app()).post('/api/iotex/devices').set(headers as Record<string, string>).send(BODY);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      message: 'Operator or IoT gateway admin authorization required',
      code: 'OPERATOR_AUTH_REQUIRED',
    });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(mockGenerateAttestation).not.toHaveBeenCalled();
  });

  it('the refusal is byte-identical to anonymous PUT /devices/:id', async () => {
    const post = await request(app()).post('/api/iotex/devices').send(BODY);
    const put = await request(app()).put('/api/iotex/devices/dev-1').send({ name: 'x' });
    expect(post.status).toBe(put.status);
    expect(post.text).toBe(put.text);
  });

  it.each([
    ['the operator bearer', { Authorization: `Bearer ${OPERATOR}` }],
    ['the gateway admin token', { 'x-iot-gateway-admin-token': IOT_ADMIN }],
  ])('%s creates a device as before (201, device row + attestation request)', async (_label, headers) => {
    const res = await request(app()).post('/api/iotex/devices').set(headers as Record<string, string>).send(BODY);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.device.name).toBe('Fake sensor');
    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(mockGenerateAttestation).toHaveBeenCalledTimes(1);
  });
});
