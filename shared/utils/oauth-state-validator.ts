/**
 * OAuth State Validation Utility
 * Task 102.13 - OAuth State Validation for Security Remediation
 *
 * SECURITY: This module implements CSRF-style state parameter generation and validation
 * for OAuth flows to prevent CSRF attacks during the OAuth authorization process.
 *
 * Features:
 * - Cryptographically secure state token generation
 * - HMAC-SHA256 for integrity verification
 * - Short expiry (5 minutes) for state tokens
 * - Session binding to prevent state token reuse across sessions
 * - Single-use token enforcement
 */

import * as crypto from 'crypto';
import { securityLogger } from '../../server/utils/logger.js';
import { isSafeRedirectUri } from './redirect-uri-validator.js';

/**
 * OAuth State payload structure
 * Contains all data needed to validate the OAuth callback
 */
export interface OAuthState {
  /** Random nonce for uniqueness */
  nonce: string;
  /** Creation timestamp in milliseconds */
  timestamp: number;
  /** Session ID the state is bound to */
  sessionId: string;
  /** OAuth provider (e.g., 'google', 'github', 'microsoft') */
  provider: string;
  /** Optional redirect URL after OAuth completion */
  redirectUri?: string;
}

/**
 * Result of state validation
 */
export interface OAuthStateValidationResult {
  /** Whether the state is valid */
  isValid: boolean;
  /** Parsed state data if valid */
  state?: OAuthState;
  /** Error message if invalid */
  error?: string;
  /** Error code for programmatic handling */
  errorCode?: OAuthStateErrorCode;
}

/**
 * Error codes for OAuth state validation failures
 */
export type OAuthStateErrorCode =
  | 'INVALID_FORMAT'
  | 'INVALID_SIGNATURE'
  | 'EXPIRED'
  | 'SESSION_MISMATCH'
  | 'ALREADY_USED'
  | 'MISSING_STATE'
  | 'MISSING_SECRET';

/**
 * Configuration for OAuth state validation
 */
export interface OAuthStateConfig {
  /** State token expiry time in milliseconds (default: 5 minutes) */
  expiryMs?: number;
  /** Secret key for HMAC signing (defaults to OAUTH_STATE_SECRET env var) */
  secret?: string;
}

// Default configuration
const DEFAULT_CONFIG: Required<OAuthStateConfig> = {
  expiryMs: 5 * 60 * 1000, // 5 minutes
  secret: process.env.OAUTH_STATE_SECRET || '',
};

/**
 * In-memory store for used state tokens
 * SECURITY: Prevents state token reuse (single-use enforcement)
 * In production, this should be backed by Redis for distributed systems
 */
const usedStates = new Map<string, number>();

// Cleanup interval for expired used states (runs every minute)
const CLEANUP_INTERVAL = 60 * 1000;
let cleanupTimer: NodeJS.Timeout | null = null;

/**
 * Start the cleanup timer for used states
 * Removes entries older than 2x the expiry time
 */
function startCleanupTimer(expiryMs: number): void {
  if (cleanupTimer) return;

  cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - expiryMs * 2;
    // Use Array.from for ES2020 compatibility
    const entries = Array.from(usedStates.entries());
    for (const [key, timestamp] of entries) {
      if (timestamp < cutoff) {
        usedStates.delete(key);
      }
    }
  }, CLEANUP_INTERVAL);

  // Don't prevent Node.js from exiting
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

/**
 * Stop the cleanup timer (for testing/shutdown)
 */
export function stopCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * Clear all used states (for testing)
 */
export function clearUsedStates(): void {
  usedStates.clear();
}

/**
 * OAuth State Validator Class
 * Provides secure state parameter generation and validation for OAuth flows
 */
export class OAuthStateValidator {
  private readonly config: Required<OAuthStateConfig>;

  /**
   * Create a new OAuthStateValidator instance
   *
   * @param config - Optional configuration overrides
   * @throws Error if OAUTH_STATE_SECRET is not set in production
   */
  constructor(config?: OAuthStateConfig) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    // SECURITY: Fail fast if secret is not configured in production or testnet.
    // Testnet is treated the same as production here because testnet OAuth
    // callbacks are reachable from the public internet just like production.
    const nodeEnv = (process.env.NODE_ENV || 'development').toLowerCase();
    const requiresSecret = nodeEnv === 'production' || nodeEnv === 'testnet';
    if (!this.config.secret && requiresSecret) {
      throw new Error(
        `OAUTH_STATE_SECRET environment variable must be set when NODE_ENV=${nodeEnv}`
      );
    }

