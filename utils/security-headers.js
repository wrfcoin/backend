/**
 * Security Headers Middleware for Wrfcoin Core
 * Comprehensive security headers implementation with CSP, HSTS, and more
 */

const crypto = require('crypto');

class SecurityHeaders {
  constructor(options = {}) {
    this.config = {
      // Content Security Policy
      csp: {
        enabled: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': [
            "'self'",
            "'unsafe-inline'",
            'https://cdn.jsdelivr.net',
          ],
          'style-src': [
            "'self'",
            "'unsafe-inline'",
            'https://fonts.googleapis.com',
          ],
          'font-src': ["'self'", 'https://fonts.gstatic.com'],
          'img-src': ["'self'", 'data:', 'https:'],
          'connect-src': ["'self'", 'wss:', 'https:'],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
        },
        reportUri: '/api/csp-report',
        ...options.csp,
      },

      // HTTP Strict Transport Security
      hsts: {
        enabled: true,
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
        ...options.hsts,
      },

      // Other security headers
      xssProtection: {
        enabled: true,
        mode: 'block',
        ...options.xssProtection,
      },

      frameOptions: {
        enabled: true,
        action: 'DENY',
        ...options.frameOptions,
      },

      contentTypeOptions: {
        enabled: true,
        ...options.contentTypeOptions,
      },

      referrerPolicy: {
        enabled: true,
        policy: 'strict-origin-when-cross-origin',
        ...options.referrerPolicy,
      },

