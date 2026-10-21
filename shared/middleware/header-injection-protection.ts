/**
 * Header Injection Protection Middleware for WRFCoin Platform
 *
 * Implements comprehensive protection against HTTP header injection attacks:
 * - CRLF (Carriage Return Line Feed) injection prevention
 * - Host header validation against allowlist
 * - X-Forwarded-* header validation from trusted proxies only
 * - Safe response header setting with automatic sanitization
 *
 * Security: This module protects against:
 * - HTTP Response Splitting attacks
 * - Host header attacks (cache poisoning, password reset poisoning)
 * - Header injection via X-Forwarded-* headers
 * - Control character injection in headers
 *
 * Task 103.9 - HTTP Header Injection Protection
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { securityLogger } from '../../server/utils/logger.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Regex pattern to detect CRLF characters (Carriage Return and Line Feed)
 * These can be used for HTTP response splitting attacks
 */
const CRLF_CHARS = /[\r\n]/g;

/**
 * Regex pattern to detect HTTP control characters (ASCII 0-31 and 127)
 * Control characters should never appear in HTTP header values
 */
const HEADER_CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/**
 * Regex pattern for URL-encoded CRLF sequences
 * Attackers may try to bypass by using URL encoding
 */
const ENCODED_CRLF = /%0[ad]|%0D|%0A/gi;

/**
 * Default allowed hosts from environment or fallback to localhost
 */
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];

/**
 * Headers that commonly carry user-controlled data and need CRLF checking
 */
const HEADERS_TO_CHECK = [
  'referer',
  'origin',
  'cookie',
  'authorization',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-requested-with',
  'content-type',
  'accept',
  'user-agent',
];

// ============================================================================
// Configuration Interface
// ============================================================================

/**
 * Configuration options for header injection protection middleware
 */
export interface HeaderInjectionProtectionConfig {
  /** Whether to validate Host header against allowlist (default: true) */
  validateHost?: boolean;
  /** Whether to wrap res.setHeader for sanitization (default: true) */
  wrapSetHeader?: boolean;
  /** Additional allowed hosts beyond defaults */
  additionalAllowedHosts?: string[];
  /** Trusted proxy IP addresses for X-Forwarded-* headers */
  trustedProxies?: string[];
  /** Whether to log injection attempts (default: true) */
  logAttempts?: boolean;
  /** Custom error handler for injection attempts */
  onError?: (req: Request, res: Response, reason: string) => void;
  /** Headers to check for CRLF injection (extends default list) */
  additionalHeadersToCheck?: string[];
  /** Whether to check for URL-encoded CRLF (default: true) */
  checkEncodedCRLF?: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<HeaderInjectionProtectionConfig> = {
  validateHost: true,
  wrapSetHeader: true,
  additionalAllowedHosts: [],
  trustedProxies: [],
  logAttempts: true,
  onError: (req: Request, res: Response, reason: string) => {
    res.status(400).json({
      error: 'Invalid request headers',
      code: 'HEADER_INJECTION_BLOCKED',
      message: reason,
    });
  },
  additionalHeadersToCheck: [],
  checkEncodedCRLF: true,
};

// ============================================================================
// Core Sanitization Functions
// ============================================================================

/**
 * Sanitizes a header value by removing CRLF and control characters
 *
 * @param value - The header value to sanitize
 * @returns Sanitized header value safe for HTTP headers
 *
 * @example
 * ```typescript
 * sanitizeHeaderValue("normal value"); // "normal value"
 * sanitizeHeaderValue("evil\r\nHeader: injected"); // "evilHeader: injected"
 * sanitizeHeaderValue("with\x00null"); // "withnull"
 * ```
 */
export function sanitizeHeaderValue(value: string): string {
  if (typeof value !== 'string') {
    return '';
  }

  // Remove CRLF characters
  let sanitized = value.replace(CRLF_CHARS, '');

  // Remove control characters
  sanitized = sanitized.replace(HEADER_CONTROL_CHARS, '');

  return sanitized;
}

/**
 * Checks if a string contains CRLF characters
 *
 * @param value - The string to check
 * @returns True if CRLF characters are present
 *
 * @example
 * ```typescript
 * containsCRLF("normal"); // false
 * containsCRLF("with\r\nnewline"); // true
 * containsCRLF("with\nnewline"); // true
 * ```
 */
export function containsCRLF(value: string): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  // Reset lastIndex for global regex
  CRLF_CHARS.lastIndex = 0;
  return CRLF_CHARS.test(value);
}

