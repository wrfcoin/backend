/**
 * Remediation Routes - RBAC-gated remediation API
 * Issue #256: Observability-to-remediation pipeline
 *
 * Provides endpoints to:
 *   GET  /active         - List active alerts with enriched playbook actions
 *   GET  /:id/actions    - Get available actions for a specific alert
 *   POST /:id/remediate  - Execute a remediation action (admin only)
 *   GET  /:id/history    - View audit trail for a specific alert
 *
 * All routes require JWT authentication.
 * Read-only routes require operator role or higher.
 * Write routes require admin role.
 */

import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticateJWT } from '../middleware/auth.js';
import { requireAdmin, requireOperator } from '../middleware/rbac-middleware.js';
import { securityLogger } from '../utils/logger.js';
import {
  incidentPlaybookEngine,
  type PlaybookDefinition,
  IncidentSeverity,
} from '../services/incidentPlaybookEngine.js';
import {
  ACTION_ALLOWLIST,
  REMEDIATION_RATE_LIMIT,
  isAllowlistedAction,
  getActionMeta,
  type RemediationAlertResponse,
  type RemediationActionResponse,
  type RemediationResultResponse,
  type RemediationHistoryEntry,
  type RemediateRequestBody,
  type ActionMeta,
} from '../types/remediation.js';

const router = express.Router();

// =====================================================
// IN-MEMORY STATE
// =====================================================

/**
 * Seed alerts derived from playbook definitions.
 * Each playbook definition is represented as a "firing" alert so the
 * remediation UI always has something to display even before a real
 * AlertManager webhook arrives.
 */
interface SeedAlert {
  id: string;
  alertName: string;
  severity: IncidentSeverity;
  status: 'firing' | 'resolved';
  description: string;
}

let seedAlerts: SeedAlert[] = [];
let seeded = false;

function ensureSeedAlerts(): SeedAlert[] {
  if (!seeded) {
    const playbooks = incidentPlaybookEngine.getPlaybooks();
    seedAlerts = playbooks.map((pb: PlaybookDefinition, idx: number) => ({
      id: `alert-${String(idx + 1).padStart(3, '0')}`,
      alertName: pb.alertName,
      severity: pb.severity,
      status: 'firing' as const,
      description: pb.description,
    }));
    seeded = true;
  }
  return seedAlerts;
}

/**
 * Per-user rate limiter: maps userId to an array of action timestamps.
 * Entries older than 1 hour are pruned on each check.
 */
const rateLimitMap = new Map<string, number[]>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const cutoff = now - windowMs;

  let timestamps = rateLimitMap.get(userId) || [];
  // Prune expired entries
  timestamps = timestamps.filter(ts => ts > cutoff);
  rateLimitMap.set(userId, timestamps);

  return timestamps.length >= REMEDIATION_RATE_LIMIT;
}

function recordAction(userId: string): void {
  const timestamps = rateLimitMap.get(userId) || [];
  timestamps.push(Date.now());
  rateLimitMap.set(userId, timestamps);
}

/**
 * In-memory audit log for remediation actions.
 * In production this would be persisted to a database.
 */
const auditLog: RemediationHistoryEntry[] = [];

// =====================================================
// HELPERS
// =====================================================

function getUserId(req: Request): string {
  const user = (req as any).user;
  return user?.userId || user?.id || 'unknown';
}

/**
 * Determine which allowlisted actions are available for a given playbook.
 * Only actions that appear in both the playbook definition and the allowlist
 * are returned.
 */
function getAllowlistedActionsForPlaybook(playbook: PlaybookDefinition): ActionMeta[] {
  return ACTION_ALLOWLIST.filter(meta =>
    playbook.actions.includes(meta.action)
  ) as unknown as ActionMeta[];
}

// =====================================================
// ROUTES
// =====================================================

/**
 * GET /active
 * List active (firing) alerts enriched with playbook actions, cooldown state,
 * and the subset of allowlisted actions available for each.
 * Requires: operator role or higher.
 */
