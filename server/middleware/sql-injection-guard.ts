/**
 * SQL Injection Guard Middleware
 * Issue #212: Wire SQL injection detector into Express middleware chain.
 *
 * Activates only for POST | PUT | PATCH requests.
 * Collects string leaf values from req.body, req.query, and req.params,
 * then runs each through the SQL injection detector.  Any detected injection
 * causes the request to be rejected with HTTP 400 before it reaches a route.
 */

import { Request, Response, NextFunction } from 'express';
import { getSQLInjectionDetector } from '../services/sql-injection-detector.js';
import { securityLogger } from '../utils/logger.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Recursively collect all string leaf values from a plain object / array.
 */
function collectStringLeaves(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStringLeaves);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(
      collectStringLeaves
    );
  }
  return [];
}

export function sqlInjectionGuard(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!WRITE_METHODS.has(req.method)) {
    next();
    return;
  }

  const detector = getSQLInjectionDetector();
  const context = { sourceIp: req.ip, endpoint: req.path };

  const candidates: string[] = [
    ...collectStringLeaves(req.body),
    ...collectStringLeaves(req.query),
    ...collectStringLeaves(req.params),
  ];

  for (const value of candidates) {
    const result = detector.analyze(value, context);
    if (result.isInjection) {
      securityLogger.warn('SQL injection blocked by middleware', {
        module: 'SQLInjectionGuard',
        endpoint: req.path,
        method: req.method,
        sourceIp: req.ip,
        riskScore: result.riskScore,
        severity: result.severity,
      });
      res.status(400).json({ error: 'Request rejected by security filter' });
      return;
    }
  }

  next();
}
