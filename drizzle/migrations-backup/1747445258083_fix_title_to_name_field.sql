-- Migration: fix_title_to_name_field
-- Created at: 2025-05-17T01:27:38.084Z
-- Description: This migration adds reward distribution tables and fixes BigInt configurations
-- Author: Wrfcoin Core Team

-- Up Migration
-- This section contains the SQL to apply the migration

-- Create enum types for reward distribution
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'contributor_type') THEN
        CREATE TYPE contributor_type AS ENUM ('COLLECTOR', 'ANALYZER', 'OFFSETTER', 'VALIDATOR', 'ALGORITHM_ADVANCER');
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reputation_factor') THEN
        CREATE TYPE reputation_factor AS ENUM ('BLOCK_VALIDATION', 'TRANSACTION_VALIDATION', 'DATA_SUBMISSION', 'GOVERNANCE', 'COMPUTATIONAL', 'PROXIMITY', 'PEER_ENDORSEMENT');
    END IF;
END$$;

-- Create reward_distribution_config table
CREATE TABLE IF NOT EXISTS reward_distribution_config (
  id SERIAL PRIMARY KEY,
  collector_percentage INTEGER NOT NULL,
  analyzer_percentage INTEGER NOT NULL,
  offsetter_percentage INTEGER NOT NULL,
  validator_percentage INTEGER NOT NULL,
  algorithm_percentage INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP,
  active BOOLEAN DEFAULT true NOT NULL,
  description TEXT,
  effective_from TIMESTAMP,
  effective_until TIMESTAMP,
  governance_vote_id VARCHAR(64),
  version VARCHAR(20) NOT NULL
);

-- Create contributor_rewards table
CREATE TABLE IF NOT EXISTS contributor_rewards (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  block_id INTEGER,
  transaction_id VARCHAR(64),
  contributor_type contributor_type NOT NULL,
  amount DECIMAL(20, 8) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  description TEXT,
  region VARCHAR(50),
  data_points INTEGER,
  computational_complexity INTEGER,
  verification_count INTEGER,
  network VARCHAR(20) NOT NULL
);

-- Create forecast_coverage_metrics table
CREATE TABLE IF NOT EXISTS forecast_coverage_metrics (
  id SERIAL PRIMARY KEY,
  region VARCHAR(50) NOT NULL,
  coverage_percentage DECIMAL(5, 2) NOT NULL,
  accuracy_score DECIMAL(5, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP,
  data_points INTEGER NOT NULL,
  verification_count INTEGER NOT NULL,
  contributor_count INTEGER NOT NULL,
  emission_adjustment DECIMAL(5, 2) DEFAULT 1.00
);

-- Create environmental_offset_proofs table
CREATE TABLE IF NOT EXISTS environmental_offset_proofs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  proof_type VARCHAR(50) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  verification_hash VARCHAR(128) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  verified_at TIMESTAMP,
  is_verified BOOLEAN DEFAULT false NOT NULL,
  offset_points INTEGER NOT NULL,
  description TEXT,
  location_latitude DECIMAL(10, 6),
  location_longitude DECIMAL(10, 6),
  external_reference VARCHAR(128)
);

-- Create computational_work_proofs table
CREATE TABLE IF NOT EXISTS computational_work_proofs (
  id SERIAL PRIMARY KEY,
  node_id INTEGER NOT NULL,
  task_id VARCHAR(64) NOT NULL,
  computation_type VARCHAR(50) NOT NULL,
  compute_resources_used JSONB NOT NULL,
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  verification_hash VARCHAR(128),
  is_verified BOOLEAN DEFAULT false NOT NULL,
  resource_hours DECIMAL(10, 2) NOT NULL,
  reward_amount DECIMAL(20, 8),
  result_metadata JSONB
);

-- Create algorithm_advancements table
CREATE TABLE IF NOT EXISTS algorithm_advancements (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  improvement_metrics JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  verified_at TIMESTAMP,
  is_verified BOOLEAN DEFAULT false NOT NULL,
  implementation_url VARCHAR(256),
  documentation_url VARCHAR(256),
  verification_proof VARCHAR(128),
  reward_amount DECIMAL(20, 8),
  advancement_type VARCHAR(50) NOT NULL
);

-- Fix any tables with title field that should be name field
ALTER TABLE computational_tasks 
ADD COLUMN IF NOT EXISTS name VARCHAR(100);

-- Update computational_tasks to copy title to name where needed
UPDATE computational_tasks 
SET name = title 
WHERE name IS NULL AND title IS NOT NULL;

-- Fix bigint columns to use proper mode
ALTER TABLE mining_pools 
ALTER COLUMN total_hashrate TYPE BIGINT 
USING total_hashrate::BIGINT;

-- Down Migration
-- This section contains the SQL to rollback the migration

-- Drop reward distribution tables
DROP TABLE IF EXISTS algorithm_advancements;
DROP TABLE IF EXISTS computational_work_proofs;
DROP TABLE IF EXISTS environmental_offset_proofs;
DROP TABLE IF EXISTS forecast_coverage_metrics;
DROP TABLE IF EXISTS contributor_rewards;
DROP TABLE IF EXISTS reward_distribution_config;

-- Drop name column from computational_tasks
ALTER TABLE computational_tasks 
DROP COLUMN IF EXISTS name;

-- Drop enum types
DROP TYPE IF EXISTS contributor_type;
DROP TYPE IF EXISTS reputation_factor;
