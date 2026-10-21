/**
 * Input Sanitizer and XSS Protection Utilities
 *
 * Provides comprehensive input validation and sanitization for API endpoints.
 * Implements XSS protection, SQL injection prevention, and type validation.
 *
 * @module input-sanitizer
 */

import validator from 'validator';
import { Request, Response, NextFunction, RequestHandler } from 'express';

// ============================================================================
// XSS Detection Patterns
// ============================================================================

/**
 * Comprehensive XSS attack patterns to detect malicious input.
 * These patterns cover common attack vectors including:
 * - Script injection
 * - Event handler injection
 * - Protocol-based attacks
 * - CSS expression attacks
 * - Data URI attacks
 */
const XSS_PATTERNS: RegExp[] = [
  // Script tags (including encoded variants)
  /<script[^>]*>[\s\S]*?<\/script>/gi,
  /<script[^>]*>/gi,
  /<\/script>/gi,

  // JavaScript protocol handlers
  /javascript\s*:/gi,
  /vbscript\s*:/gi,
  /livescript\s*:/gi,

  // Event handlers (on* attributes)
  /\bon\w+\s*=/gi,
  /\bon(abort|blur|change|click|dblclick|error|focus|keydown|keypress|keyup|load|mousedown|mousemove|mouseout|mouseover|mouseup|reset|resize|select|submit|unload)\s*=/gi,

  // Iframe injection
  /<iframe[^>]*>/gi,
  /<\/iframe>/gi,

  // Object/embed injection
  /<object[^>]*>/gi,
  /<embed[^>]*>/gi,
  /<applet[^>]*>/gi,

  // Form injection
  /<form[^>]*>/gi,

  // Meta tag injection (for redirects)
  /<meta[^>]*>/gi,

  // Base tag injection (URL hijacking)
  /<base[^>]*>/gi,

  // Link tag injection
  /<link[^>]*>/gi,

  // Style tag injection
  /<style[^>]*>[\s\S]*?<\/style>/gi,

  // SVG/XML-based XSS
  /<svg[^>]*>/gi,
  /<math[^>]*>/gi,

  // Expression/eval attacks
  /eval\s*\(/gi,
  /expression\s*\(/gi,
  /Function\s*\(/gi,
  /setTimeout\s*\(/gi,
  /setInterval\s*\(/gi,

  // Data URI attacks
  /data\s*:\s*text\/html/gi,
  /data\s*:\s*application\/javascript/gi,

  // CSS expression attacks
  /-moz-binding\s*:/gi,
  /behavior\s*:/gi,
  /binding\s*:/gi,

  // HTML entity encoded attacks (common encoded variants)
  /&#x3c;script/gi, // <script
  /&#60;script/gi, // <script
  /&#x3c;\/script/gi, // </script
  /&#60;\/script/gi, // </script

  // Null byte injection
  /\x00/g,
  /%00/g,

  // Template injection
  /\$\{[^}]*\}/g,
  /\{\{[^}]*\}\}/g,
];

/**
 * SQL injection patterns for additional security
 */
const SQL_INJECTION_PATTERNS: RegExp[] = [
  /('|")\s*(or|and)\s*('|"|\d)/gi,
  /;\s*(drop|delete|update|insert|alter|create|truncate)\s/gi,
  /union\s+select/gi,
  /--\s*$/gm,
  /\/\*[\s\S]*?\*\//g,
];

// ============================================================================
// Sanitization Functions
// ============================================================================

/**
 * Sanitizes a string input by escaping HTML entities and removing dangerous content.
 *
 * @param input - The string to sanitize
 * @returns Sanitized string with HTML entities escaped
 */
export function sanitizeString(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }

  // Trim whitespace
  let sanitized = input.trim();

  // Remove null bytes
  sanitized = sanitized.replace(/\0/g, '');
  sanitized = sanitized.replace(/%00/g, '');

  // HTML entity encoding using validator.escape
  sanitized = validator.escape(sanitized);

  return sanitized;
}

/**
 * Sanitizes a string for use in URLs.
 *
 * @param input - The URL string to sanitize
 * @returns Sanitized URL string
 */
export function sanitizeUrl(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }

  const trimmed = input.trim();

  // Block javascript: and data: protocols
  if (/^(javascript|data|vbscript):/i.test(trimmed)) {
    return '';
  }

  return trimmed;
}

/**
 * Detects potential XSS attacks in a string.
 *
 * @param input - The string to check for XSS patterns
 * @returns true if XSS patterns are detected, false otherwise
 */
export function detectXSS(input: string): boolean {
  if (typeof input !== 'string') {
    return false;
  }

  // Check against all XSS patterns
  return XSS_PATTERNS.some(pattern => {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
}

/**
 * Detects potential SQL injection attacks in a string.
 *
 * @param input - The string to check for SQL injection patterns
 * @returns true if SQL injection patterns are detected, false otherwise
 */
export function detectSQLInjection(input: string): boolean {
  if (typeof input !== 'string') {
    return false;
  }

  return SQL_INJECTION_PATTERNS.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
}

/**
 * Recursively sanitizes all string values in an object or array.
 *
 * @param obj - The object or value to sanitize
 * @param maxDepth - Maximum recursion depth (default: 10)
 * @returns Sanitized object with all string values escaped
 */
export function sanitizeObject<T>(obj: T, maxDepth: number = 10): T {
  if (maxDepth <= 0) {
    return obj;
  }

  if (typeof obj === 'string') {
    return sanitizeString(obj) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, maxDepth - 1)) as T;
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Also sanitize object keys
      const sanitizedKey = sanitizeString(key);
      result[sanitizedKey] = sanitizeObject(value, maxDepth - 1);
    }
    return result as T;
  }

  // Return non-object values as-is
  return obj;
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validates that a numeric value falls within a specified range.
 *
 * @param value - The value to validate
 * @param min - Minimum allowed value (inclusive)
 * @param max - Maximum allowed value (inclusive)
 * @returns The validated number or null if invalid
 */
export function validateNumericRange(
  value: unknown,
  min: number,
  max: number
): number | null {
  const num = Number(value);

  if (isNaN(num) || !isFinite(num)) {
    return null;
  }

  if (num < min || num > max) {
    return null;
  }

  return num;
}

/**
 * Validates that a value is one of the allowed enum values.
 *
 * @param value - The value to validate
 * @param allowed - Array of allowed values
 * @returns The validated value or null if not in allowed list
 */
export function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | null {
  if (typeof value !== 'string') {
    return null;
  }

  if (allowed.includes(value as T)) {
    return value as T;
  }

  return null;
}

/**
 * Validates that a string matches a given pattern.
 *
 * @param value - The string to validate
 * @param pattern - Regular expression pattern to match
 * @returns The validated string or null if no match
 */
export function validatePattern(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  if (pattern.test(value)) {
    return value;
  }

  return null;
}

/**
 * Validates a blockchain address format.
 *
 * @param address - The address to validate
 * @param type - The type of address (ethereum, cosmos, etc.)
 * @returns true if the address format is valid
 */
export function validateBlockchainAddress(
  address: unknown,
  type: 'ethereum' | 'cosmos' | 'polkadot' | 'generic' = 'generic'
): boolean {
  if (typeof address !== 'string') {
    return false;
  }

  const patterns: Record<string, RegExp> = {
    ethereum: /^0x[a-fA-F0-9]{40}$/,
    cosmos: /^[a-z]+1[a-z0-9]{38,58}$/,
    polkadot: /^[1-9A-HJ-NP-Za-km-z]{47,48}$/,
    generic: /^[a-zA-Z0-9]{20,100}$/,
  };

  const pattern = patterns[type] || patterns.generic;
  return pattern.test(address);
}

/**
 * Validates an NFT/Asset ID format.
 *
 * @param id - The ID to validate
 * @returns true if the ID format is valid
 */
export function validateAssetId(id: unknown): boolean {
  if (typeof id !== 'string') {
    return false;
  }

  // Allow alphanumeric IDs, hashes, and common formats
  return /^[a-zA-Z0-9_\-:]{1,128}$/.test(id);
}

/**
 * Validates a chain identifier.
 *
 * @param chain - The chain identifier to validate
 * @returns true if the chain identifier is valid
 */
export function validateChainId(chain: unknown): boolean {
  if (typeof chain !== 'string') {
    return false;
  }

  // Allow common chain ID formats
  return /^[a-zA-Z0-9_\-]{1,50}$/.test(chain);
}

// ============================================================================
// Validation Schema Types
// ============================================================================

/**
 * Schema field definition for validation.
 */
export interface ValidationField {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  enum?: readonly string[];
  pattern?: RegExp;
  validator?: (value: unknown) => boolean;
  sanitize?: boolean;
  properties?: ValidationSchema;
  items?: ValidationField;
}

/**
 * Validation schema definition.
 */
export type ValidationSchema = Record<string, ValidationField>;

/**
 * Validation error details.
 */
export interface ValidationError {
  field: string;
  message: string;
  value?: unknown;
}

/**
 * Validates a value against a schema field definition.
 *
 * @param value - The value to validate
 * @param field - The field definition
 * @param fieldName - The name of the field (for error messages)
 * @returns Array of validation errors (empty if valid)
 */
export function validateField(
  value: unknown,
  field: ValidationField,
  fieldName: string
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check required
  if (field.required && (value === undefined || value === null)) {
    errors.push({
      field: fieldName,
      message: `${fieldName} is required`,
    });
    return errors;
  }

  // Skip further validation if value is optional and not provided
  if (value === undefined || value === null) {
    return errors;
  }

  // Type validation
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push({
          field: fieldName,
          message: `${fieldName} must be a string`,
          value,
        });
        return errors;
      }

      // Check for XSS in strings
      if (detectXSS(value)) {
        errors.push({
          field: fieldName,
          message: `${fieldName} contains invalid characters`,
          value: '[REDACTED]',
        });
        return errors;
      }

      // Length validation
      if (field.minLength !== undefined && value.length < field.minLength) {
        errors.push({
          field: fieldName,
          message: `${fieldName} must be at least ${field.minLength} characters`,
        });
      }

      if (field.maxLength !== undefined && value.length > field.maxLength) {
        errors.push({
          field: fieldName,
          message: `${fieldName} must be at most ${field.maxLength} characters`,
        });
      }

      // Enum validation
      if (field.enum && !field.enum.includes(value)) {
        errors.push({
          field: fieldName,
          message: `${fieldName} must be one of: ${field.enum.join(', ')}`,
          value,
        });
      }

      // Pattern validation
      if (field.pattern && !field.pattern.test(value)) {
        errors.push({
          field: fieldName,
          message: `${fieldName} has invalid format`,
          value,
        });
      }
      break;

    case 'number':
      const numValue = typeof value === 'number' ? value : Number(value);
      if (isNaN(numValue) || !isFinite(numValue)) {
        errors.push({
          field: fieldName,
          message: `${fieldName} must be a valid number`,
          value,
        });
        return errors;
      }

      if (field.min !== undefined && numValue < field.min) {
        errors.push({
          field: fieldName,
          message: `${fieldName} must be at least ${field.min}`,
          value: numValue,
        });
      }

      if (field.max !== undefined && numValue > field.max) {
        errors.push({
          field: fieldName,
          message: `${fieldName} must be at most ${field.max}`,
          value: numValue,
        });
      }
      break;

    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push({
          field: fieldName,
          message: `${fieldName} must be a boolean`,
          value,
        });
      }
      break;

    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push({
          field: fieldName,
          message: `${fieldName} must be an object`,
          value,
        });
        return errors;
      }

      // Validate nested properties
      if (field.properties) {
        const nestedErrors = validateAgainstSchema(
          value as Record<string, unknown>,
          field.properties
        );
        errors.push(
          ...nestedErrors.map(e => ({
            ...e,
            field: `${fieldName}.${e.field}`,
          }))
        );
      }
      break;

    case 'array':
      if (!Array.isArray(value)) {
        errors.push({
          field: fieldName,
          message: `${fieldName} must be an array`,
          value,
        });
        return errors;
      }

      // Validate array items
      if (field.items) {
        value.forEach((item, index) => {
          const itemErrors = validateField(item, field.items!, `${fieldName}[${index}]`);
          errors.push(...itemErrors);
        });
      }
      break;
  }

  // Custom validator
  if (field.validator && !field.validator(value)) {
    errors.push({
      field: fieldName,
      message: `${fieldName} failed custom validation`,
      value,
    });
  }

  return errors;
}

