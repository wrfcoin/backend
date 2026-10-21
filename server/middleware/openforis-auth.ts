/**
 * OpenForis Authentication Middleware
 *
 * Provides specialized authentication mechanisms for OpenForis API access
 * using runtime-configured API keys and JWT token verification.
 */

import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { JWT_ISSUER, JWT_AUDIENCE } from '../auth/jwt-constants.js';
import { createHash } from 'crypto';
import { securityLogger } from '../utils/logger.js';

type OpenForisTier = 'free' | 'premium' | 'enterprise' | 'admin';

interface OpenForisAuthRequest extends Request {
  authMethod?: 'api_key' | 'jwt' | 'anonymous';
  openforisPermissions?: string[];
}

interface ApiKeyData {
  key: string;
  hashedKey: string;
  organizationId: string;
  organizationName: string;
  permissions: string[];
  tier: OpenForisTier;
  isActive: boolean;
  createdAt: Date;
  expiresAt?: Date;
  usage: {
    totalRequests: number;
    lastUsed?: Date;
  };
}

interface RuntimeApiKeyConfig {
  key: string;
  organizationId?: string;
  organizationName?: string;
  permissions?: string[];
  tier?: OpenForisTier;
  isActive?: boolean;
  expiresAt?: string;
}

const TIER_PERMISSIONS: Record<OpenForisTier, string[]> = {
  free: ['openforis:read', 'openforis:projects:read', 'openforis:climate:read'],
  premium: [
    'openforis:read',
    'openforis:write',
    'openforis:projects:*',
    'openforis:surveys:*',
    'openforis:climate:*',
    'openforis:analysis:basic',
  ],
  enterprise: [
    'openforis:*',
    'openforis:analysis:advanced',
    'openforis:blockchain:export',
    'openforis:bulk_operations',
  ],
  admin: ['openforis:admin', 'openforis:*'],
};

const isDevelopmentEnv = (env = process.env): boolean =>
  env.NODE_ENV?.toLowerCase() === 'development';

const resolveTier = (value: unknown): OpenForisTier => {
  if (
    value === 'free' ||
    value === 'premium' ||
    value === 'enterprise' ||
    value === 'admin'
  ) {
    return value;
  }
  return 'free';
};

