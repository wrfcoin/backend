import { Request, Response, NextFunction } from 'express';
import {
  SecurityAlert,
  SecurityAuditLog,
  ThreatLevel,
} from '../../shared/types/security-types.js';
import { securityLogger } from '../utils/logger.js';

interface RateLimitTracker {
  count: number;
  firstRequest: number;
  lastRequest: number;
  blocked: boolean;
}

interface BruteForceTracker {
  attempts: number;
  firstAttempt: number;
  lastAttempt: number;
  blocked: boolean;
}

interface SuspiciousPattern {
  type: string;
  pattern: RegExp;
  severity: ThreatLevel;
}

interface SecurityMetrics {
  totalRequests: number;
  blockedRequests: number;
  alertsTriggered: number;
  uniqueIps: Set<string>;
  lastCleanup: Date;
}

export class SecurityAlertMiddleware {
  /** #977: cleanup timer handle — previously discarded. */
  private cleanupTimer?: ReturnType<typeof setInterval>;

  private rateLimitTracker: Map<string, RateLimitTracker> = new Map();
  private bruteForceTracker: Map<string, BruteForceTracker> = new Map();
  private securityAlerts: SecurityAlert[] = [];
  private auditLogs: SecurityAuditLog[] = [];
  private metrics: SecurityMetrics = {
    totalRequests: 0,
    blockedRequests: 0,
    alertsTriggered: 0,
    uniqueIps: new Set(),
    lastCleanup: new Date(),
  };

  private sensitiveEndpoints: string[] = [
    '/api/auth',
    '/api/admin',
    '/api/vault',
    '/api/users',
    '/api/payment',
    '/api/transaction',
    '/api/wallet',
  ];