      permissionsPolicy: {
        enabled: true,
        directives: {
          camera: [],
          microphone: [],
          geolocation: [],
          payment: [],
          usb: [],
          ...options.permissionsPolicy?.directives,
        },
        ...options.permissionsPolicy,
      },
    };

    this.nonces = new Map();
  }

  // Generate CSP nonce for inline scripts/styles
  generateNonce() {
    return crypto.randomBytes(16).toString('base64');
  }

  // Main middleware function
  middleware() {
    return (req, res, next) => {
      // Generate nonce for this request
      const nonce = this.generateNonce();
      req.nonce = nonce;
      res.locals.nonce = nonce;

      // Apply all security headers
      this.applyContentSecurityPolicy(req, res, nonce);
      this.applyHSTS(res);
      this.applyXSSProtection(res);
      this.applyFrameOptions(res);
      this.applyContentTypeOptions(res);
      this.applyReferrerPolicy(res);
      this.applyPermissionsPolicy(res);
      this.applyAdditionalHeaders(res);

      next();
    };
  }

  applyContentSecurityPolicy(req, res, nonce) {
    if (!this.config.csp.enabled) return;

    const directives = { ...this.config.csp.directives };

    // Add nonce to script-src and style-src
    if (directives['script-src']) {
      directives['script-src'] = [
        ...directives['script-src'],
        `'nonce-${nonce}'`,
      ];
    }
    if (directives['style-src']) {
      directives['style-src'] = [
        ...directives['style-src'],
        `'nonce-${nonce}'`,
      ];
    }

    // Build CSP header value
    const cspValue = Object.entries(directives)
      .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
      .join('; ');

    // Add report-uri if configured
    const finalCsp = this.config.csp.reportUri
      ? `${cspValue}; report-uri ${this.config.csp.reportUri}`
      : cspValue;

    res.setHeader('Content-Security-Policy', finalCsp);

    // Also set report-only version for testing
    res.setHeader('Content-Security-Policy-Report-Only', finalCsp);
  }

  applyHSTS(res) {
    if (!this.config.hsts.enabled) return;

    let hstsValue = `max-age=${this.config.hsts.maxAge}`;

    if (this.config.hsts.includeSubDomains) {
      hstsValue += '; includeSubDomains';
    }

    if (this.config.hsts.preload) {
      hstsValue += '; preload';
    }

    res.setHeader('Strict-Transport-Security', hstsValue);
  }

  applyXSSProtection(res) {
    if (!this.config.xssProtection.enabled) return;

    const value =
      this.config.xssProtection.mode === 'block' ? '1; mode=block' : '1';

    res.setHeader('X-XSS-Protection', value);
  }

  applyFrameOptions(res) {
    if (!this.config.frameOptions.enabled) return;

    res.setHeader('X-Frame-Options', this.config.frameOptions.action);
  }

  applyContentTypeOptions(res) {
    if (!this.config.contentTypeOptions.enabled) return;

    res.setHeader('X-Content-Type-Options', 'nosniff');
  }

  applyReferrerPolicy(res) {
    if (!this.config.referrerPolicy.enabled) return;

    res.setHeader('Referrer-Policy', this.config.referrerPolicy.policy);
  }

  applyPermissionsPolicy(res) {
    if (!this.config.permissionsPolicy.enabled) return;

    const directives = Object.entries(this.config.permissionsPolicy.directives)
      .map(([feature, allowlist]) => {
        const sources =
          allowlist.length > 0 ? `(${allowlist.join(' ')})` : '()';
        return `${feature}=${sources}`;
      })
      .join(', ');

    res.setHeader('Permissions-Policy', directives);
  }

  applyAdditionalHeaders(res) {
    // Additional security headers
    res.setHeader('X-Powered-By', 'Wrfcoin-Core/1.0');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    // Cache control for security
    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, proxy-revalidate'
    );
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }

  // CSP violation reporting endpoint
  cspReportHandler() {
    return (req, res) => {
      const report = req.body;

      console.log('CSP Violation Report:', {
        timestamp: new Date().toISOString(),
        userAgent: req.get('user-agent'),
        report: report,
      });

      // Log to security monitoring system
      this.logSecurityEvent('csp_violation', {
        blocked_uri: report['csp-report']?.['blocked-uri'],
        violated_directive: report['csp-report']?.['violated-directive'],
        original_policy: report['csp-report']?.['original-policy'],
        source_file: report['csp-report']?.['source-file'],
        line_number: report['csp-report']?.['line-number'],
      });

      res.status(204).send();
    };
  }

  // Security event logging
  logSecurityEvent(eventType, details) {
    const event = {
      timestamp: new Date().toISOString(),
      type: eventType,
      details: details,
      severity: this.getEventSeverity(eventType),
    };

    // In production, send to security monitoring service
    console.log('Security Event:', event);
  }

  getEventSeverity(eventType) {
    const severityMap = {
      csp_violation: 'medium',
      xss_attempt: 'high',
      injection_attempt: 'high',
      unauthorized_access: 'critical',
    };

    return severityMap[eventType] || 'low';
  }

  // Validate and sanitize input
  validateInput(input, type = 'string') {
    if (!input) return null;

    switch (type) {
      case 'string':
        return this.sanitizeString(input);
      case 'html':
        return this.sanitizeHtml(input);
      case 'url':
        return this.validateUrl(input);
      case 'email':
        return this.validateEmail(input);
      default:
        return input;
    }
  }

  sanitizeString(str) {
    return str.replace(/[<>'"&]/g, char => {
      const charMap = {
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '&': '&amp;',
      };
      return charMap[char];
    });
  }

  sanitizeHtml(html) {
    // Basic HTML sanitization - in production, use a library like DOMPurify
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
      .replace(/on\w+="[^"]*"/gi, '')
      .replace(/javascript:/gi, '');
  }

  validateUrl(url) {
    try {
      const urlObj = new URL(url);
      // Only allow https and http protocols
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        return null;
      }
      return urlObj.toString();
    } catch {
      return null;
    }
  }

  validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email) ? email : null;
  }

  // Rate limiting for security endpoints
  createSecurityRateLimit() {
    const attempts = new Map();

    return (req, res, next) => {
      const clientId = req.ip || req.connection.remoteAddress;
      const now = Date.now();
      const windowMs = 15 * 60 * 1000; // 15 minutes
      const maxAttempts = 5;

      if (!attempts.has(clientId)) {
        attempts.set(clientId, []);
      }

      const clientAttempts = attempts.get(clientId);

      // Remove old attempts
      const recentAttempts = clientAttempts.filter(
        time => now - time < windowMs
      );
      attempts.set(clientId, recentAttempts);

      if (recentAttempts.length >= maxAttempts) {
        this.logSecurityEvent('rate_limit_exceeded', {
          clientId: clientId,
          attempts: recentAttempts.length,
          endpoint: req.path,
        });

        return res.status(429).json({
          error: 'Too many requests',
          retryAfter: Math.ceil(windowMs / 1000),
        });
      }

      recentAttempts.push(now);
      next();
    };
  }

  // Get security configuration
  getSecurityConfig() {
    return {
      csp_enabled: this.config.csp.enabled,
      hsts_enabled: this.config.hsts.enabled,
      xss_protection: this.config.xssProtection.enabled,
      frame_options: this.config.frameOptions.enabled,
      content_type_options: this.config.contentTypeOptions.enabled,
      referrer_policy: this.config.referrerPolicy.enabled,
      permissions_policy: this.config.permissionsPolicy.enabled,
    };
  }
}

module.exports = SecurityHeaders;
