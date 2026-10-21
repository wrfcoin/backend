/**
 * Credential Stuffing Protection Middleware
 *
 * SECURITY IMPLEMENTATION (Task 102.15):
 * - Account-level lockout (not just IP-based)
 * - User enumeration prevention with consistent timing
 * - Login attempt logging for audit
 * - Suspicious activity detection
 * - Optional CAPTCHA integration after failed attempts
 *
 * @module credential-stuffing-protection
 */

import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { securityLogger } from '../utils/logger.js';

// =====================================================
// TYPE DEFINITIONS
// =====================================================

/**
 * Account lockout record stored in memory/database
 */
export interface AccountLockoutRecord {
  userId: string;
  email: string;
  failedAttempts: number;
  lastAttempt: Date;
  lockedUntil: Date | null;
  lockoutHistory: Date[];
}

/**
 * Login attempt log entry for security audit
 */
export interface LoginAttemptLog {
  id: string;
  email: string;
  emailHash: string; // SHA-256 hash for privacy
  ipAddress: string;
  userAgent: string;
  timestamp: Date;
  success: boolean;
  failureReason?: string;
  geoLocation?: {
    country?: string;
    region?: string;
    city?: string;
  };
  deviceFingerprint?: string;
  suspiciousFlags: string[];
}

/**
 * Suspicious activity detection result
 */
export interface SuspiciousActivityResult {
  suspicious: boolean;
  reason?: string;
  riskScore: number; // 0-100
  flags: string[];
  recommendations: string[];
}

/**
 * IP activity tracking for detecting credential stuffing patterns
 */
interface IPActivityRecord {
  ip: string;
  attemptedEmails: Set<string>;
  totalAttempts: number;
  failedAttempts: number;
  lastAttempt: Date;
  windowStart: Date;
}

// =====================================================
// CONFIGURATION CONSTANTS
// =====================================================

/**
 * Account lockout configuration
 */
const LOCKOUT_CONFIG = {
  /** Maximum failed attempts before account lockout */
  MAX_FAILED_ATTEMPTS: 5,
  /** Lockout duration in milliseconds (30 minutes) */
  LOCKOUT_DURATION_MS: 30 * 60 * 1000,
  /** Progressive lockout multiplier for repeat offenders */
  PROGRESSIVE_LOCKOUT_MULTIPLIER: 2,
  /** Maximum lockout duration (24 hours) */
  MAX_LOCKOUT_DURATION_MS: 24 * 60 * 60 * 1000,
  /** Window for counting failed attempts (15 minutes) */
  ATTEMPT_WINDOW_MS: 15 * 60 * 1000,
};

/**
 * User enumeration prevention configuration
 */
const ENUMERATION_PREVENTION_CONFIG = {
  /** Base response delay in milliseconds */
  BASE_DELAY_MS: 500,
  /** Random delay range in milliseconds */
  RANDOM_DELAY_MS: 500,
  /** Generic error message for all authentication failures */
  GENERIC_ERROR_MESSAGE: 'Invalid email or password',
};

/**
 * Suspicious activity detection thresholds
 */
const SUSPICIOUS_ACTIVITY_CONFIG = {
  /** Max unique emails from single IP in window */
  MAX_EMAILS_PER_IP: 10,
  /** Max IPs attempting same account in window */
  MAX_IPS_PER_ACCOUNT: 5,
  /** Time window for tracking (1 hour) */
  TRACKING_WINDOW_MS: 60 * 60 * 1000,
  /** Failed attempts from IP triggering alert */
  IP_FAILURE_THRESHOLD: 20,
};

/**
 * CAPTCHA configuration
 */
const CAPTCHA_CONFIG = {
  /** Failed attempts before requiring CAPTCHA */
  CAPTCHA_THRESHOLD: 3,
  /** Window for counting failed attempts for CAPTCHA (10 minutes) */
  CAPTCHA_WINDOW_MS: 10 * 60 * 1000,
};

// =====================================================
// IN-MEMORY STORAGE (Replace with Redis in production)
// =====================================================

/**
 * Account lockout records
 * Key: normalized email address
 */
const accountLockouts = new Map<string, AccountLockoutRecord>();

/**
 * Login attempt logs (recent only, older should be persisted to database)
 */