/**
 * Checks if a string contains URL-encoded CRLF sequences
 *
 * @param value - The string to check
 * @returns True if encoded CRLF sequences are present
 *
 * @example
 * ```typescript
 * containsEncodedCRLF("normal"); // false
 * containsEncodedCRLF("with%0d%0ainjection"); // true
 * containsEncodedCRLF("with%0Ainjection"); // true
 * ```
 */
export function containsEncodedCRLF(value: string): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  // Reset lastIndex for global regex
  ENCODED_CRLF.lastIndex = 0;
  return ENCODED_CRLF.test(value);
}

/**
 * Checks if a string contains control characters
 *
 * @param value - The string to check
 * @returns True if control characters are present
 */
export function containsControlChars(value: string): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  // Reset lastIndex for global regex
  HEADER_CONTROL_CHARS.lastIndex = 0;
  return HEADER_CONTROL_CHARS.test(value);
}

// ============================================================================
// Host Header Validation
// ============================================================================

/**
 * Gets the list of allowed hosts from environment and configuration
 *
 * @param additionalHosts - Additional hosts to add to the allowlist
 * @returns Array of allowed host patterns
 */
function getAllowedHosts(additionalHosts: string[] = []): string[] {
  const envHosts = process.env.ALLOWED_HOSTS
    ? process.env.ALLOWED_HOSTS.split(',').map(h => h.trim().toLowerCase())
    : [];

  return [
    ...DEFAULT_ALLOWED_HOSTS,
    ...envHosts,
    ...additionalHosts.map(h => h.toLowerCase()),
  ];
}

/**
 * Validates a Host header value against the allowlist
 *
 * Supports:
 * - Exact hostname matching
 * - Wildcard subdomain matching (e.g., "*.example.com")
 * - Port numbers are stripped before comparison
 *
 * @param host - The Host header value to validate
 * @param allowedHosts - Array of allowed host patterns
 * @returns True if the host is allowed
 *
 * @example
 * ```typescript
 * validateHostHeader("localhost", ["localhost"]); // true
 * validateHostHeader("localhost:3000", ["localhost"]); // true
 * validateHostHeader("api.example.com", ["*.example.com"]); // true
 * validateHostHeader("evil.com", ["localhost"]); // false
 * ```
 */
export function validateHostHeader(host: string, allowedHosts?: string[]): boolean {
  if (!host || typeof host !== 'string') {
    return false;
  }

  // Remove port number if present
  const hostname = host.split(':')[0].toLowerCase().trim();

  if (!hostname) {
    return false;
  }

  // Check for CRLF injection in host header
  if (containsCRLF(host) || containsControlChars(host)) {
    return false;
  }

  const hosts = allowedHosts || getAllowedHosts();

  return hosts.some(allowed => {
    const allowedLower = allowed.toLowerCase();

    // Wildcard subdomain matching
    if (allowedLower.startsWith('*.')) {
      const domain = allowedLower.slice(2);
      // Match subdomain.domain.com or domain.com itself
      return hostname.endsWith(`.${domain}`) || hostname === domain;
    }

    // Exact match
    return hostname === allowedLower;
  });
}

/**
 * Express middleware for Host header validation
 *
 * @param allowedHosts - Optional array of allowed host patterns
 * @returns Express middleware function
 */
export function hostValidationMiddleware(allowedHosts?: string[]): RequestHandler {
  const hosts = allowedHosts || getAllowedHosts();

  return (req: Request, res: Response, next: NextFunction): void => {
    const host = req.headers.host;

    if (!validateHostHeader(host || '', hosts)) {
      securityLogger.warn('Invalid Host header blocked', { module: 'HeaderInjection', host: host?.substring(0, 100), ip: req.ip });
      res.status(400).json({
        error: 'Invalid Host header',
        code: 'INVALID_HOST_HEADER',
      });
      return;
    }

    next();
  };
}

// ============================================================================
// Safe Header Setting
// ============================================================================