  private suspiciousPatterns: SuspiciousPattern[] = [
    {
      type: 'path_traversal',
      pattern: /\.\.\//g,
      severity: 'high',
    },
    {
      type: 'xss',
      pattern: /<script/gi,
      severity: 'high',
    },
    {
      type: 'sql_injection',
      pattern: /union.*select/gi,
      severity: 'critical',
    },
    {
      type: 'command_injection',
      pattern: /[;&|`]/g,
      severity: 'critical',
    },
  ];

  constructor(config?: any) {
    // Initialize with optional configuration
    if (config) {
      // Apply configuration overrides
    }

    // Start periodic cleanup
    // #977 ratchet: stored and unref'd — constructor-started behind a
    // module-scope instance, so importing this file held the loop open.
    this.cleanupTimer = setInterval(() => this.cleanup(), 300000); // 5 minutes
    this.cleanupTimer.unref();
  }

  /**
   * Main monitoring method
   */
  monitor = (req: Request, res: Response, next: NextFunction): void => {
    const clientIp = this.getClientIp(req);
    const userAgent = req.get('User-Agent') || 'unknown';

    this.metrics.totalRequests++;
    this.metrics.uniqueIps.add(clientIp);

    try {
      // Check for rate limiting violations
      if (this.checkRateLimit(clientIp, req.url)) {
        this.handleBlockedRequest(
          req,
          res,
          'RATE_LIMIT_EXCEEDED',
          'Too many requests from IP address'
        );
        return;
      }

      // Check for brute force attempts
      if (this.checkBruteForce(clientIp, req)) {
        this.handleBlockedRequest(
          req,
          res,
          'BRUTE_FORCE_DETECTED',
          'Brute force attack detected'
        );
        return;
      }

      // Check for suspicious patterns in request
      const suspiciousPattern = this.detectSuspiciousPatterns(req);
      if (suspiciousPattern) {
        this.triggerSecurityAlert({
          id: this.generateAlertId(),
          type: 'suspicious_request',
          severity: suspiciousPattern.severity,
          description: `Suspicious ${suspiciousPattern.type} pattern detected`,
          timestamp: new Date(),
          sourceIp: clientIp,
          resolved: false,
          additionalData: {
            userAgent,
            requestPath: req.url,
            requestMethod: req.method,
          },
        });

        if (suspiciousPattern.severity === 'critical') {
          this.handleBlockedRequest(
            req,
            res,
            'SUSPICIOUS_PATTERN',
            `Suspicious ${suspiciousPattern.type} detected`
          );
          return;
        }
      }

      // Log security audit entry
      this.logSecurityEvent({
        timestamp: new Date().toISOString(),
        event: 'REQUEST_PROCESSED',
        success: true,
        userId: 'unknown',
        ipAddress: clientIp,
        userAgent,
        requestPath: req.url,
        requestMethod: req.method,
      });

      next();
    } catch (error) {
      securityLogger.error('Security middleware error', {
        operation: 'security:middleware:monitor',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      next();
    }
  };

  /**
   * Alias for monitor method - for backward compatibility with tests
   */
  checkRequest = (req: Request, res: Response, next: NextFunction): void => {
    this.monitor(req, res, next);
  };

  /**
   * Check if request exceeds rate limits
   */
  private checkRateLimit(clientIp: string, url: string): boolean {
    const now = Date.now();
    const key = `${clientIp}:${url}`;
    const tracker = this.rateLimitTracker.get(key);

    // Rate limit: 100 requests per minute for sensitive endpoints
    const isSensitive = this.isSensitiveEndpoint(url);
    const limit = isSensitive ? 10 : 100;
    const windowMs = 60 * 1000; // 1 minute

    if (!tracker) {
      this.rateLimitTracker.set(key, {
        count: 1,
        firstRequest: now,
        lastRequest: now,
        blocked: false,
      });
      return false;
    }

    // Reset window if expired
    if (now - tracker.firstRequest > windowMs) {
      this.rateLimitTracker.set(key, {
        count: 1,
        firstRequest: now,
        lastRequest: now,
        blocked: false,
      });
      return false;
    }

    tracker.count++;
    tracker.lastRequest = now;

    if (tracker.count > limit) {
      tracker.blocked = true;
      this.triggerSecurityAlert({
        id: this.generateAlertId(),
        type: 'rate_limit_violation',
        severity: 'medium',
        description: `Rate limit exceeded: ${tracker.count} requests in ${windowMs}ms`,
        timestamp: new Date(),
        sourceIp: clientIp,
        resolved: false,
        additionalData: {
          requestPath: url,
        },
      });
      return true;
    }

    return false;
  }

  /**
   * Check for brute force attempts
   */
  private checkBruteForce(clientIp: string, req: Request): boolean {
    // Only monitor authentication endpoints
    const authEndpoints = [
      '/api/auth/login',
      '/api/auth/token',
      '/api/vault/auth',
    ];
    const isAuthEndpoint = authEndpoints.some(endpoint =>
      req.url.startsWith(endpoint)
    );

    if (!isAuthEndpoint) return false;

    const now = Date.now();
    const tracker = this.bruteForceTracker.get(clientIp);
    const windowMs = 15 * 60 * 1000; // 15 minutes
    const maxAttempts = 5;

    if (!tracker) {
      this.bruteForceTracker.set(clientIp, {
        attempts: 1,
        firstAttempt: now,
        lastAttempt: now,
        blocked: false,
      });
      return false;
    }

    // Reset window if expired
    if (now - tracker.firstAttempt > windowMs) {
      this.bruteForceTracker.set(clientIp, {
        attempts: 1,
        firstAttempt: now,
        lastAttempt: now,
        blocked: false,
      });
      return false;
    }

    tracker.attempts++;
    tracker.lastAttempt = now;

    if (tracker.attempts > maxAttempts) {
      tracker.blocked = true;
      this.triggerSecurityAlert({
        id: this.generateAlertId(),
        type: 'brute_force_attack',
        severity: 'high',
        description: `Brute force attack detected: ${tracker.attempts} failed attempts`,
        timestamp: new Date(),
        sourceIp: clientIp,
        resolved: false,
        additionalData: {
          requestPath: req.url,
        },
      });
      return true;
    }

    return false;
  }

  /**
   * Record a failed login attempt for brute force tracking
   */
  recordFailedLogin(clientIp: string): void {
    const now = Date.now();
    const tracker = this.bruteForceTracker.get(clientIp);
    const windowMs = 15 * 60 * 1000; // 15 minutes

    if (!tracker) {
      this.bruteForceTracker.set(clientIp, {
        attempts: 1,
        firstAttempt: now,
        lastAttempt: now,
        blocked: false,
      });
      return;
    }

    // Reset window if expired
    if (now - tracker.firstAttempt > windowMs) {
      this.bruteForceTracker.set(clientIp, {
        attempts: 1,
        firstAttempt: now,
        lastAttempt: now,
        blocked: false,
      });
      return;
    }

    tracker.attempts++;
    tracker.lastAttempt = now;

    if (tracker.attempts > 5) {
      tracker.blocked = true;
      this.triggerSecurityAlert({
        id: this.generateAlertId(),
        type: 'brute_force_attack',
        severity: 'high',
        description: `Brute force attack detected: ${tracker.attempts} failed attempts`,
        timestamp: new Date(),
        sourceIp: clientIp,
        resolved: false,
        additionalData: {
          attempts: tracker.attempts,
        },
      });
    }
  }

  /**
   * Record a successful login to reset brute force counter
   */
  recordSuccessfulLogin(clientIp: string): void {
    this.bruteForceTracker.delete(clientIp);
  }

  /**
   * Check if IP is currently blocked due to brute force attempts
   */
  isBruteForceBlocked(clientIp: string): boolean {
    const tracker = this.bruteForceTracker.get(clientIp);
    if (!tracker) return false;

    const now = Date.now();
    const windowMs = 15 * 60 * 1000; // 15 minutes

    // Check if window has expired
    if (now - tracker.firstAttempt > windowMs) {
      this.bruteForceTracker.delete(clientIp);
      return false;
    }

    return tracker.blocked;
  }

  /**
   * Get active (unresolved) security alerts
   */
  getActiveAlerts(): SecurityAlert[] {
    return this.securityAlerts.filter(alert => !alert.resolved);
  }

  /**
   * Get a specific alert by ID
   */
  getAlert(alertId: string): SecurityAlert | undefined {
    return this.securityAlerts.find(alert => alert.id === alertId);
  }

  /**
   * Cleanup method - alias for cleanupTrackers
   */
  cleanup(): void {
    this.cleanupTrackers();
  }

  /**
   * Detect suspicious patterns in request
   */
  private detectSuspiciousPatterns(req: Request): SuspiciousPattern | null {
    const searchContent = [
      req.url,
      JSON.stringify(req.query),
      JSON.stringify(req.body || {}),
      req.get('User-Agent') || '',
      req.get('Referer') || '',
    ].join(' ');

    for (const pattern of this.suspiciousPatterns) {
      if (pattern.pattern.test(searchContent)) {
        return pattern;
      }
    }

    return null;
  }

  /**
   * Check if endpoint is considered sensitive
   */
  private isSensitiveEndpoint(url: string): boolean {
    return this.sensitiveEndpoints.some(endpoint => url.startsWith(endpoint));
  }

  /**
   * Handle blocked request
   */
  private handleBlockedRequest(
    req: Request,
    res: Response,
    code: string,
    message?: string
  ): void {
    this.metrics.blockedRequests++;

    this.logSecurityEvent({
      timestamp: new Date().toISOString(),
      event: 'REQUEST_BLOCKED',
      success: false,
      userId: 'unknown',
      ipAddress: this.getClientIp(req),
      userAgent: req.get('User-Agent') || 'unknown',
      requestPath: req.url,
      requestMethod: req.method,
      blockReason: code,
    });

    res.status(429).json({
      success: false,
      error: {
        code,
        message: message || code,
        retryAfter: 60,
      },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Trigger security alert
   */
  private triggerSecurityAlert(alert: SecurityAlert): void {
    this.securityAlerts.push(alert);
    this.metrics.alertsTriggered++;

    securityLogger.warn(`Security Alert [${alert.severity.toUpperCase()}]: ${alert.description || alert.message}`, {
      operation: 'security:alert:triggered',
      alertId: alert.id,
      severity: alert.severity,
      sourceIp: alert.sourceIp || alert.clientIp,
      additionalData: alert.additionalData,
    });

    // In production, this would send alerts to security team
    if (alert.severity === 'critical') {
      securityLogger.error('CRITICAL SECURITY ALERT', {
        operation: 'security:alert:critical',
        alertId: alert.id,
        alertType: alert.type,
        description: alert.description || alert.message,
        sourceIp: alert.sourceIp || alert.clientIp,
        timestamp: alert.timestamp,
        additionalData: alert.additionalData,
      });
    }
  }

  /**
   * Log security event for audit trail
   */
  private logSecurityEvent(event: SecurityAuditLog): void {
    this.auditLogs.push(event);

    // Keep only last 1000 entries
    if (this.auditLogs.length > 1000) {
      this.auditLogs = this.auditLogs.slice(-1000);
    }
  }

  /**
   * Get client IP address
   */
  private getClientIp(req: Request): string {
    return (
      req.ip ||
      req.get('X-Forwarded-For') ||
      req.get('X-Real-IP') ||
      (req as any).connection?.remoteAddress ||
      'unknown'
    );
  }

  /**
   * Generate unique alert ID
   */
  private generateAlertId(): string {
    return `alert_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }

  /**
   * Clean up old tracking entries
   */
  private cleanupTrackers(): void {
    const now = Date.now();
    const expiryTime = 1000 * 60 * 60; // 1 hour

    // Clean rate limit tracker
    const rateLimitEntries = Array.from(this.rateLimitTracker.entries());
    for (const [key, tracker] of rateLimitEntries) {
      if (now - tracker.lastRequest > expiryTime) {
        this.rateLimitTracker.delete(key);
      }
    }

    // Clean brute force tracker
    const bruteForceEntries = Array.from(this.bruteForceTracker.entries());
    for (const [key, tracker] of bruteForceEntries) {
      if (now - tracker.lastAttempt > expiryTime) {
        this.bruteForceTracker.delete(key);
      }
    }

    this.metrics.lastCleanup = new Date();
    securityLogger.info('Security trackers cleaned up', {
      operation: 'security:trackers:cleanup',
      rateLimitEntries: this.rateLimitTracker.size,
      bruteForceEntries: this.bruteForceTracker.size,
    });
  }

  /**
   * Get security alerts
   */
  getSecurityAlerts(limit: number = 50): SecurityAlert[] {
    return this.securityAlerts
      .slice(-limit)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Get audit logs
   */
  getAuditLogs(limit: number = 100): SecurityAuditLog[] {
    return this.auditLogs
      .slice(-limit)
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
  }

  /**
   * Get security metrics
   */
  getSecurityMetrics(): SecurityMetrics & {
    rateLimitTrackers: number;
    bruteForceTrackers: number;
  } {
    return {
      ...this.metrics,
      rateLimitTrackers: this.rateLimitTracker.size,
      bruteForceTrackers: this.bruteForceTracker.size,
    };
  }

  /**
   * Resolve security alert
   */
  resolveAlert(alertId: string): boolean {
    const alert = this.securityAlerts.find(a => a.id === alertId);
    if (alert) {
      alert.resolved = true;
      alert.resolvedAt = new Date();
      return true;
    }
    return false;
  }
}

// Create singleton instance
const securityAlertMiddleware = new SecurityAlertMiddleware();

export default securityAlertMiddleware;
