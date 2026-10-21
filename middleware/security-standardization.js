/**
 * Centralized Security Middleware Standardization for Wrfcoin Platform
 * Provides consistent CORS, security headers, and environment-aware configurations
 *
 * SECURITY: Updated to use CSP nonces instead of unsafe-inline (Task 95.2-95.3)
 */

import { corsConfig } from '../utils/cors-config.js';
import helmet from 'helmet';
import crypto from 'crypto';
import { securityLogger } from '../server/utils/logger.js';

/**
 * Generate a cryptographically secure nonce for CSP
 */
function generateNonce() {
  return crypto.randomBytes(16).toString('base64');
}

class SecurityStandardization {
  /**
   * Get standardized security middleware stack for Express apps
   * @param {Object} options - Configuration options
   * @param {string} options.level - Security level: 'public', 'standard', 'strict'
   * @param {boolean} options.enableHelmet - Enable helmet security headers (default: true)
   * @param {boolean} options.enableCORS - Enable CORS middleware (default: true)
   * @param {Object} options.customOrigins - Additional allowed origins
   */
  static getSecurityMiddleware(options = {}) {
    const {
      level = 'standard',
      enableHelmet = true,
      enableCORS = true,
      customOrigins = [],
    } = options;

    const middlewares = [];

    // SECURITY: Add CSP nonce generation middleware (Task 95.2)
    // This generates a unique nonce per request for inline scripts/styles
    middlewares.push(this.getNonceMiddleware());

    // Add security headers with nonce support
    if (enableHelmet) {
      middlewares.push(this.getHelmetConfig(level));
    }

    // Add CORS configuration
    if (enableCORS) {
      middlewares.push(this.getCORSConfig(level, customOrigins));
    }

    // Add additional security headers
    middlewares.push(corsConfig.getSecurityHeaders());

    return middlewares;
  }

  /**
   * SECURITY: Middleware to generate CSP nonce for each request (Task 95.2)
   * The nonce is stored in res.locals.cspNonce for use in templates
   */
  static getNonceMiddleware() {
    return (req, res, next) => {
      // Generate a unique nonce for this request
      const nonce = generateNonce();
      res.locals.cspNonce = nonce;

      // Make nonce available on request object as well
      req.cspNonce = nonce;

      next();
    };
  }

