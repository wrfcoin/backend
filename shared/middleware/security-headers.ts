/**
 * Unified Security Headers Middleware for WRFCoin Platform
 * Implements Content Security Policy and other security headers
 *
 * Security: This module provides comprehensive security headers including:
 * - Content Security Policy with nonce-based script execution
 * - Clickjacking protection via X-Frame-Options and frame-ancestors
 * - MIME type sniffing protection
 * - XSS protection
 * - Strict Transport Security
 * - Referrer Policy
 * - Permissions Policy
 */

import * as crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// CSP Configuration interface
export interface CSPConfig {
  /** Enable report-only mode (logs violations but doesn't enforce) */
  reportOnly?: boolean;
  /** URI to send CSP violation reports to */
  reportUri?: string;
  /** Additional allowed script sources */
  additionalScriptSrc?: string[];
  /** Additional allowed style sources */
  additionalStyleSrc?: string[];
  /** Additional allowed connect sources (for WebSocket, fetch, etc.) */
  additionalConnectSrc?: string[];
  /** Additional allowed image sources */
  additionalImgSrc?: string[];
  /** Additional allowed font sources */
  additionalFontSrc?: string[];
  /** Whether to allow unsafe-eval (not recommended, use only if necessary) */
  allowUnsafeEval?: boolean;
  /** Whether to allow unsafe-inline styles (enabled by default for compatibility) */
  allowUnsafeInlineStyles?: boolean;
  /** Custom frame-ancestors directive */
  frameAncestors?: string[];
}

// Security headers configuration interface
export interface SecurityHeadersConfig extends CSPConfig {
  /** Enable HSTS (default: true in production) */
  enableHSTS?: boolean;
  /** HSTS max-age in seconds (default: 31536000 = 1 year) */
  hstsMaxAge?: number;
  /** Include subdomains in HSTS (default: true) */
  hstsIncludeSubDomains?: boolean;
  /** Enable HSTS preload (default: false) */
  hstsPreload?: boolean;
  /** X-Frame-Options value (default: 'DENY') */
  frameOptions?: 'DENY' | 'SAMEORIGIN';
  /** Referrer-Policy value */
  referrerPolicy?: string;
}

// Default configuration
const DEFAULT_CONFIG: SecurityHeadersConfig = {
  reportOnly: false,
  enableHSTS: process.env.NODE_ENV === 'production',
  hstsMaxAge: 31536000, // 1 year
  hstsIncludeSubDomains: true,
  hstsPreload: false,
  frameOptions: 'DENY',
  referrerPolicy: 'strict-origin-when-cross-origin',
  allowUnsafeInlineStyles: true,
  frameAncestors: [],
};

/**
 * Generates a cryptographically secure nonce for CSP
 * @returns Base64 encoded nonce string
 */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Builds CSP directives based on configuration
 * @param config - CSP configuration
 * @param nonce - The nonce to use for script-src
 * @returns Array of CSP directive strings
 */
function buildCSPDirectives(config: CSPConfig, nonce: string): string[] {
  const directives: string[] = [];

  // default-src: Fallback for other directives
  directives.push("default-src 'self'");

  // script-src: Where scripts can be loaded from
  const scriptSrc = ["'self'", `'nonce-${nonce}'`];
  if (config.allowUnsafeEval) {
    scriptSrc.push("'unsafe-eval'");
  }
  if (config.additionalScriptSrc) {
    scriptSrc.push(...config.additionalScriptSrc);
  }
  directives.push(`script-src ${scriptSrc.join(' ')}`);

  // style-src: Where stylesheets can be loaded from
  const styleSrc = ["'self'"];
  if (config.allowUnsafeInlineStyles !== false) {
    styleSrc.push("'unsafe-inline'"); // Often needed for inline styles
  }
  if (config.additionalStyleSrc) {
    styleSrc.push(...config.additionalStyleSrc);
  }
  directives.push(`style-src ${styleSrc.join(' ')}`);

  // img-src: Where images can be loaded from
  const imgSrc = ["'self'", 'data:', 'https:'];
  if (config.additionalImgSrc) {
    imgSrc.push(...config.additionalImgSrc);
  }
  directives.push(`img-src ${imgSrc.join(' ')}`);

  // font-src: Where fonts can be loaded from
  const fontSrc = ["'self'"];
  if (config.additionalFontSrc) {
    fontSrc.push(...config.additionalFontSrc);
  }
  directives.push(`font-src ${fontSrc.join(' ')}`);

  // connect-src: Where fetch/XHR/WebSocket can connect to
  const connectSrc = ["'self'", 'wss:', 'https:'];
  if (config.additionalConnectSrc) {
    connectSrc.push(...config.additionalConnectSrc);
  }
  directives.push(`connect-src ${connectSrc.join(' ')}`);

  // frame-ancestors: Clickjacking protection (CSP level 2)
  const frameAncestors = config.frameAncestors && config.frameAncestors.length > 0
    ? config.frameAncestors.join(' ')
    : "'none'";
  directives.push(`frame-ancestors ${frameAncestors}`);

  // base-uri: Restrict base element URLs
  directives.push("base-uri 'self'");

  // form-action: Where forms can submit to
  directives.push("form-action 'self'");

  // object-src: Restrict plugins (Flash, etc.)
  directives.push("object-src 'none'");

  // upgrade-insecure-requests: Automatically upgrade HTTP to HTTPS
  if (process.env.NODE_ENV === 'production') {
    directives.push('upgrade-insecure-requests');
  }

  // Report URI for violation reporting
  if (config.reportUri) {
    directives.push(`report-uri ${config.reportUri}`);
  }

  return directives;
}

