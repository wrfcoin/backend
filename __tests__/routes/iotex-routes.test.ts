/**
 * backend#1132 — iotex.js is a real, DB-backed W3bstream/IoTeX router that was
 * never mounted. This smoke test proves the router module loads and answers
 * through an Express app at the mount prefix the safeMount entry uses.
 */
import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const noop = () => {};
jest.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
}));

// drizzle-style chainable query builder returning a fixed device list
const rows = [{ id: 'dev-1', name: 'Sensor A', createdAt: '2026-09-16T00:00:00.000Z' }];
const chain: any = {
  from: () => chain,
  orderBy: () => chain,
  limit: () => chain,
  offset: () => Promise.resolve(rows),
  then: (resolve: any) => resolve([{ total: rows.length }]),
};
jest.mock('../../server/db', () => ({ db: { select: () => chain } }));
jest.mock('../../server/integrations/iotex/controller', () => ({}));
jest.mock('../../shared/iot-gateway-geofence-service', () => ({
  IotGatewayGeoFenceService: class {},
  buildGeoFenceReviewUpdate: () => ({}),
  isRewardEligibleForGeoFence: () => true,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const iotexRouter = require('../../server/routes/iotex');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/iotex', iotexRouter.default || iotexRouter);
  return a;
}

describe('iotex routes (mounted at /api/iotex)', () => {
  it('GET /api/iotex/devices answers through the mount with the paginated device list', async () => {
    const res = await request(app()).get('/api/iotex/devices');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // backend#1220: anonymous callers get the allowlisted projection.
    expect(res.body.data).toEqual([{ ...rows[0], latitude: null, longitude: null }]);
    expect(res.body.pagination.total).toBe(1);
  });

  it('geofence review is admin-token gated (403 without the token)', async () => {
    const res = await request(app())
      .post('/api/iotex/devices/dev-1/geo-fence-review')
      .send({ decision: 'approve' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_AUTH_REQUIRED');
  });

  it('is a real router, not a mock: unknown sub-path falls through (404), not a fake 200', async () => {
    const res = await request(app()).get('/api/iotex/nonexistent-zzz');
    expect(res.status).toBe(404);
  });
});