/**
 * Validates data against a schema definition.
 *
 * @param data - The data object to validate
 * @param schema - The validation schema
 * @returns Array of validation errors (empty if valid)
 */
export function validateAgainstSchema(
  data: Record<string, unknown>,
  schema: ValidationSchema
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check all schema fields
  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    const value = data[fieldName];
    const fieldErrors = validateField(value, fieldDef, fieldName);
    errors.push(...fieldErrors);
  }

  return errors;
}

// ============================================================================
// Express Middleware Factory
// ============================================================================

/**
 * Options for validation middleware.
 */
export interface ValidationMiddlewareOptions {
  /** Whether to sanitize string inputs after validation */
  sanitize?: boolean;
  /** Whether to block requests with XSS patterns */
  blockXSS?: boolean;
  /** Custom error handler */
  onError?: (errors: ValidationError[], req: Request, res: Response) => void;
}

/**
 * Creates an Express middleware for request body validation.
 *
 * @param schema - The validation schema for request body
 * @param options - Middleware options
 * @returns Express middleware function
 */
export function createValidationMiddleware(
  schema: ValidationSchema,
  options: ValidationMiddlewareOptions = {}
): RequestHandler {
  const { sanitize = true, blockXSS = true, onError } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Check for XSS in the raw body
    if (blockXSS && req.body) {
      const bodyString = JSON.stringify(req.body);
      if (detectXSS(bodyString)) {
        const errorResponse = {
          error: 'Validation failed',
          details: [
            {
              field: 'body',
              message: 'Request contains invalid characters',
            },
          ],
        };

        if (onError) {
          onError([{ field: 'body', message: 'Invalid characters detected' }], req, res);
          return;
        }

        res.status(400).json(errorResponse);
        return;
      }
    }

    // Validate body against schema
    const errors = validateAgainstSchema(req.body || {}, schema);

    if (errors.length > 0) {
      if (onError) {
        onError(errors, req, res);
        return;
      }

      res.status(400).json({
        error: 'Validation failed',
        details: errors.map(e => ({
          field: e.field,
          message: e.message,
        })),
      });
      return;
    }

    // Sanitize all string inputs if enabled
    if (sanitize && req.body) {
      req.body = sanitizeObject(req.body);
    }

    next();
  };
}

