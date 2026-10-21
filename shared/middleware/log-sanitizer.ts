/**
 * Production Log Sanitization Middleware for WRFCoin Platform
 *
 * Sanitizes sensitive data from log output to prevent accidental
 * exposure of secrets, PII, and credentials in log files.
 *
 * Features:
 * - Redacts passwords, API keys, tokens, and credentials
 * - Strips JWT tokens from string-based log messages
 * - Masks database connection strings
 * - Redacts basic PII (email addresses, credit card numbers)
 * - Handles both string log messages and structured objects
 * - Express middleware for request/response log sanitization
 */

import type { Request, Response, NextFunction } from 'express';

// Field names that should always be redacted (case-insensitive matching)
const SENSITIVE_FIELD_NAMES = new Set([
  'password',
  'passwd',
  'secret',
  'credential',
  'credentials',
  'apikey',
  'api_key',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'jwt',
  'jwt_secret',
  'session_secret',
  'private_key',
  'privatekey',
  'secret_key',
  'secretkey',
  'mnemonic',
  'seed',
  'passphrase',
]);

const REDACTED = '[REDACTED]';

// Pre-compiled regex patterns for string-based redaction
const STRING_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // JWT tokens (three base64 segments separated by dots)
  { pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: REDACTED },
  // Database connection strings
  { pattern: /(?:postgres|postgresql|redis|mongodb|mysql|mariadb):\/\/[^\s"',}]+/gi, replacement: REDACTED },
  // Bearer tokens in strings
  { pattern: /(Bearer\s+)[^\s"',}]+/gi, replacement: `$1${REDACTED}` },
  // Email addresses (basic PII)
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: REDACTED },
  // Credit card numbers (basic: 13-19 digit sequences with optional separators)
  { pattern: /\b(?:\d[ -]*?){13,19}\b/g, replacement: REDACTED },
  // Key=value patterns for sensitive fields
  { pattern: /((?:password|passwd|secret|token|api_?key|authorization|credential)s?\s*[=:]\s*)(["']?)[^\s"',}&]+\2/gi, replacement: `$1${REDACTED}` },
];

/**
 * Sanitize a string log message by replacing sensitive patterns.
 */
function sanitizeString(input: string): string {
  let result = input;
  for (const { pattern, replacement } of STRING_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Sanitize an object by redacting sensitive field values.
 * Returns a new object (does not mutate the original).
 */
function sanitizeObject(obj: Record<string, unknown>, depth: number = 0): Record<string, unknown> {
  // Prevent infinite recursion on deeply nested objects
  if (depth > 10) {
    return { _truncated: 'Object too deeply nested for sanitization' };
  }

  const result: Record<string, unknown> = {};

  for (const key of Object.keys(obj)) {
    const lowerKey = key.toLowerCase();
    const value = obj[key];

    // Check if the field name itself is sensitive
    if (SENSITIVE_FIELD_NAMES.has(lowerKey)) {
      result[key] = REDACTED;
      continue;
    }

    // Recursively sanitize nested structures
    if (value === null || value === undefined) {
      result[key] = value;
    } else if (typeof value === 'string') {
      result[key] = sanitizeString(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => {
        if (typeof item === 'string') return sanitizeString(item);
        if (item !== null && typeof item === 'object') return sanitizeObject(item as Record<string, unknown>, depth + 1);
        return item;
      });
    } else if (typeof value === 'object') {
      result[key] = sanitizeObject(value as Record<string, unknown>, depth + 1);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Sanitize log data, handling both strings and structured objects.
 *
 * @param data - The log data to sanitize (string or object)
 * @returns Sanitized copy of the data
 */
export function sanitizeLogData(data: string): string;
export function sanitizeLogData(data: object): object;
export function sanitizeLogData(data: string | object): string | object {
  if (typeof data === 'string') {
    return sanitizeString(data);
  }

  if (data !== null && typeof data === 'object') {
    return sanitizeObject(data as Record<string, unknown>);
  }

  return data;
}

/**
 * Express middleware that sanitizes request/response logging.
 *
 * Intercepts req.body and sanitizes it before downstream handlers
 * might log it. Also sanitizes the authorization header value.
 *
 * Note: This does NOT modify the actual request data passed to handlers.
 * It adds a `sanitizedBody` property to `req` for safe logging purposes
 * and redacts the authorization header from a logging-safe copy.
 */
export function logSanitizationMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Attach a sanitized copy of the body for safe logging
  if (req.body && typeof req.body === 'object') {
    (req as any).sanitizedBody = sanitizeObject(req.body as Record<string, unknown>);
  }

  // Create a sanitized headers snapshot for logging (do not mutate actual headers)
  const sanitizedHeaders: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'authorization' || lowerKey === 'cookie' || lowerKey === 'x-api-key') {
      sanitizedHeaders[key] = REDACTED;
    } else if (typeof value === 'string') {
      sanitizedHeaders[key] = sanitizeString(value);
    } else {
      sanitizedHeaders[key] = value;
    }
  }
  (req as any).sanitizedHeaders = sanitizedHeaders;

  next();
}

// CommonJS compatible exports
export const logSanitizer = {
  sanitizeLogData,
  logSanitizationMiddleware,
};

export default logSanitizer;
