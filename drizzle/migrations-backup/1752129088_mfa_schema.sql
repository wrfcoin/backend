-- Multi-Factor Authentication Schema Migration
-- Created: 2025-07-10T06:31:28Z

-- User MFA Settings table
CREATE TABLE IF NOT EXISTS "user_mfa_settings" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
  "totp_secret" TEXT, -- Encrypted TOTP secret
  "backup_codes" JSONB, -- Array of hashed backup codes
  "recovery_email" TEXT,
  "sms_enabled" BOOLEAN DEFAULT false,
  "phone_number" TEXT, -- Encrypted phone number
  "trusted_devices" JSONB, -- Array of trusted device fingerprints
  "last_backup_codes_generated" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE("user_id")
);

-- MFA Authentication Attempts table
CREATE TABLE IF NOT EXISTS "mfa_attempts" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "attempt_type" TEXT NOT NULL, -- 'totp', 'sms', 'backup_code', 'webauthn'
  "success" BOOLEAN NOT NULL,
  "ip_address" INET,
  "user_agent" TEXT,
  "device_fingerprint" TEXT,
  "failure_reason" TEXT,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- User Sessions table (enhanced session management)
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id" SERIAL PRIMARY KEY,
  "session_id" TEXT NOT NULL UNIQUE,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "ip_address" INET,
  "user_agent" TEXT,
  "device_fingerprint" TEXT,
  "device_name" TEXT, -- User-provided device name
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "expires_at" TIMESTAMP NOT NULL,
  "last_activity_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "mfa_verified" BOOLEAN DEFAULT false,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Trusted Devices table
CREATE TABLE IF NOT EXISTS "trusted_devices" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "device_fingerprint" TEXT NOT NULL,
  "device_name" TEXT NOT NULL,
  "device_type" TEXT, -- 'desktop', 'mobile', 'tablet'
  "browser" TEXT,
  "operating_system" TEXT,
  "ip_address" INET,
  "location" JSONB, -- Geolocation data
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "last_used" TIMESTAMP NOT NULL DEFAULT NOW(),
  "expires_at" TIMESTAMP NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- MFA Backup Codes Usage table
CREATE TABLE IF NOT EXISTS "mfa_backup_code_usage" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "code_hash" TEXT NOT NULL, -- Hash of the used backup code
  "used_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "ip_address" INET,
  "user_agent" TEXT
);

-- SMS Verification Codes table
CREATE TABLE IF NOT EXISTS "sms_verification_codes" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "phone_number" TEXT NOT NULL, -- Encrypted
  "code" TEXT NOT NULL, -- Hashed verification code
  "purpose" TEXT NOT NULL, -- 'mfa_login', 'mfa_setup', 'password_reset'
  "is_used" BOOLEAN DEFAULT false,
  "attempts" INTEGER DEFAULT 0,
  "expires_at" TIMESTAMP NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Security Events table (for audit logging)
CREATE TABLE IF NOT EXISTS "security_events" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "event_type" TEXT NOT NULL, -- 'mfa_enabled', 'mfa_disabled', 'login', 'suspicious_activity', etc.
  "severity" TEXT NOT NULL, -- 'low', 'medium', 'high', 'critical'
  "description" TEXT NOT NULL,
  "ip_address" INET,
  "user_agent" TEXT,
  "device_fingerprint" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS "idx_user_mfa_settings_user_id" ON "user_mfa_settings"("user_id");
CREATE INDEX IF NOT EXISTS "idx_user_mfa_settings_mfa_enabled" ON "user_mfa_settings"("mfa_enabled");

CREATE INDEX IF NOT EXISTS "idx_mfa_attempts_user_id" ON "mfa_attempts"("user_id");
CREATE INDEX IF NOT EXISTS "idx_mfa_attempts_attempt_type" ON "mfa_attempts"("attempt_type");
CREATE INDEX IF NOT EXISTS "idx_mfa_attempts_success" ON "mfa_attempts"("success");
CREATE INDEX IF NOT EXISTS "idx_mfa_attempts_created_at" ON "mfa_attempts"("created_at");

CREATE INDEX IF NOT EXISTS "idx_user_sessions_session_id" ON "user_sessions"("session_id");
CREATE INDEX IF NOT EXISTS "idx_user_sessions_user_id" ON "user_sessions"("user_id");
CREATE INDEX IF NOT EXISTS "idx_user_sessions_is_active" ON "user_sessions"("is_active");
CREATE INDEX IF NOT EXISTS "idx_user_sessions_expires_at" ON "user_sessions"("expires_at");

CREATE INDEX IF NOT EXISTS "idx_trusted_devices_user_id" ON "trusted_devices"("user_id");
CREATE INDEX IF NOT EXISTS "idx_trusted_devices_device_fingerprint" ON "trusted_devices"("device_fingerprint");
CREATE INDEX IF NOT EXISTS "idx_trusted_devices_is_active" ON "trusted_devices"("is_active");

CREATE INDEX IF NOT EXISTS "idx_mfa_backup_code_usage_user_id" ON "mfa_backup_code_usage"("user_id");
CREATE INDEX IF NOT EXISTS "idx_mfa_backup_code_usage_code_hash" ON "mfa_backup_code_usage"("code_hash");

CREATE INDEX IF NOT EXISTS "idx_sms_verification_codes_user_id" ON "sms_verification_codes"("user_id");
CREATE INDEX IF NOT EXISTS "idx_sms_verification_codes_phone_number" ON "sms_verification_codes"("phone_number");
CREATE INDEX IF NOT EXISTS "idx_sms_verification_codes_expires_at" ON "sms_verification_codes"("expires_at");
CREATE INDEX IF NOT EXISTS "idx_sms_verification_codes_is_used" ON "sms_verification_codes"("is_used");

CREATE INDEX IF NOT EXISTS "idx_security_events_user_id" ON "security_events"("user_id");
CREATE INDEX IF NOT EXISTS "idx_security_events_event_type" ON "security_events"("event_type");
CREATE INDEX IF NOT EXISTS "idx_security_events_severity" ON "security_events"("severity");
CREATE INDEX IF NOT EXISTS "idx_security_events_created_at" ON "security_events"("created_at");

-- Create trigger to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_user_mfa_settings_updated_at BEFORE UPDATE ON user_mfa_settings 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();