const recentLoginAttempts: LoginAttemptLog[] = [];
const MAX_RECENT_ATTEMPTS = 10000;

/**
 * IP activity tracking
 * Key: IP address
 */
const ipActivityRecords = new Map<string, IPActivityRecord>();

/**
 * Account IP tracking (for detecting multiple IPs per account)
 * Key: normalized email, Value: Set of IPs
 */
const accountIpTracking = new Map<string, Map<string, Date>>();

// =====================================================
// UTILITY FUNCTIONS
// =====================================================

/**
 * Normalize email for consistent comparison
 */
function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Hash email for privacy-preserving logging
 */
function hashEmail(email: string): string {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

/**
 * Generate unique ID for log entries
 */
function generateLogId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Clean expired records from tracking maps
 */
function cleanExpiredRecords(): void {
  const now = Date.now();

  // Clean expired lockouts
  Array.from(accountLockouts.entries()).forEach(([email, record]) => {
    if (record.lockedUntil && record.lockedUntil.getTime() < now) {
      // Check if we should reset failed attempts (outside attempt window)
      if (now - record.lastAttempt.getTime() > LOCKOUT_CONFIG.ATTEMPT_WINDOW_MS) {
        accountLockouts.delete(email);
      } else {
        // Unlock but keep failed attempt count for progressive lockout
        record.lockedUntil = null;
      }
    }
  });

  // Clean expired IP tracking records
  const trackingCutoff = now - SUSPICIOUS_ACTIVITY_CONFIG.TRACKING_WINDOW_MS;
  Array.from(ipActivityRecords.entries()).forEach(([ip, record]) => {
    if (record.windowStart.getTime() < trackingCutoff) {
      ipActivityRecords.delete(ip);
    }
  });

  // Clean expired account IP tracking
  Array.from(accountIpTracking.entries()).forEach(([email, ipMap]) => {
    Array.from(ipMap.entries()).forEach(([ip, timestamp]) => {
      if (timestamp.getTime() < trackingCutoff) {
        ipMap.delete(ip);
      }
    });
    if (ipMap.size === 0) {
      accountIpTracking.delete(email);
    }
  });

  // Clean old login attempts (keep only recent)
  while (recentLoginAttempts.length > MAX_RECENT_ATTEMPTS) {
    recentLoginAttempts.shift();
  }
}

// Run cleanup every 5 minutes
// #977 ratchet: unref'd — created at import, must not hold the loop open.
const importTimeTimer2 = setInterval(cleanExpiredRecords, 5 * 60 * 1000);
importTimeTimer2.unref();

// =====================================================
// CORE PROTECTION FUNCTIONS
// =====================================================

/**
 * Check if an account is locked out
 *
 * @param email - The email address to check
 * @returns Object indicating lock status and unlock time
 */
export async function checkAccountLockout(
  email: string
): Promise<{ locked: boolean; unlockAt?: Date; remainingAttempts?: number }> {
  const normalizedEmail = normalizeEmail(email);
  const record = accountLockouts.get(normalizedEmail);

  if (!record) {
    return {
      locked: false,
      remainingAttempts: LOCKOUT_CONFIG.MAX_FAILED_ATTEMPTS,
    };
  }

  const now = Date.now();

  // Check if lockout is expired
  if (record.lockedUntil) {
    if (record.lockedUntil.getTime() > now) {
      return {
        locked: true,
        unlockAt: record.lockedUntil,
      };
    }
    // Lockout expired, clear it but keep record for progressive lockout
    record.lockedUntil = null;
  }

  // Check if we should reset failed attempts (outside attempt window)
  if (now - record.lastAttempt.getTime() > LOCKOUT_CONFIG.ATTEMPT_WINDOW_MS) {
    // Reset attempts but keep lockout history
    record.failedAttempts = 0;
  }

  const remainingAttempts = Math.max(
    0,
    LOCKOUT_CONFIG.MAX_FAILED_ATTEMPTS - record.failedAttempts
  );

  return {
    locked: false,
    remainingAttempts,
  };
}

/**
 * Record a failed login attempt and potentially lock the account
 *
 * @param email - The email address that failed
 * @returns Updated lockout status
 */
export async function recordFailedAttempt(
  email: string
): Promise<{ locked: boolean; unlockAt?: Date; attemptNumber: number }> {
  const normalizedEmail = normalizeEmail(email);
  const now = new Date();

  let record = accountLockouts.get(normalizedEmail);

  if (!record) {
    record = {
      userId: normalizedEmail, // Will be updated with real userId if account exists
      email: normalizedEmail,
      failedAttempts: 0,
      lastAttempt: now,
      lockedUntil: null,
      lockoutHistory: [],
    };
    accountLockouts.set(normalizedEmail, record);
  }

  // Check if we should reset the window
  if (now.getTime() - record.lastAttempt.getTime() > LOCKOUT_CONFIG.ATTEMPT_WINDOW_MS) {
    record.failedAttempts = 0;
  }

  record.failedAttempts++;
  record.lastAttempt = now;

  // Check if we should lock the account
  if (record.failedAttempts >= LOCKOUT_CONFIG.MAX_FAILED_ATTEMPTS) {
    // Calculate lockout duration with progressive multiplier
    const lockoutCount = record.lockoutHistory.length;
    const baseDuration = LOCKOUT_CONFIG.LOCKOUT_DURATION_MS;
    const multiplier = Math.pow(
      LOCKOUT_CONFIG.PROGRESSIVE_LOCKOUT_MULTIPLIER,
      Math.min(lockoutCount, 5) // Cap at 5 to prevent extreme durations
    );
    const duration = Math.min(
      baseDuration * multiplier,
      LOCKOUT_CONFIG.MAX_LOCKOUT_DURATION_MS
    );

    record.lockedUntil = new Date(now.getTime() + duration);
    record.lockoutHistory.push(now);

    return {
      locked: true,
      unlockAt: record.lockedUntil,
      attemptNumber: record.failedAttempts,
    };
  }

  return {
    locked: false,
    attemptNumber: record.failedAttempts,
  };
}

/**
 * Clear failed attempts after successful login
 *
 * @param email - The email address to clear
 */
export async function clearFailedAttempts(email: string): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  const record = accountLockouts.get(normalizedEmail);

  if (record) {
    record.failedAttempts = 0;
    record.lockedUntil = null;
    // Keep lockout history for progressive lockout on future violations
  }
}