router.get(
  '/active',
  authenticateJWT,
  requireOperator(),
  (req: Request, res: Response): void => {
    const requestId = uuidv4();

    try {
      const alerts = ensureSeedAlerts();
      const firingAlerts = alerts.filter(a => a.status === 'firing');

      const enriched: RemediationAlertResponse[] = firingAlerts.map(alert => {
        const playbook = incidentPlaybookEngine.getPlaybook(alert.alertName);
        const availableActions = playbook
          ? getAllowlistedActionsForPlaybook(playbook)
          : [];
        const cooldownActive = incidentPlaybookEngine.isInCooldown(alert.alertName);
        const cooldownRemainingSeconds = incidentPlaybookEngine.getCooldownRemaining(alert.alertName);

        return {
          id: alert.id,
          alertName: alert.alertName,
          severity: alert.severity,
          status: alert.status,
          description: alert.description,
          availableActions,
          cooldownActive,
          cooldownRemainingSeconds,
        };
      });

      res.json({
        success: true,
        data: enriched,
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      securityLogger.error('Failed to list active alerts', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: { code: 'ALERT_LIST_ERROR', message: 'Internal server error' },
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  }
);

/**
 * GET /:id/actions
 * Get available remediation actions for a specific alert.
 * Requires: operator role or higher.
 */
router.get(
  '/:id/actions',
  authenticateJWT,
  requireOperator(),
  (req: Request, res: Response): void => {
    const requestId = uuidv4();

    try {
      const alertId = req.params.id;
      const alerts = ensureSeedAlerts();
      const alert = alerts.find(a => a.id === alertId);

      if (!alert) {
        res.status(404).json({
          success: false,
          error: { code: 'ALERT_NOT_FOUND', message: 'Alert not found' },
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      const playbook = incidentPlaybookEngine.getPlaybook(alert.alertName);
      const actions = playbook
        ? getAllowlistedActionsForPlaybook(playbook)
        : [];
      const cooldownActive = incidentPlaybookEngine.isInCooldown(alert.alertName);
      const cooldownRemainingSeconds = incidentPlaybookEngine.getCooldownRemaining(alert.alertName);

      const response: RemediationActionResponse = {
        alertId: alert.id,
        alertName: alert.alertName,
        actions,
        cooldownActive,
        cooldownRemainingSeconds,
      };

      res.json({
        success: true,
        data: response,
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      securityLogger.error('Failed to get alert actions', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: { code: 'ACTIONS_ERROR', message: 'Internal server error' },
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  }
);

/**
 * POST /:id/remediate
 * Execute a remediation action on the specified alert.
 * Requires: admin role.
 *
 * Validates:
 *  - action is present and a string
 *  - action is in the allowlist
 *  - reason is present for medium/high risk actions
 *  - user is not rate-limited
 *  - alert exists
 *  - alert is not in cooldown
 */
router.post(
  '/:id/remediate',
  authenticateJWT,
  requireAdmin(),
  async (req: Request, res: Response): Promise<void> => {
    const requestId = uuidv4();

    try {
      const alertId = req.params.id;
      const body = req.body as RemediateRequestBody;

      // Validate action is present and a string
      if (!body.action || typeof body.action !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'action is required and must be a string' },
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      // Validate action is in the allowlist
      if (!isAllowlistedAction(body.action)) {
        res.status(400).json({
          success: false,
          error: { code: 'ACTION_NOT_ALLOWED', message: 'Action is not in the remediation allowlist' },
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      // Validate reason for medium/high risk actions
      const meta = getActionMeta(body.action);
      if (meta?.requiresReason && (!body.reason || typeof body.reason !== 'string' || body.reason.trim().length === 0)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'REASON_REQUIRED',
            message: `A reason is required for ${meta.riskLevel}-risk action: ${body.action}`,
          },
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      // Check rate limit
      const userId = getUserId(req);
      if (isRateLimited(userId)) {
        res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: `Rate limit exceeded. Maximum ${REMEDIATION_RATE_LIMIT} actions per hour.`,
          },
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      // Validate alert exists
      const alerts = ensureSeedAlerts();
      const alert = alerts.find(a => a.id === alertId);

      if (!alert) {
        res.status(404).json({
          success: false,
          error: { code: 'ALERT_NOT_FOUND', message: 'Alert not found' },
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      // Check cooldown
      if (incidentPlaybookEngine.isInCooldown(alert.alertName)) {
        const remaining = incidentPlaybookEngine.getCooldownRemaining(alert.alertName);
        res.status(429).json({
          success: false,
          error: {
            code: 'COOLDOWN_ACTIVE',
            message: `Alert is in cooldown. Retry after ${remaining} seconds.`,
          },
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      // Execute the playbook
      securityLogger.warn('Remediation action initiated', {
        requestId,
        alertId,
        alertName: alert.alertName,
        action: body.action,
        riskLevel: meta?.riskLevel,
        reason: body.reason || null,
        userId,
      });

      const incident = await incidentPlaybookEngine.executePlaybookManually(
        alert.alertName,
        userId
      );

      // Record in rate limiter
      recordAction(userId);

      // Record in audit log
      const auditEntry: RemediationHistoryEntry = {
        id: uuidv4(),
        alertName: alert.alertName,
        action: body.action,
        riskLevel: meta?.riskLevel || 'low',
        reason: body.reason?.trim() || null,
        executedBy: userId,
        executedAt: new Date().toISOString(),
        success: incident.actionsExecuted.every(a => a.success),
        incidentId: incident.id,
      };
      auditLog.push(auditEntry);

      securityLogger.warn('Remediation action completed', {
        requestId,
        alertId,
        alertName: alert.alertName,
        action: body.action,
        incidentId: incident.id,
        success: auditEntry.success,
        userId,
      });

      const result: RemediationResultResponse = {
        incidentId: incident.id,
        alertName: incident.alertName,
        action: body.action,
        severity: incident.severity,
        status: incident.status,
        actionsExecuted: incident.actionsExecuted.map(a => ({
          action: a.action,
          success: a.success,
          details: a.details,
          reversible: a.reversible,
        })),
      };

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      securityLogger.error('Remediation action failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: { code: 'REMEDIATION_ERROR', message: 'Internal server error' },
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  }
);

/**
 * GET /:id/history
 * View the audit trail for a specific alert.
 * Requires: operator role or higher.
 */
router.get(
  '/:id/history',
  authenticateJWT,
  requireOperator(),
  (req: Request, res: Response): void => {
    const requestId = uuidv4();

    try {
      const alertId = req.params.id;
      const alerts = ensureSeedAlerts();
      const alert = alerts.find(a => a.id === alertId);

      if (!alert) {
        res.status(404).json({
          success: false,
          error: { code: 'ALERT_NOT_FOUND', message: 'Alert not found' },
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      // Filter audit log by alert name
      const entries = auditLog.filter(entry => entry.alertName === alert.alertName);

      res.json({
        success: true,
        data: entries,
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      securityLogger.error('Failed to get alert history', {
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
