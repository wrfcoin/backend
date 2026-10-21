/**
 * backend#1133 — the ICP router answers with the honest-gap 501 envelope
 * (never fabricated canister/cycles data), keeps its input validation, and
 * loads WITHOUT mocking a controller (the old router only loaded under a
 * mocked controller that did not match the real one).
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';

const passthrough = (_req: any, _res: any, next: any) => next();
jest.mock('../../server/middleware/auth.js', () => ({
  authenticateApiKey: passthrough,
}));

import router from '../../server/routes/internet-computer-routes.ts';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/icp', router);
  return a;
}

function expectNotWired(res: request.Response, capability: string) {
  expect(res.status).toBe(501);
  expect(res.body.success).toBe(false);
  expect(res.body.unavailable).toBe(true);
  expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
  expect(res.body.error.capability).toBe(capability);
  expect(res.body.error.see).toBe('wrfcoin/backend#1133');
}

describe('internet-computer-routes (honest gaps, #1133)', () => {
  it('status reports the integration as not wired, in-band', async () => {
    const res = await request(app()).get('/api/icp/status');
    expect(res.status).toBe(200);
    expect(res.body.integration.wired).toBe(false);
    expect(res.body.connected).toBe(false);
    expect(res.body.client).toBeNull();
  });

  it.each([
    ['get', '/api/icp/canisters', 'icp.canisters.list'],
    ['post', '/api/icp/canisters', 'icp.canisters.create'],
    ['get', '/api/icp/canisters/abc', 'icp.canisters.info'],
    ['get', '/api/icp/canisters/abc/cycles', 'icp.canisters.cycles'],
    ['get', '/api/icp/tasks', 'icp.tasks.list'],
    ['post', '/api/icp/tasks', 'icp.tasks.submit'],
    ['get', '/api/icp/tasks/t1', 'icp.tasks.status'],
    ['post', '/api/icp/weather-forecast', 'icp.tasks.weather_forecast'],
    ['post', '/api/icp/climate-simulation', 'icp.tasks.climate_simulation'],
    ['post', '/api/icp/air-quality', 'icp.tasks.air_quality'],
  ])('%s %s is an explicit 501 (%s)', async (method, route, capability) => {
    const res = await (request(app()) as any)[method](route).send({});
    expectNotWired(res, capability);
    expect(JSON.stringify(res.body)).not.toMatch(/jaaaa-aaaah/); // no fabricated canister ids
  });

  it('validates required cycles input for canister top-ups before refusing', async () => {
    const bad = await request(app()).post('/api/icp/canisters/abc/cycles').send({});
    expect(bad.status).toBe(400);
    expect(bad.body.error.code ?? bad.body.code).toBe('MISSING_CYCLES');
    const res = await request(app()).post('/api/icp/canisters/abc/cycles').send({ cycles: '1000' });
    expectNotWired(res, 'icp.canisters.add_cycles');
  });

  it('validates the canister call method before refusing', async () => {
    const bad = await request(app()).post('/api/icp/canisters/abc/call').send({});
    expect(bad.status).toBe(400);
    const res = await request(app()).post('/api/icp/canisters/abc/call').send({ method: 'get_weather' });
    expectNotWired(res, 'icp.canisters.call');
  });

  it('validates required fields for cross-chain transfer before refusing', async () => {
    const bad = await request(app()).post('/api/icp/cross-chain-transfer').send({ fromChain: 'icp' });
    expect(bad.status).toBe(400);
    const res = await request(app())
      .post('/api/icp/cross-chain-transfer')
      .send({ fromChain: 'icp', toChain: 'wrf', fromToken: 'ICP', toToken: 'WRF', amount: '1' });
    expectNotWired(res, 'icp.cross_chain_transfer');
  });
});
