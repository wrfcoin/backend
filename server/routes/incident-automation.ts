/**
 * Incident Automation Routes - Automated Incident Response
 * Issue #208: AlertManager webhook integration and manual playbook controls
 */

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { authenticateJWT } from '../middleware/auth.js';
import { requireAdmin, ROLES } from '../middleware/rbac-middleware.js';
import { securityLogger } from '../utils/logger.js';
import {
  incidentPlaybookEngine,
  AlertManagerPayload,
  IncidentSeverity,
} from '../services/incidentPlaybookEngine.js';

const router = express.Router();
const ALERTMANAGER_SECRET_HEADER = 'x-alertmanager-secret';

function timingSafeSecretMatch(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

/**
 * AlertManager webhook authentication middleware.
 * Fail-closed: if secret is not configured or invalid, webhook processing is rejected.
 */
function authenticateAlertManagerWebhook(req: Request, res: Response, next: express.NextFunction): void {
  const configuredSecret = process.env.ALERTMANAGER_WEBHOOK_SECRET;
  const requestId = uuidv4();

  if (!configuredSecret || configuredSecret.trim().length === 0) {
    securityLogger.error('AlertManager webhook auth is not configured', {
      requestId,
      path: req.path,
      method: req.method,
    });
    res.status(503).json({
      success: false,
      error: { code: 'WEBHOOK_AUTH_NOT_CONFIGURED', message: 'Webhook authentication is not configured' },
      timestamp: new Date().toISOString(),
      requestId,
    });
    return;
  }

  const providedSecret = req.header(ALERTMANAGER_SECRET_HEADER) || '';
  if (!providedSecret) {
    securityLogger.warn('AlertManager webhook auth missing secret header', {
      requestId,
      path: req.path,
      method: req.method,
      ip: req.ip,
    });
    res.status(401).json({
      success: false,
      error: { code: 'WEBHOOK_AUTH_REQUIRED', message: 'Missing webhook authentication secret' },
      timestamp: new Date().toISOString(),
      requestId,
    });
    return;
  }

  if (!timingSafeSecretMatch(configuredSecret, providedSecret)) {
    securityLogger.warn('AlertManager webhook auth invalid secret', {
      requestId,
      path: req.path,
      method: req.method,
      ip: req.ip,
    });
    res.status(403).json({
      success: false,
      error: { code: 'WEBHOOK_AUTH_INVALID', message: 'Invalid webhook authentication secret' },
      timestamp: new Date().toISOString(),
      requestId,
    });
    return;
  }

  next();
}

/**
 * POST /webhook/alertmanager
 * Receive AlertManager webhook payloads and trigger matching playbooks.
 * This endpoint does NOT require JWT auth since AlertManager sends webhooks
 * with its own authentication mechanism.
 */
router.post(
  '/webhook/alertmanager',
  authenticateAlertManagerWebhook,
  async (req: Request, res: Response): Promise<void> => {
  const requestId = uuidv4();

  try {
    const payload = req.body as AlertManagerPayload;

    if (!payload || !Array.isArray(payload.alerts)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PAYLOAD', message: 'Invalid AlertManager webhook payload' },
        timestamp: new Date().toISOString(),
        requestId,
      });
      return;
    }

    securityLogger.info('AlertManager webhook received', {
      requestId,
      alertCount: payload.alerts.length,
      alertNames: payload.alerts.map(a => a.labels.alertname),
    });

    const incidents = await incidentPlaybookEngine.processAlertManagerWebhook(payload);

    res.json({
      success: true,
      data: {
        processedAlerts: payload.alerts.length,
        incidentsTriggered: incidents.length,
        incidents: incidents.map(i => ({
          id: i.id,
          alertName: i.alertName,
          severity: i.severity,
          status: i.status,
          actionsExecuted: i.actionsExecuted.length,
        })),
      },
      timestamp: new Date().toISOString(),
      requestId,
    });
  } catch (error) {
    securityLogger.error('AlertManager webhook error', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'WEBHOOK_ERROR', message: 'Internal server error' },
      timestamp: new Date().toISOString(),
      requestId,
    });
  }
  }
);

/**
 * POST /playbook/execute
 * Manually trigger a playbook (admin only)
 */
