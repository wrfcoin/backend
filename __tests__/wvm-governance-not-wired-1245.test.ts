import express from 'express';
import request from 'supertest';

jest.mock('../server/utils/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger: l, blockchainLogger: l };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const wvm = require('../server/routes/wvm');

describe('wvm GET /governance/proposals serves no fabricated data (backend#1245)', () => {
  const app = express().use('/api/wvm', wvm);

  it('answers 501 NOT_IMPLEMENTED with a pointer to the real route, and no proposal figures', async () => {
    const res = await request(app).get('/api/wvm/governance/proposals');
    expect(res.status).toBe(501);
    expect(res.body.unavailable).toBe(true);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
    expect(res.body.error.see).toBe('/api/governance/proposals');
    for (const key of ['active', 'passed', 'participationRate', 'recentProposals']) expect(res.body).not.toHaveProperty(key);
    expect(JSON.stringify(res.body)).not.toMatch(/prop-00|Carbon Neutrality|72\.4/);
  });
});
