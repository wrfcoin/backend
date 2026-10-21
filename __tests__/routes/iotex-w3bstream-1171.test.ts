/**
 * backend#1171 — W3bstream is an honest gap, never a fabricated receipt.
 *
 * The adapter used to publish to a hard-coded example.com host with a default
 * API key and answer success with Math.random transaction ids. These tests run
 * the REAL router, controller and adapter (only the DB and logger are faked)
 * and prove: /api/iotex/w3bstream/* is the standard not-wired 501 in every
 * configuration this backend can be in, device data is stored without any
 * invented transaction id, and the adapter source carries no placeholder.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import express from 'express';
import request from 'supertest';

const noop = () => {};
jest.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
}));

const mockDevice = {
  id: 'dev-ws-1',
  name: 'Station A',
  type: 'WEATHER_STATION',
  geoFenceStatus: 'clear',
  publicKey: null,
  latitude: 46.8,
  longitude: -92.1,
};
const mockDb: any = {
  select: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
};
jest.mock('../../server/db', () => ({ db: mockDb }));
jest.mock('../../shared/iot-gateway-geofence-service', () => ({
  IotGatewayGeoFenceService: class {},
  buildGeoFenceReviewUpdate: () => ({}),
  isRewardEligibleForGeoFence: () => true,
}));

const ORIGINAL_ENV = { ...process.env };
const OPERATOR = 'test-operator-token-1171';
const asOperator = { Authorization: `Bearer ${OPERATOR}` };

function loadApp() {
  let router: any;
  jest.isolateModules(() => {
    router = require('../../server/routes/iotex');
  });
  const a = express();
  a.use(express.json());
  a.use('/api/iotex', router.default || router);
  return a;
}

function loadAdapter() {
  let adapter: any;
  jest.isolateModules(() => {
    adapter = require('../../server/integrations/iotex/w3bstream-adapter');
  });
  return adapter;
}

// Every row has three entries: a two-entry row would make jest pass `done`.
// Every route is operator-only (backend#1220), so they are called as an operator.
const w3bstreamRoutes: Array<[string, string, Record<string, unknown> | null]> = [
  ['post', '/api/iotex/w3bstream/publishers', { name: 'p', type: 'WEATHER_STATION', publicKey: 'k' }],
  ['post', '/api/iotex/w3bstream/events', { publisherId: 'pub-1', eventType: 'reading', payload: { t: 1 } }],
  ['get', '/api/iotex/w3bstream/publishers', null],
  ['get', '/api/iotex/w3bstream/publishers/pub-1/events', null],
];

async function call(
  app: express.Express,
  method: string,
  path: string,
  body?: Record<string, unknown> | null,
  headers: Record<string, string> = asOperator,
) {
  const req = (request(app) as any)[method](path).set(headers);
  return body ? req.send(body) : req;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.W3B_ENDPOINT;
  delete process.env.W3B_API_KEY;
  process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR;
  mockDb.select.mockReset();
  mockDb.insert.mockReset();
  mockDb.update.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('backend#1171: /api/iotex/w3bstream/* is the standard not-wired 501', () => {
  it.each(w3bstreamRoutes)('%s %s answers 501 NOT_IMPLEMENTED when W3B env is unset', async (method, path, body) => {
    const res = await call(loadApp(), method, path, body);
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({
      success: false,
      unavailable: true,
      error: { code: 'NOT_IMPLEMENTED', capability: 'iotex.w3bstream' },
    });
    expect(res.body.error.details).toContain('W3BSTREAM_NOT_CONFIGURED');
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it.each(w3bstreamRoutes)('anonymous %s %s is refused 401 before any wiring detail (backend#1220 first)', async (method, path, body) => {
    const res = await call(loadApp(), method, path, body, {});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('OPERATOR_AUTH_REQUIRED');
    expect(JSON.stringify(res.body)).not.toMatch(/W3BSTREAM|W3B_ENDPOINT/);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('treats a placeholder endpoint (the old example.com default) as not configured', async () => {
    process.env.W3B_ENDPOINT = 'https://w3bstream.example.com/api/v1';
    process.env.W3B_API_KEY = 'mock-w3bstream-api-key';
    const res = await call(loadApp(), 'post', '/api/iotex/w3bstream/publishers', w3bstreamRoutes[0][2]);
    expect(res.status).toBe(501);
    expect(res.body.error.details).toContain('W3BSTREAM_NOT_CONFIGURED');
  });

  it('needs BOTH W3B_ENDPOINT and W3B_API_KEY', async () => {
    process.env.W3B_ENDPOINT = 'https://w3bstream.iotex.io/api/v1';
    const res = await call(loadApp(), 'get', '/api/iotex/w3bstream/publishers');
    expect(res.status).toBe(501);
    expect(res.body.error.details).toContain('W3BSTREAM_NOT_CONFIGURED');
  });

  it('stays 501 when configured, because no W3bstream client exists to publish with', async () => {
    process.env.W3B_ENDPOINT = 'https://w3bstream.iotex.io/api/v1';
    process.env.W3B_API_KEY = 'real-looking-key';
    const res = await call(loadApp(), 'post', '/api/iotex/w3bstream/events', w3bstreamRoutes[1][2]);
    expect(res.status).toBe(501);
    expect(res.body.error.details).toContain('W3BSTREAM_CLIENT_NOT_IMPLEMENTED');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('leaves the device registry mounted and DB-backed', async () => {
    const chain: any = {
      from: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      offset: () => Promise.resolve([]),
      then: (resolve: any) => resolve([{ total: 0 }]),
    };
    mockDb.select.mockReturnValue(chain);
    const res = await call(loadApp(), 'get', '/api/iotex/devices');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });
});

describe('backend#1171: device data is stored without an invented on-chain receipt', () => {
  it('POST /devices/:id/data stores the reading and records no transaction id or block reference', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([mockDevice]) }) });
    const stored: Record<string, unknown>[] = [];
    mockDb.insert.mockReturnValue({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          stored.push(values);
          return Promise.resolve([{ ...values }]);
        },
      }),
    });

    const res = await call(loadApp(), 'post', `/api/iotex/devices/${mockDevice.id}/data`, {
      data: { temperature: 12.5 },
    });

    expect(res.status).toBe(201);
    expect(stored).toHaveLength(1);
    expect(res.body.dataEntry.transactionId).toBeUndefined();
    expect(res.body.dataEntry.blockchainReference).toBeUndefined();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toMatch(/w3b-tx-/);
  });
});

describe('backend#1171: the adapter refuses instead of fabricating', () => {
  it('publish functions reject with a coded error and never return an id', async () => {
    const adapter = loadAdapter();
    await expect(adapter.sendWeatherData(mockDevice, { t: 1 })).rejects.toMatchObject({ code: 'W3BSTREAM_NOT_CONFIGURED' });
    await expect(adapter.processEvent({ id: 'e1' }, { id: 'p1' })).rejects.toMatchObject({ code: 'W3BSTREAM_NOT_CONFIGURED' });

    process.env.W3B_ENDPOINT = 'https://w3bstream.iotex.io/api/v1';
    process.env.W3B_API_KEY = 'real-looking-key';
    await expect(adapter.sendWeatherData(mockDevice, { t: 1 })).rejects.toMatchObject({ code: 'W3BSTREAM_CLIENT_NOT_IMPLEMENTED' });
  });

  it('reports project status honestly, with no invented counts', async () => {
    const status = await loadAdapter().getProjectStatus();
    expect(status).toEqual({ status: 'not_configured', configured: false, wired: false, projectName: 'wrfcoin-weather-data' });
  });

  it('rejects every placeholder host form', () => {
    const adapter = loadAdapter();
    process.env.W3B_API_KEY = 'k';
    for (const endpoint of ['https://example.com', 'https://api.example.org/v1', 'https://w3b.invalid', 'http://localhost:9000', 'not a url', 'ftp://w3bstream.iotex.io']) {
      process.env.W3B_ENDPOINT = endpoint;
      expect(adapter.isW3bstreamConfigured()).toBe(false);
    }
    process.env.W3B_ENDPOINT = 'https://w3bstream.iotex.io/api/v1';
    expect(adapter.isW3bstreamConfigured()).toBe(true);
    expect(adapter.isW3bstreamWired()).toBe(false);
  });

  it('carries no placeholder endpoint, default key or random id generator in server/integrations/iotex', () => {
    const scan = (pattern: string) => {
      try {
        return execFileSync('git', ['grep', '-n', '-E', pattern, '--', 'server/integrations/iotex'], { encoding: 'utf8' });
      } catch (error: any) {
        if (error.status === 1) return '';
        throw error;
      }
    };
    expect(scan('example\\.com')).toBe('');
    expect(scan('mock-w3bstream-api-key')).toBe('');
    expect(scan('w3b-tx-')).toBe('');
    expect(scan('mockBlockchain')).toBe('');
    expect(scan('Math\\.random')).toBe('');
  });
});
