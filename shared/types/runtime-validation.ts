/**
 * Runtime Validation with Advanced TypeScript
 *
 * Combines compile-time type safety with runtime validation
 * using advanced TypeScript features like template literals,
 * conditional types, and type predicates.
 */

import { z } from 'zod';

// 1. RUNTIME TYPE VALIDATION with Zod Integration
export const WeatherDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('temperature'),
    id: z.string(),
    stationId: z.string(),
    timestamp: z.date(),
    quality: z.enum(['high', 'medium', 'low']),
    value: z.number().min(-50).max(60), // Reasonable temperature range
    unit: z.literal('°C'),
    dewPoint: z.number().optional(),
  }),
  z.object({
    type: z.literal('humidity'),
    id: z.string(),
    stationId: z.string(),
    timestamp: z.date(),
    quality: z.enum(['high', 'medium', 'low']),
    value: z.number().min(0).max(100),
    unit: z.literal('%'),
    relativeHumidity: z.number(),
  }),
  z.object({
    type: z.literal('pressure'),
    id: z.string(),
    stationId: z.string(),
    timestamp: z.date(),
    quality: z.enum(['high', 'medium', 'low']),
    value: z.number().min(800).max(1200), // hPa range
    unit: z.literal('hPa'),
    seaLevelPressure: z.number().optional(),
  }),
]);

export type WeatherData = z.infer<typeof WeatherDataSchema>;

// 2. BRANDED TYPES with Runtime Validation
const WalletAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const TransactionHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const TokenAmountSchema = z.string().regex(/^\d+(\.\d+)?$/);

export type WalletAddress = z.infer<typeof WalletAddressSchema> & {
  readonly __brand: 'WalletAddress';
};
export type TransactionHash = z.infer<typeof TransactionHashSchema> & {
  readonly __brand: 'TransactionHash';
};
export type TokenAmount = z.infer<typeof TokenAmountSchema> & {
  readonly __brand: 'TokenAmount';
};

// Factory functions for branded types
export function createWalletAddress(address: string): WalletAddress {
  return WalletAddressSchema.parse(address) as WalletAddress;
}

export function createTransactionHash(hash: string): TransactionHash {
  return TransactionHashSchema.parse(hash) as TransactionHash;
}

export function createTokenAmount(amount: string): TokenAmount {
  return TokenAmountSchema.parse(amount) as TokenAmount;
}

// 3. CONDITIONAL VALIDATION based on Context
type ValidationContext = 'development' | 'production' | 'testing';

interface ValidationOptions<T extends ValidationContext> {
  context: T;
  strict: T extends 'production' ? true : boolean;
  allowMockData: T extends 'testing' ? true : false;
}

export class ContextualValidator<T extends ValidationContext> {
  constructor(private options: ValidationOptions<T>) {}

  validateWeatherData(data: unknown): WeatherData {
    if (this.options.context === 'testing' && this.options.allowMockData) {
      // Allow mock data patterns in testing
      return this.validateMockWeatherData(data);
    }

    if (this.options.context === 'production' && this.options.strict) {
      // Stricter validation in production
      return this.validateProductionWeatherData(data);
    }

    return WeatherDataSchema.parse(data);
  }

  private validateMockWeatherData(data: unknown): WeatherData {
    // Allow test patterns like 'test-station-id' in testing
    const result = WeatherDataSchema.parse(data);

    // Additional test validation for stationId
    if (
      typeof result.stationId === 'string' &&
      !result.stationId.match(/^(test-|real-).+/)
    ) {
      throw new Error(
        'Test data must have stationId starting with "test-" or "real-"'
      );
    }

    return result;
  }

  private validateProductionWeatherData(data: unknown): WeatherData {
    // Additional production checks
    const result = WeatherDataSchema.parse(data);

    // Ensure data is recent (within last 24 hours)
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (result.timestamp < dayAgo) {
      throw new Error('Weather data is too old for production use');
    }

    return result;
  }
}

// 4. TYPE-SAFE API RESPONSE VALIDATION
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
  metadata?: {
    timestamp: Date;
    requestId: string;
    version: string;
  };
}

export function createApiResponseSchema<T>(dataSchema: z.ZodSchema<T>) {
  return z.object({
    success: z.boolean(),
    data: dataSchema,
    error: z.string().optional(),
    metadata: z
      .object({
        timestamp: z.date(),
        requestId: z.string(),
        version: z.string(),
      })
      .optional(),
  });
}