/**
 * Add consistent response delay to prevent timing attacks
 *
 * This ensures valid and invalid email responses take similar time,
 * preventing user enumeration through timing analysis.
 */
export async function addResponseDelay(): Promise<void> {
  const delay =
    ENUMERATION_PREVENTION_CONFIG.BASE_DELAY_MS +
    Math.random() * ENUMERATION_PREVENTION_CONFIG.RANDOM_DELAY_MS;

  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Log a login attempt for security audit
 *
 * @param attempt - The login attempt details
 */
export async function logLoginAttempt(
  attempt: Omit<LoginAttemptLog, 'id' | 'emailHash' | 'timestamp'>
): Promise<void> {
  const logEntry: LoginAttemptLog = {
    id: generateLogId(),
    emailHash: hashEmail(attempt.email),
    timestamp: new Date(),
    ...attempt,
  };

  recentLoginAttempts.push(logEntry);

  // In production, also persist to database
  // await db.insert(loginAttemptLogs).values(logEntry);

  // Log security-relevant attempts
  if (!attempt.success || attempt.suspiciousFlags.length > 0) {
    securityLogger.warn('Login attempt logged', {
      operation: 'credential:stuffing:login:attempt',
      emailHash: logEntry.emailHash.substring(0, 16) + '...',
      ip: logEntry.ipAddress,
      success: logEntry.success,
      failureReason: logEntry.failureReason,
      suspiciousFlags: logEntry.suspiciousFlags,
    });
  }
}

/**
 * Detect suspicious activity patterns
 *
 * Analyzes login patterns to detect:
 * - Multiple IPs trying the same account
 * - Same IP trying multiple accounts (credential stuffing)
 * - Unusual geographic locations
 * - Known malicious IP patterns
 *
 * @param email - The email being attempted
 * @param ip - The IP address making the attempt
 * @param userAgent - The user agent string
 * @returns Suspicious activity analysis result
 */
export async function detectSuspiciousActivity(
  email: string,
  ip: string,
  userAgent?: string
): Promise<SuspiciousActivityResult> {
  const normalizedEmail = normalizeEmail(email);
  const now = new Date();
  const flags: string[] = [];
  let riskScore = 0;
  const recommendations: string[] = [];

  // Track IP activity
  let ipRecord = ipActivityRecords.get(ip);
  if (!ipRecord) {
    ipRecord = {
      ip,
      attemptedEmails: new Set(),
      totalAttempts: 0,
      failedAttempts: 0,
      lastAttempt: now,
      windowStart: now,
    };
    ipActivityRecords.set(ip, ipRecord);
  }

  // Reset window if expired
  if (
    now.getTime() - ipRecord.windowStart.getTime() >
    SUSPICIOUS_ACTIVITY_CONFIG.TRACKING_WINDOW_MS
  ) {
    ipRecord.attemptedEmails.clear();
    ipRecord.totalAttempts = 0;
    ipRecord.failedAttempts = 0;
    ipRecord.windowStart = now;
  }

  ipRecord.attemptedEmails.add(normalizedEmail);
  ipRecord.totalAttempts++;
  ipRecord.lastAttempt = now;

  // Check 1: Multiple accounts from same IP (credential stuffing indicator)
  if (ipRecord.attemptedEmails.size > SUSPICIOUS_ACTIVITY_CONFIG.MAX_EMAILS_PER_IP) {
    flags.push('MULTIPLE_ACCOUNTS_FROM_IP');
    riskScore += 40;
    recommendations.push('Consider blocking or rate-limiting this IP');
  } else if (ipRecord.attemptedEmails.size > SUSPICIOUS_ACTIVITY_CONFIG.MAX_EMAILS_PER_IP / 2) {
    flags.push('HIGH_ACCOUNT_VOLUME_FROM_IP');
    riskScore += 20;
  }

  // Track account IP activity
  let accountIps = accountIpTracking.get(normalizedEmail);
  if (!accountIps) {
    accountIps = new Map();
    accountIpTracking.set(normalizedEmail, accountIps);
  }
  accountIps.set(ip, now);

  // Check 2: Multiple IPs trying same account
  if (accountIps.size > SUSPICIOUS_ACTIVITY_CONFIG.MAX_IPS_PER_ACCOUNT) {
    flags.push('MULTIPLE_IPS_FOR_ACCOUNT');
    riskScore += 30;
    recommendations.push('Consider requiring additional verification');
  } else if (accountIps.size > SUSPICIOUS_ACTIVITY_CONFIG.MAX_IPS_PER_ACCOUNT / 2) {
    flags.push('MODERATE_IP_DIVERSITY');
    riskScore += 15;
  }

  // Check 3: High failure rate from IP
  if (ipRecord.failedAttempts > SUSPICIOUS_ACTIVITY_CONFIG.IP_FAILURE_THRESHOLD) {
    flags.push('HIGH_FAILURE_RATE_FROM_IP');
    riskScore += 35;
    recommendations.push('Consider temporary IP block');
  }

  // Check 4: Suspicious user agent patterns
  if (userAgent) {
    // Check for automated tools or missing common browser headers
    const suspiciousAgentPatterns = [
      /curl/i,
      /wget/i,
      /python/i,
      /requests/i,
      /scrapy/i,
      /bot/i,
      /spider/i,
      /headless/i,
      /phantom/i,
      /selenium/i,
    ];

    if (suspiciousAgentPatterns.some((pattern) => pattern.test(userAgent))) {
      flags.push('SUSPICIOUS_USER_AGENT');
      riskScore += 25;
      recommendations.push('Request appears to be from automated tool');
    }

    // Check for very short or generic user agents
    if (userAgent.length < 20) {
      flags.push('SHORT_USER_AGENT');
      riskScore += 10;
    }
  } else {
    flags.push('MISSING_USER_AGENT');
    riskScore += 15;
  }

  // Check 5: Rapid-fire attempts (more than 5 in last 30 seconds)
  const recentFromIp = recentLoginAttempts.filter(
    (attempt) =>
      attempt.ipAddress === ip &&
      now.getTime() - attempt.timestamp.getTime() < 30000
  );
  if (recentFromIp.length > 5) {
    flags.push('RAPID_FIRE_ATTEMPTS');
    riskScore += 30;
    recommendations.push('Implement rate limiting or CAPTCHA');
  }

  // Normalize risk score to 0-100
  riskScore = Math.min(100, riskScore);

  return {
    suspicious: riskScore >= 50 || flags.length >= 2,
    reason:
      flags.length > 0
        ? `Detected: ${flags.join(', ')}`
        : undefined,
    riskScore,
    flags,
    recommendations,
  };
}

/**
 * Record a failed attempt for IP tracking
 *
 * @param ip - The IP address
 */
export function recordIpFailure(ip: string): void {
  const record = ipActivityRecords.get(ip);
  if (record) {
    record.failedAttempts++;
  }
}

/**
 * Check if CAPTCHA should be required
 *
 * Returns true if the email or IP has exceeded the failure threshold
 * within the CAPTCHA window.
 *
 * @param email - The email address being attempted
 * @param ip - The IP address making the attempt
 * @returns Whether CAPTCHA should be required
 */
export async function shouldRequireCaptcha(
  email: string,
  ip: string
): Promise<{
  required: boolean;
  reason?: string;
}> {
  const normalizedEmail = normalizeEmail(email);
  const now = Date.now();
  const windowStart = now - CAPTCHA_CONFIG.CAPTCHA_WINDOW_MS;

  // Check failed attempts on this email
  const record = accountLockouts.get(normalizedEmail);
  if (
    record &&
    record.failedAttempts >= CAPTCHA_CONFIG.CAPTCHA_THRESHOLD &&
    record.lastAttempt.getTime() > windowStart
  ) {
    return {
      required: true,
      reason: 'Multiple failed attempts on this account',
    };
  }

  // Check failed attempts from this IP
  const recentIpAttempts = recentLoginAttempts.filter(
    (attempt) =>
      attempt.ipAddress === ip &&
      !attempt.success &&
      attempt.timestamp.getTime() > windowStart
  );

  if (recentIpAttempts.length >= CAPTCHA_CONFIG.CAPTCHA_THRESHOLD) {
    return {
      required: true,
      reason: 'Multiple failed attempts from this IP',
    };
  }

  return { required: false };
}

/**
 * Get the generic error message for authentication failures
 *
 * This ensures consistent messaging regardless of whether the email exists,
 * preventing user enumeration.
 */
export function getGenericAuthError(): string {
  return ENUMERATION_PREVENTION_CONFIG.GENERIC_ERROR_MESSAGE;
}

// =====================================================
// EXPRESS MIDDLEWARE
// =====================================================

/**
 * Credential stuffing protection middleware
 *
 * Should be applied before the login route handler.
 * Performs pre-login checks and adds protection utilities to the request.
 */
export const credentialStuffingProtection = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const email = req.body?.username || req.body?.email;
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || '';

  if (!email) {
    // No email provided, let the route handler deal with validation
    next();
    return;
  }

  try {
    // Check account lockout
    const lockoutStatus = await checkAccountLockout(email);
    if (lockoutStatus.locked) {
      // Add response delay to prevent timing attacks even on lockout
      await addResponseDelay();

      const retryAfterSeconds = lockoutStatus.unlockAt
        ? Math.ceil((lockoutStatus.unlockAt.getTime() - Date.now()) / 1000)
        : LOCKOUT_CONFIG.LOCKOUT_DURATION_MS / 1000;

      res.status(429).json({
        error: 'Account temporarily locked',
        code: 'ACCOUNT_LOCKED',
        message:
          'Too many failed login attempts. Please try again later.',
        retryAfter: retryAfterSeconds,
        // Note: We don't expose the exact unlock time to prevent attacks
      });

      // Log the blocked attempt
      await logLoginAttempt({
        email,
        ipAddress: ip,
        userAgent,
        success: false,
        failureReason: 'ACCOUNT_LOCKED',
        suspiciousFlags: ['BLOCKED_BY_LOCKOUT'],
      });

      return;
    }

    // Detect suspicious activity
    const suspiciousActivity = await detectSuspiciousActivity(email, ip, userAgent);

    // Check CAPTCHA requirement
    const captchaCheck = await shouldRequireCaptcha(email, ip);

    // Attach protection context to request for use in route handler
    (req as any).credentialProtection = {
      email,
      ip,
      userAgent,
      lockoutStatus,
      suspiciousActivity,
      captchaRequired: captchaCheck.required,
      captchaReason: captchaCheck.reason,
      logAttempt: async (success: boolean, failureReason?: string) => {
        if (!success) {
          await recordFailedAttempt(email);
          recordIpFailure(ip);
        } else {
          await clearFailedAttempts(email);
        }

        await logLoginAttempt({
          email,
          ipAddress: ip,
          userAgent,
          success,
          failureReason,
          suspiciousFlags: suspiciousActivity.flags,
        });
      },
      addDelay: addResponseDelay,
      getGenericError: getGenericAuthError,
    };

    // If CAPTCHA is required and not provided, respond with CAPTCHA challenge
    if (captchaCheck.required && !req.body?.captchaToken) {
      // Add response delay
      await addResponseDelay();

      res.status(403).json({
        error: 'CAPTCHA required',
        code: 'CAPTCHA_REQUIRED',
        message: 'Please complete the CAPTCHA verification',
        reason: captchaCheck.reason,
        // Include CAPTCHA site key for frontend
        captchaSiteKey: process.env.CAPTCHA_SITE_KEY || undefined,
      });

      return;
    }

    next();
  } catch (error) {
    securityLogger.error('Credential stuffing protection error', {
      operation: 'credential:stuffing:middleware',
      error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
    });
    // Don't block the request on protection errors, but log them
    next();
  }
};

