/**
 * Security Event Logging and Monitoring - Task 67.4
 *
 * Comprehensive security event logging, threat detection, and compliance
 * monitoring for the WRFCoin platform with HSM integration support.
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import geoip from 'geoip-lite';
import {
  securityLogger,
  logSecurityEvent,
  getCorrelationId,
  LogMetadata,
} from '../utils/logger.js';

// Security event types
export enum SecurityEventType {
  AUTHENTICATION_SUCCESS = 'authentication_success',
  AUTHENTICATION_FAILURE = 'authentication_failure',
  AUTHORIZATION_FAILURE = 'authorization_failure',
  API_KEY_USAGE = 'api_key_usage',
  API_KEY_INVALID = 'api_key_invalid',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  DATA_ACCESS = 'data_access',
  PRIVILEGE_ESCALATION = 'privilege_escalation',
  WALLET_ACCESS = 'wallet_access',
  TRANSACTION_SIGNED = 'transaction_signed',
  HSM_OPERATION = 'hsm_operation',
  ADMIN_ACTION = 'admin_action',
  SECURITY_SCAN_DETECTED = 'security_scan_detected',
  BRUTE_FORCE_ATTEMPT = 'brute_force_attempt',
  IP_GEOLOCATION_ANOMALY = 'ip_geolocation_anomaly',
  DEVICE_FINGERPRINT_MISMATCH = 'device_fingerprint_mismatch',
  SESSION_HIJACKING_ATTEMPT = 'session_hijacking_attempt',
  INJECTION_ATTEMPT = 'injection_attempt',
  XSS_ATTEMPT = 'xss_attempt',
  CSRF_ATTEMPT = 'csrf_attempt',
  COMPLIANCE_VIOLATION = 'compliance_violation',
}

// Risk levels for security events
export enum RiskLevel {
  LOW = 1,
  MEDIUM = 3,
  HIGH = 6,
  CRITICAL = 9,
}

// Security context interface
interface SecurityContext {
  userId?: string;
  sessionId?: string;
  walletAddress?: string;
  apiKeyId?: string;
  ip: string;
  userAgent: string;
  geoLocation?: {
    country: string;
    region: string;
    city: string;
    latitude: number;
    longitude: number;
  };
  deviceFingerprint?: string;
  requestSignature?: string;
  timestamp: Date;
  correlationId: string;
  riskScore: number;
}

// Extended request interface
interface RequestWithSecurity extends Request {
  securityContext?: SecurityContext;
  rateLimit?: {
    remaining: number;
    total: number;
    reset: Date;
  };
}

// Threat detection patterns
const SUSPICIOUS_PATTERNS = {
  SQL_INJECTION:
    /(\b(union|select|insert|update|delete|drop|create|alter)\b)|(\-\-)|(\#)|(\*)/i,
  XSS_ATTEMPT: /(<script|javascript:|on\w+\s*=|<iframe|<object|<embed)/i,
  PATH_TRAVERSAL: /(\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e%5c)/i,
  COMMAND_INJECTION: /(\||;|&|`|\$\(|\${)/,
  BRUTE_FORCE_INDICATORS:
    /(\bpassword\b|\blogin\b|\bauth\b).*(\bwrong\b|\binvalid\b|\bfail\b)/i,
};

// Rate limiting tracking for brute force detection
const authAttempts = new Map<
  string,
  { count: number; firstAttempt: Date; blocked: boolean }
>();
const ipActivity = new Map<
  string,
  { requests: number; firstRequest: Date; suspicious: boolean }
>();

// Device fingerprinting (simplified)
function generateDeviceFingerprint(req: RequestWithSecurity): string {
  const components = [
    req.headers['user-agent'] || '',
    req.headers['accept-language'] || '',
    req.headers['accept-encoding'] || '',
    req.headers['sec-ch-ua'] || '',
    req.headers['sec-ch-ua-platform'] || '',
    req.connection?.remoteAddress || '',
  ];

  return crypto
    .createHash('sha256')
    .update(components.join('|'))
    .digest('hex')
    .substring(0, 16);
}

// Calculate risk score based on various factors
function calculateRiskScore(
  req: RequestWithSecurity,
  context: Partial<SecurityContext>
): number {
  let riskScore = 0;
  const ip = context.ip || '';

  // Check for suspicious patterns in request
  const requestBody = JSON.stringify(req.body || {});
  const requestUrl = req.url;
  const requestHeaders = JSON.stringify(req.headers);

  Object.values(SUSPICIOUS_PATTERNS).forEach(pattern => {
    if (
      pattern.test(requestBody) ||
      pattern.test(requestUrl) ||
      pattern.test(requestHeaders)
    ) {
      riskScore += RiskLevel.HIGH;
    }
  });

  // Check IP reputation (simplified - in production, use external IP reputation services)
  if (
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('172.')
  ) {
    riskScore += RiskLevel.LOW; // Internal IP
  } else {
    riskScore += RiskLevel.MEDIUM; // External IP
  }

  // Check for unusual geographic location (if user has history)
  if (context.geoLocation) {
    // This would normally check against user's typical locations
    riskScore += RiskLevel.LOW;
  }

  // Check for unusual user agent
  const userAgent = req.headers['user-agent'] || '';
  if (
    !userAgent ||
    userAgent.length < 10 ||
    /bot|crawler|spider/i.test(userAgent)
  ) {
    riskScore += RiskLevel.MEDIUM;
  }

  // Check for unusual request patterns
  const ipActivityData = ipActivity.get(ip);
  if (ipActivityData) {
    const requestsPerMinute =
      ipActivityData.requests /
      ((Date.now() - ipActivityData.firstRequest.getTime()) / 60000);
    if (requestsPerMinute > 60) {
      // More than 60 requests per minute
      riskScore += RiskLevel.HIGH;
    } else if (requestsPerMinute > 30) {
      riskScore += RiskLevel.MEDIUM;
    }
  }

  // Check for authentication failures
  const authData = authAttempts.get(ip);
  if (authData && authData.count > 3) {
    riskScore += RiskLevel.HIGH;
  }

  return Math.min(riskScore, 10); // Cap at 10
}

// Track IP activity for anomaly detection
function trackIpActivity(ip: string): void {
  const now = new Date();
  const existing = ipActivity.get(ip);

  if (existing) {
    existing.requests++;
    // Reset if more than 1 hour has passed
    if (now.getTime() - existing.firstRequest.getTime() > 3600000) {
      existing.requests = 1;
      existing.firstRequest = now;
      existing.suspicious = false;
    }
  } else {
    ipActivity.set(ip, {
      requests: 1,
      firstRequest: now,
      suspicious: false,
    });
  }
}

// Track authentication attempts for brute force detection
function trackAuthAttempt(ip: string, success: boolean): void {
  const now = new Date();
  const existing = authAttempts.get(ip);

  if (success) {
    // Reset on successful auth
    authAttempts.delete(ip);
    return;
  }

  if (existing) {
    existing.count++;
    // Reset if more than 15 minutes has passed
    if (now.getTime() - existing.firstAttempt.getTime() > 900000) {
      existing.count = 1;
      existing.firstAttempt = now;
      existing.blocked = false;
    }

    // Block after 5 failed attempts
    if (existing.count >= 5) {
      existing.blocked = true;
    }
  } else {
    authAttempts.set(ip, {
      count: 1,
      firstAttempt: now,
      blocked: false,
    });
  }
}

// Security context middleware
export function securityContextMiddleware(
  req: RequestWithSecurity,
  res: Response,
  next: NextFunction
): void {
  const ip =
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    'unknown';
  const userAgent = req.headers['user-agent'] || '';
  const correlationId = getCorrelationId();

  // Track IP activity
  trackIpActivity(ip);

  // Get geolocation
  const geoData = geoip.lookup(ip);
  const geoLocation = geoData
    ? {
        country: geoData.country,
        region: geoData.region,
        city: geoData.city,
        latitude: geoData.ll[0],
        longitude: geoData.ll[1],
      }
    : undefined;

  // Generate device fingerprint
  const deviceFingerprint = generateDeviceFingerprint(req);

  // Create security context
  req.securityContext = {
    userId: req.user?.id,
    sessionId: (req as any).sessionID,
    walletAddress: req.user?.address,
    apiKeyId: req.apiKey?.id,
    ip,
    userAgent,
    geoLocation,
    deviceFingerprint,
    timestamp: new Date(),
    correlationId,
    riskScore: 0, // Will be calculated below
  };

  // Calculate risk score
  req.securityContext.riskScore = calculateRiskScore(req, req.securityContext);

  // Log security context creation
  securityLogger.debug('Security context created', {
    operation: 'security:context-creation',
    correlationId,
    security: {
      riskScore: req.securityContext.riskScore,
      geoLocation: req.securityContext.geoLocation,
      deviceFingerprint: req.securityContext.deviceFingerprint,
    },
  });

  next();
}

// Authentication event logging middleware
export function authenticationLoggingMiddleware(
  req: RequestWithSecurity,
  res: Response,
  next: NextFunction
): void {
  const originalSend = res.send;

  res.send = function (data: any) {
    // Check if this is an authentication endpoint
    if (
      req.path.includes('/auth') ||
      req.path.includes('/login') ||
      req.path.includes('/signin')
    ) {
      const success = res.statusCode < 400;
      const ip = req.securityContext?.ip || 'unknown';

      // Track authentication attempt
      trackAuthAttempt(ip, success);

      // Log authentication event
      logSecurityEvent(
        success
          ? SecurityEventType.AUTHENTICATION_SUCCESS
          : SecurityEventType.AUTHENTICATION_FAILURE,
        {
          method: req.body?.method || 'unknown',
          userId: req.user?.id,
          walletAddress: req.user?.address,
          riskScore: req.securityContext?.riskScore || 0,
          geoLocation: req.securityContext?.geoLocation,
          deviceFingerprint: req.securityContext?.deviceFingerprint,
          userAgent: req.securityContext?.userAgent,
        },
        success ? 'info' : 'warn',
        req.user?.id,
        req.securityContext?.ip
      );

      // Check for brute force
      const authData = authAttempts.get(ip);
      if (authData && authData.count >= 3) {
        logSecurityEvent(
          SecurityEventType.BRUTE_FORCE_ATTEMPT,
          {
            attempts: authData.count,
            timeWindow: Date.now() - authData.firstAttempt.getTime(),
            blocked: authData.blocked,
          },
          'error',
          req.user?.id,
          ip
        );
      }
    }

    return originalSend.call(this, data);
  };

  next();
}

// API key usage logging middleware
export function apiKeyLoggingMiddleware(
  req: RequestWithSecurity,
  res: Response,
  next: NextFunction
): void {
  if (req.apiKey) {
    logSecurityEvent(
      SecurityEventType.API_KEY_USAGE,
      {
        apiKeyId: req.apiKey.id,
        apiKeyName: req.apiKey.name,
        permissions: req.apiKey.permissions,
        endpoint: req.path,
        method: req.method,
        riskScore: req.securityContext?.riskScore || 0,
      },
      'info',
      req.user?.id,
      req.securityContext?.ip
    );
  }

  next();
}

// Wallet operation logging middleware
export function walletOperationLoggingMiddleware(
  req: RequestWithSecurity,
  res: Response,
  next: NextFunction
): void {
  // Check if this is a wallet-related endpoint
  if (
    req.path.includes('/wallet') ||
    req.path.includes('/transaction') ||
    req.path.includes('/sign')
  ) {
    const originalSend = res.send;

    res.send = function (data: any) {
      const success = res.statusCode < 400;

      logSecurityEvent(
        SecurityEventType.WALLET_ACCESS,
        {
          operation: req.method,
          endpoint: req.path,
          walletAddress: req.user?.address,
          success,
          transactionHash: req.body?.transactionHash,
          amount: req.body?.amount,
          recipient: req.body?.recipient,
          riskScore: req.securityContext?.riskScore || 0,
        },
        success ? 'info' : 'warn',
        req.user?.id,
        req.securityContext?.ip
      );

      return originalSend.call(this, data);
    };
  }

  next();
}

// Data access logging middleware
export function dataAccessLoggingMiddleware(
  req: RequestWithSecurity,
  res: Response,
  next: NextFunction
): void {
  // Log access to sensitive data endpoints
  const sensitiveEndpoints = [
    '/admin',
    '/users',
    '/keys',
    '/secrets',
    '/config',
  ];
  const isSensitive = sensitiveEndpoints.some(endpoint =>
    req.path.includes(endpoint)
  );

  if (isSensitive) {
    logSecurityEvent(
      SecurityEventType.DATA_ACCESS,
      {
        endpoint: req.path,
        method: req.method,
        dataType: req.path.split('/')[1], // First path segment
        query: req.query,
        riskScore: req.securityContext?.riskScore || 0,
      },
      'info',
      req.user?.id,
      req.securityContext?.ip
    );
  }

  next();
}

// HSM operation logging
export function logHsmOperation(
  operation: string,
  keyId: string,
  success: boolean,
  userId?: string,
  details?: Record<string, any>
): void {
  logSecurityEvent(
    SecurityEventType.HSM_OPERATION,
    {
      operation,
      keyId,
      success,
      details,
      timestamp: new Date().toISOString(),
    },
    success ? 'info' : 'error',
    userId
  );
}

// Transaction signing logging
export function logTransactionSigning(
  transactionHash: string,
  walletAddress: string,
  amount: string,
  recipient: string,
  userId?: string,
  network?: string
): void {
  logSecurityEvent(
    SecurityEventType.TRANSACTION_SIGNED,
    {
      transactionHash,
      walletAddress,
      amount,
      recipient,
      network,
      timestamp: new Date().toISOString(),
    },
    'info',
    userId
  );
}

// Admin action logging
export function logAdminAction(
  action: string,
  target: string,
  adminUserId: string,
  details?: Record<string, any>
): void {
  logSecurityEvent(
    SecurityEventType.ADMIN_ACTION,
    {
      action,
      target,
      details,
      timestamp: new Date().toISOString(),
    },
    'warn',
    adminUserId
  );
}

// Compliance violation logging
export function logComplianceViolation(
  violationType: string,
  description: string,
  userId?: string,
  details?: Record<string, any>
): void {
  logSecurityEvent(
    SecurityEventType.COMPLIANCE_VIOLATION,
    {
      violationType,
      description,
      details,
      timestamp: new Date().toISOString(),
    },
    'error',
    userId
  );
}

// Security scan detection middleware
export function securityScanDetectionMiddleware(
  req: RequestWithSecurity,
  res: Response,
  next: NextFunction
): void {
  const suspiciousIndicators = [
    // Common security scanner user agents
    /sqlmap|nmap|nikto|dirb|gobuster|ffuf|burp|zap|acunetix/i,
    // Suspicious paths
    /\/(admin|wp-admin|phpmyadmin|config|backup|test|debug)/i,
    // Common attack vectors
    /\.(php|asp|jsp|cgi)(\?|$)/i,
  ];

  const userAgent = req.headers['user-agent'] || '';
  const path = req.path;

  const isSuspicious = suspiciousIndicators.some(
    indicator => indicator.test(userAgent) || indicator.test(path)
  );

  if (isSuspicious) {
    logSecurityEvent(
      SecurityEventType.SECURITY_SCAN_DETECTED,
      {
        userAgent,
        path,
        method: req.method,
        headers: req.headers,
        riskScore: RiskLevel.HIGH,
      },
      'warn',
      req.user?.id,
      req.securityContext?.ip
    );

    // Increase risk score
    if (req.securityContext) {
      req.securityContext.riskScore += RiskLevel.HIGH;
    }
  }

  next();
}

// Rate limit exceeded logging
export function logRateLimitExceeded(
  req: RequestWithSecurity,
  limit: number,
  current: number,
  windowMs: number
): void {
  logSecurityEvent(
    SecurityEventType.RATE_LIMIT_EXCEEDED,
    {
      endpoint: req.path,
      method: req.method,
      limit,
      current,
      windowMs,
      riskScore: req.securityContext?.riskScore || 0,
    },
    'warn',
    req.user?.id,
    req.securityContext?.ip
  );
}

// Security middleware chain
export const securityLoggingMiddlewareChain = [
  securityContextMiddleware,
  authenticationLoggingMiddleware,
  apiKeyLoggingMiddleware,
  walletOperationLoggingMiddleware,
  dataAccessLoggingMiddleware,
  securityScanDetectionMiddleware,
];

// Re-export logSecurityEvent for external modules
export { logSecurityEvent } from '../utils/logger.js';

// Note: All functions are already exported above