const parseOpenForisApiKeyConfigs = (
  rawConfig: string
): RuntimeApiKeyConfig[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (error) {
    throw new Error(
      `OPENFORIS_API_KEYS must be valid JSON: ${(error as Error).message}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error('OPENFORIS_API_KEYS must be a JSON array');
  }

  return parsed as RuntimeApiKeyConfig[];
};

export function assertOpenForisAuthConfig(env = process.env): void {
  if (!isDevelopmentEnv(env) && !env.OPENFORIS_JWT_SECRET?.trim()) {
    throw new Error(
      'OPENFORIS_JWT_SECRET is required when NODE_ENV is not development'
    );
  }

  if (env.OPENFORIS_API_KEYS?.trim()) {
    const configs = parseOpenForisApiKeyConfigs(env.OPENFORIS_API_KEYS);
    configs.forEach((config, index) => {
      if (!config || typeof config !== 'object') {
        throw new Error(
          `OPENFORIS_API_KEYS[${index}] must be an object with a "key" value`
        );
      }
      if (typeof config.key !== 'string' || !config.key.trim()) {
        throw new Error(
          `OPENFORIS_API_KEYS[${index}].key must be a non-empty string`
        );
      }
    });
  }
}

assertOpenForisAuthConfig();

const buildRuntimeApiKeys = (env = process.env): Map<string, ApiKeyData> => {
  const rawConfig = env.OPENFORIS_API_KEYS?.trim();
  if (!rawConfig) {
    return new Map();
  }

  const configs = parseOpenForisApiKeyConfigs(rawConfig);
  const apiKeys = new Map<string, ApiKeyData>();

  configs.forEach((config, index) => {
    const key = config.key.trim();
    const tier = resolveTier(config.tier);

    const expiresAt = config.expiresAt ? new Date(config.expiresAt) : undefined;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new Error(
        `OPENFORIS_API_KEYS[${index}].expiresAt must be an ISO date string`
      );
    }

    apiKeys.set(key, {
      key,
      hashedKey: createHash('sha256').update(key).digest('hex'),
      organizationId: config.organizationId || `org_${tier}_${index}`,
      organizationName: config.organizationName || `OpenForis ${tier} org ${index + 1}`,
      permissions:
        config.permissions && config.permissions.length > 0
          ? config.permissions
          : TIER_PERMISSIONS[tier],
      tier,
      isActive: config.isActive ?? true,
      createdAt: new Date(),
      expiresAt,
      usage: { totalRequests: 0 },
    });
  });

  return apiKeys;
};

const OPENFORIS_API_KEYS = buildRuntimeApiKeys();

const requireJwtSecret = (): string => {
  const secret = process.env.OPENFORIS_JWT_SECRET?.trim();
  if (!secret) {
    throw new Error('OPENFORIS_JWT_SECRET is required for OpenForis JWT authentication');
  }
  return secret;
};

const validateApiKey = (providedKey: string): ApiKeyData | null => {
  const keyData = OPENFORIS_API_KEYS.get(providedKey);
  if (!keyData || !keyData.isActive) {
    return null;
  }

  keyData.usage.totalRequests++;
  keyData.usage.lastUsed = new Date();
  return keyData;
};

function hasOpenForisPermission(
  permissions: string[],
  requiredPermission: string
): boolean {
  if (
    permissions.includes('openforis:admin') ||
    permissions.includes('openforis:*')
  ) {
    return true;
  }

  if (permissions.includes(requiredPermission)) {
    return true;
  }

  const permissionParts = requiredPermission.split(':');
  for (let i = permissionParts.length - 1; i > 0; i--) {
    const wildcardPermission = permissionParts.slice(0, i).join(':') + ':*';
    if (permissions.includes(wildcardPermission)) {
      return true;
    }
  }

  return false;
}

const respondJwtMisconfigured = (res: Response): void => {
  res.status(500).json({
    success: false,
    error: {
      code: 'OPENFORIS_AUTH_MISCONFIGURED',
      message: 'OpenForis JWT authentication is not configured',
      details: {
        hint: 'Set OPENFORIS_JWT_SECRET before enabling OpenForis JWT authentication',
      },
    },
    timestamp: new Date().toISOString(),
  });
};

export function authenticateOpenForisApiKey(
  req: OpenForisAuthRequest,
  res: Response,
  next: NextFunction
): void {
  const apiKey =
    (req.headers['x-openforis-api-key'] as string) ||
    (req.headers['x-api-key'] as string) ||
    (req.query.apiKey as string);

  if (!apiKey) {
    res.status(401).json({
      success: false,
      error: {
        code: 'OPENFORIS_API_KEY_REQUIRED',
        message: 'OpenForis API key is required',
        details: {
          hint: 'Provide API key in X-OpenForis-API-Key header or X-API-Key header',
          example: 'X-OpenForis-API-Key: your-api-key-here',
        },
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const keyData = validateApiKey(apiKey);
  if (!keyData) {
    res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_OPENFORIS_API_KEY',
        message: 'Invalid or inactive OpenForis API key',
        details: {
          hint: 'Use a valid API key that is configured through OPENFORIS_API_KEYS',
        },
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (keyData.expiresAt && keyData.expiresAt < new Date()) {
    res.status(401).json({
      success: false,
      error: {
        code: 'OPENFORIS_API_KEY_EXPIRED',
        message: 'OpenForis API key has expired',
        details: {
          expiredAt: keyData.expiresAt.toISOString(),
        },
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  (req as any).apiKey = {
    key: keyData.key,
    organizationId: keyData.organizationId,
    permissions: keyData.permissions,
    rateLimitTier: keyData.tier,
    tier: keyData.tier,
    isActive: keyData.isActive,
  };

  req.authMethod = 'api_key';
  req.openforisPermissions = keyData.permissions;

  res.setHeader('X-OpenForis-Organization', keyData.organizationName);
  res.setHeader('X-OpenForis-Tier', keyData.tier);
  res.setHeader('X-OpenForis-Auth-Method', 'api_key');

  next();
}

export function authenticateOpenForisJWT(
  req: OpenForisAuthRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({
      success: false,
      error: {
        code: 'OPENFORIS_JWT_REQUIRED',
        message: 'OpenForis JWT token is required',
        details: {
          hint: 'Provide JWT token in Authorization header as Bearer token',
          example: 'Authorization: Bearer your-jwt-token-here',
        },
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  let jwtSecret: string;
  try {
    jwtSecret = requireJwtSecret();
  } catch {
    respondJwtMisconfigured(res);
    return;
  }

  try {
    // SECURITY FIX (Issue #390): Explicitly constrain algorithms to prevent alg:none attacks
    const decoded = jwt.verify(token, jwtSecret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as any;

    (req as any).user = {
      id: decoded.id || decoded.sub || 'unknown',
      address: decoded.address || decoded.wallet_address || 'unknown',
      role: decoded.role || 'user',
      permissions:
        decoded.openforis_permissions || decoded.permissions || ['openforis:read'],
      tier: decoded.tier || 'free',
      organizationId: decoded.organization_id || decoded.org_id,
    };

    req.authMethod = 'jwt';
    req.openforisPermissions = req.user!.permissions;

    res.setHeader('X-OpenForis-User-ID', req.user!.id!);
    res.setHeader('X-OpenForis-Tier', (req.user as any).tier);
    res.setHeader('X-OpenForis-Auth-Method', 'jwt');

    next();
  } catch (error) {
    res.status(403).json({
      success: false,
      error: {
        code: 'INVALID_OPENFORIS_JWT',
        message: 'Invalid or expired OpenForis JWT token',
        details: {
          hint: 'Use a valid JWT signed with OPENFORIS_JWT_SECRET',
          jwtError: error instanceof Error ? error.message : 'Unknown JWT error',
        },
      },
      timestamp: new Date().toISOString(),
    });
  }
}

export function authenticateOpenForisFlexible(
  req: OpenForisAuthRequest,
  res: Response,
  next: NextFunction
): void {
  const apiKey =
    (req.headers['x-openforis-api-key'] as string) ||
    (req.headers['x-api-key'] as string) ||
    (req.query.apiKey as string);
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (apiKey) {
    return authenticateOpenForisApiKey(req, res, next);
  }

  if (token) {
    return authenticateOpenForisJWT(req, res, next);
  }

  res.status(401).json({
    success: false,
    error: {
      code: 'OPENFORIS_AUTH_REQUIRED',
      message: 'OpenForis authentication required',
      details: {
        hint: 'Provide either an API key or JWT token',
        examples: {
          apiKey: 'X-OpenForis-API-Key: your-api-key-here',
          jwt: 'Authorization: Bearer your-jwt-token-here',
        },
      },
    },
    timestamp: new Date().toISOString(),
  });
}

export function authenticateOpenForisOptional(
  req: OpenForisAuthRequest,
  res: Response,
  next: NextFunction
): void {
  const apiKey =
    (req.headers['x-openforis-api-key'] as string) ||
    (req.headers['x-api-key'] as string) ||
    (req.query.apiKey as string);
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (apiKey) {
    const keyData = validateApiKey(apiKey);
    if (
      keyData &&
      keyData.isActive &&
      (!keyData.expiresAt || keyData.expiresAt > new Date())
    ) {
      (req as any).apiKey = {
        key: keyData.key,
        organizationId: keyData.organizationId,
        permissions: keyData.permissions,
        rateLimitTier: keyData.tier,
        tier: keyData.tier,
        isActive: keyData.isActive,
      };
      req.authMethod = 'api_key';
      req.openforisPermissions = keyData.permissions;
      res.setHeader('X-OpenForis-Auth-Method', 'api_key');
    }
  }

  if (!req.apiKey && token) {
    try {
      // SECURITY FIX (Issue #390): Explicitly constrain algorithms to prevent alg:none attacks
      const decoded = jwt.verify(token, requireJwtSecret(), {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      }) as any;
      (req as any).user = {
        id: decoded.id || decoded.sub || 'unknown',
        address: decoded.address || decoded.wallet_address || 'unknown',
        role: decoded.role || 'user',
        permissions:
          decoded.openforis_permissions ||
          decoded.permissions ||
          ['openforis:read'],
        tier: decoded.tier || 'free',
        organizationId: decoded.organization_id || decoded.org_id,
      };
      req.authMethod = 'jwt';
      req.openforisPermissions = req.user!.permissions;
      res.setHeader('X-OpenForis-Auth-Method', 'jwt');
    } catch (error) {
      securityLogger.warn('Invalid JWT token in optional auth', {
        operation: 'openforis:auth:optional:jwt:invalid',
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : 'Unknown error',
      });
    }
  }

  if (!req.apiKey && !req.user) {
    req.authMethod = 'anonymous';
    req.openforisPermissions = [];
    res.setHeader('X-OpenForis-Auth-Method', 'anonymous');
  }

  next();
}

export function requireOpenForisPermission(permission: string) {
  return (
    req: OpenForisAuthRequest,
    res: Response,
    next: NextFunction
  ): void => {
    const permissions = req.openforisPermissions || [];

    if (!hasOpenForisPermission(permissions, permission)) {
      res.status(403).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_OPENFORIS_PERMISSION',
          message: 'Insufficient permissions for OpenForis operation',
          details: {
            required: permission,
            available: permissions,
            tier:
              (req.user as any)?.tier || (req.apiKey as any)?.tier || 'anonymous',
            hint: 'Contact your organization admin to upgrade permissions',
          },
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  };
}

export function requireOpenForisTier(requiredTier: OpenForisTier) {
  const tierHierarchy = { free: 0, premium: 1, enterprise: 2, admin: 3 };

  return (
    req: OpenForisAuthRequest,
    res: Response,
    next: NextFunction
  ): void => {
    const userTier = (req.user as any)?.tier || (req.apiKey as any)?.tier || 'free';
    const requiredLevel = tierHierarchy[requiredTier];
    const userLevel = tierHierarchy[userTier as keyof typeof tierHierarchy] || 0;

    if (userLevel < requiredLevel) {
      res.status(403).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_OPENFORIS_TIER',
          message: `This operation requires ${requiredTier} tier or higher`,
          details: {
            required: requiredTier,
            current: userTier,
            upgrade: `Contact support to upgrade from ${userTier} to ${requiredTier}`,
          },
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  };
}

export function generateOpenForisJWT(
  userId: string = 'openforis-local-user',
  tier: string = 'premium',
  permissions: string[] = ['openforis:read', 'openforis:write']
): string {
  const normalizedTier = resolveTier(tier);
  const addressSeed = createHash('sha256')
    .update(`${userId}:${Date.now()}`)
    .digest('hex')
    .slice(0, 40);
  const payload = {
    id: userId,
    address: `0x${addressSeed}`,
    role: normalizedTier,
    tier: normalizedTier,
    openforis_permissions: permissions,
    organization_id: `org_${normalizedTier}_${Date.now()}`,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
  };

  return jwt.sign(payload, requireJwtSecret(), {
    algorithm: 'HS256',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

export { OpenForisAuthRequest, ApiKeyData };
