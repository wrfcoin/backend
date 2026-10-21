/**
 * Authentication Middleware for API Explorer
 *
 * Handles API key and Bearer token validation for testing endpoints
 * in the interactive API explorer.
 *
 * SECURITY IMPLEMENTATION (Task 102.11):
 * - API keys are validated against secure database storage
 * - Keys are hashed with SHA-256 (never stored in plaintext)
 * - Rate limiting is enforced per-key
 * - All authentication events are logged for audit
 */

import { Request, Response, NextFunction } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import { JWT_ISSUER, JWT_AUDIENCE } from '../auth/jwt-constants.js';
import { verifyJwtWithRotation } from '../auth/jwt-rotation.js';
import { apiKeyService, type APIKeyValidationResult } from '../services/api-key-service.js';
import { securityLogger, logError } from '../utils/logger.js';

// Extended Request interface types - uses global Express extension from types/global.d.ts
// Note: The actual interface extension is in backend/types/global.d.ts

/**
 * User data structure for authenticated requests
 */
interface AuthenticatedUser {
  id: string;
  address: string;
  role: string;
  permissions: string[];
}

/**
 * API key data structure for API key authenticated requests
 *
 * SECURITY NOTE (Task 102.11):
 * - The plaintext key is NEVER stored on the request object
 * - Only the key ID is kept for audit and lookup purposes
 * - remainingQuota provides rate limit feedback to clients
 */
interface AuthenticatedApiKey {
  id: string;
  // SECURITY: Plaintext key is never stored - removed 'key' property
  userId: string;
  permissions: string[];
  scopes: string[];
  rateLimitTier: string;
  remainingQuota?: {
    daily: number;
    monthly: number;
  };
}

// JWT secret must be set via environment variable - no fallback
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    'CRITICAL: JWT_SECRET environment variable is required. ' +
    'Set a strong secret (minimum 32 characters) in your environment configuration.'
  );
}

/**
 * API Key authentication middleware
 *
 * SECURITY IMPLEMENTATION (Task 102.11):
 * - Validates API key format before database lookup
 * - Uses secure SHA-256 hash comparison
 * - Enforces rate limiting and quota checks
 * - Logs all authentication attempts for audit
 * - Returns generic error messages to prevent information disclosure
 */
export const authenticateApiKey = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const apiKey = req.headers['x-api-key'] as string;

  if (!apiKey) {
    res.status(401).json({
      error: 'API Key Required',
      message: 'Please provide an API key in the X-API-Key header',
    });
    return;
  }

  try {
    // Validate API key against database with rate limiting and IP validation
    // Pass the request object to extract IP and user-agent for security checks
    const validatedKey = await validateApiKeyFromDatabase(apiKey, req);

    if (validatedKey) {
      // Assign API key object with validated information
      // SECURITY: Never store or expose the plaintext key
      (req as any).apiKey = {
        id: validatedKey.id,
        // NOTE: We no longer store the plaintext key in the request
        // key: apiKey, // REMOVED for security
        userId: validatedKey.userId,
        permissions: validatedKey.permissions,
        rateLimitTier: validatedKey.rateLimitTier,
        scopes: validatedKey.scopes,
        remainingQuota: validatedKey.remainingQuota,
      };
      next();
    } else {
      // SECURITY: Use generic error message to prevent key enumeration
      res.status(401).json({
        error: 'Invalid API Key',
        message: 'The provided API key is not valid or has been revoked',
      });
    }
  } catch (error) {
    logError(securityLogger, 'API key validation error', error as Error, { service: 'auth' });
    // SECURITY: Don't expose internal error details
    res.status(500).json({
      error: 'Authentication Error',
      message: 'Failed to validate API key',
    });
  }
};

/**
 * Validate API key against database
 *
 * SECURITY IMPLEMENTATION (Task 102.11):
 * - Validates key format before database lookup
 * - Uses SHA-256 hashing for secure key comparison
 * - Checks key expiration and revocation status
 * - Enforces rate limiting per key
 * - Logs validation attempts for security audit
 *
 * @param apiKey - The API key to validate
 * @param req - Optional request object for IP and user-agent extraction
 * @returns Key information if valid, null otherwise
 */
