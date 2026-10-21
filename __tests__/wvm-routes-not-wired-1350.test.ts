import express from 'express';
import request from 'supertest';

jest.mock('../server/utils/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger: l, blockchainLogger: l };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const wvm = require('../server/routes/wvm');

// backend#1350: every wvm.js handler used to answer invented figures as live data.
describe('wvm routes serve no fabricated data (backend#1350)', () => {
  const app = express().use('/api/wvm', wvm);
  const paths = [
    '/mining/cross-chain-rewards', '/computational-nfts/status', '/governance/proposals',
    '/rewards/distribution', '/smart-contracts/metrics', '/environmental/impact', '/wvm/performance',
  ];

  it.each(paths)('GET %s answers 501 NOT_IMPLEMENTED with no data fields', async (p) => {
    const res = await request(app).get(`/api/wvm${p}`);
    expect(res.status).toBe(501);
    expect(res.body.unavailable).toBe(true);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
    expect(Object.keys(res.body).sort()).toEqual(['error', 'reason', 'success', 'timestamp', 'unavailable']);
    expect(JSON.stringify(res.body)).not.toMatch(/totalRewards|Polygon|hurricane|prop-00|carbonFootprint/);
  });

  it('the router exposes exactly these GET routes and nothing else', () => {
    const routes = (wvm.stack as any[]).filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)}:${l.route.path}`).sort();
    expect(routes).toEqual(paths.map((p) => `get:${p}`).sort());
  });
});
