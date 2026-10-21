-- XMSS Quantum-Resistant Database Schema
-- 
-- This schema supports secure storage and management of XMSS (eXtended Merkle Signature Scheme)
-- quantum-resistant cryptographic key states and signature usage tracking.
--
-- Security Features:
-- - Encrypted private key storage
-- - Signature index tracking to prevent reuse
-- - Audit logging for all operations
-- - Key rotation and lifecycle management
-- - Backup and recovery support

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- XMSS key state storage table
-- Stores the complete state for each XMSS key pair including signature index
CREATE TABLE xmss_key_states (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id VARCHAR(255) NOT NULL,
    scheme VARCHAR(50) NOT NULL CHECK (scheme IN (
        'XMSS_SHA256_H10', 
        'XMSS_SHA256_H16', 
        'XMSS_SHA256_H20',
        'XMSSMT_SHA256_H20_D2',
        'XMSSMT_SHA256_H40_D4',
        'SPHINCSPLUS_SHA256_128S',
        'SPHINCSPLUS_SHA256_128F',
        'DILITHIUM2',
        'DILITHIUM3', 
        'DILITHIUM5',
        'FALCON512',
        'FALCON1024'
    )),
    public_key TEXT NOT NULL,
    encrypted_private_key JSONB NOT NULL, -- Stores encrypted key with salt, iv, authTag
    signature_index BIGINT NOT NULL DEFAULT 0,
    max_signatures BIGINT NOT NULL,
    height INTEGER NOT NULL, -- XMSS tree height
    layers INTEGER DEFAULT 1, -- For multi-tree XMSS (XMSSMT)
    is_active BOOLEAN DEFAULT true,
    is_exhausted BOOLEAN DEFAULT false,
    rotation_threshold BIGINT, -- When to warn about key rotation
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_signed_at TIMESTAMP WITH TIME ZONE,
    
    -- Constraints
    CONSTRAINT unique_wallet_scheme UNIQUE(wallet_id, scheme),
    CONSTRAINT valid_signature_index CHECK (signature_index >= 0),
    CONSTRAINT valid_max_signatures CHECK (max_signatures > 0),
    CONSTRAINT index_within_capacity CHECK (signature_index <= max_signatures),
    CONSTRAINT valid_height CHECK (height BETWEEN 10 AND 60),
    CONSTRAINT valid_layers CHECK (layers BETWEEN 1 AND 20)
);

-- XMSS signature usage tracking table
-- Critical for preventing signature reuse attacks in stateful signatures
CREATE TABLE xmss_signature_usage (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key_state_id UUID NOT NULL REFERENCES xmss_key_states(id) ON DELETE CASCADE,
    signature_index BIGINT NOT NULL,
    transaction_id VARCHAR(64), -- Optional transaction reference
    message_hash VARCHAR(64) NOT NULL, -- SHA-256 hash of signed message
    signature_data TEXT, -- Optional: store the actual signature
    used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    block_height BIGINT, -- Optional: block height when signature was used
    
    -- Constraints
    CONSTRAINT unique_key_signature_index UNIQUE(key_state_id, signature_index),
    CONSTRAINT valid_signature_index_usage CHECK (signature_index >= 0),
    CONSTRAINT valid_message_hash CHECK (length(message_hash) = 64)
);

-- Quantum-resistant wallet addresses table
-- Maps quantum addresses to their corresponding public keys and schemes
CREATE TABLE quantum_addresses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    address VARCHAR(42) UNIQUE NOT NULL, -- qr + 40 hex chars
    scheme VARCHAR(50) NOT NULL,
    public_key TEXT NOT NULL,
    wallet_id VARCHAR(255) NOT NULL,
    key_state_id UUID REFERENCES xmss_key_states(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT valid_quantum_address CHECK (address ~ '^qr[a-f0-9]{40}$'),
    CONSTRAINT valid_public_key CHECK (length(public_key) > 0)
);

-- XMSS key backup and recovery table
-- Secure storage for encrypted key backups
CREATE TABLE xmss_key_backups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key_state_id UUID NOT NULL REFERENCES xmss_key_states(id) ON DELETE CASCADE,
    backup_data JSONB NOT NULL, -- Encrypted backup containing key state
    backup_type VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (backup_type IN ('manual', 'automatic', 'rotation')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by VARCHAR(255), -- User or system identifier
    
    -- Constraints
    CONSTRAINT valid_backup_data CHECK (backup_data ? 'encrypted' AND backup_data ? 'salt')
);

