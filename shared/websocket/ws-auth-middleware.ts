/**
 * WebSocket Authentication Middleware
 * Task 74: JWT verification during WebSocket upgrade handshake
 *
 * Extends patterns from backend/src/websocket/auth.ts
 * Integrates with RBAC from backend/shared/rbac.ts
 */

import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import type { IncomingMessage } from 'http';
import * as fs from 'fs';
import { appLogger } from '../../server/utils/logger.js';
import {
  WebSocketAuthResult,
  WebSocketJWTPayload,
  WebSocketAuthConfig,
  DEFAULT_AUTH_CONFIG,
  UserRole,
  ROLE_LEVELS,
} from './types.js';
import { isValidRole } from '../rbac.js';

// Environment configuration
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_PUBLIC_KEY_PATH = process.env.JWT_PUBLIC_KEY_PATH;
const NODE_ENV = process.env.NODE_ENV || 'development';

/**
 * WebSocket Authentication Middleware
 * Verifies JWT tokens during WebSocket upgrade handshake
 */
export class WebSocketAuthMiddleware {
  private config: WebSocketAuthConfig;
  private jwtSecret: string | Buffer;
  private jwtPublicKey: string | undefined;

  constructor(config: Partial<WebSocketAuthConfig> = {}) {
    this.config = { ...DEFAULT_AUTH_CONFIG, ...config };

    // Load JWT secret
    if (config.jwtSecret) {
      this.jwtSecret = config.jwtSecret;
    } else if (JWT_SECRET) {
      this.jwtSecret = JWT_SECRET;
    } else {
      throw new Error('JWT_SECRET environment variable is required for WebSocket authentication');
    }

    // Load JWT public key for RS256 if available
    const publicKeyPath = config.jwtPublicKeyPath || JWT_PUBLIC_KEY_PATH;
    if (publicKeyPath && fs.existsSync(publicKeyPath)) {
      try {
        this.jwtPublicKey = fs.readFileSync(publicKeyPath, 'utf8');
        // Add RS256 to algorithms if public key is available
        if (!this.config.algorithms.includes('RS256')) {
          this.config.algorithms.push('RS256');
        }
      } catch (error) {
        appLogger.warn('Failed to load JWT public key', { module: 'WSAuth', error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Add development origins in non-production
    if (NODE_ENV !== 'production') {
      const devOrigins = ['http://localhost:3000', 'http://localhost:5000', 'http://0.0.0.0:5000'];
      devOrigins.forEach((origin) => {
        if (!this.config.allowedOrigins.includes(origin)) {
          this.config.allowedOrigins.push(origin);
        }
      });
    }
  }

  /**
   * Authenticate WebSocket upgrade request
   * Supports: Authorization header, Sec-WebSocket-Protocol, Cookie
   */
  async authenticate(req: IncomingMessage): Promise<WebSocketAuthResult> {
    try {
      // 1. Origin validation
      const origin = req.headers.origin;
      if (origin && !this.isAllowedOrigin(origin)) {
        return {
          authenticated: false,
          error: {
            code: 'INVALID_ORIGIN',
            message: `Origin '${origin}' not allowed`,
          },
        };
      }

      if (this.usesLegacyQueryToken(req)) {
        return {
          authenticated: false,
          error: {
            code: 'INVALID_TOKEN',
            message:
              'WebSocket JWTs in URL query parameters are not supported; use Authorization or Sec-WebSocket-Protocol',
          },
        };
      }

      // 2. Extract token (priority: header > protocol > cookie)
      const token = this.extractToken(req);

      // 3. Handle guest access if enabled and no token
      if (!token) {
        if (this.config.allowGuestAccess) {
          return this.createGuestSession();
        }
        return {
          authenticated: false,
          error: {
            code: 'NO_TOKEN',
            message: 'Authentication token required',
          },
        };
      }

      // 4. Verify JWT
      const decoded = await this.verifyToken(token);
      if (!decoded) {
        return {
          authenticated: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'Token verification failed',
          },
        };
      }

      // 5. Validate payload structure
      const validationResult = this.validatePayload(decoded);
      if (!validationResult.valid) {
        return {
          authenticated: false,
          error: {
            code: 'INVALID_TOKEN',
            message: validationResult.reason || 'Invalid token payload',
          },
        };
      }

      // 6. Check token expiry
      const now = Math.floor(Date.now() / 1000);
      if (decoded.exp && decoded.exp < now) {
        return {
          authenticated: false,
          error: {
            code: 'TOKEN_EXPIRED',
            message: 'Token has expired',
          },
        };
      }

      // 7. Generate session ID
      const sessionId = this.generateSessionId(decoded.id);

      return {
        authenticated: true,
        user: decoded,
        sessionId,
      };
    } catch (error) {
      return this.handleAuthError(error);
    }
  }

  /**
   * Extract JWT token from request
   * Priority: Authorization header > Sec-WebSocket-Protocol > Cookie
   */
  private extractToken(req: IncomingMessage): string | null {
    // 1. Authorization header (Bearer scheme)
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    // 2. Sec-WebSocket-Protocol using a non-sensitive bearer marker.
    const protocolHeader = req.headers['sec-websocket-protocol'];
    const protocolToken = this.extractTokenFromProtocolHeader(protocolHeader);
    if (protocolToken) {
      return protocolToken;
    }

    // 3. Cookie (wrfcoin_auth_token)
    const cookies = req.headers.cookie;
    if (cookies) {
      const match = cookies.match(/wrfcoin_auth_token=([^;]+)/);
      if (match) {
        return decodeURIComponent(match[1]);
      }
    }

    return null;
  }

  private extractTokenFromProtocolHeader(
    headerValue: string | string[] | undefined
  ): string | null {
    const rawValues = Array.isArray(headerValue)
      ? headerValue
      : typeof headerValue === 'string'
        ? [headerValue]
        : [];

    const candidates = rawValues
      .flatMap(value => value.split(','))
      .map(value => value.trim())
      .filter(Boolean);

    const bearerIndex = candidates.findIndex(
      value => value.toLowerCase() === 'bearer'
    );
    if (bearerIndex !== -1 && candidates[bearerIndex + 1]) {
      return candidates[bearerIndex + 1];
    }

    const prefixedToken = candidates.find(value =>
      value.toLowerCase().startsWith('bearer.')
    );
    if (prefixedToken) {
      return prefixedToken.slice('bearer.'.length);
    }

    return null;
  }

  private usesLegacyQueryToken(req: IncomingMessage): boolean {
    try {
      const host = req.headers.host || 'localhost';
      const protocol = (req.socket as any)?.encrypted ? 'wss' : 'ws';
      const parsedUrl = new URL(req.url || '/', `${protocol}://${host}`);
      return parsedUrl.searchParams.has('token');
    } catch {
      return false;
    }
  }

  /**
   * Verify JWT token
   */
  private async verifyToken(token: string): Promise<WebSocketJWTPayload | null> {
    try {
      // Determine which key to use based on token header
      const tokenHeader = this.decodeTokenHeader(token);
      let secret: string | Buffer;

      if (tokenHeader?.alg === 'RS256' && this.jwtPublicKey) {
        secret = this.jwtPublicKey;
      } else {
        secret = this.jwtSecret;
      }

      const decoded = jwt.verify(token, secret, {
        algorithms: this.config.algorithms as jwt.Algorithm[],
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockTolerance: this.config.clockTolerance,
      }) as WebSocketJWTPayload;

      return decoded;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw { code: 'TOKEN_EXPIRED', message: 'Token has expired', expiredAt: error.expiredAt };
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw { code: 'INVALID_TOKEN', message: error.message };
      }
      throw error;
    }
  }

  /**
   * Decode token header without verification (to determine algorithm)
   */
  private decodeTokenHeader(token: string): { alg?: string; typ?: string } | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
      return header;
    } catch {
      return null;
    }
  }

