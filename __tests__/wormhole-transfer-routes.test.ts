import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { createWormholeTransferRouter } from '../server/routes/wormhole-transfer-routes.js';
import { __resetWormholeTransferTestState } from '../server/services/wormhole-transfer-service.js';

function makeDb() {
  return {
    execute: jest.fn(async () => ({ rows: [] })),
  };
}

function makeApp(db: { execute: jest.Mock }) {
  const app = express();
  app.use(express.json());
  app.use('/api/bridges/wormhole', createWormholeTransferRouter(db as any));
  return app;
}

describe('wormhole-transfer-routes', () => {
  const originalMode = process.env.WORMHOLE_TEST_MODE;
  const originalJwtSecret = process.env.JWT_SECRET;
  let authToken = '';

  beforeAll(() => {
    process.env.WORMHOLE_TEST_MODE = 'mock';
    process.env.JWT_SECRET = 'wormhole-test-secret';
    authToken = jwt.sign({ sub: 'test-user' }, process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api' });
  });

  afterAll(() => {
    process.env.WORMHOLE_TEST_MODE = originalMode;
    process.env.JWT_SECRET = originalJwtSecret;
  });

  beforeEach(() => {
    __resetWormholeTransferTestState();
  });

  it('POST /inbound/process returns transfer record', async () => {
    const app = makeApp(makeDb());
    const res = await request(app)
      .post('/api/bridges/wormhole/inbound/process')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        emitterChain: 2,
        emitterAddress: '0xabc',
        sequence: '1',
        recipient: '0x1111111111111111111111111111111111111111',
        amount: '100',
      });

    expect(res.status).toBe(200);
    expect(res.body.direction).toBe('inbound');
    expect(res.body.status).toBe('mint_submitted');
  });

  it('POST /inbound/process returns 401 without JWT', async () => {
    const app = makeApp(makeDb());
    const res = await request(app).post('/api/bridges/wormhole/inbound/process').send({
      emitterChain: 2,
      emitterAddress: '0xabc',
      sequence: '1',
      recipient: '0x1111111111111111111111111111111111111111',
      amount: '100',
    });

    expect(res.status).toBe(401);
  });

  it('POST /outbound/initiate returns attestation transfer record', async () => {
    const app = makeApp(makeDb());
    const res = await request(app).post('/api/bridges/wormhole/outbound/initiate').send({
      sender: '0x1111111111111111111111111111111111111111',
      recipient: '0x2222222222222222222222222222222222222222',
      amount: '50',
    });

    expect(res.status).toBe(200);
    expect(res.body.direction).toBe('outbound');
    expect(res.body.status).toBe('attested');
  });

  it('GET /transfers/:transferId returns 404 when missing', async () => {
    const app = makeApp(makeDb());
    const res = await request(app).get('/api/bridges/wormhole/transfers/non-existent-id');
    expect(res.status).toBe(404);
  });
});
