/**
 * Smoke test: governance-routes module exports a valid Express router.
 * Partially addresses #340.
 */
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../../server/middleware/authMiddleware.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../shared/core4-route-client.js', () => ({
  extractCore4Data: jest.fn(),
  fetchCore4Json: jest.fn(),
  forwardCore4Headers: jest.fn(() => ({})),
  sendCore4Error: jest.fn(),
  sendCore4Unavailable: jest.fn(),
  sendNotImplemented: jest.fn(),
  toNullable: jest.fn(),
}));

import router from '../../server/routes/governance-routes.js';

describe('governance-routes module', () => {
  it('exports a defined router', () => {
    expect(router).toBeDefined();
  });

  it('router has route handlers registered', () => {
    expect(router.stack).toBeDefined();
    expect(router.stack.length).toBeGreaterThan(0);
  });
});
