/**
 * backend#1136 — the one mounted cross-chain router (`server/routes/cross-chain.ts`)
 * answers with the honest-gap 501 envelope (never a Math.random()-fabricated
 * transfer/verification), keeps auth + validation, and loads WITHOUT importing
 * `integrations/cross-chain/index.js` (which self-initialises mock providers).
 *
 * Also carries forward the #820 / #957 assertions that used to live in
 * `cross-chain-map-retired.test.ts` against the deleted JS twin
 * (`crossChainRoutes.js`): the fake `/map` surfaces stay withdrawn.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';

const passthrough = (_req: any, _res: any, next: any) => next();
jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: jest.fn(passthrough),
}));
jest.mock('../../middleware/rateLimiting.js', () => ({
  generalLimiter: passthrough,
  transferLimiter: passthrough,
}));
// Loud failure if the router (re)grows a dependency on the mock integration layer.
jest.mock('../../server/integrations/cross-chain/index.js', () => {
  throw new Error('cross-chain.ts must not import integrations/cross-chain/index.js');
});

import router from '../../server/routes/cross-chain.ts';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/cross-chain', router);
  return a;
}

function expectNotWired(res: request.Response, capability: string) {
  expect(res.status).toBe(501);
  expect(res.body.success).toBe(false);
  expect(res.body.unavailable).toBe(true);
  expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
  expect(res.body.error.capability).toBe(capability);
  expect(res.body.error.see).toBe('wrfcoin/backend#1136');
  // no fabricated bridge artefacts leak through
  expect(JSON.stringify(res.body)).not.toMatch(/-tx-\d+|"verified":true|"txHash"/);
}

describe('cross-chain router (honest gaps, #1136)', () => {
  it('status reports the integration as not wired, in-band, without auth', async () => {
    const { authenticateJWT } = require('../../server/middleware/auth.js');
    (authenticateJWT as jest.Mock).mockClear();
    const res = await request(app()).get('/api/cross-chain/status');
    expect(res.status).toBe(200);
    expect(res.body.integration.wired).toBe(false);
    expect(res.body.providers).toEqual([]);
    expect(res.body.networks).toEqual([]);
    expect(authenticateJWT).not.toHaveBeenCalled();
  });

  it.each([
    ['get', '/api/cross-chain/networks', 'cross_chain.networks'],
    ['get', '/api/cross-chain/operation/op-1', 'cross_chain.operation_status'],
    ['get', '/api/cross-chain/transactions', 'cross_chain.transactions'],
  ])('%s %s is an explicit 501 (%s)', async (method, route, capability) => {
    const res = await (request(app()) as any)[method](route);
    expectNotWired(res, capability);
  });

  it.each([
    [
      '/api/cross-chain/transfer-weather-data',
      { data: { t: 1 }, sourceChain: 'wrfcoin', targetChains: ['ethereum'] },
      'cross_chain.transfer_weather_data',
    ],
    [
      '/api/cross-chain/transfer-tokens',
      { transfer: { amount: 1 }, sourceChain: 'wrfcoin', targetChain: 'ethereum' },
      'cross_chain.transfer_tokens',
    ],
    ['/api/cross-chain/verify-data', { dataId: 'd1', chains: ['ethereum'] }, 'cross_chain.verify_data'],
    [
      '/api/cross-chain/send-message',
      { message: 'hi', sourceChain: 'wrfcoin', targetChain: 'ethereum' },
      'cross_chain.send_message',
    ],
  ])('POST %s with a valid body is an explicit 501 (%s)', async (route, body, capability) => {
    const res = await request(app()).post(route).send(body);
    expectNotWired(res, capability);
  });

  it.each([
    '/api/cross-chain/transfer-weather-data',
    '/api/cross-chain/transfer-tokens',
    '/api/cross-chain/verify-data',
    '/api/cross-chain/send-message',
  ])('POST %s still validates required parameters (400 before 501)', async (route) => {
    const res = await request(app()).post(route).send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Missing required parameters' });
  });

  it('authenticates everything except /status (#230)', async () => {
    const { authenticateJWT } = require('../../server/middleware/auth.js');
    (authenticateJWT as jest.Mock).mockClear();
    await request(app()).get('/api/cross-chain/networks');
    expect(authenticateJWT).toHaveBeenCalledTimes(1);
  });

  describe('retired cross-chain map routes (#820, carried over from crossChainRoutes.js)', () => {
    it.each(['/api/cross-chain/map', '/api/cross-chain/map/svg'])(
      'withdraws mock-backed visualization surface: %s',
      async (path) => {
        const res = await request(app()).get(path);
        expect(res.status).toBe(404);
        expect(res.text).not.toContain('<svg');
      }
    );

    it('keeps the network-list route reachable (explicit 501, not a 404)', async () => {
      const res = await request(app()).get('/api/cross-chain/networks');
      expect(res.status).toBe(501);
    });
  });
});
