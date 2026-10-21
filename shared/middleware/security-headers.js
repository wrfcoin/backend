/**
 * Unified Security Headers Middleware for WRFCoin Platform (ESM version)
 * Implements Content Security Policy and other security headers
 */

import crypto from 'crypto';

const DEFAULT_CONFIG = {
  reportOnly: false,
  enableHSTS: process.env.NODE_ENV === 'production',
  hstsMaxAge: 31536000,
  hstsIncludeSubDomains: true,
  hstsPreload: false,
  frameOptions: 'DENY',
  referrerPolicy: 'strict-origin-when-cross-origin',
  allowUnsafeInlineStyles: true,
  frameAncestors: [],
};

export function generateNonce() {
  return crypto.randomBytes(16).toString('base64');
}

function buildCSPDirectives(config, nonce) {
  const directives = [];

  directives.push("default-src 'self'");

  const scriptSrc = ["'self'", `'nonce-${nonce}'`];
  if (config.allowUnsafeEval) {
    scriptSrc.push("'unsafe-eval'");
  }
  if (config.additionalScriptSrc) {
    scriptSrc.push(...config.additionalScriptSrc);
  }
  directives.push(`script-src ${scriptSrc.join(' ')}`);

  const styleSrc = ["'self'"];
  if (config.allowUnsafeInlineStyles !== false) {
    styleSrc.push("'unsafe-inline'");
  }
  if (config.additionalStyleSrc) {
    styleSrc.push(...config.additionalStyleSrc);
  }
  directives.push(`style-src ${styleSrc.join(' ')}`);

  const imgSrc = ["'self'", 'data:', 'https:'];
  if (config.additionalImgSrc) {
    imgSrc.push(...config.additionalImgSrc);
  }
  directives.push(`img-src ${imgSrc.join(' ')}`);

  const fontSrc = ["'self'"];
  if (config.additionalFontSrc) {
    fontSrc.push(...config.additionalFontSrc);
  }
  directives.push(`font-src ${fontSrc.join(' ')}`);

  const connectSrc = ["'self'", 'wss:', 'https:'];
  if (config.additionalConnectSrc) {
    connectSrc.push(...config.additionalConnectSrc);
  }
  directives.push(`connect-src ${connectSrc.join(' ')}`);

  const frameAncestors = config.frameAncestors && config.frameAncestors.length > 0
    ? config.frameAncestors.join(' ')
    : "'none'";
  directives.push(`frame-ancestors ${frameAncestors}`);

  directives.push("base-uri 'self'");
  directives.push("form-action 'self'");
  directives.push("object-src 'none'");

  if (process.env.NODE_ENV === 'production') {
    directives.push('upgrade-insecure-requests');
  }

  if (config.reportUri) {
    directives.push(`report-uri ${config.reportUri}`);
  }

  return directives;
}

export function createSecurityHeadersMiddleware(config = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return (req, res, next) => {
    const nonce = generateNonce();
    res.locals.cspNonce = nonce;

    const cspDirectives = buildCSPDirectives(mergedConfig, nonce);
    const cspHeader = mergedConfig.reportOnly
      ? 'Content-Security-Policy-Report-Only'
      : 'Content-Security-Policy';
    res.setHeader(cspHeader, cspDirectives.join('; '));

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', mergedConfig.frameOptions || 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');

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

    res.setHeader('Referrer-Policy', mergedConfig.referrerPolicy || 'strict-origin-when-cross-origin');
    res.setHeader(
      'Permissions-Policy',
      'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
    );
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-DNS-Prefetch-Control', 'off');

    next();
  };
}

export function applySecurityHeaders(res, nonce, config = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const currentNonce = nonce || generateNonce();

  const cspDirectives = buildCSPDirectives(mergedConfig, currentNonce);
  const cspHeader = mergedConfig.reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';
  res.setHeader(cspHeader, cspDirectives.join('; '));

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', mergedConfig.frameOptions || 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');

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

  res.setHeader('Referrer-Policy', mergedConfig.referrerPolicy || 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), payment=(), usb=()'
  );
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

  return currentNonce;
}

export function applyApiSecurityHeaders(res, config = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  if (mergedConfig.enableHSTS) {
    let hstsValue = `max-age=${mergedConfig.hstsMaxAge}`;
    if (mergedConfig.hstsIncludeSubDomains) {
      hstsValue += '; includeSubDomains';
    }
    res.setHeader('Strict-Transport-Security', hstsValue);
  }

  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

export function createApiSecurityHeadersMiddleware(config = {}) {
  return (req, res, next) => {
    applyApiSecurityHeaders(res, config);
    next();
  };
}

export { DEFAULT_CONFIG };
