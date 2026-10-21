/**
 * Security Enhancer for Wrfcoin Backend
 * Implements advanced security patterns and threat detection
 */

const crypto = require('crypto');
const { securityLogger } = require('../utils/logger');

class SecurityEnhancer {
  constructor() {
    this.threatDetection = {
      suspiciousPatterns: new Map(),
      blockedIPs: new Set(),
      rateLimitViolations: new Map(),
      securityEvents: [],
    };

    this.securityPolicies = {
      maxRequestSize: 10 * 1024 * 1024, // 10MB
      allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      blockedUserAgents: ['curl', 'wget', 'python-requests'],
      requireAuth: [
        '/api/wallet/',
        '/api/governance/vote',
        '/api/mining/control',
      ],
      rateLimits: {
        '/api/wallet/': { requests: 50, window: 3600000 }, // 50 per hour
        '/api/governance/': { requests: 100, window: 3600000 },
        '/api/mining/': { requests: 200, window: 3600000 },
      },
    };
  }

  // Main security middleware
  middleware() {
    return (req, res, next) => {
      const startTime = Date.now();

      try {
        // 1. Basic request validation
        if (!this.validateRequest(req)) {
          return this.blockRequest(req, res, 'Invalid request format');
        }

        // 2. IP reputation check
        if (this.isBlockedIP(req.ip)) {
          return this.blockRequest(
            req,
            res,
            'IP blocked due to suspicious activity'
          );
        }

        // 3. User agent filtering
        if (this.isSuspiciousUserAgent(req.get('User-Agent'))) {
          this.logSecurityEvent('suspicious_user_agent', req);
        }

        // 4. Path traversal protection
        if (this.hasPathTraversal(req.path)) {
          return this.blockRequest(req, res, 'Path traversal attempt detected');
        }

        // 5. SQL injection detection
        if (this.hasSQLInjection(req)) {
          return this.blockRequest(req, res, 'SQL injection attempt detected');
        }

        // 6. XSS protection
        if (this.hasXSSAttempt(req)) {
          return this.blockRequest(req, res, 'XSS attempt detected');
        }

        // 7. Request size validation
        if (req.get('content-length') > this.securityPolicies.maxRequestSize) {
          return this.blockRequest(req, res, 'Request too large');
        }

        // 8. Method validation
        if (!this.securityPolicies.allowedMethods.includes(req.method)) {
          return this.blockRequest(req, res, 'Method not allowed');
        }

        // Add security headers
        this.addSecurityHeaders(res);

        // Log successful validation
        this.logRequestValidation(req, Date.now() - startTime);

        next();
      } catch (error) {
        securityLogger.error('Security middleware error', { module: 'SecurityEnhancer', error: error.message, stack: error.stack });
        return res.status(500).json({ error: 'Security validation failed' });
      }
    };
  }

  validateRequest(req) {
    // Basic request structure validation
    if (!req.method || !req.path) {
      return false;
    }

    // Check for required headers
    if (!req.get('User-Agent')) {
      this.logSecurityEvent('missing_user_agent', req);
    }

    return true;
  }

  isBlockedIP(ip) {
    return this.threatDetection.blockedIPs.has(ip);
  }

  isSuspiciousUserAgent(userAgent) {
    if (!userAgent) return true;

    return this.securityPolicies.blockedUserAgents.some(blocked =>
      userAgent.toLowerCase().includes(blocked.toLowerCase())
    );
  }

  hasPathTraversal(path) {
    const traversalPatterns = [
      '../',
      '..\\',
      '..%2f',
      '..%5c',
      '%2e%2e%2f',
      '%2e%2e%5c',
      'etc/passwd',
      'etc\\passwd',
      'windows/system32',
    ];

    const decodedPath = decodeURIComponent(path.toLowerCase());
    return traversalPatterns.some(pattern => decodedPath.includes(pattern));
  }