    // Use a default secret only in development/test
    if (!this.config.secret) {
      securityLogger.warn('OAUTH_STATE_SECRET missing — falling back to insecure dev value', {
        module: 'OAuthStateValidator',
        nodeEnv,
        action: 'Set OAUTH_STATE_SECRET (openssl rand -hex 32) before any non-dev deployment',
      });
      this.config.secret = 'dev-oauth-state-secret-do-not-use-in-production';
    }

    // Start cleanup timer
    startCleanupTimer(this.config.expiryMs);
  }

  /**
   * Generate a secure OAuth state token
   *
   * @param sessionId - The session ID to bind the state to
   * @param provider - The OAuth provider name
   * @param redirectUri - Optional redirect URI after OAuth completion
   * @returns The encoded state token (base64url JSON + "." + HMAC signature)
   */
  generateState(
    sessionId: string,
    provider: string,
    redirectUri?: string
  ): string {
    let safeRedirectUri = redirectUri;
    if (redirectUri && !isSafeRedirectUri(redirectUri)) {
      securityLogger.warn('OAuth state rejected unsafe redirect URI', {
        module: 'OAuthStateValidator',
        redirectUri,
        threat: 'open_redirect_blocked',
      });
      safeRedirectUri = undefined;
    }

    // SECURITY: Generate cryptographically secure nonce
    const nonce = crypto.randomBytes(16).toString('hex');

    const state: OAuthState = {
      nonce,
      timestamp: Date.now(),
      sessionId,
      provider,
      redirectUri: safeRedirectUri,
    };

    // Encode state as base64url JSON
    const stateJson = JSON.stringify(state);
    const stateBase64 = this.base64urlEncode(Buffer.from(stateJson, 'utf8'));

    // Generate HMAC signature
    const signature = this.generateSignature(stateBase64);

    // Return state in format: base64url(JSON) + "." + signature
    return `${stateBase64}.${signature}`;
  }

  /**
   * Validate an OAuth state token
   *
   * @param stateToken - The state token from OAuth callback
   * @param currentSessionId - The current session ID for binding verification
   * @returns Validation result with parsed state if valid
   */
  validateState(
    stateToken: string | undefined | null,
    currentSessionId: string
  ): OAuthStateValidationResult {
    // Check for missing state
    if (!stateToken) {
      return {
        isValid: false,
        error: 'Missing state parameter',
        errorCode: 'MISSING_STATE',
      };
    }

    // Parse state token format
    const parts = stateToken.split('.');
    if (parts.length !== 2) {
      return {
        isValid: false,
        error: 'Invalid state format',
        errorCode: 'INVALID_FORMAT',
      };
    }

    const [stateBase64, providedSignature] = parts;

    // SECURITY: Verify HMAC signature using constant-time comparison
    const expectedSignature = this.generateSignature(stateBase64);
    if (!this.constantTimeCompare(providedSignature, expectedSignature)) {
      // Log potential tampering attempt
      securityLogger.warn('OAuth state validation failed: Invalid signature', { module: 'OAuthStateValidator', threat: 'Potential tampering attempt' });
      return {
        isValid: false,
        error: 'Invalid state signature',
        errorCode: 'INVALID_SIGNATURE',
      };
    }

    // Decode and parse state JSON
    let state: OAuthState;
    try {
      const stateJson = this.base64urlDecode(stateBase64).toString('utf8');
      state = JSON.parse(stateJson);
    } catch (error) {
      return {
        isValid: false,
        error: 'Invalid state data',
        errorCode: 'INVALID_FORMAT',
      };
    }

    // Check expiry (5 minutes default)
    const age = Date.now() - state.timestamp;
    if (age > this.config.expiryMs) {
      securityLogger.warn('OAuth state expired', { module: 'OAuthStateValidator', ageMs: age, maxMs: this.config.expiryMs });
      return {
        isValid: false,
        error: 'State token has expired',
        errorCode: 'EXPIRED',
      };
    }

    // SECURITY: Verify session binding
    if (state.sessionId !== currentSessionId) {
      // Log potential session hijacking attempt
      securityLogger.warn('OAuth state validation failed: Session mismatch', { module: 'OAuthStateValidator', threat: 'Potential session hijacking attempt', expectedSession: state.sessionId.slice(0, 8) + '...', providedSession: currentSessionId.slice(0, 8) + '...' });
      return {
        isValid: false,
        error: 'State is bound to a different session',
        errorCode: 'SESSION_MISMATCH',
      };
    }

    // SECURITY: Check for state reuse (single-use enforcement)
    const stateKey = `${state.sessionId}:${state.nonce}`;
    if (usedStates.has(stateKey)) {
      securityLogger.warn('OAuth state validation failed: State already used', { module: 'OAuthStateValidator', threat: 'Potential replay attack' });
      return {
        isValid: false,
        error: 'State token has already been used',
        errorCode: 'ALREADY_USED',
      };
    }

    // Mark state as used
    usedStates.set(stateKey, Date.now());

    return {
      isValid: true,
      state,
    };
  }

  /**
   * Generate HMAC-SHA256 signature for state data
   *
   * @param data - The data to sign
   * @returns Base64url encoded HMAC signature
   */
  private generateSignature(data: string): string {
    const hmac = crypto.createHmac('sha256', this.config.secret);
    hmac.update(data);
    return this.base64urlEncode(hmac.digest());
  }

  /**
   * Base64url encode a buffer (URL-safe base64)
   *
   * @param buffer - The buffer to encode
   * @returns Base64url encoded string
   */
  private base64urlEncode(buffer: Buffer): string {
    return buffer
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * Base64url decode a string
   *
   * @param str - The base64url string to decode
   * @returns Decoded buffer
   */
  private base64urlDecode(str: string): Buffer {
    // Add padding if necessary
    let padded = str.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - (padded.length % 4)) % 4;
    padded += '='.repeat(padding);
    return Buffer.from(padded, 'base64');
  }

  /**
   * Constant-time string comparison to prevent timing attacks
   *
   * @param a - First string
   * @param b - Second string
   * @returns True if strings are equal
   */
  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      // Even for different lengths, we need to do some work to prevent timing attacks
      // Use the shorter string's length and always fail
      const minLength = Math.min(a.length, b.length);
      let result = 0;
      for (let i = 0; i < minLength; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
      }
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Get the configured expiry time in milliseconds
   */
  getExpiryMs(): number {
    return this.config.expiryMs;
  }
}

