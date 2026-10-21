-- Initial Wrfcoin Schema Migration
-- This migration captures the initial state of the Wrfcoin database

-- Computational NFTs table
CREATE TABLE IF NOT EXISTS "computational_nfts" (
  "id" SERIAL PRIMARY KEY,
  "nft_id" VARCHAR(255) NOT NULL UNIQUE,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "creator" VARCHAR(255) NOT NULL,
  "owner" VARCHAR(255),
  "token_standard" VARCHAR(50) DEFAULT 'WRC-721',
  "computation_type" VARCHAR(50) CHECK (computation_type IN ('GENERIC', 'WEATHER_FORECAST', 'CLIMATE_SIMULATION', 'AIR_QUALITY')),
  "computation_complexity" INTEGER DEFAULT 1,
  "resource_requirements" JSONB,
  "content_uri" VARCHAR(255),
  "is_verified" BOOLEAN DEFAULT false,
  "verifiers" JSONB,
  "region" VARCHAR(100),
  "accuracy" NUMERIC(5,2) DEFAULT 1.0,
  "creator_reputation" INTEGER,
  "verification_signatures" JSONB,
  "parameters" JSONB,
  "metadata" JSONB,
  "execution_result_hash" VARCHAR(255),
  "transaction_id" INTEGER,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Computational Tasks table
CREATE TABLE IF NOT EXISTS "computational_tasks" (
  "id" SERIAL PRIMARY KEY,
  "task_id" VARCHAR(255) NOT NULL UNIQUE,
  "title" VARCHAR(255),
  "description" TEXT,
  "latitude" NUMERIC(10,6),
  "longitude" NUMERIC(10,6),
  "region" VARCHAR(100),
  "region_code" VARCHAR(10),
  "task_type" VARCHAR(50) CHECK (task_type IN ('GENERIC', 'WEATHER_FORECAST', 'CLIMATE_SIMULATION', 'AIR_QUALITY')),
  "priority" VARCHAR(20) DEFAULT 'STANDARD',
  "base_reward" INTEGER DEFAULT 0,
  "status" VARCHAR(20) DEFAULT 'PENDING',
  "requires_verification" BOOLEAN DEFAULT false,
  "data_metrics" JSONB,
  "resource_requirements" JSONB,
  "nft_id" INTEGER REFERENCES "computational_nfts"("id"),
  "assigned_node_id" INTEGER,
  "verification_count" INTEGER DEFAULT 0,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "deadline" TIMESTAMP,
  "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Computational Nodes table
CREATE TABLE IF NOT EXISTS "computational_nodes" (
  "id" SERIAL PRIMARY KEY,
  "node_id" VARCHAR(255) NOT NULL UNIQUE,
  "name" VARCHAR(255),
  "wallet_address" VARCHAR(255) NOT NULL,
  "latitude" NUMERIC(10,6),
  "longitude" NUMERIC(10,6),
  "region" VARCHAR(100),
  "region_code" VARCHAR(10),
  "capabilities" TEXT[] DEFAULT '{}',
  "resource_specs" JSONB,
  "reliability" NUMERIC(4,3) DEFAULT 0.5,
  "status" VARCHAR(20) DEFAULT 'OFFLINE',
  "last_seen" TIMESTAMP,
  "reputation" INTEGER DEFAULT 0,
  "task_history" JSONB,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Environmental Data Submissions table
CREATE TABLE IF NOT EXISTS "environmental_submissions" (
  "id" SERIAL PRIMARY KEY,
  "submission_id" VARCHAR(255) NOT NULL UNIQUE,
  "submitter" VARCHAR(255) NOT NULL,
  "data_type" VARCHAR(50) NOT NULL,
  "measurements" JSONB NOT NULL,
  "location" POINT,
  "region" VARCHAR(100),
  "region_code" VARCHAR(10),
  "timestamp" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verification_status" VARCHAR(20) DEFAULT 'PENDING',
  "verification_count" INTEGER DEFAULT 0,
  "confidence_score" NUMERIC(4,3) DEFAULT 0.0,
  "transaction_id" VARCHAR(255),
  "metadata" JSONB,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Environmental Data Attestations table
CREATE TABLE IF NOT EXISTS "environmental_attestations" (
  "id" SERIAL PRIMARY KEY,
  "attestation_id" VARCHAR(255) NOT NULL UNIQUE,
  "submission_id" VARCHAR(255) NOT NULL REFERENCES "environmental_submissions"("submission_id"),
  "attester" VARCHAR(255) NOT NULL,
  "is_valid" BOOLEAN NOT NULL,
  "validation_score" NUMERIC(4,3) DEFAULT 0.5,
  "comments" TEXT,
  "attester_reputation" INTEGER,
  "timestamp" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Proximity Incentives table
CREATE TABLE IF NOT EXISTS "proximity_incentives" (
  "id" SERIAL PRIMARY KEY,
  "incentive_id" VARCHAR(255) NOT NULL UNIQUE,
  "task_id" INTEGER REFERENCES "computational_tasks"("id"),
  "node_id" INTEGER REFERENCES "computational_nodes"("id"),
  "distance_km" NUMERIC(10,3),
  "distance_tier" VARCHAR(20) CHECK (distance_tier IN ('LOCAL', 'REGIONAL', 'DISTANT', 'REMOTE')),
  "base_reward" INTEGER DEFAULT 0,
  "final_reward" INTEGER DEFAULT 0,
  "total_multiplier" NUMERIC(8,6) DEFAULT 1.0,
  "status" VARCHAR(20) DEFAULT 'CALCULATED',
  "timestamp" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "metrics" JSONB,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Users table
CREATE TABLE IF NOT EXISTS "users" (
  "id" SERIAL PRIMARY KEY,
  "username" VARCHAR(255) NOT NULL UNIQUE,
  "wallet_address" VARCHAR(255) UNIQUE,
  "email" VARCHAR(255) UNIQUE,
  "password_hash" VARCHAR(255),
  "full_name" VARCHAR(255),
  "profile_image" VARCHAR(255),
  "bio" TEXT,
  "verification_level" VARCHAR(20) DEFAULT 'UNVERIFIED',
  "reputation" INTEGER DEFAULT 0,
  "roles" TEXT[] DEFAULT '{}',
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "last_login" TIMESTAMP
);

-- Achievements table
CREATE TABLE IF NOT EXISTS "achievements" (
  "id" SERIAL PRIMARY KEY,
  "achievement_id" VARCHAR(255) NOT NULL UNIQUE,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "category" VARCHAR(50),
  "tier" VARCHAR(20) CHECK (tier IN ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM')),
  "badge_image_url" VARCHAR(255),
  "requirements" JSONB,
  "reputation_reward" INTEGER DEFAULT 0,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User Achievements table (junction table)
CREATE TABLE IF NOT EXISTS "user_achievements" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER REFERENCES "users"("id"),
  "achievement_id" VARCHAR(255) REFERENCES "achievements"("achievement_id"),
  "awarded_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "progress" JSONB,
  UNIQUE("user_id", "achievement_id")
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS "idx_computational_nfts_computation_type" ON "computational_nfts"("computation_type");
CREATE INDEX IF NOT EXISTS "idx_computational_tasks_nft_id" ON "computational_tasks"("nft_id");
CREATE INDEX IF NOT EXISTS "idx_computational_tasks_status" ON "computational_tasks"("status");
CREATE INDEX IF NOT EXISTS "idx_computational_nodes_region_code" ON "computational_nodes"("region_code");
CREATE INDEX IF NOT EXISTS "idx_environmental_submissions_data_type" ON "environmental_submissions"("data_type");
CREATE INDEX IF NOT EXISTS "idx_environmental_attestations_submission_id" ON "environmental_attestations"("submission_id");
CREATE INDEX IF NOT EXISTS "idx_proximity_incentives_task_id" ON "proximity_incentives"("task_id");
CREATE INDEX IF NOT EXISTS "idx_proximity_incentives_node_id" ON "proximity_incentives"("node_id");
CREATE INDEX IF NOT EXISTS "idx_user_achievements_user_id" ON "user_achievements"("user_id");
CREATE INDEX IF NOT EXISTS "idx_user_achievements_achievement_id" ON "user_achievements"("achievement_id");