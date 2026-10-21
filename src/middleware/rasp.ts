import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

// RASP (Runtime Application Self-Protection) middleware
// This is a simplified implementation - in production, you'd use a dedicated RASP solution

interface SecurityEvent {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  timestamp: string;
  ip: string;
  userAgent?: string;
  userId?: string;
  requestId?: string;
}

interface RASPConfig {
  enabled: boolean;
  blockingMode: boolean;
  monitoringOnly: boolean;
  alertThreshold: number;
  suspiciousPatterns: RegExp[];
  rateLimits: {
    maxRequestsPerMinute: number;
    maxRequestsPerHour: number;
  };
  // Task 80: Graduated blocking configuration
  graduatedBlocking: {
    enabled: boolean;
    // Block immediately for high-confidence attacks (critical severity)
    immediateBlockSeverities: ('critical' | 'high')[];
    // Block after N violations for medium-confidence attacks
    mediumConfidenceThreshold: number;
    // Only log for low-confidence detections
    lowConfidenceLogOnly: boolean;
  };
}

class RASPProtection {
  private config: RASPConfig;
  private requestCounts: Map<
    string,
    {
      minute: number;
      hour: number;
      lastReset: { minute: number; hour: number };
    }
  >;
  private blockedIPs: Set<string>;
  private suspiciousActivities: Map<string, SecurityEvent[]>;
  // Task 80: Track medium-confidence violations per IP for graduated blocking
  private mediumViolationCounts: Map<string, { count: number; lastViolation: number }>;

  constructor(config: Partial<RASPConfig> = {}) {
    this.config = {
      enabled: true,
      blockingMode: false, // Start in monitoring mode
      monitoringOnly: true,
      alertThreshold: 5,
      suspiciousPatterns: this.getDefaultPatterns(),
      rateLimits: {
        maxRequestsPerMinute: 60,
        maxRequestsPerHour: 1000,
      },
      // Task 80: Graduated blocking defaults
      graduatedBlocking: {
        enabled: true,
        immediateBlockSeverities: ['critical', 'high'],
        mediumConfidenceThreshold: 3,
        lowConfidenceLogOnly: true,
      },
      ...config,
    };

    this.requestCounts = new Map();
    this.blockedIPs = new Set();
    this.suspiciousActivities = new Map();
    // Task 80: Initialize medium violation tracker
    this.mediumViolationCounts = new Map();

    // Keep the periodic cleanup from pinning process shutdown in tests or short-lived workers.
    const cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    cleanupInterval.unref?.();
  }

