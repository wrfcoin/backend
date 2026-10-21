/**
 * CSRF Token Protection Middleware
 *
 * Implements Cross-Site Request Forgery protection for state-changing endpoints.
 * Uses the Double Submit Cookie pattern with cryptographically secure tokens.
 *
 * SECURITY IMPLEMENTATION (Task 103.5):
 * - Generates cryptographically secure random tokens using crypto.randomBytes
 * - Validates tokens using timing-safe comparison to prevent timing attacks
 * - Implements proper SameSite cookie policies
 * - Supports configurable ignored methods and paths
 * - Provides token refresh mechanism to prevent token reuse attacks
 */

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// Configuration constants
const CSRF_TOKEN_LENGTH = 32; // 256 bits of entropy
const CSRF_HEADER = 'x-csrf-token';
const CSRF_COOKIE = 'csrf-token';
const CSRF_COOKIE_HTTP_ONLY = 'csrf-token-http';

/**
 * CSRF protection configuration options
 */
export interface CSRFProtectionConfig {
  /** HTTP methods to skip CSRF validation (default: ['GET', 'HEAD', 'OPTIONS']) */
  ignoreMethods?: string[];
  /** Path prefixes to skip CSRF validation (e.g., ['/api/public/', '/webhook/']) */
  ignorePaths?: string[];
  /** Cookie configuration */
  cookie?: {
    /** Cookie name for the CSRF token (default: 'csrf-token') */
    name?: string;
    /** Cookie path (default: '/') */
    path?: string;
    /** Cookie domain (default: undefined, uses request domain) */
    domain?: string;
    /** Max age in seconds (default: 3600 = 1 hour) */
    maxAge?: number;
    /** SameSite policy (default: 'strict') */
    sameSite?: 'strict' | 'lax' | 'none';
    /** Secure flag - require HTTPS (default: true in production) */
    secure?: boolean;
  };
  /** Token refresh on each request (default: false) */
  refreshToken?: boolean;
  /** Custom error handler */
  onError?: (req: Request, res: Response, reason: string) => void;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<CSRFProtectionConfig> = {
  ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
  ignorePaths: [],
  cookie: {
    name: CSRF_COOKIE,
    path: '/',
    domain: undefined,
    maxAge: 3600, // 1 hour
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
  },
  refreshToken: false,
  onError: (req: Request, res: Response, reason: string) => {
    res.status(403).json({
      error: 'CSRF Token Invalid',
      message: 'The CSRF token is missing or invalid. Please refresh the page and try again.',
      code: 'CSRF_TOKEN_INVALID',
    });
  },
};

/**
 * Generates a cryptographically secure CSRF token
 *
 * @returns Base64 URL-safe encoded token string
 */
export function generateCsrfToken(): string {
  // Generate random bytes and encode as base64url (URL-safe base64)
  return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('base64url');
}

/**
 * Timing-safe comparison of CSRF tokens to prevent timing attacks
 *
 * @param a - First token to compare
 * @param b - Second token to compare
 * @returns True if tokens match, false otherwise
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  // Use constant-time comparison
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  // If lengths differ, still perform comparison to maintain constant time
  if (bufA.length !== bufB.length) {
    // Compare against zeroed dummy buffer to maintain constant timing
    const dummy = Buffer.alloc(bufA.length);
    crypto.timingSafeEqual(bufA, dummy);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Check if a path should be ignored for CSRF protection
 *
 * @param path - Request path to check
 * @param ignorePaths - Array of path prefixes to ignore
 * @returns True if path should be ignored
 */
function shouldIgnorePath(path: string, ignorePaths: string[]): boolean {
  return ignorePaths.some((ignorePath) => path.startsWith(ignorePath));
}

function parseCookies(req: Request): Record<string, string> {
  if (req.cookies && typeof req.cookies === 'object') {
    return req.cookies as Record<string, string>;
  }

  const header = req.headers.cookie;
  if (!header) {
    return {};
  }

  return header.split(';').reduce<Record<string, string>>((cookies, part) => {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) {
      return cookies;
    }

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

/**
 * Extract CSRF token from request
 * Checks header first, then falls back to body if present
 *
 * @param req - Express request object
 * @returns Token string or null if not found
 */
function extractTokenFromRequest(req: Request): string | null {
  // Check header first (preferred method)
  const headerToken = req.headers[CSRF_HEADER] as string | undefined;
  if (headerToken) {
    return headerToken;
  }

  // Check body for token (fallback for form submissions)
  if (req.body && typeof req.body === 'object') {
    const bodyToken = req.body._csrf || req.body.csrfToken;
    if (typeof bodyToken === 'string') {
      return bodyToken;
    }
  }

  return null;
}

/**
 * Creates CSRF protection middleware
 *
 * USAGE:
 * ```typescript
 * import { csrfProtectionMiddleware } from './middleware/csrf-protection.js';
 *
 * // Apply to all routes (recommended)
 * app.use(csrfProtectionMiddleware());
 *
 * // Or with custom configuration
 * app.use(csrfProtectionMiddleware({
 *   ignorePaths: ['/api/webhooks/', '/api/public/'],
 *   refreshToken: true,
 * }));
 * ```
 *
 * @param config - Configuration options
 * @returns Express middleware function
 */
export function csrfProtectionMiddleware(config: CSRFProtectionConfig = {}) {
  // Merge configuration with defaults
  const mergedConfig: Required<CSRFProtectionConfig> = {
    ...DEFAULT_CONFIG,
    ...config,
    cookie: {
      ...DEFAULT_CONFIG.cookie,
      ...config.cookie,
    },
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip CSRF validation for safe methods
    if (mergedConfig.ignoreMethods.includes(req.method.toUpperCase())) {
      // Generate token for responses if not present
      const cookies = parseCookies(req);
      const existingToken = cookies[mergedConfig.cookie.name!];

      if (!existingToken) {
        const token = generateCsrfToken();

        // Set cookie with token
        res.cookie(mergedConfig.cookie.name!, token, {
          httpOnly: false, // Client needs to read this to send in header
          secure: mergedConfig.cookie.secure,
          sameSite: mergedConfig.cookie.sameSite,
          path: mergedConfig.cookie.path,
          domain: mergedConfig.cookie.domain,
          maxAge: mergedConfig.cookie.maxAge! * 1000, // Convert to milliseconds
        });

        // Also set httpOnly cookie for double-submit verification
        res.cookie(CSRF_COOKIE_HTTP_ONLY, token, {
          httpOnly: true, // This one is httpOnly for security
          secure: mergedConfig.cookie.secure,
          sameSite: mergedConfig.cookie.sameSite,
          path: mergedConfig.cookie.path,
          domain: mergedConfig.cookie.domain,
          maxAge: mergedConfig.cookie.maxAge! * 1000,
        });

        // Store token for use in templates
        res.locals.csrfToken = token;
      } else {
        res.locals.csrfToken = existingToken;
      }

      return next();
    }

    // Check if path should be ignored
    if (shouldIgnorePath(req.path, mergedConfig.ignorePaths)) {
      return next();
    }

    // Validate CSRF token for state-changing methods
    const cookies = parseCookies(req);
    const cookieToken = cookies[CSRF_COOKIE_HTTP_ONLY];
    const requestToken = extractTokenFromRequest(req);

    // Both tokens must be present
    if (!cookieToken) {
      mergedConfig.onError(req, res, 'Missing CSRF cookie');
      return;
    }

    if (!requestToken) {
      mergedConfig.onError(req, res, 'Missing CSRF token in request');
      return;
    }

    // Validate token format (should be base64url, 43 chars for 32 bytes)
    if (requestToken.length < 20 || requestToken.length > 100) {
      mergedConfig.onError(req, res, 'Invalid CSRF token format');
      return;
    }

    // Compare tokens using timing-safe comparison
    if (!timingSafeEqual(cookieToken, requestToken)) {
      mergedConfig.onError(req, res, 'CSRF token mismatch');
      return;
    }

    // Optionally refresh token after successful validation
    if (mergedConfig.refreshToken) {
      const newToken = generateCsrfToken();

      res.cookie(mergedConfig.cookie.name!, newToken, {
        httpOnly: false,
        secure: mergedConfig.cookie.secure,
        sameSite: mergedConfig.cookie.sameSite,
        path: mergedConfig.cookie.path,
        domain: mergedConfig.cookie.domain,
        maxAge: mergedConfig.cookie.maxAge! * 1000,
      });

      res.cookie(CSRF_COOKIE_HTTP_ONLY, newToken, {
        httpOnly: true,
        secure: mergedConfig.cookie.secure,
        sameSite: mergedConfig.cookie.sameSite,
        path: mergedConfig.cookie.path,
        domain: mergedConfig.cookie.domain,
        maxAge: mergedConfig.cookie.maxAge! * 1000,
      });

      res.locals.csrfToken = newToken;
    }

    next();
  };
}

/**
 * Utility middleware to generate CSRF token without validation
 * Useful for initial page loads or token refresh endpoints
 *
 * @param config - Cookie configuration options
 * @returns Express middleware function
 */
export function generateCsrfTokenMiddleware(
  config: CSRFProtectionConfig['cookie'] = {}
) {
  const cookieConfig = {
    ...DEFAULT_CONFIG.cookie,
    ...config,
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const token = generateCsrfToken();

    // Set readable cookie for client
    res.cookie(cookieConfig.name!, token, {
      httpOnly: false,
      secure: cookieConfig.secure,
      sameSite: cookieConfig.sameSite,
      path: cookieConfig.path,
      domain: cookieConfig.domain,
      maxAge: cookieConfig.maxAge! * 1000,
    });

    // Set httpOnly cookie for verification
    res.cookie(CSRF_COOKIE_HTTP_ONLY, token, {
      httpOnly: true,
      secure: cookieConfig.secure,
      sameSite: cookieConfig.sameSite,
      path: cookieConfig.path,
      domain: cookieConfig.domain,
      maxAge: cookieConfig.maxAge! * 1000,
    });

    res.locals.csrfToken = token;
    next();
  };
}

/**
 * Express endpoint to get a fresh CSRF token
 * For use in SPAs that need to fetch tokens via API
 *
 * @param req - Express request
 * @param res - Express response
 */
export function getCsrfTokenEndpoint(req: Request, res: Response): void {
  const token = generateCsrfToken();
  const isProduction = process.env.NODE_ENV === 'production';

  // Set cookies
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: 3600 * 1000, // 1 hour
  });

  res.cookie(CSRF_COOKIE_HTTP_ONLY, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: 3600 * 1000,
  });

  res.json({
    csrfToken: token,
    headerName: CSRF_HEADER,
    expiresIn: 3600,
  });
}

// Export constants for use in other modules
export const CSRF_CONSTANTS = {
  TOKEN_LENGTH: CSRF_TOKEN_LENGTH,
  HEADER_NAME: CSRF_HEADER,
  COOKIE_NAME: CSRF_COOKIE,
  COOKIE_NAME_HTTP_ONLY: CSRF_COOKIE_HTTP_ONLY,
};

// Default export for convenience
export default csrfProtectionMiddleware;