/**
 * Helper type for the protection context added to requests
 */
export interface CredentialProtectionContext {
  email: string;
  ip: string;
  userAgent: string;
  lockoutStatus: {
    locked: boolean;
    unlockAt?: Date;
    remainingAttempts?: number;
  };
  suspiciousActivity: SuspiciousActivityResult;
  captchaRequired: boolean;
  captchaReason?: string;
  logAttempt: (success: boolean, failureReason?: string) => Promise<void>;
  addDelay: () => Promise<void>;
  getGenericError: () => string;
}

// =====================================================
// ADMIN/MONITORING FUNCTIONS
// =====================================================

/**
 * Get recent login attempts for monitoring
 *
 * @param limit - Maximum number of attempts to return
 * @returns Recent login attempts
 */
export function getRecentLoginAttempts(limit: number = 100): LoginAttemptLog[] {
  return recentLoginAttempts.slice(-limit);
}

/**
 * Get account lockout status for admin monitoring
 *
 * @param email - The email to check
 * @returns The lockout record if exists
 */
export function getAccountLockoutStatus(
  email: string
): AccountLockoutRecord | undefined {
  return accountLockouts.get(normalizeEmail(email));
}

/**
 * Manually unlock an account (admin function)
 *
 * @param email - The email to unlock
 * @returns Whether the account was unlocked
 */