  /**
   * Get Helmet configuration based on security level
   * SECURITY: Uses CSP nonces instead of unsafe-inline (Task 95.2-95.3)
   */
  static getHelmetConfig(level) {
    const configs = {
      public: {
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        hsts: false,
      },
      standard: {
        contentSecurityPolicy: {
          useDefaults: false,
          directives: {
            defaultSrc: ["'self'"],
            // SECURITY: Use nonce instead of unsafe-inline (Task 95.2)
            // The nonce is generated per-request by getNonceMiddleware()
            scriptSrc: [
              "'self'",
              (req, res) => `'nonce-${res.locals.cspNonce}'`,
            ],
            styleSrc: [
              "'self'",
              (req, res) => `'nonce-${res.locals.cspNonce}'`,
              'https://fonts.googleapis.com',
            ],
            fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'", 'wss:', 'ws:', 'https:'],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'self'"],
            // SECURITY: Removed unsafe-eval entirely (Task 95.3)
            // Applications should not use eval() or similar constructs
            baseUri: ["'self'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: [],
          },
        },
        hsts: {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true,
        },
        noSniff: true,
        xssFilter: true,
        referrerPolicy: { policy: ['strict-origin-when-cross-origin'] },
        frameguard: { action: 'deny' },
      },
      strict: {
        contentSecurityPolicy: {
          useDefaults: false,
          directives: {
            defaultSrc: ["'self'"],
            // SECURITY: Use nonce for strict mode as well
            scriptSrc: [
              "'self'",
              (req, res) => `'nonce-${res.locals.cspNonce}'`,
            ],
            styleSrc: [
              "'self'",
              (req, res) => `'nonce-${res.locals.cspNonce}'`,
            ],
            fontSrc: ["'self'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'none'"],
            frameSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: [],
          },
        },
        hsts: {
          maxAge: 63072000, // 2 years
          includeSubDomains: true,
          preload: true,
        },
        noSniff: true,
        xssFilter: true,
        referrerPolicy: { policy: ['same-origin'] },
        frameguard: { action: 'deny' },
      },
    };

    return helmet(configs[level]);
  }

  /**
   * Get CORS configuration based on security level
   */
  static getCORSConfig(level, customOrigins = []) {
    switch (level) {
      case 'public':
        return corsConfig.getPublicMiddleware();
      case 'strict':
        return corsConfig.getStrictMiddleware();
      case 'standard':
      default:
        // Add custom origins to the standard configuration
        if (customOrigins.length > 0) {
          corsConfig.updateAllowedOrigins(customOrigins);
        }
        return corsConfig.getMiddleware();
    }
  }

  /**
   * Validate security configuration for environment
   */
  static validateSecurityConfig() {
    const validation = corsConfig.validateConfig();
    const environment = process.env.NODE_ENV || 'development';

    const issues = [...validation.issues];

    // Additional validations
    if (environment === 'production') {
      const allowedOrigins = corsConfig.allowedOrigins;

      // Check for localhost origins in production
      const localhostOrigins = allowedOrigins.filter(
        origin => origin.includes('localhost') || origin.includes('127.0.0.1')
      );

      if (localhostOrigins.length > 0) {
        issues.push(
          `Production environment contains localhost origins: ${localhostOrigins.join(', ')}`
        );
      }

      // Check for development URLs in production
      const devOrigins = allowedOrigins.filter(
        origin =>
          origin.includes('localhost') ||
          origin.includes('dev.') ||
          origin.includes('-dev.')
      );

      if (devOrigins.length > 0) {
        issues.push(
          `Production environment contains development origins: ${devOrigins.join(', ')}`
        );
      }
    }

    return {
      valid: issues.length === 0,
      issues,
      environment,
      originsCount: corsConfig.allowedOrigins.length,
    };
  }

  /**
   * Get security configuration summary for monitoring
   */
  static getSecuritySummary() {
    const validation = this.validateSecurityConfig();
    const config = corsConfig.getConfigSummary();

    return {
      timestamp: new Date().toISOString(),
      environment: config.environment,
      corsConfig: {
        allowedOrigins: config.allowedOrigins,
        originsCount: config.allowedOrigins.length,
        credentialsEnabled: config.credentials,
        maxAge: config.maxAge,
      },
      validation: {
        valid: validation.valid,
        issuesCount: validation.issues.length,
        issues: validation.issues,
      },
      securityLevel: this.determineSecurityLevel(config, validation),
    };
  }

  /**
   * Determine current security level based on configuration
   */
  static determineSecurityLevel(config, validation) {
    if (!validation.valid) return 'insecure';

    const hasWildcardOrigins = config.allowedOrigins.includes('*');
    const hasLocalhostInProd =
      config.environment === 'production' &&
      config.allowedOrigins.some(origin => origin.includes('localhost'));

    if (hasWildcardOrigins || hasLocalhostInProd) return 'low';
    if (config.allowedOrigins.length > 10) return 'medium';
    return 'high';
  }

  /**
   * Log security configuration on startup
   */
  static logSecurityStartup() {
    const summary = this.getSecuritySummary();

    securityLogger.info('Security Configuration Summary', {
      environment: summary.environment,
      securityLevel: summary.securityLevel.toUpperCase(),
      corsOrigins: summary.corsConfig.originsCount,
      credentialsEnabled: summary.corsConfig.credentialsEnabled,
      configurationValid: summary.validation.valid
    });

    if (!summary.validation.valid) {
      securityLogger.warn('Security issues found', {
        issues: summary.validation.issues
      });
    }
  }
}

export default SecurityStandardization;
