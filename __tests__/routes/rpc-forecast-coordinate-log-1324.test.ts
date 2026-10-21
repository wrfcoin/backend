/**
 * backend#1324: the RPC oracle.getForecast failure path logged the caller's
 * latitude/longitude at supplied precision, and the common method-error log
 * carried upstream error text that echoes the requested point. Owner ruling
 * 2026-09-28: a position is never logged finer than 0.1 deg. Fixture
 * coordinates are synthetic.
 */
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
jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: jest.fn(), extractCore4Data: (p: any) => p,
}));
const mockForecast = jest.fn();
jest.mock('../../server/services/noaa-nws-api-service', () => jest.fn(() => ({ getForecast: mockForecast })));

const KEY = 'test-only-1324-rpc-access-key';
const saved = { RPC_API_KEY: process.env.RPC_API_KEY };
const router = require('../../server/routes/rpc-routes');
const { logger } = require('../../server/utils/logger');
const call = (location: unknown) =>
  request((() => { const a = express(); a.use(express.json()); a.use('/api/rpc', router); return a; })())
    .post('/api/rpc').set('x-api-key', KEY)
    .send({ jsonrpc: '2.0', id: 1, method: 'oracle.getForecast', params: { location } });
const logged = () => JSON.stringify(logger.error.mock.calls);
const FINE = /44\.98765|93\.26543|44\.9876|93\.2654/;

beforeEach(() => { process.env.RPC_API_KEY = KEY; jest.clearAllMocks(); });
afterAll(() => { if (saved.RPC_API_KEY === undefined) delete process.env.RPC_API_KEY; else process.env.RPC_API_KEY = saved.RPC_API_KEY; });

describe.each([
  ['string "lat,lng"', '44.98765,-93.26543'],
  ['{latitude, longitude} object', { latitude: 44.98765, longitude: -93.26543 }],
])('oracle.getForecast failure with a %s location', (_name, location) => {
  it('logs the position at 0.1 deg only, even when the upstream error echoes the exact point', async () => {
    mockForecast.mockRejectedValue(new Error('NWS 404 for https://api.weather.gov/points/44.98765,-93.26543'));
    const res = await call(location);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(logger.error).toHaveBeenCalled();
    expect(logged()).not.toMatch(FINE);
    // the region is still recorded, at 0.1 deg
    expect(logged()).toContain('45');
    expect(logged()).toContain('-93.3');
  });

  it('a successful lookup is unchanged and logs no error', async () => {
    mockForecast.mockResolvedValue({ periods: [] });
    const res = await call(location);
    expect(res.status).toBe(200);
    expect(res.body.result.source).toBe('noaa-nws');
    expect(mockForecast).toHaveBeenCalledWith(44.98765, -93.26543);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

it('invalid coordinate input logs no exact position', async () => {
  const res = await call('44.98765,not-a-number');
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(logged()).not.toMatch(FINE);
});

// Review of #1347: scientific spellings whose mantissa is fractional used to leave a fine prefix.
describe.each([
  '449876.5e-4,-932654.3e-4',
  '4498.765e-2,-9326.543e-2',
  '4498765e-5,-9326543e-5',
])('oracle.getForecast failure echoing the scientific spelling %s', (spelling) => {
  it('retains no mantissa prefix in either RPC log', async () => {
    mockForecast.mockRejectedValue(new Error(`NWS 404 for points/${spelling}`));
    const res = await call(spelling);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const text = logged();
    expect(text).not.toMatch(/44987|44\.98|9326|93\.26|449876|4498\.7|932654/);
    expect(text).toContain('45.0');
  });
});

function deepEncode(text: string, levels: number): string {
  let out = [...text].map((ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');
  for (let i = 1; i < levels; i += 1) out = out.replace(/%/g, '%25');
  return out;
}

// Review of #1347 (SOL-C): percent-encoded mantissa signs/dots inside upstream error text.
describe.each([
  ['encoded sign', '4498765e-5,-9326543e-5', 'NWS 404 for https://api.weather.gov/points/4498765e-5,%2D9326543e-5'],
  ['encoded dot in a fractional mantissa', '4498765e-5,-9326543e-5', 'NWS 404 for https://api.weather.gov/points/449876%2E5e-4,-932654%2E3e-4'],
  ['encoded digits', '4498765e-5,-9326543e-5', 'NWS 404 for points/44%39%38765e-5,%2D93%32%36543e-5'],
  ['encoded exponent marker %65', '4498765e-5,-9326543e-5', 'NWS 404 for https://api.weather.gov/points/4498765%65-5,-9326543%65-5'],
  ['encoded exponent marker %45 (upper case)', '4498765e-5,-9326543e-5', 'NWS 404 for https://api.weather.gov/points/4498765%45-5,%2D9326543%45%2D5'],
  ['fully encoded token', '4498765e-5,-9326543e-5', 'NWS 404 for points/%34%34%39%38%37%36%35%65%2D%35,%2D%39%33%32%36%35%34%33%45%2D%35'],
  ['encoded plus exponent', '4498765e-5,-9326543e-5', 'NWS 404 for points/4.498765e%2B1,%2D9.326543e%2B1'],
  // Round 5 (SOL-C): encoded separators glue to the number; whole value is dropped, decoded text never reused.
  ['encoded slash before the token', '4498765e-5,-9326543e-5', 'NWS 404 for points%2F4498765%65-5,%2D9326543%65-5'],
  ['encoded comma before a positive token', '4498765e-5,9326543e-5', 'NWS 404 for points/4498765e-5%2C9326543e-5'],
  ['a coordinate encoded 6 levels deep (round 6)', '4498765e-5,-9326543e-5', 'upstream said: points/' + deepEncode('4498765e-5,-9326543e-5', 6) + ' while fetching'],
  ['a coordinate encoded 5 levels deep (control)', '4498765e-5,-9326543e-5', 'upstream said: points/' + deepEncode('4498765e-5,-9326543e-5', 5) + ' while fetching'],
  ['double-encoded token', '4498765e-5,-9326543e-5', 'NWS 404 for points%252F4498765%2565-5,%252D9326543%2565-5'],
])('oracle.getForecast failure echoing an %s', (_name, location, upstream) => {
  it('neither RPC log entry retains a recoverable exact number', async () => {
    mockForecast.mockRejectedValue(new Error(upstream));
    const res = await call(location);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(logger.error.mock.calls.length).toBeGreaterThanOrEqual(2); // the forecast log AND the common method-error log
    const text = logged();
    expect(text).not.toMatch(/9326543|932654|4498765|449876|93\.26|44\.98|%2[dDeEbB]|%3\d/);
    expect(text).toContain('[REDACTED: encoded coordinate text]');
    expect(text).toContain('"latitude"'); // the 0.1 degree location entry is still logged
  });
});