-- XMSS operation audit log
-- Comprehensive logging for security and compliance
CREATE TABLE xmss_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    operation_type VARCHAR(50) NOT NULL CHECK (operation_type IN (
        'generate_keypair', 'sign_transaction', 'verify_signature', 'backup_state', 
        'restore_state', 'rotate_key', 'deactivate_key', 'update_index'
    )),
    key_state_id UUID REFERENCES xmss_key_states(id) ON DELETE SET NULL,
    wallet_id VARCHAR(255),
    scheme VARCHAR(50),
    signature_index BIGINT,
    operation_data JSONB, -- Additional operation-specific data
    result VARCHAR(20) NOT NULL CHECK (result IN ('success', 'failure', 'error')),
    error_message TEXT,
    ip_address INET,
    user_agent TEXT,
    performed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Indexes for efficient querying
    INDEX idx_audit_operation_type (operation_type),
    INDEX idx_audit_performed_at (performed_at),
    INDEX idx_audit_key_state (key_state_id),
    INDEX idx_audit_wallet_id (wallet_id)
);

-- XMSS scheme parameters table
-- Reference table for supported XMSS parameter sets
CREATE TABLE xmss_scheme_parameters (
    scheme VARCHAR(50) PRIMARY KEY,
    description TEXT NOT NULL,
    height INTEGER NOT NULL,
    layers INTEGER DEFAULT 1,
    max_signatures BIGINT NOT NULL,
    signature_size INTEGER NOT NULL, -- Size in bytes
    public_key_size INTEGER NOT NULL, -- Size in bytes
    security_level INTEGER NOT NULL, -- Bits of security
    hash_function VARCHAR(20) NOT NULL,
    is_supported BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert supported XMSS parameter sets
INSERT INTO xmss_scheme_parameters (scheme, description, height, layers, max_signatures, signature_size, public_key_size, security_level, hash_function) VALUES
('XMSS_SHA256_H10', 'XMSS with 1,024 signatures', 10, 1, 1024, 2500, 64, 128, 'SHA-256'),
('XMSS_SHA256_H16', 'XMSS with 65,536 signatures', 16, 1, 65536, 2500, 64, 128, 'SHA-256'),
('XMSS_SHA256_H20', 'XMSS with 1,048,576 signatures', 20, 1, 1048576, 2500, 64, 128, 'SHA-256'),
('XMSSMT_SHA256_H20_D2', 'Multi-tree XMSS with high capacity', 20, 2, 1048576, 2500, 64, 128, 'SHA-256'),
('XMSSMT_SHA256_H40_D4', 'Multi-tree XMSS with very high capacity', 40, 4, 1099511627776, 2500, 64, 128, 'SHA-256'),
('SPHINCSPLUS_SHA256_128S', 'SPHINCS+ small signatures', 0, 1, 0, 7856, 32, 128, 'SHA-256'),
('SPHINCSPLUS_SHA256_128F', 'SPHINCS+ fast signatures', 0, 1, 0, 17088, 32, 128, 'SHA-256'),
('DILITHIUM2', 'Dilithium security level 2', 0, 1, 0, 2420, 1312, 128, 'SHAKE-256'),
('DILITHIUM3', 'Dilithium security level 3', 0, 1, 0, 3293, 1952, 192, 'SHAKE-256'),
('DILITHIUM5', 'Dilithium security level 5', 0, 1, 0, 4595, 2592, 256, 'SHAKE-256'),
('FALCON512', 'Falcon-512', 0, 1, 0, 690, 897, 103, 'SHAKE-256'),
('FALCON1024', 'Falcon-1024', 0, 1, 0, 1330, 1793, 206, 'SHAKE-256');

-- Create indexes for performance optimization
CREATE INDEX idx_xmss_key_states_wallet_id ON xmss_key_states(wallet_id);
CREATE INDEX idx_xmss_key_states_scheme ON xmss_key_states(scheme);
CREATE INDEX idx_xmss_key_states_active ON xmss_key_states(is_active) WHERE is_active = true;
CREATE INDEX idx_xmss_key_states_exhausted ON xmss_key_states(is_exhausted) WHERE is_exhausted = true;
CREATE INDEX idx_xmss_key_states_signature_index ON xmss_key_states(signature_index);
CREATE INDEX idx_xmss_key_states_updated_at ON xmss_key_states(updated_at);

CREATE INDEX idx_xmss_signature_usage_key_state ON xmss_signature_usage(key_state_id);
CREATE INDEX idx_xmss_signature_usage_used_at ON xmss_signature_usage(used_at);
CREATE INDEX idx_xmss_signature_usage_transaction ON xmss_signature_usage(transaction_id) WHERE transaction_id IS NOT NULL;

CREATE INDEX idx_quantum_addresses_address ON quantum_addresses(address);
CREATE INDEX idx_quantum_addresses_wallet_id ON quantum_addresses(wallet_id);
CREATE INDEX idx_quantum_addresses_scheme ON quantum_addresses(scheme);
CREATE INDEX idx_quantum_addresses_active ON quantum_addresses(is_active) WHERE is_active = true;

CREATE INDEX idx_xmss_key_backups_key_state ON xmss_key_backups(key_state_id);
CREATE INDEX idx_xmss_key_backups_created_at ON xmss_key_backups(created_at);
CREATE INDEX idx_xmss_key_backups_type ON xmss_key_backups(backup_type);

-- Functions and triggers for automatic updates

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to automatically update updated_at on xmss_key_states
CREATE TRIGGER update_xmss_key_states_updated_at
    BEFORE UPDATE ON xmss_key_states
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function to check if key is exhausted and update status
CREATE OR REPLACE FUNCTION check_key_exhaustion()
RETURNS TRIGGER AS $$
BEGIN
    -- Mark key as exhausted if signature index reaches maximum
    IF NEW.signature_index >= NEW.max_signatures THEN
        NEW.is_exhausted = true;
        NEW.is_active = false;
    END IF;
    
    -- Update last_signed_at if signature index increased
    IF NEW.signature_index > OLD.signature_index THEN
        NEW.last_signed_at = NOW();
    END IF;
    
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to check key exhaustion on signature index updates
CREATE TRIGGER check_xmss_key_exhaustion
    BEFORE UPDATE ON xmss_key_states
    FOR EACH ROW
    WHEN (NEW.signature_index != OLD.signature_index)
    EXECUTE FUNCTION check_key_exhaustion();

-- Function to log key operations automatically
CREATE OR REPLACE FUNCTION log_key_operation()
RETURNS TRIGGER AS $$
BEGIN
    -- Log key state changes
    IF TG_OP = 'INSERT' THEN
        INSERT INTO xmss_audit_log (operation_type, key_state_id, wallet_id, scheme, operation_data, result)
        VALUES ('generate_keypair', NEW.id, NEW.wallet_id, NEW.scheme, 
                json_build_object('max_signatures', NEW.max_signatures, 'height', NEW.height, 'layers', NEW.layers),
                'success');
    ELSIF TG_OP = 'UPDATE' AND NEW.signature_index != OLD.signature_index THEN
        INSERT INTO xmss_audit_log (operation_type, key_state_id, wallet_id, scheme, signature_index, operation_data, result)
        VALUES ('update_index', NEW.id, NEW.wallet_id, NEW.scheme, NEW.signature_index,
                json_build_object('old_index', OLD.signature_index, 'new_index', NEW.signature_index),
                'success');
    ELSIF TG_OP = 'UPDATE' AND NEW.is_active != OLD.is_active AND NEW.is_active = false THEN
        INSERT INTO xmss_audit_log (operation_type, key_state_id, wallet_id, scheme, operation_data, result)
        VALUES ('deactivate_key', NEW.id, NEW.wallet_id, NEW.scheme,
                json_build_object('reason', CASE WHEN NEW.is_exhausted THEN 'exhausted' ELSE 'manual' END),
                'success');
    END IF;
    
    RETURN COALESCE(NEW, OLD);
END;
$$ language 'plpgsql';

-- Trigger to automatically log key operations
CREATE TRIGGER log_xmss_key_operations
    AFTER INSERT OR UPDATE ON xmss_key_states
    FOR EACH ROW
    EXECUTE FUNCTION log_key_operation();

-- Function to prevent signature index reuse
CREATE OR REPLACE FUNCTION prevent_signature_reuse()
RETURNS TRIGGER AS $$
BEGIN
    -- Check if this signature index was already used for this key
    IF EXISTS (
        SELECT 1 FROM xmss_signature_usage 
        WHERE key_state_id = NEW.key_state_id 
        AND signature_index = NEW.signature_index
    ) THEN
        RAISE EXCEPTION 'Signature index % already used for key %', NEW.signature_index, NEW.key_state_id;
    END IF;
    
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to prevent signature reuse attacks
CREATE TRIGGER prevent_xmss_signature_reuse
    BEFORE INSERT ON xmss_signature_usage
    FOR EACH ROW
    EXECUTE FUNCTION prevent_signature_reuse();

-- Views for common queries

-- View for active quantum addresses with key state information
CREATE VIEW active_quantum_addresses AS
SELECT 
    qa.id,
    qa.address,
    qa.scheme,
    qa.wallet_id,
    qa.created_at,
    xks.id as key_state_id,
    xks.signature_index,
    xks.max_signatures,
    xks.max_signatures - xks.signature_index as remaining_signatures,
    ROUND((xks.signature_index::float / xks.max_signatures::float) * 100, 2) as usage_percentage,
    xks.is_exhausted,
    CASE 
        WHEN xks.max_signatures - xks.signature_index < 100 THEN 'critical'
        WHEN xks.max_signatures - xks.signature_index < 1000 THEN 'warning'
        ELSE 'normal'
    END as warning_level
FROM quantum_addresses qa
JOIN xmss_key_states xks ON qa.key_state_id = xks.id
WHERE qa.is_active = true AND xks.is_active = true;

-- View for key rotation candidates
CREATE VIEW key_rotation_candidates AS
SELECT 
    id,
    wallet_id,
    scheme,
    signature_index,
    max_signatures,
    max_signatures - signature_index as remaining_signatures,
    ROUND((signature_index::float / max_signatures::float) * 100, 2) as usage_percentage,
    last_signed_at,
    created_at
FROM xmss_key_states
WHERE is_active = true 
AND (
    signature_index >= max_signatures * 0.8 OR  -- 80% used
    (rotation_threshold IS NOT NULL AND signature_index >= rotation_threshold)
)
ORDER BY usage_percentage DESC;

-- Security and maintenance procedures

-- Function to rotate XMSS keys
CREATE OR REPLACE FUNCTION rotate_xmss_key(
    p_key_state_id UUID,
    p_new_scheme VARCHAR(50) DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    old_key xmss_key_states%ROWTYPE;
    new_key_id UUID;
BEGIN
    -- Get old key information
    SELECT * INTO old_key FROM xmss_key_states WHERE id = p_key_state_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Key state not found: %', p_key_state_id;
    END IF;
    
    -- Use same scheme if not specified
    IF p_new_scheme IS NULL THEN
        p_new_scheme := old_key.scheme;
    END IF;
    
    -- This would integrate with the application layer to generate new keys
    -- For now, we just mark the old key as inactive and log the rotation
    UPDATE xmss_key_states 
    SET is_active = false, updated_at = NOW()
    WHERE id = p_key_state_id;
    
    -- Log rotation
    INSERT INTO xmss_audit_log (operation_type, key_state_id, wallet_id, scheme, operation_data, result)
    VALUES ('rotate_key', p_key_state_id, old_key.wallet_id, old_key.scheme,
            json_build_object('old_key_id', p_key_state_id, 'new_scheme', p_new_scheme, 'remaining_signatures', old_key.max_signatures - old_key.signature_index),
            'success');
    
    RETURN p_key_state_id; -- In real implementation, return new key ID
END;
$$ language 'plpgsql';

-- Function to cleanup old audit logs
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(retention_days INTEGER DEFAULT 365)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM xmss_audit_log 
    WHERE performed_at < NOW() - INTERVAL '1 day' * retention_days;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    RETURN deleted_count;
END;
$$ language 'plpgsql';

-- Comments for documentation
COMMENT ON TABLE xmss_key_states IS 'Stores XMSS quantum-resistant key states with signature index tracking';
COMMENT ON TABLE xmss_signature_usage IS 'Tracks usage of individual XMSS signatures to prevent reuse attacks';
COMMENT ON TABLE quantum_addresses IS 'Maps quantum-resistant addresses to their public keys and schemes';
COMMENT ON TABLE xmss_key_backups IS 'Secure encrypted backups of XMSS key states';
COMMENT ON TABLE xmss_audit_log IS 'Comprehensive audit log for all XMSS operations';
COMMENT ON TABLE xmss_scheme_parameters IS 'Reference table for supported quantum-resistant signature schemes';

COMMENT ON COLUMN xmss_key_states.signature_index IS 'Current signature index - CRITICAL: never reuse indices';
COMMENT ON COLUMN xmss_key_states.encrypted_private_key IS 'AES-GCM encrypted private key data with salt and IV';
COMMENT ON COLUMN xmss_signature_usage.signature_index IS 'One-time-use signature index for this key';
COMMENT ON COLUMN quantum_addresses.address IS 'Quantum-resistant address format: qr + 40 hex chars';

-- Grant appropriate permissions (adjust as needed for your application)
-- GRANT SELECT, INSERT, UPDATE ON xmss_key_states TO app_user;
-- GRANT SELECT, INSERT ON xmss_signature_usage TO app_user;
-- GRANT SELECT, INSERT, UPDATE ON quantum_addresses TO app_user;
-- GRANT SELECT, INSERT ON xmss_key_backups TO app_user;
-- GRANT SELECT, INSERT ON xmss_audit_log TO app_user;
-- GRANT SELECT ON xmss_scheme_parameters TO app_user;