-- API Key Management Schema Migration
-- Creates tables for comprehensive API key management

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- API Keys table - stores encrypted API key data
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL, -- References users.accounts_consolidated.id
    name VARCHAR(255) NOT NULL,
    description TEXT,
    
    -- Encrypted key data
    key_hash VARCHAR(512) NOT NULL UNIQUE, -- SHA-256 hash for validation
    key_prefix VARCHAR(12) NOT NULL, -- First 12 chars for display (wrf_xxxxx...)
    
    -- Security and permissions
    permissions JSONB NOT NULL DEFAULT '["read"]', -- ['read', 'write', 'admin']
    scopes JSONB NOT NULL DEFAULT '["*"]', -- API endpoint scopes
    
    -- Rate limiting and quotas
    rate_limit_tier VARCHAR(50) NOT NULL DEFAULT 'standard', -- standard, premium, enterprise
    daily_request_limit INTEGER DEFAULT 10000,
    monthly_request_limit INTEGER DEFAULT 300000,
    
    -- Status and lifecycle
    is_active BOOLEAN NOT NULL DEFAULT true,
    expires_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    
    -- IP and environment restrictions
    allowed_ips JSONB DEFAULT '[]', -- Array of allowed IP addresses/CIDR blocks
    allowed_domains JSONB DEFAULT '[]', -- Array of allowed referrer domains
    environment VARCHAR(50) DEFAULT 'production', -- production, staging, development
    
    -- Audit fields
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by UUID NOT NULL, -- User who created the key
    revoked_at TIMESTAMP WITH TIME ZONE,
    revoked_by UUID,
    revoke_reason TEXT
);

-- Indexes for api_keys table
CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_idx ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS api_keys_is_active_idx ON api_keys(is_active);
CREATE INDEX IF NOT EXISTS api_keys_expires_at_idx ON api_keys(expires_at);
CREATE INDEX IF NOT EXISTS api_keys_last_used_idx ON api_keys(last_used_at);

