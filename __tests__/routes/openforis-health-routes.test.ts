/** backend#1134 — openforis-health.ts mounts at /api/openforis and answers. */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';

const noop = () => {};
jest.mock('../../server/utils/logger', () => ({
  openforisLogger: { info: noop, warn: noop, error: noop, debug: noop },
  performanceLogger: { info: noop, warn: noop, error: noop, debug: noop },
}));

import router from '../../server/routes/openforis-health.ts';

describe('openforis-health routes (mounted at /api/openforis)', () => {
  it('GET /api/openforis/health/ping responds without throwing', async () => {
    const app = express();
    app.use('/api/openforis', router);
    const res = await request(app).get('/api/openforis/health/ping');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('openforis-integration');
  });
});
