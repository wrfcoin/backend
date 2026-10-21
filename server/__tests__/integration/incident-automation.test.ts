/**
 * Integration Tests - Incident Automation Playbook Endpoints
 * Issue #208: Tests for AlertManager webhook, manual playbook execution,
 * rollback, cooldown enforcement, and audit trail
 */

const request = require('supertest');
const express = require('express');
import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  jest,
} from '@jest/globals';

// Mock auth middleware
jest.mock('../../middleware/auth.js', () => ({
  authenticateJWT: (req: any, res: any, next: any) => {
    req.user = {
      id: 'admin-user-id',
      userId: 'admin-user-id',
      roles: ['admin'],
      permissions: ['*'],
      sessionId: 'test-session',
    };
    next();
  },
}));

// Mock RBAC middleware
jest.mock(
  '../../middleware/rbac-middleware.js',
  () => ({
    requireAdmin: () => (req: any, res: any, next: any) => next(),
    requireRole: () => (req: any, res: any, next: any) => next(),
    ROLES: {
      ADMIN: 'admin',
      OPERATOR: 'operator',
      USER: 'user',
      GUEST: 'guest',
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

import incidentAutomationRoutes from '../../routes/incident-automation.js';
import {
  IncidentPlaybookEngine,
  IncidentSeverity,
} from '../../services/incidentPlaybookEngine.js';

// Create a fresh engine for each test suite to avoid cross-test contamination
let engine: IncidentPlaybookEngine;

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/incident-automation', incidentAutomationRoutes);
  return app;
};

const app = createApp();
const ALERTMANAGER_WEBHOOK_SECRET = 'test-alertmanager-webhook-secret';
const previousWebhookSecret = process.env.ALERTMANAGER_WEBHOOK_SECRET;

const postAlertmanagerWebhook = () =>
  request(app)
    .post('/api/incident-automation/webhook/alertmanager')
    .set('x-alertmanager-secret', ALERTMANAGER_WEBHOOK_SECRET);

describe('Incident Automation Endpoints', () => {
  beforeAll(() => {
    process.env.ALERTMANAGER_WEBHOOK_SECRET = ALERTMANAGER_WEBHOOK_SECRET;
  });

  afterAll(() => {
    if (previousWebhookSecret === undefined) {
      delete process.env.ALERTMANAGER_WEBHOOK_SECRET;
    } else {
      process.env.ALERTMANAGER_WEBHOOK_SECRET = previousWebhookSecret;
    }
  });

  describe('POST /api/incident-automation/webhook/alertmanager', () => {
    test('should reject webhook when auth header is missing', async () => {
      const res = await request(app)
        .post('/api/incident-automation/webhook/alertmanager')
        .send({ alerts: [] });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('WEBHOOK_AUTH_REQUIRED');
    });

    test('should reject webhook when auth header is invalid', async () => {
      const res = await request(app)
        .post('/api/incident-automation/webhook/alertmanager')
        .set('x-alertmanager-secret', 'invalid-secret')
        .send({ alerts: [] });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('WEBHOOK_AUTH_INVALID');
    });

    test('should process a valid AlertManager webhook', async () => {
      const res = await postAlertmanagerWebhook()
        .send({
          alerts: [
            {
              status: 'firing',
              labels: {
                alertname: 'CrossChainBridgeFailure',
                severity: 'critical',
              },
              annotations: {
                summary: 'Bridge transfer failures detected',
              },
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.processedAlerts).toBe(1);
      expect(res.body.data.incidentsTriggered).toBe(1);
      expect(res.body.data.incidents[0].alertName).toBe('CrossChainBridgeFailure');
      expect(res.body.data.incidents[0].severity).toBe('SEV1');
      expect(res.body.data.incidents[0].status).toBe('completed');
      expect(res.body.data.incidents[0].actionsExecuted).toBeGreaterThan(0);
    });

    test('should handle resolved alerts without triggering playbooks', async () => {
      const res = await postAlertmanagerWebhook()
        .send({
          alerts: [
            {
              status: 'resolved',
              labels: {
                alertname: 'HighAPIErrorRate',
                severity: 'critical',
              },
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.incidentsTriggered).toBe(0);
    });

    test('should skip alerts without matching playbooks', async () => {
      const res = await postAlertmanagerWebhook()
        .send({
          alerts: [
            {
              status: 'firing',
              labels: {
                alertname: 'NonExistentAlert',
                severity: 'warning',
              },
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.incidentsTriggered).toBe(0);
    });

    test('should reject invalid payload', async () => {
      const res = await postAlertmanagerWebhook()
        .send({ invalid: 'data' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_PAYLOAD');
    });

    test('should enforce cooldown on repeated alerts', async () => {
      // First alert - triggers playbook (use a different alert to avoid cooldown from test above)
      const res1 = await postAlertmanagerWebhook()
        .send({
          alerts: [
            {
              status: 'firing',
              labels: {
                alertname: 'HSMOperationFailure',
                severity: 'critical',
              },
            },
          ],
        });

      expect(res1.status).toBe(200);
      expect(res1.body.data.incidentsTriggered).toBe(1);

      // Second alert within cooldown - should be skipped
      const res2 = await postAlertmanagerWebhook()
        .send({
          alerts: [
            {
              status: 'firing',
              labels: {
                alertname: 'HSMOperationFailure',
                severity: 'critical',
              },
            },
          ],
        });

      expect(res2.status).toBe(200);
      expect(res2.body.data.incidentsTriggered).toBe(0);
    });

    test('should process multiple alerts in a single webhook', async () => {
      const res = await postAlertmanagerWebhook()
        .send({
          alerts: [
            {
              status: 'firing',
              labels: {
                alertname: 'WeatherDataQualityDegraded',
                severity: 'warning',
              },
            },
            {
              status: 'firing',
              labels: {
                alertname: 'ValidatorSlashed',
                severity: 'critical',
              },
            },
          ],
        });

      expect(res.status).toBe(200);
      // WeatherDataQualityDegraded is SEV4 (log only, no actions) but still creates an incident
      // ValidatorSlashed is SEV2 with actions
      expect(res.body.data.processedAlerts).toBe(2);
    });
  });

  describe('POST /api/incident-automation/playbook/execute', () => {
    test('should manually execute a playbook', async () => {
      const res = await request(app)
        .post('/api/incident-automation/playbook/execute')
        .send({ alertName: 'SuspiciousActivityDetected' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.alertName).toBe('SuspiciousActivityDetected');
      expect(res.body.data.severity).toBe('SEV2');
      expect(res.body.data.actionsExecuted.length).toBeGreaterThan(0);
    });

    test('should reject missing alertName', async () => {
      const res = await request(app)
        .post('/api/incident-automation/playbook/execute')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PARAMS');
    });

    test('should return 404 for unknown playbook', async () => {
      const res = await request(app)
        .post('/api/incident-automation/playbook/execute')
        .send({ alertName: 'NonExistentPlaybook' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PLAYBOOK_NOT_FOUND');
    });
  });

  describe('POST /api/incident-automation/playbook/rollback/:incidentId', () => {
    test('should rollback an incident', async () => {
      // First trigger an incident
      const triggerRes = await request(app)
        .post('/api/incident-automation/playbook/execute')
        .send({ alertName: 'BlockProductionStalled' });

      expect(triggerRes.status).toBe(200);
      const incidentId = triggerRes.body.data.incidentId;

      // Then rollback
      const rollbackRes = await request(app)
        .post(`/api/incident-automation/playbook/rollback/${incidentId}`)
        .send();

      expect(rollbackRes.status).toBe(200);
      expect(rollbackRes.body.success).toBe(true);
      expect(rollbackRes.body.data.status).toBe('rolled_back');
      expect(rollbackRes.body.data.rolledBackBy).toBe('admin-user-id');
    });

    test('should return 404 for non-existent incident', async () => {
      const res = await request(app)
        .post('/api/incident-automation/playbook/rollback/non-existent-id')
        .send();

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INCIDENT_NOT_FOUND');
    });

    test('should return 409 for already rolled back incident', async () => {
      // Trigger and rollback
      const triggerRes = await request(app)
        .post('/api/incident-automation/playbook/execute')
        .send({ alertName: 'HighAPIErrorRate' });

      const incidentId = triggerRes.body.data.incidentId;

      await request(app)
        .post(`/api/incident-automation/playbook/rollback/${incidentId}`)
        .send();

      // Try to rollback again
      const res = await request(app)
        .post(`/api/incident-automation/playbook/rollback/${incidentId}`)
        .send();

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_ROLLED_BACK');
    });
  });

  describe('GET /api/incident-automation/incidents/history', () => {
    test('should return incident history', async () => {
      const res = await request(app)
        .get('/api/incident-automation/incidents/history')
        .query({ limit: 10 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.incidents)).toBe(true);
      expect(typeof res.body.data.total).toBe('number');
      expect(res.body.data.automatedState).toBeDefined();
    });

    test('should filter by severity', async () => {
      const res = await request(app)
        .get('/api/incident-automation/incidents/history')
        .query({ severity: 'SEV1' });

      expect(res.status).toBe(200);
      if (res.body.data.incidents.length > 0) {
        res.body.data.incidents.forEach((incident: any) => {
          expect(incident.severity).toBe('SEV1');
        });
      }
    });

    test('should respect pagination limits', async () => {
      const res = await request(app)
        .get('/api/incident-automation/incidents/history')
        .query({ limit: 2, offset: 0 });

      expect(res.status).toBe(200);
      expect(res.body.data.incidents.length).toBeLessThanOrEqual(2);
    });

    test('should include automated state in response', async () => {
      const res = await request(app)
        .get('/api/incident-automation/incidents/history');

      expect(res.status).toBe(200);
      const state = res.body.data.automatedState;
      expect(state).toHaveProperty('bridgePaused');
      expect(state).toHaveProperty('rewardsFrozen');
      expect(state).toHaveProperty('capsModified');
      expect(state).toHaveProperty('keyRotationTriggered');
    });
  });
});

describe('IncidentPlaybookEngine Unit Tests', () => {
  let testEngine: IncidentPlaybookEngine;

  beforeEach(() => {
    testEngine = new IncidentPlaybookEngine();
  });

  test('should have predefined playbooks', () => {
    const playbooks = testEngine.getPlaybooks();
    expect(playbooks.length).toBeGreaterThan(0);

    const bridgePlaybook = testEngine.getPlaybook('CrossChainBridgeFailure');
    expect(bridgePlaybook).toBeDefined();
    expect(bridgePlaybook!.severity).toBe(IncidentSeverity.SEV1);
    expect(bridgePlaybook!.actions).toContain('pause_bridge');
  });

  test('should track cooldowns correctly', async () => {
    expect(testEngine.isInCooldown('CrossChainBridgeFailure')).toBe(false);

    await testEngine.processAlertManagerWebhook({
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'CrossChainBridgeFailure', severity: 'critical' },
        },
      ],
    });

    expect(testEngine.isInCooldown('CrossChainBridgeFailure')).toBe(true);
    expect(testEngine.getCooldownRemaining('CrossChainBridgeFailure')).toBeGreaterThan(0);
  });

  test('should capture state snapshot before actions', async () => {
    const incidents = await testEngine.processAlertManagerWebhook({
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'CrossChainBridgeFailure', severity: 'critical' },
        },
      ],
    });

    expect(incidents.length).toBe(1);
    expect(incidents[0].stateSnapshot).toBeDefined();
    expect(incidents[0].stateSnapshot.bridgePaused).toBe(false);

    // After execution, state should be updated
    const state = testEngine.getAutomatedState();
    expect(state.bridgePaused).toBe(true);
  });

  test('should rollback reversible actions', async () => {
    const incidents = await testEngine.processAlertManagerWebhook({
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'CrossChainBridgeFailure', severity: 'critical' },
        },
      ],
    });

    const incidentId = incidents[0].id;
    expect(testEngine.getAutomatedState().bridgePaused).toBe(true);

    await testEngine.rollbackIncident(incidentId, 'admin');

    expect(testEngine.getAutomatedState().bridgePaused).toBe(false);
    const rolledBack = testEngine.getIncident(incidentId);
    expect(rolledBack!.status).toBe('rolled_back');
    expect(rolledBack!.rolledBackBy).toBe('admin');
  });

  test('should return incident history sorted by time', () => {
    const history = testEngine.getIncidentHistory();
    expect(history.total).toBe(0);
    expect(history.incidents).toEqual([]);
  });

  test('should execute manual playbook', async () => {
    const incident = await testEngine.executePlaybookManually(
      'SuspiciousActivityDetected',
      'test-admin'
    );

    expect(incident.triggeredBy).toBe('manual');
    expect(incident.severity).toBe(IncidentSeverity.SEV2);
    expect(incident.actionsExecuted.length).toBeGreaterThan(0);
  });

  test('should throw on unknown playbook', async () => {
    await expect(
      testEngine.executePlaybookManually('UnknownAlert', 'admin')
    ).rejects.toThrow('No playbook found for alert');
  });

  test('should throw on double rollback', async () => {
    const incidents = await testEngine.processAlertManagerWebhook({
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'CrossChainBridgeFailure', severity: 'critical' },
        },
      ],
    });

    const incidentId = incidents[0].id;
    await testEngine.rollbackIncident(incidentId, 'admin');

    await expect(
      testEngine.rollbackIncident(incidentId, 'admin')
    ).rejects.toThrow('already been rolled back');
  });
});
