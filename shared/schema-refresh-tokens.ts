/**
 * Refresh Tokens Schema - Task 94.2
 *
 * Implements secure refresh token storage for RS256 JWT authentication.
 * - Access tokens: 1 hour expiration (short-lived)
 * - Refresh tokens: 7 days expiration (longer-lived, stored as hash)
 */

import { pgTable, serial, varchar, timestamp, boolean, jsonb, uuid } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './schema.js';

/**
 * Refresh tokens table for JWT token rotation
 * Security considerations:
 * - Only store SHA-256 hash of token (never plaintext)
 * - Track device info for security monitoring
 * - Support revocation for logout and security events
 */
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: serial('user_id').notNull().references(() => users.id),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(), // SHA-256 hash
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at'),
  revoked: boolean('revoked').default(false).notNull(),
  revokedAt: timestamp('revoked_at'),
  revokedReason: varchar('revoked_reason', { length: 100 }),

  // Security tracking
  deviceInfo: jsonb('device_info').$type<{
    userAgent: string;
    ip: string;
    fingerprint?: string;
    platform?: string;
  }>(),

  // Token family for rotation detection
  // If a refresh token is reused after rotation, revoke entire family
  tokenFamily: uuid('token_family').defaultRandom().notNull(),
});

/**
 * Relations for refresh tokens
 */
export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, {
    fields: [refreshTokens.userId],
    references: [users.id],
  }),
}));

// Type exports
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type InsertRefreshToken = typeof refreshTokens.$inferInsert;

/**
 * Token revocation reasons
 */
export const TOKEN_REVOCATION_REASONS = {
  LOGOUT: 'logout',
  LOGOUT_ALL: 'logout_all_devices',
  PASSWORD_CHANGE: 'password_change',
  SECURITY_CONCERN: 'security_concern',
  TOKEN_REUSE: 'token_reuse_detected',
  EXPIRED: 'expired',
  ADMIN_REVOKE: 'admin_revoke',
} as const;

export type TokenRevocationReason = typeof TOKEN_REVOCATION_REASONS[keyof typeof TOKEN_REVOCATION_REASONS];