/**
 * Creates a simple XSS detection middleware.
 *
 * @returns Express middleware function that blocks XSS attempts
 */
export function xssProtectionMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Check body
    if (req.body && detectXSS(JSON.stringify(req.body))) {
      res.status(400).json({
        error: 'Invalid characters detected in request body',
      });
      return;
    }

    // Check query parameters
    if (req.query) {
      const queryString = Object.values(req.query).join(' ');
      if (detectXSS(queryString)) {
        res.status(400).json({
          error: 'Invalid characters detected in query parameters',
        });
        return;
      }
    }

    next();
  };
}

/**
 * Creates a sanitization middleware that sanitizes all inputs.
 *
 * @returns Express middleware function
 */
export function sanitizationMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.body) {
      req.body = sanitizeObject(req.body);
    }

    if (req.query) {
      req.query = sanitizeObject(req.query as Record<string, unknown>) as typeof req.query;
    }

    if (req.params) {
      req.params = sanitizeObject(req.params);
    }

    next();
  };
}

// ============================================================================
// Pre-built Validation Schemas for Common Use Cases
// ============================================================================

/**
 * Common validation schema for cross-chain transfer requests.
 */
export const CrossChainTransferSchema: ValidationSchema = {
  assetId: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 128,
    validator: validateAssetId,
  },
  assetType: {
    type: 'string',
    required: false,
    maxLength: 50,
  },
  sourceChain: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 50,
    validator: validateChainId,
  },
  destinationChain: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 50,
    validator: validateChainId,
  },
  destinationAddress: {
    type: 'string',
    required: true,
    minLength: 10,
    maxLength: 100,
  },
  metadata: {
    type: 'object',
    required: false,
  },
};

