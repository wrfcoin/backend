/**
 * Integration Tests - Remediation API Endpoints
 * Issue #256: Tests for active alerts, actions, remediation execution,
 * rate limiting, cooldown enforcement, and audit trail
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  jest,
} from '@jest/globals';

// Mock cuid2 to avoid @noble/hashes version mismatch (v2 expects Uint8Array,
// cuid2 passes strings). cuid2 is a transitive dep from supertest→formidable.
jest.mock('@paralleldrive/cuid2', () => ({
  createId: () => 'mock-cuid-id',
  init: () => () => 'mock-cuid-id',
}));

const request = require('supertest');
const express = require('express');

// =====================================================
// Mutable role state - controls auth/RBAC mock behaviour
// =====================================================
let mockUserRoles: string[] = ['admin'];

// Mock auth middleware - MUST be before imports
jest.mock('../../middleware/auth.js', () => ({
  authenticateJWT: (req: any, res: any, next: any) => {
    if (mockUserRoles.length === 0) {
      return res.status(401).json({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
        timestamp: new Date().toISOString(),
      });
    }
    req.user = {
      id: 'test-user-id',
      userId: 'test-user-id',
      roles: mockUserRoles,
      permissions: ['*'],
      sessionId: 'test-session',
    };
    next();
  },
}));

// Mock RBAC middleware - MUST be before imports
jest.mock(
  '../../middleware/rbac-middleware.js',
  () => ({
    requireAdmin: () => (req: any, res: any, next: any) => {
      const roles: string[] = req.user?.roles || [];
      if (!roles.includes('admin') && !roles.includes('super_admin')) {
        return res.status(403).json({
          success: false,
          error: { code: 'INSUFFICIENT_ROLE', message: 'Admin role required' },
          timestamp: new Date().toISOString(),
        });
      }
      next();
    },
    requireOperator: () => (req: any, res: any, next: any) => {
      const roles: string[] = req.user?.roles || [];
      const allowed = ['operator', 'admin', 'super_admin'];
      if (!roles.some((r: string) => allowed.includes(r))) {
        return res.status(403).json({
          success: false,
          error: { code: 'INSUFFICIENT_ROLE', message: 'Operator role required' },
          timestamp: new Date().toISOString(),
        });
      }
      next();
    },
    requireRole: () => (req: any, res: any, next: any) => next(),
    ROLES: {
      ADMIN: 'admin',
      OPERATOR: 'operator',
      USER: 'user',
      GUEST: 'guest',
      SUPER_ADMIN: 'super_admin',
    },
  }),
  { virtual: true }
);

// Mock logger
jest.mock('../../utils/logger.js', () => ({
  securityLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  appLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import remediationRoutes from '../../routes/remediation.js';

// =====================================================
// App setup
// =====================================================

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/alerts', remediationRoutes);
  return app;
};

const app = createApp();

// =====================================================
// Tests
// =====================================================

describe('Remediation API Endpoints', () => {
  beforeEach(() => {
    mockUserRoles = ['admin'];
  });

  // -------------------------------------------------
  // GET /api/alerts/active
  // -------------------------------------------------
  describe('GET /api/alerts/active', () => {
    test('returns 401 for unauthenticated requests', async () => {
      mockUserRoles = [];

      const res = await request(app).get('/api/alerts/active');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    test('operator can list active alerts', async () => {
      mockUserRoles = ['operator'];

      const res = await request(app).get('/api/alerts/active');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    test('alerts include playbook actions', async () => {
      const res = await request(app).get('/api/alerts/active');

      expect(res.status).toBe(200);

      // Find at least one alert that has available actions with riskLevel and enabled
      const alertsWithActions = res.body.data.filter(
        (alert: any) => alert.availableActions && alert.availableActions.length > 0
      );
      expect(alertsWithActions.length).toBeGreaterThan(0);

      const firstAction = alertsWithActions[0].availableActions[0];
      expect(firstAction).toHaveProperty('riskLevel');
      expect(firstAction).toHaveProperty('action');
    });
  });

  // -------------------------------------------------
  // GET /api/alerts/:id/actions
  // -------------------------------------------------
  describe('GET /api/alerts/:id/actions', () => {
    test('returns 404 for non-existent alert', async () => {
      const res = await request(app).get('/api/alerts/non-existent/actions');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('ALERT_NOT_FOUND');
    });

    test('returns actions for existing alert', async () => {
      // First get the active alerts to find a valid ID
      const activeRes = await request(app).get('/api/alerts/active');
      expect(activeRes.status).toBe(200);
      expect(activeRes.body.data.length).toBeGreaterThan(0);

      const alertId = activeRes.body.data[0].id;

      const res = await request(app).get(`/api/alerts/${alertId}/actions`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('alertId', alertId);
      expect(res.body.data).toHaveProperty('actions');
      expect(Array.isArray(res.body.data.actions)).toBe(true);
    });
  });

  // -------------------------------------------------
  // POST /api/alerts/:id/remediate
  // -------------------------------------------------
  describe('POST /api/alerts/:id/remediate', () => {
    test('non-admin returns 403', async () => {
      mockUserRoles = ['operator'];

      const res = await request(app)
        .post('/api/alerts/alert-001/remediate')
        .send({ action: 'escalate' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    test('missing action returns 400', async () => {
      const res = await request(app)
        .post('/api/alerts/alert-001/remediate')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_PARAMS');
    });

    test('non-allowlisted action returns 400', async () => {
      const res = await request(app)
        .post('/api/alerts/alert-001/remediate')
        .send({ action: 'emergency_key_rotation' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('ACTION_NOT_ALLOWED');
    });

    test('medium-risk action without reason returns 400', async () => {
      // Find an alert that has the tighten_caps action
      const activeRes = await request(app).get('/api/alerts/active');
      const alertWithTightenCaps = activeRes.body.data.find(
        (a: any) =>
          a.availableActions &&
          a.availableActions.some((act: any) => act.action === 'tighten_caps')
      );
      expect(alertWithTightenCaps).toBeDefined();

      const res = await request(app)
        .post(`/api/alerts/${alertWithTightenCaps.id}/remediate`)
        .send({ action: 'tighten_caps' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('REASON_REQUIRED');
    });

    test('valid low-risk action succeeds', async () => {
      // Find an alert that has the escalate action
      const activeRes = await request(app).get('/api/alerts/active');
      const alertWithEscalate = activeRes.body.data.find(
        (a: any) =>
          a.availableActions &&
          a.availableActions.some((act: any) => act.action === 'escalate')
      );
      expect(alertWithEscalate).toBeDefined();

      const res = await request(app)
        .post(`/api/alerts/${alertWithEscalate.id}/remediate`)
        .send({ action: 'escalate' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('status', 'completed');
      expect(res.body.data).toHaveProperty('incidentId');
      expect(res.body.data).toHaveProperty('actionsExecuted');
    });

    test('valid medium-risk action with reason succeeds', async () => {
      // Find an alert that has the tighten_caps action
      const activeRes = await request(app).get('/api/alerts/active');
      const alertWithTightenCaps = activeRes.body.data.find(
        (a: any) =>
          a.availableActions &&
          a.availableActions.some((act: any) => act.action === 'tighten_caps')
      );
      expect(alertWithTightenCaps).toBeDefined();

      const res = await request(app)
        .post(`/api/alerts/${alertWithTightenCaps.id}/remediate`)
        .send({
          action: 'tighten_caps',
          reason: 'Suspicious validator slashing event detected',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('incidentId');
    });

    test('cooldown enforcement returns 429', async () => {
      // First, find an alert and execute an action to trigger cooldown
      const activeRes = await request(app).get('/api/alerts/active');

      // Find an alert with escalate that has NOT been used yet
      // (use a unique alert to avoid cooldown from previous tests)
      const alert = activeRes.body.data.find(
        (a: any) =>
          a.alertName === 'ConsensusRoundTimeout' &&
          a.availableActions &&
          a.availableActions.some((act: any) => act.action === 'escalate')
      );
      expect(alert).toBeDefined();

      // First execution should succeed
      const firstRes = await request(app)
        .post(`/api/alerts/${alert.id}/remediate`)
        .send({ action: 'escalate' });

      expect(firstRes.status).toBe(200);

      // Second execution should be blocked by cooldown
      const secondRes = await request(app)
        .post(`/api/alerts/${alert.id}/remediate`)
        .send({ action: 'escalate' });

      expect(secondRes.status).toBe(429);
      expect(secondRes.body.success).toBe(false);
      expect(secondRes.body.error.code).toBe('COOLDOWN_ACTIVE');
    });
  });

  // -------------------------------------------------
  // GET /api/alerts/:id/history
  // -------------------------------------------------
  describe('GET /api/alerts/:id/history', () => {
    test('returns history array', async () => {
      // Use the first alert (some may have history from previous tests)
      const activeRes = await request(app).get('/api/alerts/active');
      expect(activeRes.body.data.length).toBeGreaterThan(0);
      const alertId = activeRes.body.data[0].id;

      const res = await request(app).get(`/api/alerts/${alertId}/history`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    test('operator can read history', async () => {
      mockUserRoles = ['operator'];

      const activeRes = await request(app).get('/api/alerts/active');
      expect(activeRes.body.data.length).toBeGreaterThan(0);
      const alertId = activeRes.body.data[0].id;

      const res = await request(app).get(`/api/alerts/${alertId}/history`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });
});
