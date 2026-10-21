/**
 * Regression guard for #779: the live N5 backend returned HTTP 404 for
 * POST /api/oracle/submit-data even though PR #772 added the route. The
 * earn-loop (mobile #44 commit->reveal) is dead the moment this route 404s.
 *
 * This test mounts the real oracle submit router exactly the way the optimized
 * production entrypoint does (`app.use('/api/oracle', oracleSubmitRoutes)`) and
 * asserts the submit-data endpoint is REACHABLE — i.e. it must reject a bad
 * payload with 400, never fall through to the 404 "Endpoint not found" handler.
 *
 * Pairs with the dist/build regression test (#791) which proves the compiled
 * route module is actually emitted into dist/.
 */

import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// The handler short-circuits with 400 on a missing payload before any core4
// network call, but mock the client anyway so the import graph never reaches out.
jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: jest.fn(),
  extractCore4Data: (payload: any) => payload?.data ?? payload,
  forwardCore4Headers: jest.fn(() => ({})),
}));
jest.mock('../../server/middleware/authMiddleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

import oracleSubmitRoutes from '../../server/routes/oracle-submit-routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  // Mirror enhanced_unified_api_optimized.ts: critical earn-loop route mounted
  // statically so live/testnet does not depend on CommonJS route-module loading.
  app.use('/api/oracle', oracleSubmitRoutes);
  // Catch-all 404 like the production server, so a missing mount is observable.
  app.use((_req, res) => res.status(404).json({ error: 'Endpoint not found' }));
  return app;
}

describe('oracle submit route is mounted (#779)', () => {
  let app: express.Express;
  beforeAll(() => {
    app = buildApp();
  });

  it('POST /api/oracle/submit-data is reachable (not 404)', async () => {
    const res = await request(app).post('/api/oracle/submit-data').send({});
    expect(res.status).not.toBe(404);
    expect(res.body?.error).not.toBe('Endpoint not found');
  });

  it('rejects an invalid payload with 400 (route logic executes)', async () => {
    const res = await request(app).post('/api/oracle/submit-data').send({});
    expect(res.status).toBe(400);
    expect(res.body?.error).toBe('Missing required fields');
  });

  it('still 404s for a genuinely unknown oracle path (guard is meaningful)', async () => {
    const res = await request(app).post('/api/oracle/does-not-exist').send({});
    expect(res.status).toBe(404);
  });
});


describe('legacy server uses the same guarded oracle submit mount (#1284)', () => {
  // Execute the actual legacy entrypoint mount block, without booting its
  // unrelated databases/routers. A trap stands in for the retired duplicate.
  const source = require('node:fs').readFileSync('server/server.js', 'utf8');
  const start = source.indexOf('// Mount Oracle API routes directly');
  const end = source.indexOf("app.use('/api/documentation'", start);
  if (start < 0 || end < 0) throw new Error('Legacy oracle mount block not found');
  const mount = new Function('app', 'require', source.slice(start, end));
  it.each(['/api/oracle/submit-data', '/api/oracle/submit-data/prepare'])
  ('mounts guarded %s before detail routes', async (path) => {
    const app = express();
    app.use(express.json());
    const duplicate = express.Router();
    duplicate.post('/submit-data', (_req, res) => res.status(418).json({ error: 'unguarded duplicate reached' }));
    mount(app, (id: string) => {
      if (id.includes('oracle-submit-routes')) return { default: oracleSubmitRoutes };
      if (id.includes('oracle-detail-routes')) return duplicate;
      if (id.endsWith('/oracle-routes')) return express.Router();
      throw new Error(`Unexpected legacy oracle dependency: ${id}`);
    });
    const res = await request(app).post(path).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing required fields');
  });
});
