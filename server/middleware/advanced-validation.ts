/**
 * Advanced Validation Middleware with TypeScript Features
 *
 * Demonstrates middleware creation using advanced TypeScript patterns
 * including conditional types, template literals, and runtime validation.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  createValidationMiddleware,
  TypedValidator,
} from '../../shared/types/runtime-validation.js';
import { AuthenticatedRequest } from '../../shared/types/security-types.js';

// Template literal types for API routes
type ApiVersion = 'v1' | 'v2';
type ResourceType = 'weather' | 'transactions' | 'nfts' | 'users';
type ApiRoute<V extends ApiVersion, R extends ResourceType> = `/api/${V}/${R}`;

// Conditional validation based on API route
type ValidationSchema<T extends string> = T extends '/api/v1/weather'
  ? typeof WeatherValidationSchema
  : T extends '/api/v1/transactions'
    ? typeof TransactionValidationSchema
    : T extends '/api/v1/nfts'
      ? typeof NFTValidationSchema
      : T extends '/api/v1/users'
        ? typeof UserValidationSchema
        : never;

// Schema definitions
const WeatherValidationSchema = z.object({
  type: z.enum(['temperature', 'humidity', 'pressure', 'precipitation']),
  stationId: z.string().min(8).max(12),
  value: z.number(),
  timestamp: z.string().datetime(),
  quality: z.enum(['high', 'medium', 'low']),
});

const TransactionValidationSchema = z.object({
  chainId: z.enum(['ethereum', 'polygon', 'bsc', 'avalanche', 'wrfcoin']),
  from: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  gasPrice: z.string().optional(),
  gasLimit: z.number().optional(),
});

const NFTValidationSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000),
  owner: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  metadata: z.object({
    attributes: z.array(
      z.object({
        trait_type: z.string(),
        value: z.union([z.string(), z.number()]),
        display_type: z.string().optional(),
      })
    ),
    computationResults: z.record(z.string(), z.any()).optional(),
  }),
});

const UserValidationSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  role: z.enum(['admin', 'validator', 'contributor', 'viewer']),
  preferences: z
    .object({
      notifications: z.boolean(),
      dataSharing: z.boolean(),
    })
    .optional(),
});

// Advanced middleware factory with type inference
export function createAdvancedValidationMiddleware<T extends string>(
  route: T,
  property: 'body' | 'query' | 'params' = 'body'
) {
  // Type-safe schema selection based on route
  const getSchema = (route: string) => {
    switch (route) {
      case '/api/v1/weather':
        return WeatherValidationSchema;
      case '/api/v1/transactions':
        return TransactionValidationSchema;
      case '/api/v1/nfts':
        return NFTValidationSchema;
      case '/api/v1/users':
        return UserValidationSchema;
      default:
        throw new Error(`No validation schema found for route: ${route}`);
    }
  };

  const schema = getSchema(route);

  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void => {
    try {
      // Validate using the appropriate schema
      req[property] = schema.parse(req[property]);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: error.issues.map(err => ({
            field: err.path.join('.'),
            message: err.message,
            code: err.code,
          })),
        });
      } else {
        next(error);
      }
    }
  };
}

// Rate limiting with typed constraints
type RateLimitConfig<T extends string> = T extends '/api/v1/weather'
  ? { windowMs: 60000; max: 100 }
  : T extends '/api/v1/transactions'
    ? { windowMs: 60000; max: 10 }
    : T extends '/api/v1/nfts'
      ? { windowMs: 60000; max: 20 }
      : { windowMs: 60000; max: 50 };

export function createTypedRateLimit<T extends string>(
  route: T
): RateLimitConfig<T> {
  const configs = {
    '/api/v1/weather': { windowMs: 60000, max: 100 },
    '/api/v1/transactions': { windowMs: 60000, max: 10 },
    '/api/v1/nfts': { windowMs: 60000, max: 20 },
  } as const;

  return (configs[route as keyof typeof configs] || {
    windowMs: 60000,
    max: 50,
  }) as RateLimitConfig<T>;
}

// Permission-based middleware with role typing
type UserRole = 'admin' | 'validator' | 'contributor' | 'viewer';
type Permission = 'read' | 'write' | 'delete' | 'manage' | 'validate';

type RolePermissions = {
  admin: ['read', 'write', 'delete', 'manage', 'validate'];
  validator: ['read', 'write', 'validate'];
  contributor: ['read', 'write'];
  viewer: ['read'];
};

type UserPermissions<T extends UserRole> = RolePermissions[T][number];

export function requirePermission<T extends Permission>(permission: T) {
  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    if (!req.user.permissions?.includes(permission)) {
      res.status(403).json({
        success: false,
        error: `Permission '${permission}' required`,
        userRole: req.user.role,
        userPermissions: req.user.permissions,
      });
      return;
    }

    next();
  };
}

// Chain-specific validation middleware
export function validateChainOperation<
  T extends 'ethereum' | 'polygon' | 'bsc' | 'avalanche' | 'wrfcoin',
>(chainId: T) {
  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void => {
    const chainConfigs = {
      ethereum: { minGasPrice: '1000000000', maxGasLimit: 8000000 },
      polygon: { minGasPrice: '30000000000', maxGasLimit: 20000000 },
      bsc: { minGasPrice: '5000000000', maxGasLimit: 10000000 },
      avalanche: { minGasPrice: '25000000000', maxGasLimit: 8000000 },
      wrfcoin: { minGasPrice: '1000000000', maxGasLimit: 21000000 },
    };

    const config = chainConfigs[chainId];
    const transaction = req.body;

    // Chain-specific validation
    if (chainId === 'ethereum' || chainId === 'polygon') {
      if (!transaction.gasPrice || !transaction.gasLimit) {
        res.status(400).json({
          success: false,
          error: `Gas price and limit required for ${chainId}`,
          required: ['gasPrice', 'gasLimit'],
        });
        return;
      }

      if (parseInt(transaction.gasPrice, 10) < parseInt(config.minGasPrice, 10)) {
        res.status(400).json({
          success: false,
          error: `Gas price too low for ${chainId}`,
          minimum: config.minGasPrice,
        });
        return;
      }
    }

    if (chainId === 'wrfcoin') {
      // Validate Wrfcoin-specific fields
      if (
        transaction.type === 'computational' &&
        !transaction.computationalProof
      ) {
        res.status(400).json({
          success: false,
          error:
            'Computational proof required for Wrfcoin computational transactions',
        });
        return;
      }
    }

    next();
  };
}

// Data freshness validation with template literals
type TimeWindow = '1m' | '5m' | '15m' | '1h' | '24h';
type DataType = 'weather' | 'price' | 'gas' | 'network';

export function validateDataFreshness<T extends DataType>(
  dataType: T,
  maxAge: TimeWindow
) {
  const timeWindows = {
    '1m': 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
  };

  const maxAgeMs = timeWindows[maxAge];

  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void => {
    const data = req.body;

    if (!data.timestamp) {
      res.status(400).json({
        success: false,
        error: `Timestamp required for ${dataType} data`,
      });
      return;
    }

    const dataAge = Date.now() - new Date(data.timestamp).getTime();

    if (dataAge > maxAgeMs) {
      res.status(400).json({
        success: false,
        error: `${dataType} data too old`,
        maxAge: maxAge,
        dataAge: `${Math.round(dataAge / 1000)}s`,
        required: `Data must be newer than ${maxAge}`,
      });
      return;
    }

    next();
  };
}

// Composable middleware chain with type safety
export class MiddlewareChain {
  private middlewares: Array<
    (req: AuthenticatedRequest, res: Response, next: NextFunction) => void
  > = [];

  add(
    middleware: (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
    ) => void
  ): this {
    this.middlewares.push(middleware);
    return this;
  }

  addValidation<T extends string>(
    route: T,
    property: 'body' | 'query' | 'params' = 'body'
  ): this {
    this.middlewares.push(createAdvancedValidationMiddleware(route, property));
    return this;
  }

  addPermission<T extends Permission>(permission: T): this {
    this.middlewares.push(requirePermission(permission));
    return this;
  }

  addChainValidation<
    T extends 'ethereum' | 'polygon' | 'bsc' | 'avalanche' | 'wrfcoin',
  >(chainId: T): this {
    this.middlewares.push(validateChainOperation(chainId));
    return this;
  }

  addDataFreshness<T extends DataType>(dataType: T, maxAge: TimeWindow): this {
    this.middlewares.push(validateDataFreshness(dataType, maxAge));
    return this;
  }

  build(): Array<
    (req: AuthenticatedRequest, res: Response, next: NextFunction) => void
  > {
    return [...this.middlewares];
  }
}

// Export pre-configured middleware chains
export const weatherDataMiddleware = new MiddlewareChain()
  .addValidation('/api/v1/weather')
  .addPermission('write')
  .addDataFreshness('weather', '15m')
  .build();

export const transactionMiddleware = new MiddlewareChain()
  .addValidation('/api/v1/transactions')
  .addPermission('write')
  .build();

export const nftMiddleware = new MiddlewareChain()
  .addValidation('/api/v1/nfts')
  .addPermission('write')
  .build();

// Export individual validators for testing
export {
  WeatherValidationSchema,
  TransactionValidationSchema,
  NFTValidationSchema,
  UserValidationSchema,
};
