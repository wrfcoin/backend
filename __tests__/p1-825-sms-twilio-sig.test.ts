/**
 * Tests for #825: SMS ingest webhook Twilio signature validation.
 *
 * The validateTwilioSignature middleware (sms-ingest-routes.ts) was added in
 * PR #827 to block forged SMS observations. These tests cover the tampering
 * scenario specifically — an attacker who intercepts a valid signature and
 * replays it against different body params must be rejected.
 *
 * Complementary to __tests__/sms-ingest.test.ts which tests 503/403 basics.
 * Strategy: use the same minimal-app pattern to import the real middleware.
 */

jest.mock('../database/connection', () => ({
  db: { execute: jest.fn().mockResolvedValue({ rows: [] }) },
}));

jest.mock('../utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import request from 'supertest';

const AUTH_TOKEN = 'test-twilio-auth-token-825-32chars!!';
const WEBHOOK_URL = 'http://localhost:3001/api/sms/ingest';

function buildSig(params: Record<string, string>): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const twilio = require('twilio');
  return twilio.getExpectedTwilioSignature(AUTH_TOKEN, WEBHOOK_URL, params);
}

describe('POST /api/sms/ingest — Twilio signature anti-tampering (#825)', () => {
  let app: import('express').Application;

  beforeAll(async () => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.TWILIO_WEBHOOK_URL = WEBHOOK_URL;

    const express = (await import('express')).default;
    const { default: smsRoutes } = await import('../server/routes/sms-ingest-routes.js');
    app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/api/sms', smsRoutes);
  });

  afterAll(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_WEBHOOK_URL;
  });

  it('rejects a valid signature when the body params are tampered (#825)', async () => {
    // Attacker has obtained a valid signature for legit params, then replaces Body
    const legitParams = { From: '+15550001234', Body: 'T:22 H:60' };
    const sig = buildSig(legitParams);

    const tamperedParams = { From: '+15550001234', Body: 'T:99 H:99 P:9999 W:99' };

    const res = await request(app)
      .post('/api/sms/ingest')
      .type('form')
      .set('x-twilio-signature', sig)
      .send(tamperedParams);

    expect(res.status).toBe(403);
  });

  it('rejects a valid signature when the From field is spoofed (#825)', async () => {
    // Signature was computed for one sender; attacker swaps in a different number
    const legitParams = { From: '+15550001234', Body: 'T:22 H:60' };
    const sig = buildSig(legitParams);

    const spoofedSender = { From: '+19998887777', Body: 'T:22 H:60' };

    const res = await request(app)
      .post('/api/sms/ingest')
      .type('form')
      .set('x-twilio-signature', sig)
      .send(spoofedSender);

    expect(res.status).toBe(403);
  });

  it('accepts a correctly signed request for legit params (#825)', async () => {
    const params = { From: '+15550009999', Body: 'T:18 H:72 P:1015' };
    const sig = buildSig(params);

    const res = await request(app)
      .post('/api/sms/ingest')
      .type('form')
      .set('x-twilio-signature', sig)
      .send(params);

    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(503);
    expect(res.type).toMatch(/xml/);
  });
});