/**
 * Safely sets a response header with automatic sanitization
 *
 * @param res - Express response object (or any object with setHeader method)
 * @param name - Header name
 * @param value - Header value to set (will be sanitized)
 *
 * @example
 * ```typescript
 * setHeaderSafe(res, "X-Custom-Header", "safe value");
 * setHeaderSafe(res, "X-Custom-Header", "evil\r\nX-Injected: true"); // Sets "evilX-Injected: true"
 * ```
 */
export function setHeaderSafe(
  res: { setHeader: (name: string, value: string | string[]) => void },
  name: string,
  value: string | string[]
): void {
  const sanitizedName = sanitizeHeaderValue(name);

  if (Array.isArray(value)) {
    const sanitizedValues = value.map(v => sanitizeHeaderValue(String(v)));
    res.setHeader(sanitizedName, sanitizedValues);
  } else {
    const sanitizedValue = sanitizeHeaderValue(String(value));

    // Log if sanitization changed the value
    if (sanitizedValue !== value) {
      securityLogger.warn('Header value sanitized', { module: 'HeaderInjection', headerName: name });
    }

    res.setHeader(sanitizedName, sanitizedValue);
  }
}

/**
 * Creates middleware that wraps res.setHeader to automatically sanitize all outgoing headers
 *
 * @returns Express middleware function
 */
export function createHeaderProtectionMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const originalSetHeader = res.setHeader.bind(res);

    // Override setHeader to sanitize values
    res.setHeader = function (
      name: string,
      value: string | number | readonly string[]
    ): Response {
      let sanitizedValue: string | string[];

      if (Array.isArray(value)) {
        sanitizedValue = value.map(v => sanitizeHeaderValue(String(v)));
      } else {
        sanitizedValue = sanitizeHeaderValue(String(value));
      }

      const sanitizedName = sanitizeHeaderValue(name);
      originalSetHeader(sanitizedName, sanitizedValue);
      return this;
    };

    next();
  };
}

// ============================================================================
// X-Forwarded-* Header Validation
// ============================================================================

/**
 * Result of X-Forwarded-* header validation
 */
export interface ForwardedHeadersResult {
  /** The validated client IP address */
  ip: string;
  /** The validated protocol (http or https) */
  proto: string;
  /** The validated original host */
  host: string;
  /** Whether the request came through a trusted proxy */
  isTrustedProxy: boolean;
}

/**
 * Gets the list of trusted proxy addresses from environment and configuration
 *
 * @param additionalProxies - Additional proxy addresses to trust
 * @returns Array of trusted proxy IP addresses
 */
function getTrustedProxies(additionalProxies: string[] = []): string[] {
  const envProxies = process.env.TRUSTED_PROXIES
    ? process.env.TRUSTED_PROXIES.split(',').map(p => p.trim())
    : [];

  return [...envProxies, ...additionalProxies];
}

/**
 * Validates and extracts X-Forwarded-* headers from trusted proxies only
 *
 * Security: Only trusts forwarded headers when the request comes from a known proxy.
 * This prevents attackers from spoofing client IPs or protocols.
 *
 * @param req - Express request object
 * @param trustedProxies - Array of trusted proxy IP addresses
 * @returns Validated forwarded headers result
 *
 * @example
 * ```typescript
 * const headers = validateForwardedHeaders(req, ["10.0.0.1", "10.0.0.2"]);
 * console.log(headers.ip); // Validated client IP
 * console.log(headers.proto); // "https" or "http"
 * ```
 */
