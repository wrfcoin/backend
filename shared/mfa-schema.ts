import { relations } from 'drizzle-orm';
import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  inet,
} from 'drizzle-orm/pg-core';
import { users } from './schema.js';

// User MFA Settings table
export const userMfaSettings = pgTable('user_mfa_settings', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  totpSecret: text('totp_secret'), // Encrypted TOTP secret
  backupCodes: jsonb('backup_codes'), // Array of hashed backup codes
  recoveryEmail: text('recovery_email'),
  smsEnabled: boolean('sms_enabled').default(false),
  phoneNumber: text('phone_number'), // Encrypted phone number
  trustedDevices: jsonb('trusted_devices'), // Array of trusted device fingerprints
  lastBackupCodesGenerated: timestamp('last_backup_codes_generated'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// MFA Authentication Attempts table
export const mfaAttempts = pgTable('mfa_attempts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  attemptType: text('attempt_type').notNull(), // 'totp', 'sms', 'backup_code', 'webauthn'
  success: boolean('success').notNull(),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  deviceFingerprint: text('device_fingerprint'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// User Sessions table (enhanced session management)
export const userSessions = pgTable('user_sessions', {
  id: serial('id').primaryKey(),
  sessionId: text('session_id').notNull().unique(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  deviceFingerprint: text('device_fingerprint'),
  deviceName: text('device_name'), // User-provided device name
  isActive: boolean('is_active').notNull().default(true),
  expiresAt: timestamp('expires_at').notNull(),
  lastActivityAt: timestamp('last_activity_at').notNull().defaultNow(),
  mfaVerified: boolean('mfa_verified').default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Trusted Devices table
export const trustedDevices = pgTable('trusted_devices', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  deviceFingerprint: text('device_fingerprint').notNull(),
  deviceName: text('device_name').notNull(),
  deviceType: text('device_type'), // 'desktop', 'mobile', 'tablet'
  browser: text('browser'),
  operatingSystem: text('operating_system'),
  ipAddress: inet('ip_address'),
  location: jsonb('location'), // Geolocation data
  isActive: boolean('is_active').notNull().default(true),
  lastUsed: timestamp('last_used').notNull().defaultNow(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// MFA Backup Codes Usage table
export const mfaBackupCodeUsage = pgTable('mfa_backup_code_usage', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  codeHash: text('code_hash').notNull(), // Hash of the used backup code
  usedAt: timestamp('used_at').notNull().defaultNow(),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
});

// SMS Verification Codes table
export const smsVerificationCodes = pgTable('sms_verification_codes', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  phoneNumber: text('phone_number').notNull(), // Encrypted
  code: text('code').notNull(), // Hashed verification code
  purpose: text('purpose').notNull(), // 'mfa_login', 'mfa_setup', 'password_reset'
  isUsed: boolean('is_used').default(false),
  attempts: integer('attempts').default(0),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// =====================================================
// WEBAUTHN/FIDO2 CREDENTIALS TABLE (Task 94.14)
// Stores registered WebAuthn authenticators (security keys, biometrics)
// =====================================================
export const webauthnCredentials = pgTable('webauthn_credentials', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  credentialId: text('credential_id').notNull().unique(), // Base64URL encoded credential ID
  publicKey: text('public_key').notNull(), // Base64 encoded COSE public key
  counter: integer('counter').notNull().default(0), // Signature counter for replay protection
  deviceType: text('device_type'), // 'platform' (built-in) or 'cross-platform' (roaming)
  transports: jsonb('transports'), // ['usb', 'ble', 'nfc', 'internal', 'hybrid']
  aaguid: text('aaguid'), // Authenticator Attestation GUID
  friendlyName: text('friendly_name'), // User-provided name for the credential
  backedUp: boolean('backed_up').default(false), // Whether credential is backed up (passkey sync)
  lastUsedAt: timestamp('last_used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// WebAuthn Challenge Storage (temporary, for registration/authentication flows)
export const webauthnChallenges = pgTable('webauthn_challenges', {
  id: serial('id').primaryKey(),
  challengeId: text('challenge_id').notNull().unique(), // Random ID for lookup
  challenge: text('challenge').notNull(), // Base64URL encoded challenge
  userId: integer('user_id').references(() => users.id), // Optional for registration
  type: text('type').notNull(), // 'registration' or 'authentication'
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Security Events table (for audit logging)
export const securityEvents = pgTable('security_events', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  eventType: text('event_type').notNull(), // 'mfa_enabled', 'mfa_disabled', 'login', 'suspicious_activity', etc.
  severity: text('severity').notNull(), // 'low', 'medium', 'high', 'critical'
  description: text('description').notNull(),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  deviceFingerprint: text('device_fingerprint'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Relations
export const userMfaSettingsRelations = relations(
  userMfaSettings,
  ({ one }) => ({
    user: one(users, {
      fields: [userMfaSettings.userId],
      references: [users.id],
    }),
  })
);

export const mfaAttemptsRelations = relations(mfaAttempts, ({ one }) => ({
  user: one(users, {
    fields: [mfaAttempts.userId],
    references: [users.id],
  }),
}));

export const userSessionsRelations = relations(userSessions, ({ one }) => ({
  user: one(users, {
    fields: [userSessions.userId],
    references: [users.id],
  }),
}));

export const trustedDevicesRelations = relations(trustedDevices, ({ one }) => ({
  user: one(users, {
    fields: [trustedDevices.userId],
    references: [users.id],
  }),
}));

export const mfaBackupCodeUsageRelations = relations(
  mfaBackupCodeUsage,
  ({ one }) => ({
    user: one(users, {
      fields: [mfaBackupCodeUsage.userId],
      references: [users.id],
    }),
  })
);

export const smsVerificationCodesRelations = relations(
  smsVerificationCodes,
  ({ one }) => ({
    user: one(users, {
      fields: [smsVerificationCodes.userId],
      references: [users.id],
    }),
  })
);

export const securityEventsRelations = relations(securityEvents, ({ one }) => ({
  user: one(users, {
    fields: [securityEvents.userId],
    references: [users.id],
  }),
}));

// Type exports
export type UserMfaSettings = typeof userMfaSettings.$inferSelect;
export type InsertUserMfaSettings = typeof userMfaSettings.$inferInsert;

export type MfaAttempt = typeof mfaAttempts.$inferSelect;
export type InsertMfaAttempt = typeof mfaAttempts.$inferInsert;

export type UserSession = typeof userSessions.$inferSelect;
export type InsertUserSession = typeof userSessions.$inferInsert;

export type TrustedDevice = typeof trustedDevices.$inferSelect;
export type InsertTrustedDevice = typeof trustedDevices.$inferInsert;

export type MfaBackupCodeUsage = typeof mfaBackupCodeUsage.$inferSelect;
export type InsertMfaBackupCodeUsage = typeof mfaBackupCodeUsage.$inferInsert;

export type SmsVerificationCode = typeof smsVerificationCodes.$inferSelect;
export type InsertSmsVerificationCode =
  typeof smsVerificationCodes.$inferInsert;

export type SecurityEvent = typeof securityEvents.$inferSelect;
export type InsertSecurityEvent = typeof securityEvents.$inferInsert;