/**
 * Creates Express middleware for security headers
 * @param config - Security headers configuration
 * @returns Express middleware function
 */
export function createSecurityHeadersMiddleware(config: SecurityHeadersConfig = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return (req: Request, res: Response, next: NextFunction): void => {
    // Generate nonce for this request
    const nonce = generateNonce();

    // Store nonce in res.locals for use in templates
    res.locals.cspNonce = nonce;

    // Build and set Content Security Policy
    const cspDirectives = buildCSPDirectives(mergedConfig, nonce);
    const cspHeader = mergedConfig.reportOnly
      ? 'Content-Security-Policy-Report-Only'
      : 'Content-Security-Policy';
    res.setHeader(cspHeader, cspDirectives.join('; '));

    // X-Content-Type-Options: Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // X-Frame-Options: Clickjacking protection (legacy, but still useful)
    res.setHeader('X-Frame-Options', mergedConfig.frameOptions || 'DENY');

    // X-XSS-Protection: Enable XSS filter in older browsers
    res.setHeader('X-XSS-Protection', '1; mode=block');

    // Strict-Transport-Security: Force HTTPS
    if (mergedConfig.enableHSTS) {
      let hstsValue = `max-age=${mergedConfig.hstsMaxAge}`;
      if (mergedConfig.hstsIncludeSubDomains) {
        hstsValue += '; includeSubDomains';
      }
      if (mergedConfig.hstsPreload) {
        hstsValue += '; preload';
      }
      res.setHeader('Strict-Transport-Security', hstsValue);
    }

    // Referrer-Policy: Control referrer information
    res.setHeader('Referrer-Policy', mergedConfig.referrerPolicy || 'strict-origin-when-cross-origin');

    // Permissions-Policy: Restrict browser features
    res.setHeader(
      'Permissions-Policy',
      'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
    );

    // X-Permitted-Cross-Domain-Policies: Restrict cross-domain policy files
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    // X-Download-Options: Prevent IE from opening downloads in site context
    res.setHeader('X-Download-Options', 'noopen');

    // X-DNS-Prefetch-Control: Control DNS prefetching
    res.setHeader('X-DNS-Prefetch-Control', 'off');

    next();
  };
}

/**
 * Applies security headers to raw HTTP server responses (non-Express)
 * @param res - Node.js HTTP response object with setHeader method
 * @param nonce - Optional nonce to use (generates new one if not provided)
 * @param config - Optional security headers configuration
 * @returns The nonce used (for use in inline scripts)
 */
export function applySecurityHeaders(
  res: { setHeader: (name: string, value: string) => void },
  nonce?: string,
  config: SecurityHeadersConfig = {}
): string {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const currentNonce = nonce || generateNonce();

  // Build and set Content Security Policy
  const cspDirectives = buildCSPDirectives(mergedConfig, currentNonce);
  const cspHeader = mergedConfig.reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';
  res.setHeader(cspHeader, cspDirectives.join('; '));

  // X-Content-Type-Options: Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // X-Frame-Options: Clickjacking protection
  res.setHeader('X-Frame-Options', mergedConfig.frameOptions || 'DENY');

  // X-XSS-Protection: Enable XSS filter in older browsers
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Strict-Transport-Security: Force HTTPS
  if (mergedConfig.enableHSTS) {
    let hstsValue = `max-age=${mergedConfig.hstsMaxAge}`;
    if (mergedConfig.hstsIncludeSubDomains) {
      hstsValue += '; includeSubDomains';
    }
    if (mergedConfig.hstsPreload) {
      hstsValue += '; preload';
    }
    res.setHeader('Strict-Transport-Security', hstsValue);
  }

  // Referrer-Policy: Control referrer information
  res.setHeader('Referrer-Policy', mergedConfig.referrerPolicy || 'strict-origin-when-cross-origin');

  // Permissions-Policy: Restrict browser features
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), payment=(), usb=()'
  );

  // X-Permitted-Cross-Domain-Policies: Restrict cross-domain policy files
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

  return currentNonce;
}

/**
 * Applies API-specific security headers (lighter weight for JSON APIs)
 * @param res - Response object with setHeader method
 * @param config - Optional configuration
 */
export function applyApiSecurityHeaders(
  res: { setHeader: (name: string, value: string) => void },
  config: SecurityHeadersConfig = {}
): void {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Simplified CSP for API responses (no scripts needed)
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");

  // Core security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // HSTS
  if (mergedConfig.enableHSTS) {
    let hstsValue = `max-age=${mergedConfig.hstsMaxAge}`;
    if (mergedConfig.hstsIncludeSubDomains) {
      hstsValue += '; includeSubDomains';
    }
    res.setHeader('Strict-Transport-Security', hstsValue);
  }

  // Referrer Policy
  res.setHeader('Referrer-Policy', 'no-referrer');

  // Cache Control for API responses
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

/**
 * Creates Express middleware for API-specific security headers
 * @param config - Security headers configuration
 * @returns Express middleware function
 */
export function createApiSecurityHeadersMiddleware(config: SecurityHeadersConfig = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    applyApiSecurityHeaders(res, config);
    next();
  };
}

// CommonJS compatible exports
export const securityHeaders = {
  generateNonce,
  createSecurityHeadersMiddleware,
  applySecurityHeaders,
  applyApiSecurityHeaders,
  createApiSecurityHeadersMiddleware,
};

export default securityHeaders;
