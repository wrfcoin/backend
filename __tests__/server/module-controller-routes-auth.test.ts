/**
 * Regression test for #899: the /api/modules router must gate its entire
 * surface behind node-control rate limiting + auth, matching the sibling
 * admin route families. A public-testnet deploy (0.0.0.0) otherwise exposes
 * remote restart / enable / disable / config-write to anonymous clients.
 */
import { describe, expect, it, jest } from '@jest/globals';

// Sentinel middlewares so we can assert they are mounted, without pulling the
// real config/toml chain the route module transitively requires.
const rateLimiterSentinel = jest.fn((_req: any, _res: any, next: any) => next());
const authSentinel = jest.fn((_req: any, _res: any, next: any) => next());

jest.mock('../../server/middleware/rpcAuthMiddleware', () => ({
  nodeControlRateLimiter: rateLimiterSentinel,
  verifyNodeControlAuth: authSentinel,
}));

jest.mock('../../utils/module_controller', () => ({
  getWorkflowCategories: jest.fn(),
  enableCategory: jest.fn(),
  disableCategory: jest.fn(),
  restartWorkflows: jest.fn(),
  loadConfigProfile: jest.fn(),
  saveConfigProfile: jest.fn(),
  getConfigProfiles: jest.fn(),
  getWorkflows: jest.fn(),
  enableModule: jest.fn(),
  disableModule: jest.fn(),
  getModuleDependencies: jest.fn(),
  getModules: jest.fn(),
}));

jest.mock('../../server/utils/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../server/routes/module-controller-routes');

describe('module-controller-routes auth (#899)', () => {
  it('mounts node-control rate limiter and auth as router-level middleware', () => {
    const routerMiddleware = router.stack.filter((layer: any) => !layer.route);
    const handles = routerMiddleware.map((layer: any) => layer.handle);
    expect(handles).toContain(rateLimiterSentinel);
    expect(handles).toContain(authSentinel);
  });

  it('applies the auth guard BEFORE any route handler', () => {
    const firstRouteIdx = router.stack.findIndex((layer: any) => layer.route);
    const authIdx = router.stack.findIndex((layer: any) => layer.handle === authSentinel);
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(firstRouteIdx).toBeGreaterThan(authIdx);
  });
});