  private getDefaultPatterns(): RegExp[] {
    return [
      // SQL Injection patterns
      /(\bunion\b.*\bselect\b)|(\bselect\b.*\bunion\b)/i,
      /(\bor\b\s+\d+\s*=\s*\d+)|(\band\b\s+\d+\s*=\s*\d+)/i,
      /('|\")?\s*(or|and)\s+('|\")?\s*\d+\s*=\s*\d+/i,
      /\b(insert|update|delete|drop|create|alter|exec|execute)\b/i,

      // XSS patterns
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/i,
      /javascript\s*:/i,
      /on\w+\s*=/i,
      /expression\s*\(/i,

      // Command Injection patterns
      /[;&|`$(){}[\]]/,
      /\b(exec|system|eval|cmd|shell)\b/i,

      // Path Traversal patterns
      /\.\.[\/\\]/,
      /(\.\.%2f|\.\.%5c)/i,

      // LDAP Injection patterns
      /[()&|!]/,

      // XML/XXE patterns
      /<!ENTITY/i,
      /SYSTEM\s+["']/i,

      // Server-Side Template Injection
      /\{\{.*\}\}|\$\{.*\}/,

      // Remote File Inclusion
      /^https?:\/\//i,
      /^ftp:\/\//i,
    ];
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!this.config.enabled) {
        return next();
      }

      const ip = this.getClientIP(req);
      const userAgent = req.get('User-Agent') || 'Unknown';
      const requestId = this.generateRequestId();

      // Check if IP is already blocked
      if (this.blockedIPs.has(ip)) {
        this.logSecurityEvent({
          type: 'blocked_request',
          severity: 'high',
          description: 'Request from blocked IP',
          timestamp: new Date().toISOString(),
          ip,
          userAgent,
          requestId,
        });

        return res.status(403).json({
          error: 'Access denied',
          code: 'IP_BLOCKED',
        });
      }

      // Rate limiting check
      if (!this.checkRateLimit(ip)) {
        this.handleSecurityViolation(ip, {
          type: 'rate_limit_exceeded',
          severity: 'medium',
          description: 'Rate limit exceeded',
          timestamp: new Date().toISOString(),
          ip,
          userAgent,
          requestId,
        });

        return res.status(429).json({
          error: 'Too many requests',
          code: 'RATE_LIMIT_EXCEEDED',
        });
      }

      // Analyze request for suspicious patterns
      const threats = this.analyzeRequest(req, ip, userAgent, requestId);

      if (threats.length > 0) {
        for (const threat of threats) {
          this.handleSecurityViolation(ip, threat);
        }

        // Task 80: Implement graduated blocking based on attack confidence
        if (this.config.blockingMode) {
          const shouldBlock = this.evaluateGraduatedBlocking(ip, threats);
          if (shouldBlock) {
            return res.status(403).json({
              error: 'Request blocked due to security policy',
              code: 'SECURITY_VIOLATION',
            });
          }
        }
      }

      // Continue to next middleware
      next();
    };
  }

  /**
   * Task 80: Evaluate graduated blocking based on attack confidence
   * - Critical/High severity: Block immediately
   * - Medium severity: Block after threshold violations
   * - Low severity: Log only
   */
  private evaluateGraduatedBlocking(ip: string, threats: SecurityEvent[]): boolean {
    const { graduatedBlocking } = this.config;

    if (!graduatedBlocking.enabled) {
      // Fall back to original behavior
      return threats.some(t => t.severity === 'critical' || t.severity === 'high');
    }

    // Check for immediate block severities (high-confidence attacks)
    const hasImmediateBlockThreat = threats.some(t =>
      graduatedBlocking.immediateBlockSeverities.includes(t.severity as 'critical' | 'high')
    );

    if (hasImmediateBlockThreat) {
      logger.warn('[RASP] Immediate block triggered for high-confidence attack', {
        ip,
        threats: threats.filter(t =>
          graduatedBlocking.immediateBlockSeverities.includes(t.severity as 'critical' | 'high')
        ).map(t => ({ type: t.type, severity: t.severity })),
      });
      return true;
    }

    // Check medium-confidence threats
    const mediumThreats = threats.filter(t => t.severity === 'medium');
    if (mediumThreats.length > 0) {
      const now = Date.now();
      let violationInfo = this.mediumViolationCounts.get(ip);

      if (!violationInfo || now - violationInfo.lastViolation > 3600000) {
        // Reset if last violation was more than 1 hour ago
        violationInfo = { count: 0, lastViolation: now };
      }

      violationInfo.count += mediumThreats.length;
      violationInfo.lastViolation = now;
      this.mediumViolationCounts.set(ip, violationInfo);

      if (violationInfo.count >= graduatedBlocking.mediumConfidenceThreshold) {
        logger.warn('[RASP] Medium-confidence threshold exceeded, blocking', {
          ip,
          violationCount: violationInfo.count,
          threshold: graduatedBlocking.mediumConfidenceThreshold,
        });
        return true;
      }
    }

    // Low severity: Log only (already logged in handleSecurityViolation)
    if (graduatedBlocking.lowConfidenceLogOnly) {
      const lowThreats = threats.filter(t => t.severity === 'low');
      if (lowThreats.length > 0 && mediumThreats.length === 0) {
        // Only low-severity threats, don't block
        return false;
      }
    }

    return false;
  }

  private analyzeRequest(
    req: Request,
    ip: string,
    userAgent: string,
    requestId: string
  ): SecurityEvent[] {
    const threats: SecurityEvent[] = [];
    const timestamp = new Date().toISOString();

    // Analyze URL parameters
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') {
        const suspiciousPattern = this.checkPatterns(value);
        if (suspiciousPattern) {
          threats.push({
            type: 'suspicious_query_parameter',
            severity: this.getSeverityForPattern(suspiciousPattern),
            description: `Suspicious pattern in query parameter "${key}": ${suspiciousPattern.source}`,
            timestamp,
            ip,
            userAgent,
            requestId,
          });
        }
      }
    }

    // Analyze request body
    if (req.body && typeof req.body === 'object') {
      const bodyStr = JSON.stringify(req.body);
      const suspiciousPattern = this.checkPatterns(bodyStr);
      if (suspiciousPattern) {
        threats.push({
          type: 'suspicious_request_body',
          severity: this.getSeverityForPattern(suspiciousPattern),
          description: `Suspicious pattern in request body: ${suspiciousPattern.source}`,
          timestamp,
          ip,
          userAgent,
          requestId,
        });
      }
    }

    // Analyze headers
    for (const [header, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        const suspiciousPattern = this.checkPatterns(value);
        if (suspiciousPattern) {
          threats.push({
            type: 'suspicious_header',
            severity: this.getSeverityForPattern(suspiciousPattern),
            description: `Suspicious pattern in header "${header}": ${suspiciousPattern.source}`,
            timestamp,
            ip,
            userAgent,
            requestId,
          });
        }
      }
    }

    // Check for unusual request patterns
    if (req.url.length > 2000) {
      threats.push({
        type: 'unusual_request_size',
        severity: 'medium',
        description: 'Unusually long URL detected',
        timestamp,
        ip,
        userAgent,
        requestId,
      });
    }

    // Check for missing or suspicious User-Agent
    if (
      !userAgent ||
      userAgent === 'Unknown' ||
      this.isSuspiciousUserAgent(userAgent)
    ) {
      threats.push({
        type: 'suspicious_user_agent',
        severity: 'low',
        description: 'Suspicious or missing User-Agent header',
        timestamp,
        ip,
        userAgent,
        requestId,
      });
    }

    return threats;
  }

  private checkPatterns(input: string): RegExp | null {
    for (const pattern of this.config.suspiciousPatterns) {
      if (pattern.test(input)) {
        return pattern;
      }
    }
    return null;
  }

  private getSeverityForPattern(
    pattern: RegExp
  ): 'low' | 'medium' | 'high' | 'critical' {
    const patternStr = pattern.source.toLowerCase();

    if (
      patternStr.includes('union') ||
      patternStr.includes('select') ||
      patternStr.includes('script')
    ) {
      return 'critical';
    }

    if (
      patternStr.includes('exec') ||
      patternStr.includes('system') ||
      patternStr.includes('cmd')
    ) {
      return 'high';
    }

    if (
      patternStr.includes('javascript') ||
      patternStr.includes('expression')
    ) {
      return 'medium';
    }

    return 'low';
  }

  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const minuteWindow = Math.floor(now / (60 * 1000));
    const hourWindow = Math.floor(now / (60 * 60 * 1000));

    let counts = this.requestCounts.get(ip);
    if (!counts) {
      counts = {
        minute: 0,
        hour: 0,
        lastReset: { minute: minuteWindow, hour: hourWindow },
      };
      this.requestCounts.set(ip, counts);
    }

    // Reset counters if time windows have changed
    if (counts.lastReset.minute !== minuteWindow) {
      counts.minute = 0;
      counts.lastReset.minute = minuteWindow;
    }

    if (counts.lastReset.hour !== hourWindow) {
      counts.hour = 0;
      counts.lastReset.hour = hourWindow;
    }

    // Check limits
    if (
      counts.minute >= this.config.rateLimits.maxRequestsPerMinute ||
      counts.hour >= this.config.rateLimits.maxRequestsPerHour
    ) {
      return false;
    }

    // Increment counters
    counts.minute++;
    counts.hour++;

    return true;
  }

  private handleSecurityViolation(ip: string, event: SecurityEvent): void {
    this.logSecurityEvent(event);

    // Track suspicious activities per IP
    let activities = this.suspiciousActivities.get(ip);
    if (!activities) {
      activities = [];
      this.suspiciousActivities.set(ip, activities);
    }

    activities.push(event);

    // Block IP if threshold is exceeded
    if (activities.length >= this.config.alertThreshold) {
      this.blockedIPs.add(ip);

      logger.warn('[RASP] IP blocked due to repeated security violations', {
        ip,
        violationCount: activities.length,
        violations: activities.map(a => a.type),
      });

      // Send alert to security team
      this.sendSecurityAlert(ip, activities);
    }
  }

  private logSecurityEvent(event: SecurityEvent): void {
    logger.warn('[RASP] Security event detected', event);

    // In production, also send to SIEM or security monitoring system
    // this.sendToSIEM(event);
  }

  private sendSecurityAlert(ip: string, activities: SecurityEvent[]): void {
    // In production, integrate with alerting system (Slack, PagerDuty, etc.)
    logger.error('[RASP] Security alert: IP blocked', {
      ip,
      violationCount: activities.length,
      criticalViolations: activities.filter(a => a.severity === 'critical')
        .length,
      highViolations: activities.filter(a => a.severity === 'high').length,
    });
  }

  private isSuspiciousUserAgent(userAgent: string): boolean {
    const suspiciousPatterns = [
      /sqlmap/i,
      /nikto/i,
      /burp/i,
      /nmap/i,
      /scanner/i,
      /bot.*attack/i,
      /hack/i,
    ];

    return suspiciousPatterns.some(pattern => pattern.test(userAgent));
  }

  private getClientIP(req: Request): string {
    // Try to get real IP from various headers
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded && typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }

    const realIP = req.headers['x-real-ip'];
    if (realIP && typeof realIP === 'string') {
      return realIP;
    }

    return (
      req.connection.remoteAddress || req.socket.remoteAddress || '0.0.0.0'
    );
  }

  private generateRequestId(): string {
    return generateRaspRequestId();
  }

  private cleanup(): void {
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;

    // Clean up old suspicious activities
    for (const [ip, activities] of this.suspiciousActivities.entries()) {
      const recentActivities = activities.filter(
        activity => new Date(activity.timestamp).getTime() > hourAgo
      );

      if (recentActivities.length === 0) {
        this.suspiciousActivities.delete(ip);
        this.blockedIPs.delete(ip); // Unblock IP if no recent activity
      } else {
        this.suspiciousActivities.set(ip, recentActivities);
      }
    }

    // Task 80: Clean up old medium violation counts
    for (const [ip, violationInfo] of this.mediumViolationCounts.entries()) {
      if (now - violationInfo.lastViolation > 3600000) {
        this.mediumViolationCounts.delete(ip);
      }
    }

    logger.debug('[RASP] Cleanup completed', {
      activeIPs: this.suspiciousActivities.size,
      blockedIPs: this.blockedIPs.size,
      mediumViolationTracking: this.mediumViolationCounts.size,
    });
  }

  // Admin methods
  public unblockIP(ip: string): void {
    this.blockedIPs.delete(ip);
    this.suspiciousActivities.delete(ip);
    logger.info('[RASP] IP unblocked by admin', { ip });
  }

  public getBlockedIPs(): string[] {
    return Array.from(this.blockedIPs);
  }

  public getSecurityStats(): any {
    return {
      blockedIPs: this.blockedIPs.size,
      activeMonitoring: this.suspiciousActivities.size,
      mediumViolationTracking: this.mediumViolationCounts.size,
      config: {
        enabled: this.config.enabled,
        blockingMode: this.config.blockingMode,
        monitoringOnly: this.config.monitoringOnly,
        alertThreshold: this.config.alertThreshold,
        rateLimits: this.config.rateLimits,
        graduatedBlocking: this.config.graduatedBlocking,
      },
    };
  }

  public updateConfig(newConfig: Partial<RASPConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('[RASP] Configuration updated', newConfig);
  }
}

export function generateRaspRequestId(): string {
  return `rasp_${randomUUID()}`;
}

// Export singleton instance
export const raspProtection = new RASPProtection({
  enabled: process.env.RASP_ENABLED !== 'false',
  blockingMode: process.env.RASP_BLOCKING_MODE === 'true',
  monitoringOnly: process.env.RASP_MONITORING_ONLY !== 'false',
  // Task 80: Graduated blocking environment configuration
  graduatedBlocking: {
    enabled: process.env.RASP_GRADUATED_BLOCKING !== 'false',
    immediateBlockSeverities: ['critical', 'high'],
    mediumConfidenceThreshold: parseInt(process.env.RASP_MEDIUM_THRESHOLD || '3', 10),
    lowConfidenceLogOnly: process.env.RASP_BLOCK_LOW_SEVERITY !== 'true',
  },
});

// Export middleware
export const raspMiddleware = raspProtection.middleware();

// Export admin functions
export const raspAdmin = {
  unblockIP: (ip: string) => raspProtection.unblockIP(ip),
  getBlockedIPs: () => raspProtection.getBlockedIPs(),
  getStats: () => raspProtection.getSecurityStats(),
  updateConfig: (config: Partial<RASPConfig>) =>
    raspProtection.updateConfig(config),
};