/**
 * Common validation schema for bridge fee estimation.
 */
export const BridgeFeeEstimateSchema: ValidationSchema = {
  bridgeId: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 50,
    pattern: /^[a-zA-Z0-9\-_]+$/,
  },
  amount: {
    type: 'number',
    required: true,
    min: 0,
  },
  sourceChain: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 50,
  },
  destChain: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 50,
  },
};

/**
 * Common validation schema for compute task submission.
 */
export const ComputeTaskSchema: ValidationSchema = {
  taskType: {
    type: 'string',
    required: true,
    enum: [
      'machine-learning',
      'data-processing',
      'scientific-computation',
      'rendering',
    ] as const,
  },
  priority: {
    type: 'string',
    required: false,
    enum: ['low', 'medium', 'high'] as const,
  },
  resourceRequirements: {
    type: 'object',
    required: false,
    properties: {
      cpu: { type: 'number', min: 1, max: 128 },
      memory: { type: 'number', min: 1, max: 512 },
      gpu: { type: 'boolean' },
    },
  },
};

/**
 * Common validation schema for AI/ML inference requests.
 */
export const AIInferenceSchema: ValidationSchema = {
  model: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 100,
  },
  input_data: {
    type: 'object',
    required: true,
  },
  prediction_horizon: {
    type: 'string',
    required: false,
    maxLength: 20,
  },
};

/**
 * Common validation schema for AI/ML training requests.
 */
export const AITrainingSchema: ValidationSchema = {
  model_type: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 100,
  },
  training_data: {
    type: 'object',
    required: true,
  },
  parameters: {
    type: 'object',
    required: false,
  },
};

// ============================================================================
// Export Types
// ============================================================================

export type {
  ValidationField as ValidationFieldType,
  ValidationSchema as ValidationSchemaType,
  ValidationError as ValidationErrorType,
  ValidationMiddlewareOptions as ValidationMiddlewareOptionsType,
};
