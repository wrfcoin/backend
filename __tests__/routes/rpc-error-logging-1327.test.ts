import express from 'express';
import request from 'supertest';

jest.mock('../../server/utils/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    metrics: { recordHttpRequest: jest.fn() } };
  return { logger, securityLogger: logger, blockchainLogger: logger };
});
jest.mock('../../server/middleware/authLogging', () => ({
  logAuthSuccess: jest.fn(), logAuthFailure: jest.fn(), logApiKeyUsage: jest.fn(),
}));
const mockFetch = jest.fn();
jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: (...args: any[]) => mockFetch(...args), extractCore4Data: (p: any) => p,
}));
const mockForecast = jest.fn();
jest.mock('../../server/services/noaa-nws-api-service', () => jest.fn(() => ({ getForecast: mockForecast })));

const KEY = 'test-only-A13-rpc-access-key';
const READER = 'test-only-A13-reader';
const saved = { RPC_API_KEY: process.env.RPC_API_KEY, WRFCOIN_READER_TOKEN: process.env.WRFCOIN_READER_TOKEN };
const router = require('../../server/routes/rpc-routes');
const { logger } = require('../../server/utils/logger');
function app() { const a = express(); a.use(express.json()); a.use('/api/rpc', router); return a; }
function call(method = 'blockchain.getStatus', params?: any, authenticated = true) {
  const req = request(app()).post('/api/rpc');
  if (authenticated) req.set('x-api-key', KEY);
  return req.send({ jsonrpc: '2.0', id: 'original-request-id', method, ...(params === undefined ? {} : { params }) });
}
beforeEach(() => {
  process.env.RPC_API_KEY = KEY; process.env.WRFCOIN_READER_TOKEN = READER;
  jest.clearAllMocks(); mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, payload: { chain_height: 12, peer_count: 2, avg_block_time_secs: 3 } });
});
afterAll(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

it.each([undefined, {}, null, [], 1, 'text'])('preserves missing-Reader classification with params=%j', async params => {
  delete process.env.WRFCOIN_READER_TOKEN;
  const res = await call('blockchain.getStatus', params);
  expect(res.status).toBe(503);
  expect(res.body).toEqual({ jsonrpc: '2.0', id: 'original-request-id', error: {
    code: -32000, message: 'Core4 Reader credential is not configured', data: { code: 'CORE4_READER_CREDENTIAL_UNCONFIGURED' },
  } });
  expect(mockFetch).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith('RPC method execution error: blockchain.getStatus', {
    error: 'Chain reads are unavailable: the backend core4 Reader credential is not configured',
  });
});
it.each([
  ['blockchain.getBlock', 'blockHeight'], ['oracle.getForecast', 'location'],
])('preserves %s validation errors when optional params is omitted', async (method, missing) => {
  const res = await call(method);
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ jsonrpc: '2.0', id: 'original-request-id', error: {
    code: -32602, message: 'Invalid params', data: `Missing required parameter: ${missing}`,
  } });
  expect(mockFetch).not.toHaveBeenCalled(); expect(mockForecast).not.toHaveBeenCalled();
});
it.each([
  [undefined, 400, -32603, 'Internal error'],
  [-32603, 400, -32603, 'Internal error'],
  [-32601, 501, -32601, 'Not implemented'],
])('preserves an upstream method error code=%j with no params', async (code, status, rpcCode, message) => {
  mockFetch.mockRejectedValue(Object.assign(new Error('test upstream outage'), code === undefined ? {} : { code }));
  const res = await call();
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ jsonrpc: '2.0', id: 'original-request-id', error: { code: rpcCode, message } });
  expect(logger.error).toHaveBeenCalledWith('RPC method execution error: blockchain.getStatus', { error: 'test upstream outage' });
});
it('does not retain caller parameter values in the common method-error log', async () => {
  delete process.env.WRFCOIN_READER_TOKEN;
  const res = await call('blockchain.getStatus', { private_data: 'caller-only-1327-marker', location: { latitude: 39.739236, longitude: -104.990251 } });
  expect(res.status).toBe(503);
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('caller-only-1327-marker');
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('39.739236');
  expect(logger.error.mock.calls[0][1]).not.toHaveProperty('params');
});
it.each([undefined, {}])('retains successful getStatus responses with params=%j', async params => {
  const res = await call('blockchain.getStatus', params);
  expect(res.status).toBe(200); expect(res.body.id).toBe('original-request-id'); expect(res.body.result.blockHeight).toBe(12);
  expect(mockFetch).toHaveBeenCalledTimes(3); expect(logger.error).not.toHaveBeenCalled();
});
it('retains real RPC authentication before method dispatch', async () => {
  expect((await call('blockchain.getStatus', undefined, false)).status).toBe(401);
  expect(mockFetch).not.toHaveBeenCalled();
});