// 5. PIPELINE VALIDATION with Transformations
export class ValidationPipeline<TInput, TOutput> {
  private steps: Array<(input: any) => any> = [];

  addStep<TNext>(
    fn: (input: TInput) => TNext
  ): ValidationPipeline<TInput, TNext> {
    this.steps.push(fn);
    return this as any;
  }

  addValidation<T>(schema: z.ZodSchema<T>): ValidationPipeline<TInput, T> {
    this.steps.push(input => schema.parse(input));
    return this as any;
  }

  addTransform<T>(fn: (input: TOutput) => T): ValidationPipeline<TInput, T> {
    this.steps.push(fn);
    return this as any;
  }

  execute(input: TInput): TOutput {
    return this.steps.reduce((acc, step) => step(acc), input as any);
  }
}

// 6. SCHEMA COMPOSITION for Complex Types
export const BlockchainTransactionSchema = z.object({
  id: z.string(),
  hash: TransactionHashSchema,
  from: WalletAddressSchema,
  to: WalletAddressSchema,
  amount: TokenAmountSchema,
  chainId: z.enum(['ethereum', 'polygon', 'bsc', 'avalanche', 'wrfcoin']),
  status: z.enum(['pending', 'confirmed', 'failed', 'rejected']),
  timestamp: z.date(),
  gasPrice: z.string().optional(),
  gasLimit: z.number().optional(),
  blockNumber: z.number().optional(),
});

export const ComputationalNFTSchema = z.object({
  tokenId: z.string(),
  name: z.string(),
  description: z.string(),
  owner: WalletAddressSchema,
  creator: WalletAddressSchema,
  metadata: z.object({
    attributes: z.array(
      z.object({
        trait_type: z.string(),
        value: z.union([z.string(), z.number()]),
        display_type: z
          .enum(['boost_number', 'boost_percentage', 'number', 'date'])
          .optional(),
      })
    ),
    computationResults: z.record(z.string(), z.any()).optional(),
    weatherDataUsed: z.array(WeatherDataSchema).optional(),
  }),
  mintTransaction: BlockchainTransactionSchema,
  computationCompleted: z.boolean(),
  qualityScore: z.number().min(0).max(100),
});

export type BlockchainTransaction = z.infer<typeof BlockchainTransactionSchema>;
export type ComputationalNFT = z.infer<typeof ComputationalNFTSchema>;

// 7. ERROR HANDLING with Typed Errors
export class ValidationError extends Error {
  constructor(
    message: string,
    public field: string,
    public value: unknown,
    public code: string
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class TypedValidator {
  static validateWeatherData(data: unknown): WeatherData {
    try {
      return WeatherDataSchema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const firstError = error.issues[0];
        throw new ValidationError(
          `Invalid weather data: ${firstError.message}`,
          firstError.path.join('.'),
          data,
          'WEATHER_VALIDATION_ERROR'
        );
      }
      throw error;
    }
  }

  static validateTransaction(data: unknown): BlockchainTransaction {
    try {
      return BlockchainTransactionSchema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const firstError = error.issues[0];
        throw new ValidationError(
          `Invalid transaction: ${firstError.message}`,
          firstError.path.join('.'),
          data,
          'TRANSACTION_VALIDATION_ERROR'
        );
      }
      throw error;
    }
  }

  static validateNFT(data: unknown): ComputationalNFT {
    try {
      return ComputationalNFTSchema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const firstError = error.issues[0];
        throw new ValidationError(
          `Invalid NFT: ${firstError.message}`,
          firstError.path.join('.'),
          data,
          'NFT_VALIDATION_ERROR'
        );
      }
      throw error;
    }
  }
}

// 8. MIDDLEWARE FACTORY for Express with Type Safety
export function createValidationMiddleware<T>(schema: z.ZodSchema<T>) {
  return (property: 'body' | 'query' | 'params') => {
    return (req: any, res: any, next: any) => {
      try {
        req[property] = schema.parse(req[property]);
        next();
      } catch (error) {
        if (error instanceof z.ZodError) {
          res.status(400).json({
            success: false,
            error: 'Validation error',
            details: error.issues,
          });
        } else {
          next(error);
        }
      }
    };
  };
}

// Usage examples:
// export const validateWeatherDataBody = createValidationMiddleware(WeatherDataSchema)('body');
// export const validateTransactionParams = createValidationMiddleware(BlockchainTransactionSchema)('params');
