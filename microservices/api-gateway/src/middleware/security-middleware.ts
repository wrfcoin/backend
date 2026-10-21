import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';
import { Request, Response, NextFunction } from 'express';
import { Logger } from '../services/logger.js';
import { AuthenticatedRequest } from './auth-middleware.js';

// Rate limiting configurations
export const createRateLimiter = (
  windowMs: number,
  max: number,
  message?: string
) => {
  return rateLimit({
    windowMs,
    max,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: message || 'Too many requests, please try again later.',
        retryAfter: Math.ceil(windowMs / 1000),
      },
      timestamp: new Date().toISOString(),
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
      Logger.security('Rate limit exceeded', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        url: req.originalUrl,
        method: req.method,
      });

      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: message || 'Too many requests, please try again later.',
          retryAfter: Math.ceil(windowMs / 1000),
        },
        timestamp: new Date().toISOString(),
      });
    },
    skip: (req: Request) => {
      // Skip rate limiting for health checks
      return req.path === '/health';
    },
  });
};

// General API rate limiter - 100 requests per 15 minutes
export const generalRateLimit = createRateLimiter(
  15 * 60 * 1000, // 15 minutes
  100,
  'Too many API requests from this IP, please try again in 15 minutes.'
);

// Strict rate limiter for auth endpoints - 5 attempts per 15 minutes
export const authRateLimit = createRateLimiter(
  15 * 60 * 1000, // 15 minutes
  5,
  'Too many authentication attempts, please try again in 15 minutes.'
);

// Wallet operations rate limiter - 20 requests per 5 minutes
export const walletRateLimit = createRateLimiter(
  5 * 60 * 1000, // 5 minutes
  20,
  'Too many wallet operations, please try again in 5 minutes.'
);

// Bridge operations rate limiter (more strict) - 3 requests per 10 minutes
export const bridgeRateLimit = createRateLimiter(
  10 * 60 * 1000, // 10 minutes
  3,
  'Too many bridge operations, please try again in 10 minutes.'
);

// Speed limiter - progressively slow down requests
export const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 50, // Allow 50 requests at full speed
  delayMs: 500, // Add 500ms delay per request after delayAfter
  maxDelayMs: 20000, // Maximum delay of 20 seconds
  skip: (req: Request) => {
    return req.path === '/health';
  },
});

// IP-based blocking middleware
const blockedIPs = new Set<string>();
const suspiciousActivity = new Map<
  string,
  { count: number; lastSeen: number }
>();

export function ipSecurityMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';

  // Check if IP is blocked
  if (blockedIPs.has(clientIP)) {
    Logger.security('Blocked IP attempted access', {
      ip: clientIP,
      url: req.originalUrl,
      method: req.method,
      userAgent: req.get('User-Agent'),
    });

    res.status(403).json({
      success: false,
      error: {
        code: 'IP_BLOCKED',
        message: 'Access denied from this IP address',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Track suspicious activity
  const now = Date.now();
  const activity = suspiciousActivity.get(clientIP) || {
    count: 0,
    lastSeen: now,
  };

  // Reset count if more than 1 hour has passed
  if (now - activity.lastSeen > 60 * 60 * 1000) {
    activity.count = 0;
  }

  activity.count += 1;
  activity.lastSeen = now;
  suspiciousActivity.set(clientIP, activity);

  // Block IP if too many suspicious activities
  if (activity.count > 100) {
    blockedIPs.add(clientIP);
    Logger.security('IP auto-blocked for suspicious activity', {
      ip: clientIP,
      activityCount: activity.count,
      timeframe: '1 hour',
    });

    res.status(403).json({
      success: false,
      error: {
        code: 'IP_AUTO_BLOCKED',
        message: 'IP blocked due to suspicious activity',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  next();
}

// Enhanced security headers middleware
export function securityHeaders(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Content Security Policy
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "script-src 'self'; " +
      "style-src 'self' https:; " +
      "img-src 'self' data: https:; " +
      "font-src 'self' https:; " +
      "connect-src 'self' https: wss:; " +
      "frame-ancestors 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self';"
  );

  // Additional security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=()'
  );

  // HTTP Strict Transport Security
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains'
  );

  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  // API-specific headers
  res.setHeader('X-API-Version', '1.0.0');
  res.setHeader('X-Service', 'WRFCoin-API-Gateway');

  // Remove sensitive headers
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');

  next();
}

// Request validation middleware
export function requestValidation(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Check for malicious patterns in URL
  const maliciousPatterns = [
    /\.\./, // Path traversal
    /<script/i, // XSS
    /javascript:/i, // XSS
    /vbscript:/i, // XSS
    /onload=/i, // Event handler injection
    /onerror=/i, // Event handler injection
    /eval\(/i, // Code injection
    /union\s+select/i, // SQL injection
    /insert\s+into/i, // SQL injection
    /delete\s+from/i, // SQL injection
    /drop\s+table/i, // SQL injection
  ];

  const url = req.originalUrl.toLowerCase();
  const userAgent = req.get('User-Agent') || '';

  for (const pattern of maliciousPatterns) {
    if (pattern.test(url)) {
      Logger.security('Malicious URL pattern detected', {
        pattern: pattern.source,
        url: req.originalUrl,
        ip: req.ip,
        userAgent,
      });

      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Request contains invalid characters',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }
  }

  // Check request body size
  const contentLength = parseInt(req.get('Content-Length') || '0', 10);
  if (contentLength > 10 * 1024 * 1024) {
    // 10MB limit
    Logger.security('Large request body detected', {
      contentLength,
      url: req.originalUrl,
      ip: req.ip,
    });

    res.status(413).json({
      success: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body too large',
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Check for bot user agents
  const botPatterns = [/bot/i, /crawler/i, /spider/i, /scraper/i];

  const isBot = botPatterns.some(pattern => pattern.test(userAgent));
  if (isBot && !req.originalUrl.includes('/health')) {
    Logger.security('Bot access attempt', {
      userAgent,
      url: req.originalUrl,
      ip: req.ip,
    });
  }

  next();
}

// Export utilities for IP management
export const SecurityUtils = {
  blockIP: (ip: string) => {
    blockedIPs.add(ip);
    Logger.security('IP manually blocked', { ip });
  },

  unblockIP: (ip: string) => {
    blockedIPs.delete(ip);
    Logger.security('IP manually unblocked', { ip });
  },

  getBlockedIPs: () => Array.from(blockedIPs),

  getSuspiciousActivity: () =>
    Array.from(suspiciousActivity.entries()).map(([ip, activity]) => ({
      ip,
      count: activity.count,
      lastSeen: new Date(activity.lastSeen).toISOString(),
    })),

  clearSuspiciousActivity: (ip?: string) => {
    if (ip) {
      suspiciousActivity.delete(ip);
    } else {
      suspiciousActivity.clear();
    }
  },
};
