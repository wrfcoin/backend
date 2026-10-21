/**
 * Regression test for #900: /api/n8n must not expose workflow execution to
 * anonymous clients. Admin execute/toggle routes are gated by
 * requireAuth/requireAdmin, matching mcp-routes.js.
 */
import { describe, expect, it, jest } from '@jest/globals';

const requireAuthSentinel = jest.fn((_req: any, _res: any, next: any) => next());
const requireAdminSentinel = jest.fn((_req: any, _res: any, next: any) => next());

jest.mock('../../server/middleware/authMiddleware', () => ({
  requireAuth: requireAuthSentinel,
  requireAdmin: requireAdminSentinel,
}));

jest.mock('../../server/controllers/n8nController', () => ({
  getConnectionStatus: jest.fn(),
  getAllWorkflows: jest.fn(),
  executeWorkflow: jest.fn(),
  getExecutions: jest.fn(),
  toggleWorkflow: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../server/routes/n8n-routes');

function findRoute(method: string, path: string) {
  return router.stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method],
  );
}

describe('n8n-routes auth (#900)', () => {
  it('gates the family with requireAuth as router-level middleware', () => {
    const handles = router.stack.filter((l: any) => !l.route).map((l: any) => l.handle);
    expect(handles).toContain(requireAuthSentinel);
  });

  it('puts requireAdmin on every execute/mutation route', () => {
    const adminPaths: Array<[string, string]> = [
      ['post', '/workflows/:workflowId/execute'],
      ['patch', '/workflows/:workflowId/active'],
    ];
    for (const [method, path] of adminPaths) {
      const layer = findRoute(method, path);
      expect(layer).toBeTruthy();
      const stackHandles = layer.route.stack.map((s: any) => s.handle);
      expect(stackHandles).toContain(requireAdminSentinel);
    }
  });

});
