-- Migration: Create File Storage and Permission Tables
-- This migration creates the database tables for the file permission system

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create files table
CREATE TABLE IF NOT EXISTS files (
    id SERIAL PRIMARY KEY,
    file_id TEXT NOT NULL UNIQUE DEFAULT uuid_generate_v4()::text,
    user_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    storage_provider TEXT NOT NULL DEFAULT 'S3',
    storage_path TEXT NOT NULL,
    checksum TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE', 'SHARED', 'PUBLIC', 'RESTRICTED')),
    is_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
    encryption_key_id TEXT,
    uploaded_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMP,
    expires_at TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED', 'DELETED', 'EXPIRED')),
    tags JSONB DEFAULT '[]'::jsonb,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for files table
CREATE INDEX IF NOT EXISTS idx_files_file_id ON files(file_id);
CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);
CREATE INDEX IF NOT EXISTS idx_files_visibility ON files(visibility);
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_uploaded_at ON files(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_files_tags ON files USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_files_metadata ON files USING GIN(metadata);

-- Create file_permissions table
CREATE TABLE IF NOT EXISTS file_permissions (
    id SERIAL PRIMARY KEY,
    file_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    granted_by_user_id INTEGER NOT NULL,
    permission TEXT NOT NULL CHECK (permission IN ('READ', 'write', 'delete', 'share', 'admin')),
    granted_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    conditions JSONB DEFAULT '{}'::jsonb,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for file_permissions table
CREATE INDEX IF NOT EXISTS idx_file_permissions_file_user ON file_permissions(file_id, user_id);
CREATE INDEX IF NOT EXISTS idx_file_permissions_file_id ON file_permissions(file_id);
CREATE INDEX IF NOT EXISTS idx_file_permissions_user_id ON file_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_file_permissions_permission ON file_permissions(permission);
CREATE INDEX IF NOT EXISTS idx_file_permissions_active ON file_permissions(is_active);
CREATE INDEX IF NOT EXISTS idx_file_permissions_expires ON file_permissions(expires_at) WHERE expires_at IS NOT NULL;

-- Create file_access_logs table
CREATE TABLE IF NOT EXISTS file_access_logs (
    id SERIAL PRIMARY KEY,
    file_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    permission TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    error_code TEXT,
    error_message TEXT,
    ip_address TEXT,
    user_agent TEXT,
    session_id TEXT,
    request_id TEXT,
    accessed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    duration INTEGER,
    bytes_transferred INTEGER,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Create indexes for file_access_logs table
CREATE INDEX IF NOT EXISTS idx_file_access_logs_file_id ON file_access_logs(file_id);
CREATE INDEX IF NOT EXISTS idx_file_access_logs_user_id ON file_access_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_file_access_logs_action ON file_access_logs(action);
CREATE INDEX IF NOT EXISTS idx_file_access_logs_timestamp ON file_access_logs(accessed_at);
CREATE INDEX IF NOT EXISTS idx_file_access_logs_success ON file_access_logs(success);

-- Create file_shares table
CREATE TABLE IF NOT EXISTS file_shares (
    id SERIAL PRIMARY KEY,
    file_id TEXT NOT NULL,
    shared_by_user_id INTEGER NOT NULL,
    share_token TEXT NOT NULL UNIQUE DEFAULT encode(sha256(random()::text::bytea), 'hex'),
    share_type TEXT NOT NULL DEFAULT 'LINK' CHECK (share_type IN ('LINK', 'EMAIL', 'USER')),
    permissions JSONB NOT NULL DEFAULT '["read"]'::jsonb,
    max_accesses INTEGER,
    current_accesses INTEGER NOT NULL DEFAULT 0,
    password_protected BOOLEAN NOT NULL DEFAULT FALSE,
    password_hash TEXT,
    expires_at TIMESTAMP,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    recipient_email TEXT,
    recipient_user_id INTEGER,
    notification_sent BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for file_shares table
CREATE INDEX IF NOT EXISTS idx_file_shares_file_id ON file_shares(file_id);
CREATE INDEX IF NOT EXISTS idx_file_shares_token ON file_shares(share_token);
CREATE INDEX IF NOT EXISTS idx_file_shares_shared_by ON file_shares(shared_by_user_id);
CREATE INDEX IF NOT EXISTS idx_file_shares_active ON file_shares(is_active);
CREATE INDEX IF NOT EXISTS idx_file_shares_expires ON file_shares(expires_at) WHERE expires_at IS NOT NULL;

-- Add foreign key constraints (assuming users table exists)
-- Note: Uncomment these if the users table exists and you want referential integrity
-- ALTER TABLE files ADD CONSTRAINT fk_files_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
-- ALTER TABLE file_permissions ADD CONSTRAINT fk_file_permissions_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
-- ALTER TABLE file_permissions ADD CONSTRAINT fk_file_permissions_granted_by FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE CASCADE;
-- ALTER TABLE file_access_logs ADD CONSTRAINT fk_file_access_logs_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
-- ALTER TABLE file_shares ADD CONSTRAINT fk_file_shares_shared_by FOREIGN KEY (shared_by_user_id) REFERENCES users(id) ON DELETE CASCADE;
-- ALTER TABLE file_shares ADD CONSTRAINT fk_file_shares_recipient FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Create triggers for updating updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_files_updated_at BEFORE UPDATE ON files
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_file_permissions_updated_at BEFORE UPDATE ON file_permissions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_file_shares_updated_at BEFORE UPDATE ON file_shares
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create views for common queries

-- View for active files with basic info
CREATE OR REPLACE VIEW active_files AS
SELECT 
    file_id,
    user_id,
    original_name,
    mime_type,
    file_size,
    visibility,
    is_encrypted,
    uploaded_at,
    last_accessed_at,
    tags,
    status
FROM files 
WHERE status = 'ACTIVE';

-- View for file permissions with user context
CREATE OR REPLACE VIEW file_permissions_with_users AS
SELECT 
    fp.file_id,
    fp.user_id,
    fp.permission,
    fp.granted_at,
    fp.expires_at,
    fp.is_active,
    f.original_name as file_name,
    f.visibility as file_visibility,
    f.status as file_status
FROM file_permissions fp
JOIN files f ON fp.file_id = f.file_id
WHERE fp.is_active = TRUE 
  AND f.status = 'ACTIVE';

-- View for recent file access activity
CREATE OR REPLACE VIEW recent_file_access AS
SELECT 
    fal.file_id,
    fal.user_id,
    fal.action,
    fal.success,
    fal.accessed_at,
    f.original_name as file_name,
    f.mime_type,
    f.file_size
FROM file_access_logs fal
JOIN files f ON fal.file_id = f.file_id
WHERE fal.accessed_at >= NOW() - INTERVAL '30 days'
ORDER BY fal.accessed_at DESC;

-- Add comments for documentation
COMMENT ON TABLE files IS 'Stores file metadata and storage information';
COMMENT ON TABLE file_permissions IS 'Role-based access control for files';
COMMENT ON TABLE file_access_logs IS 'Audit trail for file access attempts';
COMMENT ON TABLE file_shares IS 'File sharing tokens and configurations';

COMMENT ON COLUMN files.file_id IS 'Unique identifier for external API access';
COMMENT ON COLUMN files.checksum IS 'SHA-256 hash for file integrity verification';
COMMENT ON COLUMN files.encryption_key_id IS 'Vault key ID for encrypted files';
COMMENT ON COLUMN file_permissions.permission IS 'Permission level: read, write, delete, share, admin';
COMMENT ON COLUMN file_shares.share_token IS 'Secure token for shared file access';

-- Grant permissions (adjust as needed for your application)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON files TO your_app_user;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON file_permissions TO your_app_user;
-- GRANT SELECT, INSERT ON file_access_logs TO your_app_user;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON file_shares TO your_app_user;
-- GRANT SELECT ON active_files TO your_app_user;
-- GRANT SELECT ON file_permissions_with_users TO your_app_user;
-- GRANT SELECT ON recent_file_access TO your_app_user;