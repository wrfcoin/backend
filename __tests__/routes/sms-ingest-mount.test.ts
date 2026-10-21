/**
 * backend#1134 — sms-ingest-routes.ts mounts at /api/sms and its primary
 * endpoint responds (fails closed when TWILIO_AUTH_TOKEN is unset) instead of
 * throwing. Signature validation itself is covered by __tests__/sms-ingest.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';

const noop = () => {};
jest.mock('../../server/utils/logger', () => ({ appLogger: { info: noop, warn: noop, error: noop, debug: noop } }));
jest.mock('../../database/connection', () => ({ db: {} }));

import router from '../../server/routes/sms-ingest-routes.ts';

describe('sms-ingest routes (mounted at /api/sms)', () => {
  it('POST /api/sms/ingest responds (fail-closed) without TWILIO_AUTH_TOKEN', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/api/sms', router);
    const res = await request(app).post('/api/sms/ingest').type('form').send({ Body: 'T:23.5 H:65', From: '+15550001' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
  });
});