async function validateApiKeyFromDatabase(
  apiKey: string,
  req?: Request
): Promise<{
  id: string;
  userId: string;
  permissions: string[];
  rateLimitTier: string;
  scopes: string[];
  remainingQuota?: {
    daily: number;
    monthly: number;
  };
} | null> {
  // Extract request info for rate limiting and IP validation
  const requestInfo = req ? {
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent'] || undefined,
    endpoint: req.originalUrl,
  } : undefined;

  // Validate the API key using the service
  const result: APIKeyValidationResult = await apiKeyService.validateKey(apiKey, requestInfo);

  if (!result.isValid) {
    // Log the failure reason for debugging (without exposing to client)
    securityLogger.warn('API key validation failed', { error: result.error, errorCode: result.errorCode });
    return null;
  }

  // Return the validated key information
  return {
    id: result.keyId!,
    userId: result.userId!,
    permissions: result.permissions!,
    rateLimitTier: result.rateLimitTier!,
    scopes: result.scopes!,
    remainingQuota: result.remainingQuota,
  };
}

/**
 * Extract client IP address from request
 * Handles proxy headers (X-Forwarded-For, X-Real-IP) for accurate IP detection
 *
 * SECURITY NOTE: In production, ensure your reverse proxy is trusted
 * and properly sets these headers. Untrusted headers can be spoofed.
 */
function getClientIp(req: Request): string | undefined {
  // Check X-Forwarded-For header (set by proxies)
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    // X-Forwarded-For can contain multiple IPs; the first is the client
    const ips = typeof xForwardedFor === 'string'
      ? xForwardedFor.split(',')
      : xForwardedFor;
    return ips[0]?.trim();
  }

  // Check X-Real-IP header (set by some proxies like nginx)
  const xRealIp = req.headers['x-real-ip'];
  if (xRealIp) {
    return typeof xRealIp === 'string' ? xRealIp : xRealIp[0];
  }

  // Fall back to direct connection IP
  return req.ip || req.socket?.remoteAddress;
}

/**
 * Bearer token authentication middleware
 */
export const authenticateToken = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({
      error: 'Bearer Token Required',
      message: 'Please provide a Bearer token in the Authorization header',
    });
    return;
  }

  try {
    // SECURITY FIX (Issue #390): Explicitly constrain algorithms to prevent alg:none attacks
    // DUAL-KEY ROTATION (#754): verifyJwtWithRotation tries JWT_SECRET first,
    // then falls back to JWT_SECRET_PREVIOUS if set. See docs/ops/secrets-rotation.md.
    const { payload: decoded, verifiedWith } = verifyJwtWithRotation<{
      id?: string;
      userId?: string;
      address?: string;
      role?: string;
      permissions?: string[];
      exp?: number;
    }>(token, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    if (verifiedWith === 'previous') {
      securityLogger.info('JWT verified with previous key during rotation', {
        path: req.path,
      });
    }

    // Check token expiration is present
    if (!decoded.exp) {
      res.status(401).json({
        error: 'Invalid Token',
        message: 'Token missing expiration claim',
      });
      return;
    }

    req.user = {
      id: decoded.id || decoded.userId || 'unknown',
      address: decoded.address || 'unknown',
      role: decoded.role || 'user',
      permissions: decoded.permissions || ['read'],
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        error: 'Token Expired',
        message: 'The provided Bearer token has expired',
      });
    } else if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        error: 'Invalid Token',
        message: 'The provided Bearer token is invalid',
      });
    } else {
      res.status(401).json({
        error: 'Authentication Failed',
        message: 'Failed to verify Bearer token',
      });
    }
  }
};