// Default singleton instance
let defaultValidator: OAuthStateValidator | null = null;

/**
 * Get the default OAuthStateValidator instance
 *
 * @returns Default validator instance
 */
export function getOAuthStateValidator(): OAuthStateValidator {
  if (!defaultValidator) {
    defaultValidator = new OAuthStateValidator();
  }
  return defaultValidator;
}

/**
 * Generate a secure OAuth state token using the default validator
 *
 * @param sessionId - The session ID to bind the state to
 * @param provider - The OAuth provider name
 * @param redirectUri - Optional redirect URI after OAuth completion
 * @returns The encoded state token
 */
export function generateOAuthState(
  sessionId: string,
  provider: string,
  redirectUri?: string
): string {
  return getOAuthStateValidator().generateState(sessionId, provider, redirectUri);
}

/**
 * Validate an OAuth state token using the default validator
 *
 * @param stateToken - The state token from OAuth callback
 * @param currentSessionId - The current session ID for binding verification
 * @returns Validation result with parsed state if valid
 */
export function validateOAuthState(
  stateToken: string | undefined | null,
  currentSessionId: string
): OAuthStateValidationResult {
  return getOAuthStateValidator().validateState(stateToken, currentSessionId);
}

/**
 * Log OAuth state validation failure for security monitoring
 *
 * @param result - The validation result
 * @param additionalContext - Additional context for logging
 */
export function logOAuthStateFailure(
  result: OAuthStateValidationResult,
  additionalContext?: {
    ipAddress?: string;
    userAgent?: string;
    provider?: string;
  }
): void {
  if (result.isValid) return;

  securityLogger.error('OAuth state validation failure', {
    module: 'OAuthStateValidator',
    errorCode: result.errorCode,
    error: result.error,
    ...additionalContext,
  });

  // In a production system, this would also:
  // - Log to a security event monitoring system
  // - Increment metrics counters for alerting
  // - Potentially trigger rate limiting for the IP
}