router.post(
  '/playbook/execute',
  authenticateJWT,
  requireAdmin(),
  async (req: Request, res: Response): Promise<void> => {
    const requestId = uuidv4();

    try {
      const { alertName } = req.body;
      if (!alertName || typeof alertName !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'alertName is required' },
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      const playbook = incidentPlaybookEngine.getPlaybook(alertName);
      if (!playbook) {
        res.status(404).json({
          success: false,
          error: { code: 'PLAYBOOK_NOT_FOUND', message: `No playbook found for alert: ${alertName}` },
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      // Check cooldown
      if (incidentPlaybookEngine.isInCooldown(alertName)) {
        const remaining = incidentPlaybookEngine.getCooldownRemaining(alertName);
        res.status(429).json({
          success: false,
          error: {
            code: 'COOLDOWN_ACTIVE',
            message: `Playbook is in cooldown. Retry after ${remaining} seconds.`,
          },
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      const user = (req as any).user;
      const triggeredBy = user?.userId || user?.id || 'admin';

      securityLogger.warn('Manual playbook execution', {
        requestId,
        alertName,
        triggeredBy,
      });

      const incident = await incidentPlaybookEngine.executePlaybookManually(alertName, triggeredBy);

      res.json({
        success: true,
        data: {
          incidentId: incident.id,
          alertName: incident.alertName,
          severity: incident.severity,
          status: incident.status,
          actionsExecuted: incident.actionsExecuted.map(a => ({
            action: a.action,
            success: a.success,
            details: a.details,
            reversible: a.reversible,
          })),
        },
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      securityLogger.error('Manual playbook execution error', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: { code: 'EXECUTION_ERROR', message: 'Internal server error' },
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  }
);

/**
 * POST /playbook/rollback/:incidentId
 * Rollback automated actions for an incident (admin only)
 */
router.post(
  '/playbook/rollback/:incidentId',
  authenticateJWT,
  requireAdmin(),
  async (req: Request, res: Response): Promise<void> => {
    const requestId = uuidv4();

    try {
      const { incidentId } = req.params;
      if (!incidentId) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'incidentId is required' },
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      const user = (req as any).user;
      const rolledBackBy = user?.userId || user?.id || 'admin';

      securityLogger.warn('Incident rollback requested', {
        requestId,
        incidentId,
        rolledBackBy,
      });

      const incident = await incidentPlaybookEngine.rollbackIncident(incidentId, rolledBackBy);

      res.json({
        success: true,
        data: {
          incidentId: incident.id,
          alertName: incident.alertName,
          status: incident.status,
          rolledBackAt: incident.rolledBackAt?.toISOString(),
          rolledBackBy: incident.rolledBackBy,
          actionsRolledBack: incident.actionsExecuted.filter(a => a.reversible).length,
        },
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNotFound = message.includes('not found');
      const isAlreadyRolledBack = message.includes('already been rolled back');

      res.status(isNotFound ? 404 : isAlreadyRolledBack ? 409 : 500).json({
        success: false,
        error: {
          code: isNotFound ? 'INCIDENT_NOT_FOUND' : isAlreadyRolledBack ? 'ALREADY_ROLLED_BACK' : 'ROLLBACK_ERROR',
          message: isNotFound || isAlreadyRolledBack ? message : 'Internal server error',
        },
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  }
);

/**
 * GET /incidents/history
 * View incident history (admin only)
 */
router.get(
  '/incidents/history',
  authenticateJWT,
  requireAdmin(),
  async (req: Request, res: Response): Promise<void> => {
    const requestId = uuidv4();

    try {
      const {
        severity,
        status,
        limit = '50',
        offset = '0',
      } = req.query;

      const result = incidentPlaybookEngine.getIncidentHistory({
        severity: severity ? (severity as IncidentSeverity) : undefined,
        status: status as string | undefined,
        limit: Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50)),
        offset: Math.max(0, parseInt(offset as string, 10) || 0),
      });

      res.json({
        success: true,
        data: {
          incidents: result.incidents.map(i => ({
            id: i.id,
            alertName: i.alertName,
            severity: i.severity,
            status: i.status,
            triggeredAt: i.triggeredAt.toISOString(),
            completedAt: i.completedAt?.toISOString(),
            rolledBackAt: i.rolledBackAt?.toISOString(),
            triggeredBy: i.triggeredBy,
            rolledBackBy: i.rolledBackBy,
            actionsExecuted: i.actionsExecuted.length,
          })),
          total: result.total,
          automatedState: incidentPlaybookEngine.getAutomatedState(),
        },
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      securityLogger.error('Incident history error', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: { code: 'HISTORY_ERROR', message: 'Internal server error' },
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  }
);

export default router;