/**
 * Optional authentication - allows both authenticated and anonymous requests
 *
 * SECURITY IMPLEMENTATION (Task 102.11):
 * - Attempts API key validation with full security checks
 * - Falls through to Bearer token if API key fails
 * - Allows anonymous access if both fail (for public endpoints)
 */
export const optionalAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const apiKey = req.headers['x-api-key'] as string;
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  // Try API key first
  if (apiKey) {
    try {
      // Pass request for IP validation and rate limiting
      const validatedKey = await validateApiKeyFromDatabase(apiKey, req);
      if (validatedKey) {
        // Assign API key object with validated information
        // SECURITY: Never store or expose the plaintext key
        (req as any).apiKey = {
          id: validatedKey.id,
          // NOTE: We no longer store the plaintext key in the request
          userId: validatedKey.userId,
          permissions: validatedKey.permissions,
          rateLimitTier: validatedKey.rateLimitTier,
          scopes: validatedKey.scopes,
          remainingQuota: validatedKey.remainingQuota,
        };
      }
    } catch (error) {
      // API key validation failed, continue without API key auth
      securityLogger.warn('API key validation failed in optional auth', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Try Bearer token
  if (token) {
    try {
      // SECURITY FIX (Issue #390): Explicitly constrain algorithms to prevent alg:none attacks
      // DUAL-KEY ROTATION (#754): see docs/ops/secrets-rotation.md
      const { payload: decoded } = verifyJwtWithRotation<{
        id?: string;
        userId?: string;
        address?: string;
        role?: string;
        permissions?: string[];
      }>(token, {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
      req.user = {
        id: decoded.id || decoded.userId || 'unknown',
        address: decoded.address || 'unknown',
        role: decoded.role || 'user',
        permissions: decoded.permissions || ['read'],
      };
    } catch (error) {
      // Invalid token, but continue as anonymous
      securityLogger.warn('Invalid token in optional auth', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  next();
};

/**
 * Generate JWT token for authenticated user
 *
 * @param user - User data to encode in the token
 * @param expiresIn - Token expiration time (default: 24 hours)
 */
export const generateAuthToken = (
  user: {
    id: string;
    address: string;
    role: string;
    permissions: string[];
  },
  expiresIn: string = '24h'
): string => {
  const payload = {
    id: user.id,
    address: user.address,
    role: user.role,
    permissions: user.permissions,
    iat: Math.floor(Date.now() / 1000),
  };

  const signOptions: SignOptions = {
    expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  };

  // JWT_SECRET is guaranteed to be set (module throws on load if not)
  return jwt.sign(payload, JWT_SECRET as string, signOptions);
};

/**
 * Permission checking middleware
 */
export const requirePermission = (permission: string) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Authentication Required',
        message: 'This endpoint requires authentication',
      });
      return;
    }

    if (!req.user.permissions?.includes(permission)) {
      res.status(403).json({
        error: 'Insufficient Permissions',
        message: `This endpoint requires '${permission}' permission`,
        userPermissions: req.user.permissions,
      });
      return;
    }

    next();
  };
};

/**
 * Role checking middleware
 */
export const requireRole = (role: string) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Authentication Required',
        message: 'This endpoint requires authentication',
      });
      return;
    }

    if (req.user.role !== role) {
      res.status(403).json({
        error: 'Insufficient Role',
        message: `This endpoint requires '${role}' role`,
        userRole: req.user.role,
      });
      return;
    }

    next();
  };
};

/**
 * Authentication test routes - REMOVED
 *
 * The demo authentication endpoints have been removed for security reasons.
 * These endpoints allowed arbitrary role assignment and privilege escalation.
 *
 * For testing authentication:
 * 1. Use proper user registration and login flows
 * 2. Set up test users in a test database
 * 3. Use integration tests with proper authentication tokens
 */
export const authTestRoutes = (_app: any): void => {
  // Demo authentication endpoints have been removed for security
  // This function is kept as a no-op for backward compatibility
  securityLogger.warn('authTestRoutes: Demo authentication endpoints have been removed. Use proper authentication flows instead.');
};
