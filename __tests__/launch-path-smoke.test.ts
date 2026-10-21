/**
 * Launch-path smoke tests — issue #791
 *
 * Goal: verify that all testnet-critical route files are mounted and respond
 * with a non-404 status.  A 404 means the file was missing from dist/ or
 * safeMount silently dropped it (#791).  Any other status (400/401/500) proves
 * the handler is reachable.
 *
 * weather-routes.js uses a top-level `await import()` (valid Node ESM) that
 * Jest's CJS transform cannot execute.  We substitute a stub router and verify
 * the file exists separately.
 *
 * Inline handlers (commit/reveal) live directly in
 * enhanced_unified_api_optimized.ts — they cannot regress via a missing
 * safeMount file, so they are covered by the live integration script
 * (scripts/smoke-test-launch-paths.ts) rather than here.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Module mocks — Jest hoists these before all requires.
// Variables referenced in factory fns must be prefixed "mock" to survive the
// hoisting transformation.  All other constants are inlined inside the factory.
// ---------------------------------------------------------------------------

// authMiddleware — pass-through so auth never blocks smoke checks.
jest.mock('../server/middleware/authMiddleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  authMiddleware: (_req: any, _res: any, next: any) => next(),
  authenticateToken: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

// logger — no-op stubs (values inlined to survive hoisting).
jest.mock('../server/utils/logger', () => ({
  blockchainLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger:           { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  appLogger:        { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  securityLogger:   { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// rate limiters — pass-through.
jest.mock('../middleware/rateLimiting', () => ({
  generalLimiter:  (_req: any, _res: any, next: any) => next(),
  transferLimiter: (_req: any, _res: any, next: any) => next(),
  strictLimiter:   (_req: any, _res: any, next: any) => next(),
  authLimiter:     (_req: any, _res: any, next: any) => next(),
}));

// commit-reveal-hash utilities.
jest.mock('../shared/commit-reveal-hash', () => ({
  buildCanonicalReading: jest.fn(() => ({ mock: true })),
  canonicalizeJson:      jest.fn((v: unknown) => v),
  computeCommitId:       jest.fn(() => 'mock-commit-id-abc123'),
}));

// core4-route-client — both extension variants so dynamic import() also resolves.
jest.mock('../shared/core4-route-client', () => ({
  fetchCore4Json:      jest.fn().mockRejectedValue(new Error('core4 unavailable (smoke test)')),
  extractCore4Data:    jest.fn((p: unknown) => p),
  forwardCore4Headers: jest.fn(() => ({})),
  sendCore4Error:      jest.fn((_res: any, _u: unknown, msg: string) =>
    _res.status(502).json({ error: msg })),
  sendCore4Unavailable: jest.fn((_res: any, _e: unknown, msg: string) =>
    _res.status(503).json({ error: msg })),
  sendNotImplemented:  jest.fn((_res: any, msg: string) =>
    _res.status(501).json({ error: msg })),
}));

// weather-types.
jest.mock('../shared/types/weather-types', () => ({
  normalizeCommitRevealReading: jest.fn((x: unknown) => x),
}));

// config.
jest.mock('../config', () => ({}));

// api-error utility (required at top of weather-routes.js).
jest.mock('../server/utils/api-error', () => ({
  createApiError: jest.fn((code: string, msg: string) => ({ error: code, message: msg })),
}));

// weather-routes.js has a top-level `await import()` — not runnable in Jest CJS
// mode.  Substitute a minimal stub so the mount-path assertions still hold.
// The file-existence check below verifies the real file is present on disk.
jest.mock('../server/routes/weather-routes', () => {
  const express = require('express');
  const router = express.Router();
  router.get('/health', (_req: any, res: any) =>
    res.status(200).json({ status: 'ok', stub: true }));
  router.get('/data/:location', (_req: any, res: any) => res.json({}));
  router.get('/stations', (_req: any, res: any) => res.json({ stations: [] }));
  return router;
});

// ---------------------------------------------------------------------------
// Route imports (after all mocks are registered)
// ---------------------------------------------------------------------------

import oracleSubmitRoutes from '../server/routes/oracle-submit-routes';
const walletRoutes  = require('../server/routes/wallet-routes');
const weatherRoutes = require('../server/routes/weather-routes');

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeApp(mountPath: string, router: express.Router): express.Application {
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Launch-path smoke: route files exist on disk', () => {
  const root = path.resolve(__dirname, '..');

  it.each([
    'server/routes/oracle-submit-routes.ts',
    'server/routes/wallet-routes.js',
    'server/routes/weather-routes.js',
  ])('%s is present', (rel) => {
    expect(fs.existsSync(path.join(root, rel))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('Launch-path smoke: POST /api/oracle/submit-data', () => {
  const app = makeApp('/api/oracle', oracleSubmitRoutes as any);

  it('responds non-404 — empty body returns 400 (route IS mounted)', async () => {
    const res = await request(app)
      .post('/api/oracle/submit-data')
      .send({});

    expect(res.status).not.toBe(404);
    expect(res.status).toBe(400);
  });

  it('responds non-404 — full payload with contributor', async () => {
    const res = await request(app)
      .post('/api/oracle/submit-data')
      .send({
        dataType: 'temperature',
        location: 'test-station',
        value: 22.5,
        timestamp: new Date().toISOString(),
        source: 'smoke-test',
        contributor: '0xDeaDBeEf00000000000000000000000000000000',
      });

    expect(res.status).not.toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('Launch-path smoke: GET /api/weather/* (stub router)', () => {
  const app = makeApp('/api/weather', weatherRoutes);

  it('/health is mounted — responds 200', async () => {
    const res = await request(app).get('/api/weather/health');
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200);
  });

  it('/data/:location is mounted — responds non-404', async () => {
    const res = await request(app).get('/api/weather/data/lat:40.71,lon:-74.00');
    expect(res.status).not.toBe(404);
  });

  it('/stations is mounted — responds non-404', async () => {
    const res = await request(app).get('/api/weather/stations');
    expect(res.status).not.toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('Launch-path smoke: GET /api/wallet/*', () => {
  // GET /:address is an own-address, Reader-token read (#1282). Authenticate as
  // the owner and configure the Reader token so the request reaches core4.
  const OWNER = '0xDeaDBeEf00000000000000000000000000000000';
  const app = express();
  app.use((req: any, _res, next) => { req.user = { sub: OWNER }; next(); });
  app.use('/api/wallet', walletRoutes);
  let previousReader: string | undefined;

  beforeAll(() => {
    previousReader = process.env.WRFCOIN_READER_TOKEN;
    process.env.WRFCOIN_READER_TOKEN = 'smoke-reader-token';
  });

  afterAll(() => {
    if (previousReader === undefined) delete process.env.WRFCOIN_READER_TOKEN;
    else process.env.WRFCOIN_READER_TOKEN = previousReader;
  });

  it('/:address is mounted — core4-unavailable returns 503, not 404', async () => {
    const res = await request(app).get(`/api/wallet/${OWNER}`);

    expect(res.status).not.toBe(404);
    expect(res.status).toBe(503);
  });
});
