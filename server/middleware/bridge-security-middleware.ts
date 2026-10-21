/**
 * Bridge Security Middleware
 *
 * Express middleware for bridge API protection:
 * - Request validation and sanitization
 * - Rate limiting per address
 * - Security headers
 * - Audit logging
 * - DDoS protection
 */

import { Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import crypto from 'crypto';
import { crosschainLogger, logError } from '../utils/logger.js';
import strictCorsConfig from '../utils/strict-cors-config.js';

const { resolveAllowedOrigins } = strictCorsConfig;

interface BridgeRequest extends Request {
  bridgeContext?: {
    requestId: string;
    timestamp: Date;
    sourceChain?: string;
    destinationChain?: string;
    amount?: string;
  };
}

// Rate limiter for bridge operations
export const bridgeRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  message: 'Too many bridge requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  // SECURITY FIX: Use ONLY the IP address for rate limiting key generation.
  // Using user-provided data (like wallet address) in the rate limit key allows
  // attackers to bypass rate limiting by simply varying the address parameter
  // in each request. The IP address is the only reliable identifier for rate
  // limiting that cannot be easily spoofed by the client.
  keyGenerator: ((req: Request) => {
    // Use only IP address - never use user-provided input in rate limit keys
    return ipKeyGenerator(req.ip || 'unknown');
  }) as any,
});

// Strict rate limiter for high-value transfers
export const highValueRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Only 10 high-value transfers per hour
  message: 'High-value transfer limit exceeded',
  skip: ((req: Request) => {
    const amount = req.body?.amount;
    return !amount || BigInt(amount) < BigInt('1000000000000000000000'); // < 1000 tokens
  }) as any,
});

/**
 * Validate bridge request parameters
 */
export function validateBridgeRequest(
  req: BridgeRequest,
  res: Response,
  next: NextFunction
): void {
  try {
    const { sourceChain, destinationChain, sender, recipient, amount, asset } = req.body;

    // Validate required fields
    if (!sourceChain || !destinationChain || !sender || !recipient || !amount || !asset) {
      res.status(400).json({
        error: 'Missing required fields',
        required: ['sourceChain', 'destinationChain', 'sender', 'recipient', 'amount', 'asset'],
      });
      return;
    }

    // Validate chains are different
    if (sourceChain === destinationChain) {
      res.status(400).json({
        error: 'Source and destination chains must be different',
      });
      return;
    }

    // Validate addresses (basic)
    if (!isValidAddress(sender) || !isValidAddress(recipient)) {
      res.status(400).json({
        error: 'Invalid address format',
      });
      return;
    }

    // Validate amount
    try {
      const amountBigInt = BigInt(amount);
      if (amountBigInt <= 0n) {
        res.status(400).json({
          error: 'Amount must be greater than 0',
        });
        return;
      }
    } catch {
      res.status(400).json({
        error: 'Invalid amount format',
      });
      return;
    }

    // Attach context
    req.bridgeContext = {
      requestId: generateRequestId(),
      timestamp: new Date(),
      sourceChain,
      destinationChain,
      amount,
    };

    next();
  } catch (error) {
    res.status(500).json({
      error: 'Request validation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Security headers middleware
 */
export function securityHeaders(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Enable XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Strict transport security
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // Content security policy
  res.setHeader('Content-Security-Policy', "default-src 'self'");

  // Referrer policy
  res.setHeader('Referrer-Policy', 'no-referrer');

  next();
}

/**
 * Audit logging middleware
 */
export function auditLogger(
  req: BridgeRequest,
  res: Response,
  next: NextFunction
): void {
  const startTime = Date.now();

  // Log response
  res.on('finish', () => {
    const duration = Date.now() - startTime;

    crosschainLogger.info('Bridge request audit', {
      operation: 'bridge:audit',
      requestId: req.bridgeContext?.requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      statusCode: res.statusCode,
      duration,
      sourceChain: req.bridgeContext?.sourceChain,
      destinationChain: req.bridgeContext?.destinationChain,
    });
  });

  next();
}

/**
 * Signature verification middleware
 */
export function verifySignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const signature = req.headers['x-signature'] as string;
  const timestamp = req.headers['x-timestamp'] as string;

  if (!signature || !timestamp) {
    res.status(401).json({
      error: 'Missing signature or timestamp',
    });
    return;
  }

  // Verify timestamp is recent (within 5 minutes)
  const now = Date.now();
  const requestTime = parseInt(timestamp, 10);

  if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
    res.status(401).json({
      error: 'Request timestamp expired',
    });
    return;
  }

  // In production, verify actual signature
  // For now, just validate format
  if (!/^0x[a-fA-F0-9]{130}$/.test(signature)) {
    res.status(401).json({
      error: 'Invalid signature format',
    });
    return;
  }

  next();
}

/**
 * CORS configuration for bridge API
 */
export const bridgeCorsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests from whitelisted origins. BRIDGE_ALLOWED_ORIGINS overrides
    // CORS_ORIGIN; in production either must be explicit, non-loopback and
    // non-wildcard (backend#1236), else the request is refused.
    let whitelist: string[];
    try {
      whitelist = resolveAllowedOrigins({
        corsOriginEnv: process.env.BRIDGE_ALLOWED_ORIGINS || process.env.CORS_ORIGIN,
        developmentDefaults: ['http://localhost:3000', 'http://localhost:4001'],
      });
    } catch (error) {
      callback(error as Error);
      return;
    }

    if (!origin || whitelist.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Signature', 'X-Timestamp'],
  maxAge: 86400, // 24 hours
};

/**
 * Helper functions
 */
function isValidAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  // EVM address validation
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return true;
  }

  // Cosmos address validation
  if (/^(cosmos|osmo)[a-z0-9]{39}$/.test(address)) {
    return true;
  }

  // Basic validation for other chain types
  if (address.length >= 20 && address.length <= 128) {
    return true;
  }

  return false;
}

function generateRequestId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Error handler middleware
 */
export function bridgeErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  logError(crosschainLogger, 'Bridge operation error', err, {
    operation: 'bridge:error',
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    error: 'Bridge operation failed',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
  });
}