export function validateForwardedHeaders(
  req: Request,
  trustedProxies?: string[]
): ForwardedHeadersResult {
  const proxies = trustedProxies || getTrustedProxies();
  const remoteAddr = req.socket?.remoteAddress || req.ip || 'unknown';

  // Check if request is from a trusted proxy
  const isTrustedProxy = proxies.length > 0 && proxies.some(proxy => {
    // Handle IPv6-mapped IPv4 addresses
    const normalizedRemote = remoteAddr.replace(/^::ffff:/, '');
    const normalizedProxy = proxy.replace(/^::ffff:/, '');
    return normalizedRemote === normalizedProxy;
  });

  // If not from trusted proxy, use direct connection values
  if (!isTrustedProxy) {
    return {
      ip: remoteAddr,
      proto: req.secure ? 'https' : 'http',
      host: req.headers.host || '',
      isTrustedProxy: false,
    };
  }

  // Validate and use forwarded headers from trusted proxy
  const forwardedFor = req.headers['x-forwarded-for'];
  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedHost = req.headers['x-forwarded-host'];

  // Extract first IP from X-Forwarded-For (client IP)
  let clientIp = remoteAddr;
  if (typeof forwardedFor === 'string' && forwardedFor) {
    const ips = forwardedFor.split(',').map(ip => ip.trim());
    if (ips.length > 0) {
      // Sanitize the IP address
      clientIp = sanitizeHeaderValue(ips[0]);
      // Basic IP validation
      if (!isValidIpAddress(clientIp)) {
        clientIp = remoteAddr;
      }
    }
  }

  // Validate protocol
  let proto = req.secure ? 'https' : 'http';
  if (typeof forwardedProto === 'string' && forwardedProto) {
    const sanitizedProto = sanitizeHeaderValue(forwardedProto.toLowerCase());
    if (sanitizedProto === 'https' || sanitizedProto === 'http') {
      proto = sanitizedProto;
    }
  }

  // Validate host
  let host = req.headers.host || '';
  if (typeof forwardedHost === 'string' && forwardedHost) {
    const sanitizedHost = sanitizeHeaderValue(forwardedHost);
    // Only use if it doesn't contain suspicious characters
    if (!/[<>"'\\]/.test(sanitizedHost)) {
      host = sanitizedHost;
    }
  }

  return {
    ip: clientIp,
    proto,
    host,
    isTrustedProxy: true,
  };
}

/**
 * Basic IP address validation (IPv4 and IPv6)
 *
 * @param ip - IP address to validate
 * @returns True if the IP address appears valid
 */
function isValidIpAddress(ip: string): boolean {
  // IPv4 pattern
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  // Simplified IPv6 pattern (allows compressed notation)
  const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

  return ipv4Pattern.test(ip) || ipv6Pattern.test(ip);
}

// ============================================================================
// Comprehensive Middleware
// ============================================================================

/**
 * Creates comprehensive header injection protection middleware
 *
 * This middleware:
 * 1. Validates Host header against allowlist
 * 2. Checks for CRLF injection in common headers
 * 3. Checks for URL-encoded CRLF sequences
 * 4. Wraps res.setHeader for automatic sanitization
 * 5. Validates X-Forwarded-* headers from trusted proxies only
 *
 * @param options - Configuration options
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * import { createHeaderInjectionProtectionMiddleware } from './middleware/header-injection-protection.js';
 *
 * // Apply to all routes
 * app.use(createHeaderInjectionProtectionMiddleware());
 *
 * // Or with custom configuration
 * app.use(createHeaderInjectionProtectionMiddleware({
 *   additionalAllowedHosts: ['api.example.com', '*.myapp.com'],
 *   trustedProxies: ['10.0.0.1', '10.0.0.2'],
 *   logAttempts: true,
 * }));
 * ```
 */
export function createHeaderInjectionProtectionMiddleware(
  options: HeaderInjectionProtectionConfig = {}
): RequestHandler {
  const config: Required<HeaderInjectionProtectionConfig> = {
    ...DEFAULT_CONFIG,
    ...options,
  };

  const allowedHosts = getAllowedHosts(config.additionalAllowedHosts);
  const trustedProxies = getTrustedProxies(config.trustedProxies);
  const headersToCheck = [...HEADERS_TO_CHECK, ...config.additionalHeadersToCheck];

  return (req: Request, res: Response, next: NextFunction): void => {
    // Step 1: Validate Host header
    if (config.validateHost && !validateHostHeader(req.headers.host || '', allowedHosts)) {
      if (config.logAttempts) {
        securityLogger.warn('Invalid Host header blocked', { module: 'HeaderInjection', host: req.headers.host?.substring(0, 100), ip: req.ip });
      }
      config.onError(req, res, 'Invalid Host header');
      return;
    }

    // Step 2: Check for CRLF in request headers
    for (const header of headersToCheck) {
      const headerValue = req.headers[header];
      if (headerValue) {
        const valueStr = Array.isArray(headerValue) ? headerValue.join(', ') : headerValue;

        // Check for raw CRLF
        if (containsCRLF(valueStr)) {
          if (config.logAttempts) {
            securityLogger.warn('CRLF injection attempt blocked', { module: 'HeaderInjection', header, ip: req.ip });
          }
          config.onError(req, res, `Invalid characters in ${header} header`);
          return;
        }

        // Check for encoded CRLF
        if (config.checkEncodedCRLF && containsEncodedCRLF(valueStr)) {
          if (config.logAttempts) {
            securityLogger.warn('Encoded CRLF injection attempt blocked', { module: 'HeaderInjection', header, ip: req.ip });
          }
          config.onError(req, res, `Invalid encoded characters in ${header} header`);
          return;
        }

        // Check for control characters
        if (containsControlChars(valueStr)) {
          if (config.logAttempts) {
            securityLogger.warn('Control character injection attempt blocked', { module: 'HeaderInjection', header, ip: req.ip });
          }
          config.onError(req, res, `Invalid control characters in ${header} header`);
          return;
        }
      }
    }

    // Step 3: Validate and attach forwarded headers info
    const forwardedInfo = validateForwardedHeaders(req, trustedProxies);
    (req as any).forwardedHeaders = forwardedInfo;

    // Step 4: Wrap setHeader if enabled
    if (config.wrapSetHeader) {
      const originalSetHeader = res.setHeader.bind(res);

      res.setHeader = function (
        name: string,
        value: string | number | readonly string[]
      ): Response {
        let sanitizedValue: string | string[];

        if (Array.isArray(value)) {
          sanitizedValue = value.map(v => sanitizeHeaderValue(String(v)));
        } else {
          sanitizedValue = sanitizeHeaderValue(String(value));
        }

        const sanitizedName = sanitizeHeaderValue(name);

        // Log if sanitization changed the value (potential injection attempt)
        if (config.logAttempts) {
          const originalValue = Array.isArray(value) ? value.join(', ') : String(value);
          const sanitizedValueStr = Array.isArray(sanitizedValue)
            ? sanitizedValue.join(', ')
            : sanitizedValue;
          if (sanitizedValueStr !== originalValue) {
            securityLogger.warn('Response header value sanitized', { module: 'HeaderInjection', headerName: name, ip: req.ip });
          }
        }

        originalSetHeader(sanitizedName, sanitizedValue);
        return this;
      };
    }

    next();
  };
}

// ============================================================================
// Utility Functions for External Use
// ============================================================================

/**
 * Checks if a request appears to contain header injection attempts
 *
 * @param req - Express request object
 * @returns Object indicating if injection was detected and details
 */
export function detectHeaderInjection(req: Request): {
  detected: boolean;
  details: string[];
} {
  const details: string[] = [];

  for (const header of HEADERS_TO_CHECK) {
    const headerValue = req.headers[header];
    if (headerValue) {
      const valueStr = Array.isArray(headerValue) ? headerValue.join(', ') : headerValue;

      if (containsCRLF(valueStr)) {
        details.push(`CRLF in ${header}`);
      }

      if (containsEncodedCRLF(valueStr)) {
        details.push(`Encoded CRLF in ${header}`);
      }

      if (containsControlChars(valueStr)) {
        details.push(`Control characters in ${header}`);
      }
    }
  }

  return {
    detected: details.length > 0,
    details,
  };
}

/**
 * Gets sanitized request headers for logging or processing
 *
 * @param req - Express request object
 * @returns Object with sanitized header values
 */
export function getSanitizedHeaders(req: Request): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      const valueStr = Array.isArray(value) ? value.join(', ') : value;
      sanitized[key] = sanitizeHeaderValue(valueStr);
    }
  }

  return sanitized;
}

// ============================================================================
// Module Exports
// ============================================================================

/**
 * CommonJS compatible exports for the header injection protection module
 */
export const headerInjectionProtection = {
  // Core functions
  sanitizeHeaderValue,
  containsCRLF,
  containsEncodedCRLF,
  containsControlChars,

  // Host validation
  validateHostHeader,
  hostValidationMiddleware,

  // Safe header setting
  setHeaderSafe,
  createHeaderProtectionMiddleware,

  // Forwarded headers
  validateForwardedHeaders,

  // Comprehensive middleware
  createHeaderInjectionProtectionMiddleware,

  // Utilities
  detectHeaderInjection,
  getSanitizedHeaders,
};

export default headerInjectionProtection;
