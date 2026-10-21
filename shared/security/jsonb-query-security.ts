/**
 * JSONB Query Security Module
 * Task 104.2: NoSQL/JSONB Injection Prevention
 *
 * Provides comprehensive security for JSONB queries in PostgreSQL,
 * including path validation, operator whitelisting, and injection detection.
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface JSONBSecurityResult {
  isValid: boolean;
  sanitizedPath?: string;
  errors: string[];
  warnings: string[];
  riskScore: number;
}

export interface JSONBQueryContext {
  entityType: string;
  userId?: string;
  ipAddress?: string;
  queryPath: string;
  operator?: string;
  value?: unknown;
}

export interface JSONBSecurityEvent {
  eventType: 'JSONB_PATH_INJECTION' | 'OPERATOR_ABUSE' | 'PROTOTYPE_POLLUTION' | 'SUSPICIOUS_PATTERN';
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  context: JSONBQueryContext;
  timestamp: Date;
  blocked: boolean;
}

// ============================================================================
// Dangerous Patterns
// ============================================================================

/**
 * Patterns that could lead to prototype pollution or security issues
 */
const DANGEROUS_PATH_PATTERNS: RegExp[] = [
  // Prototype pollution attempts
  /\$\.constructor/gi,
  /\$\.__proto__/gi,
  /\$\.prototype/gi,
  /__proto__/gi,
  /constructor\s*\[/gi,
  /prototype\s*\[/gi,

  // Path traversal attempts
  /\.\.\//g,
  /\.\.\\/g,

  // JavaScript execution attempts
  /\beval\s*\(/gi,
  /\bfunction\s*\(/gi,
  /\bnew\s+Function/gi,

  // SQL injection in JSONB paths
  /'\s*(or|and)\s*'/gi,
  /;\s*drop/gi,
  /union\s+select/gi,

  // Command injection attempts
  /\$\(/g,
  /`[^`]*`/g,
  /\|\|/g,

  // NoSQL injection patterns
  /\$where/gi,
  /\$regex/gi,
  /\$gt\s*:/gi,
  /\$lt\s*:/gi,
  /\$ne\s*:/gi,
  /\$nin\s*:/gi,
  /\$or\s*:/gi,
  /\$and\s*:/gi,

  // PostgreSQL-specific JSONB injection
  /\bto_jsonb\s*\(/gi,
  /\bjsonb_build_object\s*\(/gi,
  /\bjsonb_agg\s*\(/gi,
  /\bjsonb_set\s*\(/gi,
  /\bjson_populate_record/gi,
];

/**
 * Valid JSONB path segment pattern
 * Allows alphanumeric, underscore, hyphen, and array indices
 */
const VALID_PATH_SEGMENT_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$|^\d+$/;

/**
 * Maximum path depth to prevent resource exhaustion
 */
const MAX_PATH_DEPTH = 10;

/**
 * Maximum path length to prevent buffer issues
 */
const MAX_PATH_LENGTH = 500;

// ============================================================================
// Allowed JSONB Operators
// ============================================================================

/**
 * Whitelisted JSONB operators for PostgreSQL
 */
const ALLOWED_JSONB_OPERATORS = new Set([
  '->', // Get JSON object field as JSON
  '->>', // Get JSON object field as text
  '#>', // Get JSON object at path as JSON
  '#>>', // Get JSON object at path as text
  '@>', // Contains (left contains right)
  '<@', // Is contained by
  '?', // Key exists
  '?|', // Any key exists
  '?&', // All keys exist
  '||', // Concatenate (careful - also string concat)
  '-', // Delete key
  '#-', // Delete at path
  '@?', // JSON path exists
  '@@', // JSON path match
]);

/**
 * Operators that require elevated permissions
 */
const PRIVILEGED_OPERATORS = new Set([
  '||', // Can be used for injection if not careful
  '-', // Modifying data
  '#-', // Modifying nested data
  'jsonb_set',
  'jsonb_insert',
  'jsonb_delete_path',
]);

// ============================================================================
// Security Functions
// ============================================================================

/**
 * Check for dangerous JSONB path patterns
 */
export function detectJSONBInjection(path: string): {
  detected: boolean;
  patterns: string[];
  riskScore: number;
} {
  if (typeof path !== 'string') {
    return { detected: false, patterns: [], riskScore: 0 };
  }

  const detectedPatterns: string[] = [];
  let riskScore = 0;

  for (const pattern of DANGEROUS_PATH_PATTERNS) {
    pattern.lastIndex = 0; // Reset regex state
    if (pattern.test(path)) {
      detectedPatterns.push(pattern.source);
      // Increase risk based on pattern severity
      if (pattern.source.includes('proto') || pattern.source.includes('constructor')) {
        riskScore += 50; // Critical
      } else if (pattern.source.includes('where') || pattern.source.includes('drop')) {
        riskScore += 40; // High
      } else {
        riskScore += 20; // Medium
      }
    }
  }

  return {
    detected: detectedPatterns.length > 0,
    patterns: detectedPatterns,
    riskScore: Math.min(100, riskScore),
  };
}

/**
 * Validate a JSONB path string
 */
export function validateJSONBPath(path: string): JSONBSecurityResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let riskScore = 0;

  // Type check
  if (typeof path !== 'string') {
    return {
      isValid: false,
      errors: ['JSONB path must be a string'],
      warnings: [],
      riskScore: 100,
    };
  }

  // Length check
  if (path.length > MAX_PATH_LENGTH) {
    errors.push(`JSONB path exceeds maximum length of ${MAX_PATH_LENGTH} characters`);
    riskScore += 30;
  }

  // Empty check
  if (path.trim().length === 0) {
    errors.push('JSONB path cannot be empty');
    return { isValid: false, errors, warnings, riskScore: 50 };
  }

  // Check for injection patterns
  const injectionCheck = detectJSONBInjection(path);
  if (injectionCheck.detected) {
    errors.push('JSONB path contains potentially dangerous patterns');
    riskScore = Math.max(riskScore, injectionCheck.riskScore);
  }

  // Parse and validate path segments
  // Handle both dot notation (a.b.c) and bracket notation (a[0].b)
  const normalizedPath = path
    .replace(/\[(\d+)\]/g, '.$1') // Convert array indices to dot notation
    .replace(/^\$\.?/, ''); // Remove leading $ or $.

  const segments = normalizedPath.split('.');

  // Check depth
  if (segments.length > MAX_PATH_DEPTH) {
    errors.push(`JSONB path depth exceeds maximum of ${MAX_PATH_DEPTH} levels`);
    riskScore += 20;
  }

  // Validate each segment
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (segment.length === 0) {
      if (i === 0 && path.startsWith('.')) {
        errors.push('JSONB path cannot start with a dot');
      } else {
        errors.push('JSONB path contains empty segments');
      }
      continue;
    }

    if (!VALID_PATH_SEGMENT_PATTERN.test(segment)) {
      errors.push(`Invalid path segment at position ${i}: "${segment}"`);
      riskScore += 10;
    }

    // Check for reserved keywords that might be suspicious
    const lowerSegment = segment.toLowerCase();
    if (['password', 'secret', 'key', 'token', 'credential'].includes(lowerSegment)) {
      warnings.push(`Path segment "${segment}" may access sensitive data`);
      riskScore += 5;
    }
  }

  // Build sanitized path
  const sanitizedPath = segments
    .filter(s => s.length > 0 && VALID_PATH_SEGMENT_PATTERN.test(s))
    .join('.');

  return {
    isValid: errors.length === 0,
    sanitizedPath: errors.length === 0 ? sanitizedPath : undefined,
    errors,
    warnings,
    riskScore,
  };
}

/**
 * Validate a JSONB operator
 */
export function validateJSONBOperator(
  operator: string,
  requirePrivileged: boolean = false
): {
  isValid: boolean;
  isPrivileged: boolean;
  error?: string;
} {
  if (typeof operator !== 'string') {
    return {
      isValid: false,
      isPrivileged: false,
      error: 'Operator must be a string',
    };
  }

  const normalizedOperator = operator.trim();

  if (!ALLOWED_JSONB_OPERATORS.has(normalizedOperator)) {
    return {
      isValid: false,
      isPrivileged: false,
      error: `Operator "${operator}" is not in the allowlist`,
    };
  }

  const isPrivileged = PRIVILEGED_OPERATORS.has(normalizedOperator);

  if (isPrivileged && !requirePrivileged) {
    return {
      isValid: false,
      isPrivileged: true,
      error: `Operator "${operator}" requires elevated privileges`,
    };
  }

  return {
    isValid: true,
    isPrivileged,
  };
}

/**
 * Validate JSONB query value
 */
export function validateJSONBValue(value: unknown): {
  isValid: boolean;
  sanitizedValue?: unknown;
  error?: string;
} {
  // Null and undefined are valid JSONB values
  if (value === null || value === undefined) {
    return { isValid: true, sanitizedValue: null };
  }

  // Check primitive types
  if (typeof value === 'string') {
    // Check for injection attempts in string values
    const injectionCheck = detectJSONBInjection(value);
    if (injectionCheck.detected && injectionCheck.riskScore > 30) {
      return {
        isValid: false,
        error: 'String value contains potentially dangerous patterns',
      };
    }
    return { isValid: true, sanitizedValue: value };
  }

  if (typeof value === 'number') {
    if (!isFinite(value)) {
      return { isValid: false, error: 'Numeric value must be finite' };
    }
    return { isValid: true, sanitizedValue: value };
  }

  if (typeof value === 'boolean') {
    return { isValid: true, sanitizedValue: value };
  }

  // Check arrays
  if (Array.isArray(value)) {
    if (value.length > 1000) {
      return { isValid: false, error: 'Array value exceeds maximum length of 1000' };
    }
    const sanitizedArray: unknown[] = [];
    for (const item of value) {
      const itemResult = validateJSONBValue(item);
      if (!itemResult.isValid) {
        return itemResult;
      }
      sanitizedArray.push(itemResult.sanitizedValue);
    }
    return { isValid: true, sanitizedValue: sanitizedArray };
  }

  // Check objects
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > 100) {
      return { isValid: false, error: 'Object value exceeds maximum of 100 keys' };
    }

    const sanitizedObject: Record<string, unknown> = {};
    for (const key of keys) {
      // Validate key
      const keyCheck = detectJSONBInjection(key);
      if (keyCheck.detected) {
        return { isValid: false, error: `Object key "${key}" contains dangerous patterns` };
      }

      // Validate value recursively
      const valueResult = validateJSONBValue((value as Record<string, unknown>)[key]);
      if (!valueResult.isValid) {
        return valueResult;
      }
      sanitizedObject[key] = valueResult.sanitizedValue;
    }
    return { isValid: true, sanitizedValue: sanitizedObject };
  }

  return { isValid: false, error: `Unsupported value type: ${typeof value}` };
}

/**
 * Comprehensive JSONB query validation
 */
export function validateJSONBQuery(
  context: JSONBQueryContext,
  allowedPaths?: Set<string>
): JSONBSecurityResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let totalRiskScore = 0;

  // Validate path
  const pathResult = validateJSONBPath(context.queryPath);
  if (!pathResult.isValid) {
    errors.push(...pathResult.errors);
    totalRiskScore = Math.max(totalRiskScore, pathResult.riskScore);
  }
  warnings.push(...pathResult.warnings);

  // Check against allowlist if provided
  if (allowedPaths && pathResult.sanitizedPath) {
    const isAllowed = checkPathAgainstAllowlist(pathResult.sanitizedPath, allowedPaths);
    if (!isAllowed) {
      errors.push(`Path "${context.queryPath}" is not in the allowlist for ${context.entityType}`);
      totalRiskScore += 30;
    }
  }

  // Validate operator if present
  if (context.operator) {
    const operatorResult = validateJSONBOperator(context.operator);
    if (!operatorResult.isValid) {
      errors.push(operatorResult.error!);
      totalRiskScore += operatorResult.isPrivileged ? 40 : 20;
    }
  }

  // Validate value if present
  if (context.value !== undefined) {
    const valueResult = validateJSONBValue(context.value);
    if (!valueResult.isValid) {
      errors.push(valueResult.error!);
      totalRiskScore += 20;
    }
  }

  return {
    isValid: errors.length === 0,
    sanitizedPath: pathResult.sanitizedPath,
    errors,
    warnings,
    riskScore: Math.min(100, totalRiskScore),
  };
}

/**
 * Check if a path matches against an allowlist (with wildcard support)
 */
export function checkPathAgainstAllowlist(path: string, allowedPaths: Set<string>): boolean {
  // Direct match
  if (allowedPaths.has(path)) {
    return true;
  }

  // Check wildcard patterns
  for (const allowedPath of allowedPaths) {
    if (allowedPath.endsWith('.*')) {
      // Prefix match (e.g., "measurements.*" matches "measurements.temperature")
      const prefix = allowedPath.slice(0, -2);
      if (path.startsWith(prefix + '.') || path === prefix) {
        return true;
      }
    } else if (allowedPath.includes('*')) {
      // Convert glob pattern to regex
      const regexPattern = allowedPath
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^.]+');
      const regex = new RegExp(`^${regexPattern}$`);
      if (regex.test(path)) {
        return true;
      }
    }
  }

  return false;
}

// ============================================================================
// Express Middleware
// ============================================================================

/**
 * Security event handler type
 */
export type SecurityEventHandler = (event: JSONBSecurityEvent) => void | Promise<void>;

/**
 * JSONB security middleware options
 */
export interface JSONBSecurityMiddlewareOptions {
  /** Entity type being queried */
  entityType: string;
  /** Field names in request body that contain JSONB paths */
  pathFields?: string[];
  /** Field names in query params that contain JSONB paths */
  queryPathFields?: string[];
  /** Allowed paths for this entity type */
  allowedPaths?: Set<string>;
  /** Custom security event handler */
  onSecurityEvent?: SecurityEventHandler;
  /** Block requests with high risk scores */
  blockHighRisk?: boolean;
  /** Risk score threshold for blocking (default: 50) */
  riskThreshold?: number;
}

/**
 * Create JSONB security middleware
 */
export function createJSONBSecurityMiddleware(
  options: JSONBSecurityMiddlewareOptions
): RequestHandler {
  const {
    entityType,
    pathFields = ['path', 'jsonb_path', 'field'],
    queryPathFields = ['path', 'field', 'filter'],
    allowedPaths,
    onSecurityEvent,
    blockHighRisk = true,
    riskThreshold = 50,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const errors: string[] = [];
    const warnings: string[] = [];
    let maxRiskScore = 0;

    // Check body fields
    if (req.body) {
      for (const field of pathFields) {
        const pathValue = req.body[field];
        if (pathValue) {
          const context: JSONBQueryContext = {
            entityType,
            userId: (req as any).user?.id,
            ipAddress: req.ip,
            queryPath: pathValue,
            operator: req.body.operator,
            value: req.body.value,
          };

          const result = validateJSONBQuery(context, allowedPaths);
          if (!result.isValid) {
            errors.push(...result.errors);
            if (onSecurityEvent) {
              await onSecurityEvent({
                eventType: 'JSONB_PATH_INJECTION',
                severity: result.riskScore >= 50 ? 'CRITICAL' : 'WARNING',
                context,
                timestamp: new Date(),
                blocked: blockHighRisk && result.riskScore >= riskThreshold,
              });
            }
          }
          warnings.push(...result.warnings);
          maxRiskScore = Math.max(maxRiskScore, result.riskScore);

          // Update body with sanitized path
          if (result.sanitizedPath) {
            req.body[field] = result.sanitizedPath;
          }
        }
      }
    }

    // Check query params
    if (req.query) {
      for (const field of queryPathFields) {
        const pathValue = req.query[field];
        if (typeof pathValue === 'string') {
          const context: JSONBQueryContext = {
            entityType,
            userId: (req as any).user?.id,
            ipAddress: req.ip,
            queryPath: pathValue,
          };

          const result = validateJSONBQuery(context, allowedPaths);
          if (!result.isValid) {
            errors.push(...result.errors);
            if (onSecurityEvent) {
              await onSecurityEvent({
                eventType: 'JSONB_PATH_INJECTION',
                severity: result.riskScore >= 50 ? 'CRITICAL' : 'WARNING',
                context,
                timestamp: new Date(),
                blocked: blockHighRisk && result.riskScore >= riskThreshold,
              });
            }
          }
          warnings.push(...result.warnings);
          maxRiskScore = Math.max(maxRiskScore, result.riskScore);

          // Update query with sanitized path
          if (result.sanitizedPath) {
            req.query[field] = result.sanitizedPath;
          }
        }
      }
    }

    // Block if risk is too high
    if (blockHighRisk && maxRiskScore >= riskThreshold) {
      res.status(400).json({
        success: false,
        error: 'JSONB query validation failed',
        details: errors,
      });
      return;
    }

    // Add warnings to response headers for debugging (in non-production)
    if (warnings.length > 0 && process.env.NODE_ENV !== 'production') {
      res.setHeader('X-JSONB-Security-Warnings', warnings.join('; '));
    }

    next();
  };
}

/**
 * Simple JSONB path validation middleware
 */
export function validateJSONBPathMiddleware(
  paramName: string = 'path'
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const pathValue = req.params[paramName] || req.query[paramName] || req.body?.[paramName];

    if (!pathValue) {
      next();
      return;
    }

    if (typeof pathValue !== 'string') {
      res.status(400).json({
        success: false,
        error: 'JSONB path must be a string',
      });
      return;
    }

    const result = validateJSONBPath(pathValue);

    if (!result.isValid) {
      res.status(400).json({
        success: false,
        error: 'Invalid JSONB path',
        details: result.errors,
      });
      return;
    }

    // Store sanitized path for use in handlers
    (req as any).sanitizedJSONBPath = result.sanitizedPath;
    next();
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Build a safe JSONB path expression for PostgreSQL
 */
export function buildSafeJSONBPath(
  column: string,
  path: string,
  asText: boolean = true
): string | null {
  // Validate column name
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
    return null;
  }

  // Validate path
  const result = validateJSONBPath(path);
  if (!result.isValid || !result.sanitizedPath) {
    return null;
  }

  const segments = result.sanitizedPath.split('.');
  const operator = asText ? '->>' : '->';

  if (segments.length === 1) {
    return `${column}${operator}'${segments[0]}'`;
  }

  // Build path with proper operators
  let expression = column;
  for (let i = 0; i < segments.length - 1; i++) {
    expression += `->'${segments[i]}'`;
  }
  expression += `${operator}'${segments[segments.length - 1]}'`;

  return expression;
}

/**
 * Build a safe JSONB containment query
 */
export function buildSafeJSONBContains(
  column: string,
  value: Record<string, unknown>
): { expression: string; params: unknown[] } | null {
  // Validate column name
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
    return null;
  }

  // Validate value
  const valueResult = validateJSONBValue(value);
  if (!valueResult.isValid) {
    return null;
  }

  return {
    expression: `${column} @> $1::jsonb`,
    params: [JSON.stringify(valueResult.sanitizedValue)],
  };
}

// ============================================================================
// Export
// ============================================================================

export default {
  detectJSONBInjection,
  validateJSONBPath,
  validateJSONBOperator,
  validateJSONBValue,
  validateJSONBQuery,
  checkPathAgainstAllowlist,
  createJSONBSecurityMiddleware,
  validateJSONBPathMiddleware,
  buildSafeJSONBPath,
  buildSafeJSONBContains,
  ALLOWED_JSONB_OPERATORS,
  PRIVILEGED_OPERATORS,
};