-- API Key Usage Tracking - stores request logs for analytics and rate limiting
CREATE TABLE IF NOT EXISTS api_key_usage (
    id SERIAL PRIMARY KEY,
    api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    
    -- Request details
    endpoint VARCHAR(500) NOT NULL,
    method VARCHAR(10) NOT NULL,
    status_code INTEGER NOT NULL,
    response_time INTEGER, -- milliseconds
    
    -- Request metadata
    user_agent TEXT,
    ip_address VARCHAR(45), -- IPv6 compatible
    referrer TEXT,
    request_size INTEGER, -- bytes
    response_size INTEGER, -- bytes
    
    -- Geographic and network info
    country VARCHAR(2),
    region VARCHAR(100),
    city VARCHAR(100),
    isp VARCHAR(255),
    
    -- Error tracking
    error_code VARCHAR(50),
    error_message TEXT,
    
    -- Timestamp
    requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for api_key_usage table
CREATE INDEX IF NOT EXISTS api_key_usage_api_key_id_idx ON api_key_usage(api_key_id);
CREATE INDEX IF NOT EXISTS api_key_usage_requested_at_idx ON api_key_usage(requested_at);
CREATE INDEX IF NOT EXISTS api_key_usage_endpoint_idx ON api_key_usage(endpoint);
CREATE INDEX IF NOT EXISTS api_key_usage_status_code_idx ON api_key_usage(status_code);

-- API Key Rate Limits - tracks current usage for rate limiting
CREATE TABLE IF NOT EXISTS api_key_rate_limits (
    id SERIAL PRIMARY KEY,
    api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    
    -- Time windows
    window_type VARCHAR(20) NOT NULL, -- minute, hour, day, month
    window_start TIMESTAMP WITH TIME ZONE NOT NULL,
    window_end TIMESTAMP WITH TIME ZONE NOT NULL,
    
    -- Usage counters
    request_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    
    -- Last updated
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for api_key_rate_limits table
CREATE UNIQUE INDEX IF NOT EXISTS api_key_rate_limits_key_window_idx 
    ON api_key_rate_limits(api_key_id, window_type, window_start);
CREATE INDEX IF NOT EXISTS api_key_rate_limits_window_end_idx ON api_key_rate_limits(window_end);

-- API Key Events - audit log for key lifecycle events
CREATE TABLE IF NOT EXISTS api_key_events (
    id SERIAL PRIMARY KEY,
    api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    
    -- Event details
    event_type VARCHAR(50) NOT NULL, -- created, updated, revoked, regenerated, used
    event_data JSONB DEFAULT '{}', -- Additional event metadata
    
    -- User and context
    user_id UUID NOT NULL, -- User who performed the action
    ip_address VARCHAR(45),
    user_agent TEXT,
    
    -- Timestamp
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for api_key_events table
CREATE INDEX IF NOT EXISTS api_key_events_api_key_id_idx ON api_key_events(api_key_id);
CREATE INDEX IF NOT EXISTS api_key_events_event_type_idx ON api_key_events(event_type);
CREATE INDEX IF NOT EXISTS api_key_events_occurred_at_idx ON api_key_events(occurred_at);
CREATE INDEX IF NOT EXISTS api_key_events_user_id_idx ON api_key_events(user_id);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to automatically update updated_at on api_keys
CREATE TRIGGER update_api_keys_updated_at 
    BEFORE UPDATE ON api_keys
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger to automatically update updated_at on api_key_rate_limits
CREATE TRIGGER update_api_key_rate_limits_updated_at 
    BEFORE UPDATE ON api_key_rate_limits
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Create a view for API key analytics
CREATE OR REPLACE VIEW api_key_analytics AS
SELECT 
    ak.id,
    ak.user_id,
    ak.name,
    ak.rate_limit_tier,
    ak.is_active,
    ak.created_at,
    ak.last_used_at,
    COUNT(aku.id) as total_requests,
    COUNT(CASE WHEN aku.requested_at >= CURRENT_DATE THEN 1 END) as requests_today,
    COUNT(CASE WHEN aku.requested_at >= DATE_TRUNC('month', CURRENT_DATE) THEN 1 END) as requests_this_month,
    AVG(aku.response_time) as avg_response_time,
    COUNT(CASE WHEN aku.status_code >= 400 THEN 1 END) as error_count,
    COALESCE(
        COUNT(CASE WHEN aku.status_code >= 400 THEN 1 END)::FLOAT / NULLIF(COUNT(aku.id), 0) * 100, 
        0
    ) as error_rate_percentage
FROM api_keys ak
LEFT JOIN api_key_usage aku ON ak.id = aku.api_key_id
GROUP BY ak.id, ak.user_id, ak.name, ak.rate_limit_tier, ak.is_active, ak.created_at, ak.last_used_at;

-- Create a function to clean up old usage data (for maintenance)
CREATE OR REPLACE FUNCTION cleanup_old_api_usage_data(retention_days INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM api_key_usage 
    WHERE requested_at < CURRENT_TIMESTAMP - INTERVAL '1 day' * retention_days;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    -- Also clean up old rate limit windows
    DELETE FROM api_key_rate_limits 
    WHERE window_end < CURRENT_TIMESTAMP - INTERVAL '1 day' * 7; -- Keep 7 days of rate limit data
    
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Comments for documentation
COMMENT ON TABLE api_keys IS 'Stores API key metadata with security controls and rate limiting';
COMMENT ON TABLE api_key_usage IS 'Tracks all API requests for analytics and monitoring';
COMMENT ON TABLE api_key_rate_limits IS 'Maintains rate limiting counters for different time windows';
COMMENT ON TABLE api_key_events IS 'Audit log for API key lifecycle events';
COMMENT ON VIEW api_key_analytics IS 'Aggregated analytics view for API key usage statistics';
COMMENT ON FUNCTION cleanup_old_api_usage_data IS 'Maintenance function to clean up old usage tracking data';

-- Grant permissions (adjust based on your user setup)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO api_user;
-- GRANT SELECT, INSERT ON api_key_usage TO api_user;
-- GRANT SELECT, INSERT, UPDATE ON api_key_rate_limits TO api_user;
-- GRANT SELECT, INSERT ON api_key_events TO api_user;
-- GRANT SELECT ON api_key_analytics TO api_user;