export function adminUnlockAccount(email: string): boolean {
  const record = accountLockouts.get(normalizeEmail(email));
  if (record) {
    record.lockedUntil = null;
    record.failedAttempts = 0;
    return true;
  }
  return false;
}

/**
 * Get suspicious IP activity summary for monitoring
 *
 * @returns Summary of suspicious IP activity
 */
export function getSuspiciousIpSummary(): Array<{
  ip: string;
  uniqueEmails: number;
  totalAttempts: number;
  failedAttempts: number;
  lastAttempt: Date;
}> {
  const summary: Array<{
    ip: string;
    uniqueEmails: number;
    totalAttempts: number;
    failedAttempts: number;
    lastAttempt: Date;
  }> = [];

  Array.from(ipActivityRecords.entries()).forEach(([ip, record]) => {
    if (
      record.attemptedEmails.size > 3 ||
      record.failedAttempts > 5
    ) {
      summary.push({
        ip,
        uniqueEmails: record.attemptedEmails.size,
        totalAttempts: record.totalAttempts,
        failedAttempts: record.failedAttempts,
        lastAttempt: record.lastAttempt,
      });
    }
  });

  return summary.sort((a, b) => b.failedAttempts - a.failedAttempts);
}

export default {
  credentialStuffingProtection,
  checkAccountLockout,
  recordFailedAttempt,
  clearFailedAttempts,
  addResponseDelay,
  logLoginAttempt,
  detectSuspiciousActivity,
  shouldRequireCaptcha,
  getGenericAuthError,
  getRecentLoginAttempts,
  getAccountLockoutStatus,
  adminUnlockAccount,
  getSuspiciousIpSummary,
};
