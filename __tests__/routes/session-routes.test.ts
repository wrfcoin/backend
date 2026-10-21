/**
 * Smoke test: session-routes module exports a valid Express router.
 * Partially addresses #340.
 */
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (_req: any, _res: any, next: any) => next(),
  authenticateApiKey: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../server/middleware/rbac-middleware.js', () => ({
  requireAdmin: () => (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../server/services/session-service.js', () => ({
  sessionService: {
    getSessions: jest.fn(),
    terminateSession: jest.fn(),
    terminateAllSessions: jest.fn(),
    getSessionActivity: jest.fn(),
    cleanupExpiredSessions: jest.fn(),
  },
}));

jest.mock('../../server/services/device-service.js', () => ({
  deviceService: {
    getDevices: jest.fn(),
    trustDevice: jest.fn(),
    removeDevice: jest.fn(),
  },
}));

jest.mock('../../server/utils/logger.js', () => ({
  securityLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logError: jest.fn(),
}));

import router from '../../server/routes/session-routes.js';

describe('session-routes module', () => {
  it('exports a defined router', () => {
    expect(router).toBeDefined();
  });

  it('router has route handlers registered', () => {
    expect(router.stack).toBeDefined();
    expect(router.stack.length).toBeGreaterThan(0);
  });
});
