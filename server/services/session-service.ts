import { eq, and, gt, lt, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import { securityLogger } from '../utils/logger.js';
import {
  userSessions,
  securityEvents,
  type UserSession,
  type InsertUserSession,
  type InsertSecurityEvent,
} from '../../shared/schema.js';
import { db } from '../../database/connection.js';

// Configuration
// SECURITY FIX (102.6): Updated session timeouts for improved security
const SESSION_CONFIG = {
  // SECURITY FIX (102.6): Absolute session expiry - maximum 8 hours regardless of activity
  // This forces re-authentication even for active users to limit exposure window
  ABSOLUTE_SESSION_TIMEOUT: 8 * 60 * 60 * 1000, // 8 hours absolute max
  // SECURITY FIX (102.6): Idle session timeout reduced from 8 hours to 1 hour
  // Sessions expire after 1 hour of inactivity to limit hijacking window
  IDLE_SESSION_TIMEOUT: 60 * 60 * 1000, // 1 hour idle timeout
  MAX_CONCURRENT_SESSIONS: 5,
  // SECURITY FIX (102.6): Session extension capped at 30 minutes
  SESSION_EXTENSION_TIME: 30 * 60 * 1000, // 30 minutes
  CLEANUP_INTERVAL: 60 * 60 * 1000, // 1 hour
  // SECURITY FIX (102.6): Inactivity detection threshold
  INACTIVE_THRESHOLD: 15 * 60 * 1000, // 15 minutes - triggers refresh prompt
};


export interface SessionCreateOptions {
  userId: number;
  ipAddress?: string;
  userAgent?: string;
  deviceFingerprint?: string;
  deviceName?: string;
  mfaVerified?: boolean;
}

export interface SessionValidationResult {
  valid: boolean;
  session?: UserSession;
  reason?: string;
  requiresRefresh?: boolean;
}

export interface DeviceInfo {
  fingerprint: string;
  name: string;
  type?: string;
  browser?: string;
  operatingSystem?: string;
}

export class SessionService {
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanupTimer();
  }

  /**
   * Create a new session
   * SECURITY FIX (102.6): Sessions now use both idle and absolute timeouts
   */
  async createSession(options: SessionCreateOptions): Promise<string> {
    const {
      userId,
      ipAddress,
      userAgent,
      deviceFingerprint,
      deviceName,
      mfaVerified = false,
    } = options;

    // Generate session ID
    const sessionId = this.generateSessionId();
    // SECURITY FIX (102.6): Use idle timeout for initial expiry
    // The validateSession method enforces both idle and absolute expiry
    const expiresAt = new Date(Date.now() + SESSION_CONFIG.IDLE_SESSION_TIMEOUT);

    // Check for concurrent session limit
    const activeSessions = await this.getActiveSessionsCount(userId);
    if (activeSessions >= SESSION_CONFIG.MAX_CONCURRENT_SESSIONS) {
      // Remove oldest session
      await this.removeOldestSession(userId);

      await this.logSecurityEvent({
        userId,
        eventType: 'session_limit_exceeded',
        severity: 'medium',
        description:
          'User exceeded concurrent session limit, oldest session removed',
        ipAddress,
        userAgent,
        deviceFingerprint,
      });
    }

    // Create session
    await db.insert(userSessions).values({
      sessionId,
      userId,
      ipAddress,
      userAgent,
      deviceFingerprint,
      deviceName: deviceName || 'Unknown Device',
      expiresAt,
      mfaVerified,
    });

    await this.logSecurityEvent({
      userId,
      eventType: 'session_created',
      severity: 'low',
      description: 'New user session created',
      ipAddress,
      userAgent,
      deviceFingerprint,
    });

    return sessionId;
  }

  /**
   * Validate session
   * SECURITY FIX (102.6): Now enforces both idle and absolute session timeouts
   */
  async validateSession(sessionId: string): Promise<SessionValidationResult> {
    const session = await db
      .select()
      .from(userSessions)
      .where(
        and(
          eq(userSessions.sessionId, sessionId),
          eq(userSessions.isActive, true)
        )
      )
      .limit(1);

    if (!session.length) {
      return {
        valid: false,
        reason: 'Session not found',
      };
    }

    const sessionData = session[0];
    const now = new Date();

    // SECURITY FIX (102.6): Check absolute session expiry first
    // Sessions cannot exceed 8 hours regardless of activity
    const absoluteExpiry = new Date(
      sessionData.createdAt.getTime() + SESSION_CONFIG.ABSOLUTE_SESSION_TIMEOUT
    );
    if (now > absoluteExpiry) {
      await this.invalidateSession(sessionId, 'Absolute session timeout exceeded');
      return {
        valid: false,
        reason: 'Session has exceeded maximum lifetime. Please log in again.',
      };
    }

    // Check if session idle timeout is expired
    if (sessionData.expiresAt < now) {
      await this.invalidateSession(sessionId, 'Session idle timeout expired');
      return {
        valid: false,
        reason: 'Session expired due to inactivity',
      };
    }

    // Check for approaching inactivity threshold (15 minutes of no activity)
    const inactiveThreshold = new Date(
      now.getTime() - SESSION_CONFIG.INACTIVE_THRESHOLD
    );
    if (sessionData.lastActivityAt < inactiveThreshold) {
      return {
        valid: true,
        session: sessionData,
        requiresRefresh: true,
      };
    }

    // Update last activity and extend idle timeout
    await this.updateLastActivity(sessionId);

    return {
      valid: true,
      session: sessionData,
    };
  }

  /**
   * Extend session
   * SECURITY FIX (102.6): Session extension respects absolute expiry limit
   */
  async extendSession(sessionId: string): Promise<boolean> {
    const validation = await this.validateSession(sessionId);

    if (!validation.valid || !validation.session) {
      return false;
    }

    const session = validation.session;
    const now = Date.now();

    // SECURITY FIX (102.6): Calculate maximum allowed expiry based on absolute timeout
    const absoluteExpiry = session.createdAt.getTime() + SESSION_CONFIG.ABSOLUTE_SESSION_TIMEOUT;
    const requestedExpiry = now + SESSION_CONFIG.SESSION_EXTENSION_TIME;

    // Cap the new expiry at the absolute session limit
    const newExpiresAt = new Date(Math.min(requestedExpiry, absoluteExpiry));

    await db
      .update(userSessions)
      .set({
        expiresAt: newExpiresAt,
        lastActivityAt: new Date(),
      })
      .where(eq(userSessions.sessionId, sessionId));

    await this.logSecurityEvent({
      userId: session.userId,
      eventType: 'session_extended',
      severity: 'low',
      description: 'User session extended',
    });

    return true;
  }

  /**
   * Invalidate session
   */
  async invalidateSession(sessionId: string, reason?: string): Promise<void> {
    const session = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.sessionId, sessionId))
      .limit(1);

    if (session.length > 0) {
      await db
        .update(userSessions)
        .set({
          isActive: false,
        })
        .where(eq(userSessions.sessionId, sessionId));

      await this.logSecurityEvent({
        userId: session[0].userId,
        eventType: 'session_invalidated',
        severity: 'low',
        description: `Session invalidated: ${reason || 'Manual logout'}`,
      });
    }
  }

  /**
   * Invalidate all sessions for user
   */
  async invalidateAllUserSessions(
    userId: number,
    except?: string
  ): Promise<void> {
    const whereCondition = except
      ? and(
          eq(userSessions.userId, userId),
          eq(userSessions.isActive, true),
          sql`${userSessions.sessionId} != ${except}`
        )
      : and(eq(userSessions.userId, userId), eq(userSessions.isActive, true));

    await db
      .update(userSessions)
      .set({
        isActive: false,
      })
      .where(whereCondition);

    await this.logSecurityEvent({
      userId,
      eventType: 'all_sessions_invalidated',
      severity: 'medium',
      description: 'All user sessions invalidated',
    });
  }

  /**
   * Get user's active sessions
   */
  async getUserActiveSessions(userId: number): Promise<UserSession[]> {
    return await db
      .select()
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, userId),
          eq(userSessions.isActive, true),
          gt(userSessions.expiresAt, new Date())
        )
      );
  }

  /**
   * Get active sessions count for user
   */
  async getActiveSessionsCount(userId: number): Promise<number> {
    const result = await db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, userId),
          eq(userSessions.isActive, true),
          gt(userSessions.expiresAt, new Date())
        )
      );

    return result[0]?.count || 0;
  }

  /**
   * Remove specific session
   */
  async removeSession(userId: number, sessionId: string): Promise<boolean> {
    try {
      await db
        .update(userSessions)
        .set({
          isActive: false,
        })
        .where(
          and(
            eq(userSessions.sessionId, sessionId),
            eq(userSessions.userId, userId)
          )
        );

      await this.logSecurityEvent({
        userId,
        eventType: 'session_removed',
        severity: 'low',
        description: 'Session removed by user',
      });
      return true;
    } catch (error) {
      securityLogger.error('Error removing session', { module: 'SessionService', operation: 'removeSession', error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Check for suspicious session activity
   */
  async checkSuspiciousActivity(
    userId: number,
    deviceInfo: DeviceInfo,
    ipAddress?: string
  ): Promise<boolean> {
    // Get recent sessions
    const recentSessions = await db
      .select()
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, userId),
          gt(userSessions.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)) // Last 24 hours
        )
      );

    // Check for multiple different devices/IPs in short time
    const uniqueFingerprints = new Set(
      recentSessions.map(s => s.deviceFingerprint).filter(Boolean)
    );
    const uniqueIPs = new Set(
      recentSessions.map(s => s.ipAddress).filter(Boolean)
    );

    const isSuspicious = uniqueFingerprints.size > 3 || uniqueIPs.size > 5;

    if (isSuspicious) {
      await this.logSecurityEvent({
        userId,
        eventType: 'suspicious_activity',
        severity: 'high',
        description:
          'Suspicious login activity detected: multiple devices/locations',
        ipAddress,
        deviceFingerprint: deviceInfo.fingerprint,
        metadata: {
          uniqueDevices: uniqueFingerprints.size,
          uniqueIPs: uniqueIPs.size,
        },
      });
    }

    return isSuspicious;
  }

  /**
   * Update last activity timestamp
   */
  private async updateLastActivity(sessionId: string): Promise<void> {
    await db
      .update(userSessions)
      .set({
        lastActivityAt: new Date(),
      })
      .where(eq(userSessions.sessionId, sessionId));
  }

  /**
   * Remove oldest session for user
   */
  private async removeOldestSession(userId: number): Promise<void> {
    const oldestSession = await db
      .select()
      .from(userSessions)
      .where(
        and(eq(userSessions.userId, userId), eq(userSessions.isActive, true))
      )
      .orderBy(userSessions.createdAt)
      .limit(1);

    if (oldestSession.length > 0) {
      await this.invalidateSession(
        oldestSession[0].sessionId,
        'Concurrent session limit exceeded'
      );
    }
  }

  /**
   * Generate secure session ID
   */
  private generateSessionId(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Log security event
   */
  private async logSecurityEvent(event: InsertSecurityEvent): Promise<void> {
    await db.insert(securityEvents).values(event);
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions(): Promise<void> {
    const now = new Date();

    // Mark expired sessions as inactive
    await db
      .update(userSessions)
      .set({
        isActive: false,
      })
      .where(
        and(eq(userSessions.isActive, true), lt(userSessions.expiresAt, now))
      );

    // Remove very old inactive sessions (older than 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db
      .delete(userSessions)
      .where(
        and(
          eq(userSessions.isActive, false),
          lt(userSessions.createdAt, thirtyDaysAgo)
        )
      );
  }

  /**
   * Start automatic cleanup timer
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(async () => {
      try {
        await this.cleanupExpiredSessions();
      } catch (error) {
        securityLogger.error('Session cleanup error', { module: 'SessionService', operation: 'cleanupExpiredSessions', error: error instanceof Error ? error.message : String(error) });
      }
    }, SESSION_CONFIG.CLEANUP_INTERVAL);

    this.cleanupTimer.unref();
  }

  /**
   * Stop cleanup timer
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Get session statistics
   */
  async getSessionStats(): Promise<{
    totalActive: number;
    totalInactive: number;
    usersWithActiveSessions: number;
  }> {
    const [activeCount, inactiveCount, activeUsers] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(userSessions)
        .where(
          and(
            eq(userSessions.isActive, true),
            gt(userSessions.expiresAt, new Date())
          )
        ),

      db
        .select({ count: sql<number>`count(*)` })
        .from(userSessions)
        .where(eq(userSessions.isActive, false)),

      db
        .select({ count: sql<number>`count(distinct ${userSessions.userId})` })
        .from(userSessions)
        .where(
          and(
            eq(userSessions.isActive, true),
            gt(userSessions.expiresAt, new Date())
          )
        ),
    ]);

    return {
      totalActive: activeCount[0]?.count || 0,
      totalInactive: inactiveCount[0]?.count || 0,
      usersWithActiveSessions: activeUsers[0]?.count || 0,
    };
  }
}

export const sessionService = new SessionService();