  /**
   * Validate JWT payload structure
   */
  private validatePayload(payload: WebSocketJWTPayload): { valid: boolean; reason?: string } {
    // Required fields
    if (!payload.id) {
      return { valid: false, reason: 'Missing user ID' };
    }

    if (!payload.address) {
      return { valid: false, reason: 'Missing wallet address' };
    }

    if (!payload.role) {
      return { valid: false, reason: 'Missing user role' };
    }

    // Validate role
    if (!this.isValidRole(payload.role)) {
      return { valid: false, reason: `Invalid role: ${payload.role}` };
    }

    // Validate wallet address format (Ethereum-style)
    if (!this.isValidWalletAddress(payload.address)) {
      return { valid: false, reason: 'Invalid wallet address format' };
    }

    return { valid: true };
  }

  /**
   * Check if role is valid
   */
  private isValidRole(role: string): role is UserRole {
    return role in ROLE_LEVELS || isValidRole(role);
  }

  /**
   * Validate wallet address format
   */
  private isValidWalletAddress(address: string): boolean {
    // Ethereum-style address validation
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  /**
   * Check if origin is allowed
   */
  private isAllowedOrigin(origin: string): boolean {
    // Allow if no origins configured (development mode)
    if (this.config.allowedOrigins.length === 0 && NODE_ENV !== 'production') {
      return true;
    }

    return this.config.allowedOrigins.some((allowed) => {
      // Exact match
      if (allowed === origin) return true;
      // Wildcard subdomain match (e.g., *.wrfcoin.com)
      if (allowed.startsWith('*.')) {
        const domain = allowed.slice(2);
        return origin.endsWith(domain);
      }
      return false;
    });
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(userId: string): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `ws_${userId.slice(0, 8)}_${timestamp}_${random}`;
  }

  /**
   * Create guest session for unauthenticated access
   */
  private createGuestSession(): WebSocketAuthResult {
    const guestId = `guest_${crypto.randomBytes(8).toString('hex')}`;
    const now = Math.floor(Date.now() / 1000);

    return {
      authenticated: true,
      user: {
        id: guestId,
        address: '0x0000000000000000000000000000000000000000',
        role: 'guest',
        permissions: [],
        iat: now,
        exp: now + 3600, // 1 hour for guests
      },
      sessionId: this.generateSessionId(guestId),
    };
  }

  /**
   * Handle authentication errors
   */
  private handleAuthError(error: unknown): WebSocketAuthResult {
    if (error && typeof error === 'object') {
      const err = error as { code?: string; message?: string };
      if (err.code === 'TOKEN_EXPIRED') {
        return {
          authenticated: false,
          error: {
            code: 'TOKEN_EXPIRED',
            message: err.message || 'Token has expired',
          },
        };
      }
      if (err.code === 'INVALID_TOKEN') {
        return {
          authenticated: false,
          error: {
            code: 'INVALID_TOKEN',
            message: err.message || 'Invalid token',
          },
        };
      }
    }

    appLogger.error('Authentication error', { module: 'WSAuth', error: error instanceof Error ? error.message : String(error) });
    return {
      authenticated: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Authentication failed',
      },
    };
  }

