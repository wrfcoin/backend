/**
 * Unit tests for Session Service
 * Tests session management, timeouts, and concurrent session limits
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { sessionService } from '../../services/session-service.js';

// Mock dependencies
jest.mock('drizzle-orm/postgres-js');
jest.mock('postgres');
jest.mock('../../utils/logger.js', () => ({
  securityLogger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));
// Mock drizzle
jest.mock('drizzle-orm/postgres-js', () => {
  const { createDrizzleChainMock } = require('../support/drizzle-chain-mock.cjs');
  const { db, resetResults } = createDrizzleChainMock(jest);
  return { drizzle: jest.fn(() => db), __db: db, __reset: resetResults };
});
type AnyMock = jest.Mock<(...args: any[]) => any>;
const drizzleMock = jest.requireMock('drizzle-orm/postgres-js') as {
  __db: Record<string, AnyMock>;
  __reset: () => void;
};
const mockDb = drizzleMock.__db;

describe('SessionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    drizzleMock.__reset();

    // Default mock implementations
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.limit.mockReturnThis();
    mockDb.orderBy.mockReturnThis();
    mockDb.insert.mockReturnThis();
    mockDb.values.mockReturnThis();
    mockDb.returning.mockReturnThis();
    mockDb.update.mockReturnThis();
    mockDb.set.mockReturnThis();
    mockDb.delete.mockReturnThis();

  });

  describe('createSession', () => {
    it('should create a new session successfully', async () => {
      const options = {
        userId: 1,
        ipAddress: '192.168.1.1',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        deviceFingerprint: 'device123',
        mfaVerified: true,
      };

      mockDb.select.mockResolvedValueOnce([{ count: 0 }]);

      const result = await sessionService.createSession(options);

      expect(result).toMatch(/^[a-f0-9]{64}$/);
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          sessionId: result,
          userId: 1,
          deviceFingerprint: 'device123',
        })
      );
    });

    it('should enforce concurrent session limits', async () => {
      const options = {
        userId: 1,
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
        deviceFingerprint: 'device123',
        mfaVerified: true,
      };

      // Mock max sessions already exist
      const existingSessions = Array(5)
        .fill(null)
        .map((_, i) => ({
          id: i + 1,
          sessionId: `session_${i}`,
          createdAt: new Date(),
        }));

      mockDb.select
        .mockResolvedValueOnce([{ count: existingSessions.length }])
        .mockResolvedValueOnce([existingSessions[0]])
        .mockResolvedValueOnce([existingSessions[0]]);

      const result = await sessionService.createSession(options);

      expect(result).toMatch(/^[a-f0-9]{64}$/);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should preserve supplied device metadata', async () => {
      const options = {
        userId: 1,
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
        deviceFingerprint: 'device123',
        mfaVerified: true,
        deviceName: 'Test workstation',
      };

      mockDb.select.mockResolvedValueOnce([{ count: 0 }]);

      await sessionService.createSession(options);

      expect(mockDb.values).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          deviceFingerprint: 'device123',
          deviceName: 'Test workstation',
        })
      );
    });

    it('should generate unique session IDs', async () => {
      const options = {
        userId: 1,
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
        mfaVerified: true,
      };

      mockDb.select.mockResolvedValue([{ count: 0 }]);

      const results = await Promise.all([
        sessionService.createSession(options),
        sessionService.createSession(options),
        sessionService.createSession(options),
      ]);

      // All session IDs should be unique
      const uniqueIds = new Set(results);
      expect(uniqueIds.size).toBe(3);
    });
  });

  describe('validateSession', () => {
    it('should validate active session', async () => {
      const sessionId = 'session_123';
      const mockSession = {
        id: 1,
        sessionId,
        userId: 1,
        expiresAt: new Date(Date.now() + 3600000), // 1 hour future
        mfaVerified: true,
        lastActivityAt: new Date(),
        createdAt: new Date(),
      };

      mockDb.select.mockResolvedValueOnce([mockSession]);
      mockDb.update.mockResolvedValueOnce([mockSession]);

      const result = await sessionService.validateSession(sessionId);

      expect(result).toEqual({ valid: true, session: mockSession });
      expect(mockDb.update).toHaveBeenCalled(); // Should update last activity
    });

    it('should return null for expired session', async () => {
      const sessionId = 'session_123';
      const mockExpiredSession = {
        id: 1,
        sessionId,
        userId: 1,
        expiresAt: new Date(Date.now() - 3600000), // 1 hour past
        mfaVerified: true,
        lastActivityAt: new Date(),
        createdAt: new Date(),
      };

      mockDb.select.mockResolvedValueOnce([mockExpiredSession]);
      mockDb.delete.mockResolvedValueOnce(undefined);

      const result = await sessionService.validateSession(sessionId);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('inactivity');
    });

    it('should reject a non-existent session', async () => {
      const sessionId = 'nonexistent';

      mockDb.select.mockResolvedValueOnce([]);

      const result = await sessionService.validateSession(sessionId);

      expect(result).toEqual({ valid: false, reason: 'Session not found' });
    });

    it('should handle session timeout based on activity', async () => {
      const sessionId = 'session_123';
      const mockSession = {
        id: 1,
        sessionId,
        userId: 1,
        expiresAt: new Date(Date.now() + 3600000),
        lastActivityAt: new Date(Date.now() - 1800000), // 30 minutes ago
        createdAt: new Date(),
        mfaVerified: true,
      };

      mockDb.select.mockResolvedValueOnce([mockSession]);

      // Mock inactivity timeout (should depend on configuration)
      const result = await sessionService.validateSession(sessionId);

      // Session should still be valid if within timeout window
      expect(result).toEqual({
        valid: true,
        session: mockSession,
        requiresRefresh: true,
      });
    });
  });

  describe('extendSession', () => {
    it('should extend session expiry time', async () => {
      const sessionId = 'session_123';
      const mockSession = {
        id: 1,
        sessionId,
        expiresAt: new Date(Date.now() + 1800000), // 30 minutes future
        createdAt: new Date(),
        lastActivityAt: new Date(),
        userId: 1,
      };

      mockDb.select.mockResolvedValueOnce([mockSession]);
      mockDb.update.mockResolvedValueOnce([
        { ...mockSession, expiresAt: new Date(Date.now() + 3600000) },
      ]);

      const result = await sessionService.extendSession(sessionId);

      expect(result).toBe(true);
      expect(mockDb.update).toHaveBeenCalledWith(expect.any(Object));
    });

    it('should return false for non-existent session', async () => {
      const sessionId = 'nonexistent';

      mockDb.select.mockResolvedValueOnce([]);

      const result = await sessionService.extendSession(sessionId);

      expect(result).toBe(false);
    });

    it('should not extend already expired sessions', async () => {
      const sessionId = 'session_123';
      const mockExpiredSession = {
        id: 1,
        sessionId,
        expiresAt: new Date(Date.now() - 3600000), // 1 hour past
        createdAt: new Date(),
        lastActivityAt: new Date(),
        userId: 1,
      };

      mockDb.select.mockResolvedValueOnce([mockExpiredSession]);

      const result = await sessionService.extendSession(sessionId);

      expect(result).toBe(false);
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe('removeSession', () => {
    it('should remove user session', async () => {
      const userId = 1;
      const sessionId = 'session_123';

      mockDb.update.mockResolvedValueOnce([{ id: 1 }]);

      const result = await sessionService.removeSession(userId, sessionId);

      expect(result).toBe(true);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should return false if session storage fails', async () => {
      const userId = 1;
      const sessionId = 'nonexistent';

      mockDb.update.mockRejectedValueOnce(new Error('Database error'));

      const result = await sessionService.removeSession(userId, sessionId);

      expect(result).toBe(false);
    });
  });

  describe('getUserActiveSessions', () => {
    it('should return user active sessions', async () => {
      const userId = 1;
      const mockSessions = [
        {
          id: 1,
          sessionId: 'session_1',
          userId: 1,
          deviceName: 'Chrome Browser',
          ipAddress: '192.168.1.1',
          lastActivityAt: new Date(),
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
          mfaVerified: true,
        },
        {
          id: 2,
          sessionId: 'session_2',
          userId: 1,
          deviceName: 'Mobile Safari',
          ipAddress: '192.168.1.2',
          lastActivityAt: new Date(),
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
          mfaVerified: false,
        },
      ];

      mockDb.select.mockResolvedValueOnce(mockSessions);

      const result = await sessionService.getUserActiveSessions(userId);

      expect(result).toEqual(mockSessions);
      expect(result).toHaveLength(2);
    });

    it('should only return non-expired sessions', async () => {
      const userId = 1;

      // Mock query should filter out expired sessions
      const mockActiveSessions = [
        {
          id: 1,
          sessionId: 'session_1',
          userId: 1,
          expiresAt: new Date(Date.now() + 3600000),
        },
      ];

      mockDb.select.mockResolvedValueOnce(mockActiveSessions);

      const result = await sessionService.getUserActiveSessions(userId);

      expect(result).toHaveLength(1);
    });
  });

  describe('invalidateAllUserSessions', () => {
    it('should invalidate all user sessions', async () => {
      const userId = 1;

      mockDb.update.mockResolvedValueOnce(undefined);

      await sessionService.invalidateAllUserSessions(userId);

      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should exclude current session when specified', async () => {
      const userId = 1;
      const currentSessionId = 'current_session';

      mockDb.update.mockResolvedValueOnce(undefined);

      await sessionService.invalidateAllUserSessions(userId, currentSessionId);

      expect(mockDb.update).toHaveBeenCalled();
      // Should exclude current session in the delete query
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should remove expired sessions', async () => {
      const mockExpiredCount = 5;
      mockDb.delete.mockResolvedValueOnce(
        Array(mockExpiredCount).fill({ id: 1 })
      );

      await sessionService.cleanupExpiredSessions();

      expect(mockDb.delete).toHaveBeenCalled();
    });
  });

  describe('getSessionStats', () => {
    it('should return session statistics', async () => {
      mockDb.select.mockResolvedValueOnce([{ count: 45 }]);
      mockDb.select.mockResolvedValueOnce([{ count: 105 }]);
      mockDb.select.mockResolvedValueOnce([{ count: 12 }]);

      const result = await sessionService.getSessionStats();

      expect(result).toEqual({
        totalActive: 45,
        totalInactive: 105,
        usersWithActiveSessions: 12,
      });
    });
  });

  describe('Session ID Generation', () => {
    it('should generate cryptographically secure session IDs', () => {
      const sessionIds = new Set();

      // Generate multiple session IDs
      for (let i = 0; i < 1000; i++) {
        const sessionId = (sessionService as any).generateSessionId();
        sessionIds.add(sessionId);

        // Should be properly formatted
        expect(sessionId).toMatch(/^[a-zA-Z0-9+/=]+$/);
        expect(sessionId.length).toBeGreaterThan(20);
      }

      // All should be unique
      expect(sessionIds.size).toBe(1000);
    });
  });

  describe('Session Security', () => {
    it('should detect suspicious session patterns', async () => {
      mockDb.select.mockResolvedValueOnce(
        Array.from({ length: 4 }, (_, index) => ({
          deviceFingerprint: `device-${index}`,
          ipAddress: `192.168.1.${index}`,
        }))
      );

      const result = await sessionService.checkSuspiciousActivity(
        1,
        { fingerprint: 'device-current', name: 'Current device' },
        '192.168.1.10'
      );

      expect(result).toBe(true);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('should enforce session timeout policies', async () => {
      const sessionId = 'session_123';

      // Mock session with old last activity
      const mockSession = {
        id: 1,
        sessionId,
        userId: 1,
        lastActivityAt: new Date(Date.now() - 7200000), // 2 hours ago
        expiresAt: new Date(Date.now() + 3600000), // Still within expiry
        mfaVerified: false,
        createdAt: new Date(),
      };

      mockDb.select.mockResolvedValueOnce([mockSession]);

      const result = await sessionService.validateSession(sessionId);

      // Should handle inactivity timeout based on MFA status
      // Non-MFA sessions should have shorter inactivity timeout
      expect(result.requiresRefresh).toBe(true);
    });
  });

  describe('Concurrent Session Management', () => {
    it('should handle session limit edge cases', async () => {
      const options = {
        userId: 1,
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
        mfaVerified: true,
      };

      // Mock exactly at the session limit
      const existingSessions = Array(5)
        .fill(null)
        .map((_, i) => ({
          id: i + 1,
          sessionId: `session_${i}`,
          createdAt: new Date(Date.now() - i * 60000), // Different creation times
        }));

      mockDb.select
        .mockResolvedValueOnce([{ count: existingSessions.length }])
        .mockResolvedValueOnce([existingSessions[0]])
        .mockResolvedValueOnce([existingSessions[0]]);

      await sessionService.createSession(options);

      // Should remove the oldest session (highest index)
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should prioritize removal of inactive sessions', async () => {
      const options = {
        userId: 1,
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
        mfaVerified: true,
      };

      // Mock sessions with different activity levels
      const existingSessions = [
        {
          id: 1,
          sessionId: 'session_1',
          lastActivityAt: new Date(), // Most recent
          createdAt: new Date(Date.now() - 60000),
        },
        {
          id: 2,
          sessionId: 'session_2',
          lastActivityAt: new Date(Date.now() - 3600000), // 1 hour ago
          createdAt: new Date(Date.now() - 120000),
        },
      ];

      mockDb.select.mockResolvedValueOnce([{ count: existingSessions.length }]);

      await sessionService.createSession(options);

      // Should prefer keeping active sessions
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle database connection errors', async () => {
      const sessionId = 'session_123';

      mockDb.select.mockRejectedValueOnce(
        new Error('Database connection failed')
      );

      await expect(sessionService.validateSession(sessionId)).rejects.toThrow(
        'Database connection failed'
      );
    });

    it('should propagate session storage errors', async () => {
      const options = {
        userId: 1,
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
        mfaVerified: true,
      };

      mockDb.select.mockResolvedValue([{ count: 0 }]);
      mockDb.insert.mockRejectedValueOnce(new Error('Session insert failed'));

      await expect(sessionService.createSession(options)).rejects.toThrow(
        'Session insert failed'
      );
    });

    it('should handle session ID generation failures', async () => {
      const options = {
        userId: 1,
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
        mfaVerified: true,
      };

      // Mock crypto failure
      const originalCrypto = require('crypto');
      jest.spyOn(originalCrypto, 'randomBytes').mockImplementationOnce(() => {
        throw new Error('Crypto error');
      });

      await expect(sessionService.createSession(options)).rejects.toThrow();
    });
  });
});