  hasSQLInjection(req) {
    const sqlPatterns = [
      /(\b(union|select|insert|update|delete|drop|create|alter|exec|execute)\b)/i,
      /(\b(or|and)\s+\w*\s*=\s*\w*)/i,
      /(--|\/\*|\*\/|;|\|)/,
      /(\b(char|ascii|substring|length|user|database|version)\s*\()/i,
    ];

    const testStrings = [
      req.path,
      JSON.stringify(req.query),
      JSON.stringify(req.body),
      req.get('User-Agent') || '',
    ];

    return testStrings.some(str =>
      sqlPatterns.some(pattern => pattern.test(str))
    );
  }

  hasXSSAttempt(req) {
    const xssPatterns = [
      /<script[^>]*>.*?<\/script>/gi,
      /javascript:/gi,
      /vbscript:/gi,
      /on\w+\s*=/gi,
      /<iframe[^>]*>/gi,
      /<object[^>]*>/gi,
      /<embed[^>]*>/gi,
      /eval\s*\(/gi,
      /expression\s*\(/gi,
    ];

    const testStrings = [
      req.path,
      JSON.stringify(req.query),
      JSON.stringify(req.body),
    ];

    return testStrings.some(str =>
      xssPatterns.some(pattern => pattern.test(str))
    );
  }

  blockRequest(req, res, reason) {
    this.logSecurityEvent('request_blocked', req, { reason });

    // Add to suspicious patterns
    const pattern = `${req.ip}:${req.path}`;
    const count = this.threatDetection.suspiciousPatterns.get(pattern) || 0;
    this.threatDetection.suspiciousPatterns.set(pattern, count + 1);

    // Block IP after 5 suspicious requests
    if (count >= 4) {
      this.threatDetection.blockedIPs.add(req.ip);
      securityLogger.warn('IP blocked due to repeated suspicious activity', { module: 'SecurityEnhancer', ip: req.ip, suspiciousCount: count + 1 });
    }

    return res.status(403).json({
      error: 'Request blocked',
      reason: reason,
      timestamp: new Date().toISOString(),
    });
  }

  addSecurityHeaders(res) {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' https:; base-uri 'self'; form-action 'self';",
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
      'X-Security-Enhanced': 'Wrfcoin-Security-v2.0',
    });
  }

  logSecurityEvent(type, req, extra = {}) {
    const event = {
      type,
      timestamp: new Date().toISOString(),
      ip: req.ip,
      method: req.method,
      path: req.path,
      userAgent: req.get('User-Agent'),
      ...extra,
    };

    this.threatDetection.securityEvents.push(event);

    // Keep only last 1000 events
    if (this.threatDetection.securityEvents.length > 1000) {
      this.threatDetection.securityEvents =
        this.threatDetection.securityEvents.slice(-1000);
    }

    // Log critical events
    if (['request_blocked', 'sql_injection', 'xss_attempt'].includes(type)) {
      securityLogger.warn('Security event detected', { module: 'SecurityEnhancer', eventType: type, ...event });
    }
  }

  logRequestValidation(req, processingTime) {
    if (processingTime > 100) {
      // Log slow security checks
      securityLogger.info('Slow security validation detected', { module: 'SecurityEnhancer', path: req.path, processingTime, threshold: 100 });
    }
  }

  // Generate security report
  getSecurityReport() {
    const recentEvents = this.threatDetection.securityEvents.slice(-100);
    const eventTypes = {};

    recentEvents.forEach(event => {
      eventTypes[event.type] = (eventTypes[event.type] || 0) + 1;
    });

    return {
      blockedIPs: Array.from(this.threatDetection.blockedIPs),
      suspiciousPatterns: Object.fromEntries(
        this.threatDetection.suspiciousPatterns
      ),
      recentEvents: recentEvents.slice(-10),
      eventSummary: eventTypes,
      totalEvents: this.threatDetection.securityEvents.length,
      policies: this.securityPolicies,
      timestamp: new Date().toISOString(),
    };
  }

  // Clear security data
  clearSecurityData() {
    this.threatDetection.suspiciousPatterns.clear();
    this.threatDetection.blockedIPs.clear();
    this.threatDetection.securityEvents = [];
  }

  // Unblock IP
  unblockIP(ip) {
    this.threatDetection.blockedIPs.delete(ip);
    securityLogger.info('IP unblocked', { module: 'SecurityEnhancer', ip });
  }
}

module.exports = SecurityEnhancer;