  /**
   * Get client IP address from request
   */
  static getClientIp(req: IncomingMessage): string {
    // Check X-Forwarded-For header (from reverse proxy)
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(',')[0];
      return ips.trim();
    }

    // Check X-Real-IP header (nginx)
    const realIp = req.headers['x-real-ip'];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0] : realIp;
    }

    // Fall back to socket remote address
    const socketAddress = req.socket?.remoteAddress;
    if (socketAddress) {
      // Handle IPv4-mapped IPv6 addresses
      return socketAddress.replace(/^::ffff:/, '');
    }

    return '0.0.0.0';
  }

  /**
   * Get user agent from request
   */
  static getUserAgent(req: IncomingMessage): string {
    const userAgent = req.headers['user-agent'];
    return userAgent || 'unknown';
  }
}

/**
 * Create singleton instance with default configuration
 */
let defaultInstance: WebSocketAuthMiddleware | null = null;

export function getWebSocketAuthMiddleware(
  config?: Partial<WebSocketAuthConfig>,
): WebSocketAuthMiddleware {
  if (!defaultInstance || config) {
    defaultInstance = new WebSocketAuthMiddleware(config);
  }
  return defaultInstance;
}

/**
 * Express/Connect-style middleware factory for HTTP upgrade
 */
export function createUpgradeMiddleware(config?: Partial<WebSocketAuthConfig>) {
  const authMiddleware = new WebSocketAuthMiddleware(config);

  return async (
    req: IncomingMessage,
    socket: any,
    head: Buffer,
    next: (authResult: WebSocketAuthResult) => void,
  ) => {
    const authResult = await authMiddleware.authenticate(req);
    next(authResult);
  };
}
