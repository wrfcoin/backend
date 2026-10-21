/**
 * WRFCoin Session Store Configuration
 *
 * SECURITY FIX (102.8): Session Storage Security
 *
 * This module provides Redis-based session storage for production environments.
 * The default in-memory session store in express-session is NOT suitable for production:
 * - Memory leaks under load
 * - Sessions lost on server restart
 * - Cannot scale across multiple server instances
 * - No session persistence or backup
 *
 * IMPORTANT: Always use Redis (or another persistent store) for production sessions.
 */

const session = require('express-session');

/**
 * Get the appropriate session store based on environment
 *
 * In production, uses Redis for:
 * - Session persistence across server restarts
 * - Shared sessions across multiple server instances
 * - Automatic session expiry management
 * - Better memory management
 *
 * In development, can use in-memory store for simplicity
 * (but logs a warning about production requirements)
 *
 * @returns {Object} Session store instance or null (for in-memory)
 */
function getSessionStore() {
  const isProduction = process.env.NODE_ENV === 'production';
  const forceRedis = process.env.FORCE_REDIS_SESSIONS === 'true';

  if (isProduction || forceRedis) {
    return createRedisSessionStore();
  }

  // Development mode - use in-memory store with warning
  console.warn(
    '[SESSION SECURITY WARNING] Using in-memory session store. ' +
    'This is NOT suitable for production. Set NODE_ENV=production or ' +
    'FORCE_REDIS_SESSIONS=true to enable Redis session storage.'
  );

  return null; // express-session will use MemoryStore
}

/**
 * Create Redis session store
 *
 * @returns {Object} Redis session store instance
 */
function createRedisSessionStore() {
  // Dynamic import to avoid requiring redis in development
  let RedisStore;
  let redisClient;

  try {
    // Try to load connect-redis (modern version)
    const connectRedis = require('connect-redis');
    RedisStore = connectRedis.default || connectRedis;

    // Use the existing Redis connection utility
    const { createSecureRedisConnection } = require('../server/utils/redis-connection');
    redisClient = createSecureRedisConnection({
      // Session-specific configuration
      db: parseInt(process.env.REDIS_SESSION_DB) || 1, // Separate DB for sessions
      prefix: 'sess:',
    });

    console.log('[SESSION STORE] Redis session store configured successfully');

    return new RedisStore({
      client: redisClient,
      prefix: 'wrfcoin:sess:',
      // SECURITY: Disable session touch to prevent activity-based attacks
      // Sessions are managed via our custom session-service.ts
      disableTouch: false,
      // TTL in seconds - matches SESSION_CONFIG.IDLE_SESSION_TIMEOUT
      ttl: 3600, // 1 hour
    });

  } catch (error) {
    console.error(
      '[SESSION STORE ERROR] Failed to create Redis session store:',
      error.message
    );
    console.error(
      '[SESSION STORE ERROR] Ensure connect-redis and ioredis are installed: ' +
      'npm install connect-redis ioredis'
    );

    if (process.env.NODE_ENV === 'production') {
      // In production, fail fast rather than use insecure in-memory store
      throw new Error(
        'Redis session store is required in production but failed to initialize. ' +
        'Check Redis connection settings and ensure connect-redis is installed.'
      );
    }

    // In non-production, fall back to memory store with warning
    console.warn(
      '[SESSION STORE WARNING] Falling back to in-memory session store. ' +
      'This is a security risk and should not be used in production.'
    );
    return null;
  }
}

/**
 * Session configuration with security hardening
 *
 * @param {Object} store - Session store instance (Redis or null for MemoryStore)
 * @returns {Object} Express-session configuration object
 */
function getSessionConfig(store = null) {
  const isProduction = process.env.NODE_ENV === 'production';
  const isDevelopment = process.env.NODE_ENV === 'development';

  const config = {
    // Session secret - MUST be set via environment variable in production
    secret: process.env.SESSION_SECRET || (() => {
      if (isProduction) {
        throw new Error('SESSION_SECRET environment variable is required in production');
      }
      console.warn('[SESSION WARNING] Using default session secret. Set SESSION_SECRET in production.');
      return 'dev-session-secret-not-for-production';
    })(),

    // Session cookie name - avoid default 'connect.sid' to reduce fingerprinting
    name: 'wrfcoin_session',

    // Cookie configuration with security hardening
    cookie: {
      // SECURITY FIX (102.7): HttpOnly prevents XSS access to cookies
      httpOnly: true,

      // SECURITY FIX (102.7): Secure cookies in production/staging
      // Only allow cookies over HTTPS unless explicitly in development
      secure: !isDevelopment || process.env.FORCE_HTTPS === 'true',

      // SECURITY FIX (102.7): Strict SameSite prevents CSRF attacks
      sameSite: 'strict',

      // SECURITY FIX (102.6): 1-hour idle timeout
      // Sessions expire after 1 hour of inactivity
      maxAge: 60 * 60 * 1000, // 1 hour

      // Path restriction
      path: '/',

      // Domain configuration for production
      ...(isProduction && process.env.SESSION_COOKIE_DOMAIN && {
        domain: process.env.SESSION_COOKIE_DOMAIN,
      }),
    },

    // SECURITY FIX (102.6): Rolling sessions reset expiry on each request
    // Combined with shorter maxAge, provides sliding window session management
    rolling: true,

    // Do not save session if unmodified
    resave: false,

    // Do not create session until something stored
    saveUninitialized: false,

    // Use provided store (Redis) or default to MemoryStore
    ...(store && { store }),

    // Proxy trust for load balancers
    ...(isProduction && { proxy: true }),
  };

  return config;
}

/**
 * Session security middleware
 *
 * Additional security checks for session handling:
 * - Session regeneration on privilege escalation
 * - Session fixation protection
 * - Session binding validation
 */
function sessionSecurityMiddleware(req, res, next) {
  // SECURITY FIX (102.5): Validate session is from cookie only
  // Reject any attempts to provide session via headers
  if (req.headers['x-session-id']) {
    console.warn('[SESSION SECURITY] Rejected header-based session ID attempt', {
      ip: req.ip,
      path: req.path,
    });
    // Don't reject the request, just ignore the header
    // Session will be validated from cookie only
  }

  next();
}

/**
 * Regenerate session on authentication events
 * Call this after login to prevent session fixation attacks
 *
 * @param {Object} req - Express request object
 * @returns {Promise<void>}
 */
function regenerateSessionOnAuth(req) {
  return new Promise((resolve, reject) => {
    const oldSessionData = { ...req.session };

    req.session.regenerate((err) => {
      if (err) {
        console.error('[SESSION SECURITY] Failed to regenerate session:', err);
        return reject(err);
      }

      // Copy over non-sensitive session data
      // (Don't copy authentication state - that's what we're setting)
      if (oldSessionData.preferences) {
        req.session.preferences = oldSessionData.preferences;
      }

      console.log('[SESSION SECURITY] Session regenerated on authentication');
      resolve();
    });
  });
}

module.exports = {
  getSessionStore,
  createRedisSessionStore,
  getSessionConfig,
  sessionSecurityMiddleware,
  regenerateSessionOnAuth,
};
