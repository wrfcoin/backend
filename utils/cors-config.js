/**
 * Advanced CORS Configuration for Wrfcoin Core
 * Provides secure cross-origin resource sharing with environment-specific settings
 */

import cors from 'cors';
import strictCorsConfig from '../server/utils/strict-cors-config.js';
import { createApiError } from '../server/utils/api-error.js';

const { resolveAllowedOrigins } = strictCorsConfig;
const { isExplicitlyDisallowedOrigin } = strictCorsConfig;

class WrfcoinCORSConfig {
  constructor() {
    this.environment = process.env.NODE_ENV || 'development';
    this.allowedOrigins = this.getAllowedOrigins();
    this.corsOptions = this.buildCORSOptions();
  }

  // Get allowed origins based on environment
  getAllowedOrigins() {
    const baseOrigins = [];

    // Environment-specific origins
    if (this.environment === 'production') {
      baseOrigins.push(
        'https://wrfcoin.app',
        'https://www.wrfcoin.app',
        'https://api.wrfcoin.app',
        'https://dashboard.wrfcoin.app',
        'https://bridge.wrfcoin.app',
        'https://explorer.wrfcoin.app'
      );
    } else if (this.environment === 'staging') {
      baseOrigins.push(
        'https://staging.wrfcoin.app',
        'https://staging-api.wrfcoin.app',
        'https://staging-dashboard.wrfcoin.app'
      );
    } else if (this.environment === 'development') {
      baseOrigins.push(
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:5000',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5000'
      );
    }

    // Add custom origins from the canonical CORS env var with legacy fallback support.
    const customOrigins = resolveAllowedOrigins({
      developmentDefaults: [],
    });
    baseOrigins.push(...customOrigins.map(origin => origin.trim()));

    return [...new Set(baseOrigins.filter(Boolean))];
  }

  // Build comprehensive CORS options
  buildCORSOptions() {
    return {
      origin: this.originHandler.bind(this),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      allowedHeaders: [
        'Origin',
        'X-Requested-With',
        'Content-Type',
        'Accept',
        'Authorization',
        'X-API-Key',
        'X-User-ID',
        'X-Request-ID',
        'X-Forwarded-For',
        'X-Real-IP',
        'Cache-Control',
        'Pragma',
      ],
      exposedHeaders: [
        'X-Total-Count',
        'X-Page-Count',
        'X-Rate-Limit-Limit',
        'X-Rate-Limit-Remaining',
        'X-Rate-Limit-Reset',
        'X-Request-ID',
        'X-Response-Time',
      ],
      credentials: true,
      maxAge: this.environment === 'production' ? 86400 : 3600, // 24h prod, 1h dev
      preflightContinue: false,
      optionsSuccessStatus: 200,
    };
  }

  // Dynamic origin handler
  originHandler(origin, callback) {
    // Allow requests with no origin (mobile apps, etc.)
    if (!origin && this.environment === 'development') {
      return callback(null, true);
    }

    // Check if origin is allowed
    if (this.isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      // Log unauthorized origin attempt
      console.warn('CORS: Blocked request from unauthorized origin:', {
        origin,
        timestamp: new Date().toISOString(),
        environment: this.environment,
      });

      callback(new Error(`CORS: Origin ${origin} not allowed`), false);
    }
  }

  // Check if origin is allowed
  isOriginAllowed(origin) {
    if (!origin) return this.environment === 'development';

    if (isExplicitlyDisallowedOrigin(origin)) {
      return false;
    }

    // Direct match
    if (this.allowedOrigins.includes(origin)) {
      return true;
    }

    // SECURITY: Use explicit subdomain allowlist instead of wildcard patterns (Task 95.1)
    // This prevents attacks from compromised or malicious subdomains
    const ALLOWED_SUBDOMAINS = [
      'app',
      'api',
      'dashboard',
      'admin',
      'bridge',
      'explorer',
      'staging',
      'dev',
    ];

    // Build explicit patterns for allowed subdomains only
    const allowedPatterns = ALLOWED_SUBDOMAINS.map(
      sub => new RegExp(`^https:\\/\\/${sub}\\.wrfcoin\\.app$`)
    );

    // Development localhost patterns (only in development)
    if (this.environment === 'development') {
      allowedPatterns.push(
        /^http:\/\/localhost:\d+$/,
        /^http:\/\/127\.0\.0\.1:\d+$/,
        /^http:\/\/0\.0\.0\.0:\d+$/
      );
    }

    return allowedPatterns.some(pattern => pattern.test(origin));
  }

  // Get CORS middleware
  getMiddleware() {
    return cors(this.corsOptions);
  }

  // Get strict CORS for sensitive endpoints
  getStrictMiddleware() {
    const strictOptions = {
      ...this.corsOptions,
      origin: (origin, callback) => {
        // Only allow specific production origins for sensitive endpoints
        const strictOrigins = [
          'https://wrfcoin.app',
          'https://www.wrfcoin.app',
          'https://dashboard.wrfcoin.app',
        ];

        if (this.environment === 'development') {
          strictOrigins.push('http://localhost:3000', 'http://localhost:5000');
        }

        if (!origin || strictOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('CORS: Strict origin policy violated'), false);
        }
      },
      credentials: true,
      maxAge: 0, // No caching for sensitive endpoints
    };

