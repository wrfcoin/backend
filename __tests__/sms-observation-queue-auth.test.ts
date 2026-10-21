/**
 * SMS Observation Gateway — queue endpoint auth tests
 *
 * Verifies that GET /observations/queue is gated by the operator token
 * (requireOperatorToken middleware), so unauthenticated callers cannot
 * enumerate pending inbound messages.
 */

import express from 'express';
import request from 'supertest';

// ─── mock the SMS gateway service ────────────────────────────────────────────

jest.mock('../server/services/sms-observation-gateway-service.js', () => {
  const svc: any = {
    listQueue: jest.fn(() => [{ id: 'msg-1', text: 'T:22 H:60' }]),
    ingestInboundMessage: jest.fn(),
  };
  return {
    SmsObservationGatewayService: jest.fn(() => svc),
    smsObservationGatewayService: svc,
    encodeCompactSmsObservationEnvelope: jest.fn(),
    signCompactSmsObservationEnvelope: jest.fn(),
  };
});

// Mock operator-token-auth to use WRFCOIN_OPERATOR_TOKEN from env
// (the real implementation is CJS/JS; Jest ESM interop can be flaky — use the real module directly)

// ─── helpers ─────────────────────────────────────────────────────────────────

const OPERATOR_TOKEN = 'test-operator-secret-gateway-queue';

function buildApp() {
  const { createSmsObservationGatewayRouter } = require('../server/routes/sms-observation-gateway-routes.js');
  const app = express();
  app.use(express.json());
  app.use('/sms', createSmsObservationGatewayRouter());
  return app;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('GET /sms/observations/queue — operator auth gate', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR_TOKEN;
  });

  afterEach(() => {
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const app = buildApp();
    const res = await request(app).get('/sms/observations/queue');
    expect(res.status).toBe(401);
  });

  it('returns 403 when an incorrect operator token is provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/sms/observations/queue')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(403);
  });

  it('returns 200 with queue data when the correct operator token is provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/sms/observations/queue')
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 503 when WRFCOIN_OPERATOR_TOKEN is not configured', async () => {
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
    const app = buildApp();
    const res = await request(app)
      .get('/sms/observations/queue')
      .set('Authorization', `Bearer ${OPERATOR_TOKEN}`);
    // requireOperatorToken returns 503 when no token is configured
    expect(res.status).toBe(503);
  });
});
