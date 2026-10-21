/**
 * Identity Policy Middleware
 *
 * Express middleware that enforces authorization policies on identity
 * mutation routes (credential issue/revoke, key epoch mutations,
 * governance policy toggles).
 *
 * Fail-closed: if the user is not authenticated or the policy evaluation
 * yields DENY, the request is rejected with a sanitized reason code.
 *
 * Issues: #252, #237
 */

import { Request, Response, NextFunction } from 'express';
import {
  evaluatePolicy,
  logGovernanceAudit,
  type PolicyAction,
  type PolicySubject,
} from '../services/identity-governance-service.js';

/**
 * Extract a PolicySubject from the Express request.
 * Handles both JWT-authenticated (req.user) and API-key-authenticated requests.
 */
function extractSubject(req: Request): PolicySubject {
  const user = req.user;
  if (user && user.id) {
    return {
      userId: user.id,
      role: user.role || 'user',
      permissions: user.permissions || [],
      authenticated: true,
    };
  }

  // Check API key auth (set by authenticateApiKey middleware)
  const apiKey = (req as any).apiKey;
  if (apiKey && apiKey.userId) {
    return {
      userId: apiKey.userId,
      role: 'api_key',
      permissions: apiKey.permissions || [],
      authenticated: true,
    };
  }

  return { authenticated: false };
}

/**
 * Extract client IP for audit logging.
 * Respects proxy headers when available.
 */
function getClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const ips = typeof xff === 'string' ? xff.split(',') : xff;
    return ips[0]?.trim() || 'unknown';
  }
  const xri = req.headers['x-real-ip'];
  if (xri) {
    return typeof xri === 'string' ? xri : xri[0] || 'unknown';
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Creates an Express middleware that enforces the given policy action.
 *
 * Usage:
 *   router.post('/credentials', requirePolicy('credential:issue'), handler);
 *
 * On DENY, responds with 401 (unauthenticated) or 403 (insufficient role/perm)
 * and a sanitized JSON body. Never leaks internal policy details.
 */
export function requirePolicy(action: PolicyAction) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const subject = extractSubject(req);
    const decision = evaluatePolicy(action, subject);

    // Audit every policy evaluation (allow and deny)
    logGovernanceAudit({
      action,
      decision,
      subjectId: subject.userId,
      subjectRole: subject.role,
      resourceId: req.params.id || req.params.credentialId || req.params.epochId,
      ipAddress: getClientIp(req),
    });

    if (decision.verdict === 'ALLOW') {
      // Attach decision to request for downstream handlers
      (req as any).policyDecision = decision;
      next();
      return;
    }

    // Map reason to HTTP status
    const status = decision.reason === 'UNAUTHENTICATED' ? 401 : 403;

    res.status(status).json({
      success: false,
      error: decision.reason,
      message: decision.message,
      timestamp: decision.timestamp,
    });
  };
}

/**
 * Middleware that requires authentication but does not enforce a specific
 * policy action. Useful for read-with-context endpoints.
 */
export function requireAuthenticated(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const subject = extractSubject(req);
  if (!subject.authenticated) {
    res.status(401).json({
      success: false,
      error: 'UNAUTHENTICATED',
      message: 'Authentication is required for this endpoint.',
      timestamp: new Date().toISOString(),
    });
    return;
  }
  next();
}