    return cors(strictOptions);
  }

  // Get public CORS for open endpoints
  getPublicMiddleware() {
    const publicOptions = {
      ...this.corsOptions,
      origin: true, // Allow all origins
      credentials: false, // No credentials for public endpoints
      allowedHeaders: [
        'Origin',
        'X-Requested-With',
        'Content-Type',
        'Accept',
        'Cache-Control',
      ],
      maxAge: 86400, // 24 hours caching
    };

    return cors(publicOptions);
  }

  // WebSocket CORS configuration
  getWebSocketCORS() {
    return {
      origin: this.allowedOrigins,
      credentials: true,
    };
  }

  // Preflight handler for complex requests
  preflightHandler() {
    return (req, res, next) => {
      if (req.method === 'OPTIONS') {
        // Set CORS headers for preflight
        const origin = req.headers.origin;

        if (this.isOriginAllowed(origin)) {
          res.header('Access-Control-Allow-Origin', origin);
          res.header('Access-Control-Allow-Credentials', 'true');
          res.header(
            'Access-Control-Allow-Methods',
            this.corsOptions.methods.join(', ')
          );
          res.header(
            'Access-Control-Allow-Headers',
            this.corsOptions.allowedHeaders.join(', ')
          );
          res.header(
            'Access-Control-Max-Age',
            this.corsOptions.maxAge.toString()
          );

          return res.status(200).end();
        } else {
          return res
            .status(403)
            .json(createApiError('CORS_ORIGIN_NOT_ALLOWED', 'Origin not allowed by CORS policy'));
        }
      }
      next();
    };
  }

  // Security headers middleware
  getSecurityHeaders() {
    return (req, res, next) => {
      // Security headers
      res.header('X-Content-Type-Options', 'nosniff');
      res.header('X-Frame-Options', 'DENY');
      res.header('X-XSS-Protection', '1; mode=block');
      res.header('Referrer-Policy', 'strict-origin-when-cross-origin');

      // SECURITY: Content Security Policy with nonce support (Task 95.2-95.3)
      // CSP nonces are handled by security-standardization.js middleware
      // This is a fallback CSP for cases where that middleware isn't used
      if (this.environment === 'production') {
        // Get nonce from response locals if available
        const nonce = res.locals?.cspNonce || '';
        const nonceDirective = nonce ? `'nonce-${nonce}'` : '';

        res.header(
          'Content-Security-Policy',
          `default-src 'self'; ` +
            `script-src 'self' ${nonceDirective} https://cdn.wrfcoin.app; ` +
            `style-src 'self' ${nonceDirective} https://fonts.googleapis.com; ` +
            `font-src 'self' https://fonts.gstatic.com; ` +
            `img-src 'self' data: https:; ` +
            `connect-src 'self' https://api.wrfcoin.app wss://api.wrfcoin.app; ` +
            `base-uri 'self'; ` +
            `form-action 'self';`
        );
      }

      next();
    };
  }

  // Get configuration summary
  getConfigSummary() {
    return {
      environment: this.environment,
      allowedOrigins: this.allowedOrigins,
      allowedMethods: this.corsOptions.methods,
      allowedHeaders: this.corsOptions.allowedHeaders,
      exposedHeaders: this.corsOptions.exposedHeaders,
      credentials: this.corsOptions.credentials,
      maxAge: this.corsOptions.maxAge,
    };
  }

  // Validate CORS configuration
  validateConfig() {
    const issues = [];

    if (this.allowedOrigins.length === 0) {
      issues.push('No allowed origins configured');
    }

    if (
      this.environment === 'production' &&
      this.allowedOrigins.some(origin => origin.includes('localhost'))
    ) {
      issues.push('Localhost origins detected in production');
    }

    if (this.corsOptions.credentials && this.allowedOrigins.includes('*')) {
      issues.push('Wildcard origin not allowed with credentials');
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  // Update allowed origins dynamically
  updateAllowedOrigins(newOrigins) {
    this.allowedOrigins = [...new Set([...this.allowedOrigins, ...newOrigins])];
    console.log('CORS: Updated allowed origins', this.allowedOrigins);
  }

  // Remove origin from allowed list
  removeAllowedOrigin(origin) {
    this.allowedOrigins = this.allowedOrigins.filter(o => o !== origin);
    console.log('CORS: Removed origin', origin);
  }
}

// Create singleton instance
const corsConfig = new WrfcoinCORSConfig();

// Validate configuration on startup
const validation = corsConfig.validateConfig();
if (!validation.valid) {
  console.warn('CORS Configuration Issues:', validation.issues);
}

console.log('CORS Configuration Initialized:', {
  environment: corsConfig.environment,
  originsCount: corsConfig.allowedOrigins.length,
  credentialsEnabled: corsConfig.corsOptions.credentials,
});

export { WrfcoinCORSConfig, corsConfig };
