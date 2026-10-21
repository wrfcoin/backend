/**
 * Tests for SMS ingest routes — specifically Twilio signature validation
 * and weather data parsing.
 *
 * The database connection is mocked so the test suite doesn't need Postgres.
 */

// Mock the DB connection before any other import to avoid ESM parse errors.
jest.mock('../database/connection', () => ({
  db: {
    execute: jest.fn().mockResolvedValue({ rows: [] }),
  },
}));

import { parseSmsBody } from '../server/routes/sms-ingest-routes.js';

// ─── parseSmsBody unit tests ─────────────────────────────────────────────────

describe('parseSmsBody', () => {
  it('parses "T:23.5 H:65" correctly', () => {
    const result = parseSmsBody('T:23.5 H:65');
    expect(result.temperature_c).toBe(23.5);
    expect(result.humidity_percent).toBe(65);
  });

  it('parses "TEMP 21 HUM 55 P:1013" correctly', () => {
    const result = parseSmsBody('TEMP 21 HUM 55 P:1013');
    expect(result.temperature_c).toBe(21);
    expect(result.humidity_percent).toBe(55);
    expect(result.pressure_hpa).toBe(1013);
  });

  it('parses wind speed "W:5.2"', () => {
    const result = parseSmsBody('W:5.2');
    expect(result.wind_speed_ms).toBe(5.2);
  });

  it('returns empty object for unparseable text', () => {
    const result = parseSmsBody('hello world');
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('rejects out-of-range temperature', () => {
    const result = parseSmsBody('T:999');
    expect(result.temperature_c).toBeUndefined();
  });
});

// ─── Twilio signature validation integration tests ───────────────────────────

describe('POST /api/sms/ingest — Twilio signature validation', () => {
  const AUTH_TOKEN = 'test-twilio-auth-token-32-chars!!';
  const WEBHOOK_URL = 'http://localhost:3001/api/sms/ingest';

  let app: import('express').Application;
  let request: typeof import('supertest').default;

  beforeAll(async () => {
    const express = (await import('express')).default;
    const { default: smsIngestRoutes } = await import('../server/routes/sms-ingest-routes.js');

    app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/api/sms', smsIngestRoutes);

    // @ts-ignore
    request = (await import('supertest')).default;
  });

  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.TWILIO_WEBHOOK_URL = WEBHOOK_URL;
  });

  afterEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_WEBHOOK_URL;
  });

  function buildSignature(params: Record<string, string>): string {
    // @ts-ignore — twilio typings vary by version
    const twilio = require('twilio');
    return twilio.getExpectedTwilioSignature(AUTH_TOKEN, WEBHOOK_URL, params);
  }

  it('returns 503 when TWILIO_AUTH_TOKEN is not configured', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await request(app)
      .post('/api/sms/ingest')
      .type('form')
      .send({ From: '+15550001234', Body: 'T:20 H:50' });
    expect(res.status).toBe(503);
  });

  it('returns 403 when the Twilio signature is missing', async () => {
    const res = await request(app)
      .post('/api/sms/ingest')
      .type('form')
      .send({ From: '+15550001234', Body: 'T:20 H:50' });
    expect(res.status).toBe(403);
  });

  it('returns 403 when the Twilio signature is wrong', async () => {
    const res = await request(app)
      .post('/api/sms/ingest')
      .type('form')
      .set('x-twilio-signature', 'bad-signature')
      .send({ From: '+15550001234', Body: 'T:20 H:50' });
    expect(res.status).toBe(403);
  });

  it('accepts a valid Twilio-signed request and returns TwiML', async () => {
    const params = { From: '+15550001234', Body: 'T:22 H:60' };
    const sig = buildSignature(params);

    const res = await request(app)
      .post('/api/sms/ingest')
      .type('form')
      .set('x-twilio-signature', sig)
      .send(params);

    // Signature passed — response must not be 403 or 503.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(503);
    // Should return TwiML XML
    expect(res.type).toMatch(/xml/);
  });
});
