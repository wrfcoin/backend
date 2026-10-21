-- WRFCoin Backend Baseline Schema
-- Consolidated from 947 migrations into a single baseline.
-- Generated from shared/schema.ts, shared/governance-schema.ts,
-- shared/mfa-schema.ts, shared/file-schema.ts, shared/schema-lineage.ts
--
-- This migration creates the full database schema from scratch.
-- All statements use IF NOT EXISTS for idempotent re-runs.

-- ============================================================================
-- 1. CORE TABLES
-- ============================================================================

-- Users
CREATE TABLE IF NOT EXISTS "users" (
  "id" serial PRIMARY KEY,
  "username" text NOT NULL UNIQUE,
  "email" text,
  "wallet_address" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "last_login" timestamp,
  "status" text NOT NULL DEFAULT 'active',
  "role" text NOT NULL DEFAULT 'user',
  "preferences" jsonb,
  "profile_picture" text,
  "reputation" integer DEFAULT 0,
  "display_name" text,
  "bio" text,
  "avatar" text,
  "location" text,
  "is_verified" boolean DEFAULT false,
  "last_active_at" timestamp,
  "password_hash" text,
  "mfa_enabled" boolean DEFAULT false,
  "permissions" jsonb
);

-- Transactions
CREATE TABLE IF NOT EXISTS "transactions" (
  "id" serial PRIMARY KEY,
  "tx_id" text NOT NULL UNIQUE,
  "from_address" text NOT NULL,
  "to_address" text NOT NULL,
  "amount" integer NOT NULL,
  "fee" integer NOT NULL,
  "timestamp" timestamp NOT NULL DEFAULT now(),
  "status" text NOT NULL,
  "type" text NOT NULL,
  "block_id" integer,
  "data" jsonb
);

-- Blocks
CREATE TABLE IF NOT EXISTS "blocks" (
  "id" serial PRIMARY KEY,
  "block_id" text NOT NULL UNIQUE,
  "height" integer NOT NULL,
  "timestamp" timestamp NOT NULL DEFAULT now(),
  "hash" text NOT NULL,
  "prev_hash" text NOT NULL,
  "transaction_count" integer NOT NULL,
  "difficulty" integer NOT NULL,
  "size" integer NOT NULL,
  "validator" text,
  "merkle_root" text NOT NULL,
  "nonce" text,
  "block_type" text NOT NULL DEFAULT 'standard',
  "signature" text,
  "metadata" jsonb
);

-- Wallets
CREATE TABLE IF NOT EXISTS "wallets" (
  "id" serial PRIMARY KEY,
  "address" text NOT NULL UNIQUE,
  "network" text NOT NULL DEFAULT 'testnet',
  "balance" text NOT NULL DEFAULT '0',
  "last_updated" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "public_key" text,
  "label" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "metadata" jsonb
);

-- ============================================================================
-- 2. NFT TABLES
-- ============================================================================

-- NFTs
CREATE TABLE IF NOT EXISTS "nfts" (
  "id" serial PRIMARY KEY,
  "nft_id" text NOT NULL UNIQUE,
  "title" text NOT NULL,
  "description" text,
  "creator" text NOT NULL,
  "owner" text NOT NULL,
  "content_uri" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "transaction_id" text,
  "metadata" jsonb,
  "nft_type" text NOT NULL DEFAULT 'standard'
);

-- Computational NFTs
CREATE TABLE IF NOT EXISTS "computational_nfts" (
  "id" serial PRIMARY KEY,
  "nft_id" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text,
  "creator" text NOT NULL,
  "content_uri" text,
  "computation_type" text,
  "computation_complexity" integer,
  "resource_requirements" jsonb,
  "input_data" jsonb,
  "parameters" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "is_verified" boolean DEFAULT false,
  "verifiers" jsonb,
  "region" text,
  "accuracy" text,
  "creator_reputation" integer,
  "verification_signatures" jsonb,
  "execution_result_hash" text,
  "metadata" jsonb,
  "transaction_id" text,
  "version_tag" text
);

-- Computational Tasks
CREATE TABLE IF NOT EXISTS "computational_tasks" (
  "id" serial PRIMARY KEY,
  "task_id" text NOT NULL UNIQUE,
  "name" text,
  "title" text,
  "description" text,
  "latitude" text,
  "longitude" text,
  "region" text,
  "region_code" text,
  "task_type" text,
  "priority" text,
  "base_reward" integer,
  "status" text NOT NULL DEFAULT 'PENDING',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "deadline" timestamp,
  "requires_verification" boolean DEFAULT true,
  "data_metrics" jsonb,
  "assigned_node_id" text,
  "nft_id" integer REFERENCES "computational_nfts"("id")
);

-- NFT Workflow Links
CREATE TABLE IF NOT EXISTS "nft_workflow_links" (
  "id" text PRIMARY KEY,
  "nft_id" text NOT NULL,
  "workflow_id" text NOT NULL,
  "name" text NOT NULL,
  "trigger_type" text NOT NULL DEFAULT 'manual',
  "trigger_events" jsonb,
  "schedule" text,
  "input_mappings" jsonb,
  "last_run" timestamp,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb
);

-- Computational Nodes
CREATE TABLE IF NOT EXISTS "computational_nodes" (
  "id" serial PRIMARY KEY,
  "node_id" text NOT NULL UNIQUE,
  "operator_address" text NOT NULL,
  "capabilities" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "last_heartbeat" timestamp,
  "total_tasks_completed" integer NOT NULL DEFAULT 0,
  "uptime" text NOT NULL DEFAULT '0',
  "location" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb
);

-- ============================================================================
-- 3. WEATHER TABLES
-- ============================================================================

-- Weather Data
CREATE TABLE IF NOT EXISTS "weather_data" (
  "id" serial PRIMARY KEY,
  "data_id" text NOT NULL UNIQUE,
  "timestamp" timestamp NOT NULL DEFAULT now(),
  "latitude" text NOT NULL,
  "longitude" text NOT NULL,
  "elevation" integer,
  "station_id" text,
  "temperature" text,
  "humidity" text,
  "pressure" text,
  "wind_speed" text,
  "wind_direction" text,
  "precipitation" text,
  "cloud_cover" text,
  "visibility" text,
  "data_hash" text NOT NULL,
  "signature" text,
  "verification_status" text NOT NULL DEFAULT 'pending',
  "verifiers" jsonb,
  "block_id" text,
  "source_type" text NOT NULL,
  "metadata" jsonb
);

-- Weather Forecasts
CREATE TABLE IF NOT EXISTS "weather_forecasts" (
  "id" serial PRIMARY KEY,
  "forecast_id" text NOT NULL UNIQUE,
  "generated_at" timestamp NOT NULL DEFAULT now(),
  "valid_from" timestamp NOT NULL,
  "valid_to" timestamp NOT NULL,
  "region" text NOT NULL,
  "resolution" text NOT NULL,
  "latitude" text NOT NULL,
  "longitude" text NOT NULL,
  "model_name" text NOT NULL,
  "model_version" text NOT NULL,
  "creator" text NOT NULL,
  "data_uri" text NOT NULL,
  "metrics" jsonb,
  "variables" jsonb NOT NULL,
  "verification_status" text NOT NULL DEFAULT 'pending',
  "verifiers" jsonb,
  "transaction_id" text,
  "task_id" text,
  "metadata" jsonb
);

-- Weather Stations
CREATE TABLE IF NOT EXISTS "weather_stations" (
  "id" serial PRIMARY KEY,
  "station_id" text NOT NULL UNIQUE,
  "owner_address" text NOT NULL,
  "location" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "quality_score" integer NOT NULL DEFAULT 100,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "last_reward_time" timestamp,
  "total_rewards" text DEFAULT '0',
  "metadata" jsonb
);

-- Weather Alert History
CREATE TABLE IF NOT EXISTS "weather_alert_history" (
  "id" serial PRIMARY KEY,
  "alert_id" text NOT NULL UNIQUE,
  "alert_type" text NOT NULL,
  "severity" text NOT NULL,
  "status" text NOT NULL,
  "area_desc" text,
  "zone_ids" jsonb,
  "payload" jsonb NOT NULL,
  "issued_at" timestamp,
  "effective_at" timestamp,
  "expires_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- Weather Data Quality
CREATE TABLE IF NOT EXISTS "weather_data_quality" (
  "id" serial PRIMARY KEY,
  "station_id" text NOT NULL,
  "submission_id" text,
  "data_id" text REFERENCES "weather_data"("data_id"),
  "quality_score" real,
  "confidence" real,
  "factors" jsonb,
  "anomaly_detected" boolean DEFAULT false,
  "validation_status" text DEFAULT 'pending',
  "calculated_at" timestamp DEFAULT now(),
  "validated_by" text,
  "metadata" jsonb
);

-- ============================================================================
-- 4. FORECAST ENSEMBLE TABLES
-- ============================================================================

-- Forecast Ensemble Submissions
CREATE TABLE IF NOT EXISTS "forecast_ensemble_submissions" (
  "id" serial PRIMARY KEY,
  "submission_id" text NOT NULL UNIQUE,
  "round_id" text NOT NULL,
  "model_id" text NOT NULL,
  "model_name" text NOT NULL,
  "contributor_address" text,
  "domain_bounds" jsonb NOT NULL,
  "valid_time_range" jsonb NOT NULL,
  "forecast_ref" jsonb NOT NULL,
  "metrics" jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "submitted_at" timestamp NOT NULL DEFAULT now(),
  "scored_at" timestamp,
  "metadata" jsonb
);

-- Forecast Ensemble Rounds
CREATE TABLE IF NOT EXISTS "forecast_ensemble_rounds" (
  "id" serial PRIMARY KEY,
  "round_id" text NOT NULL UNIQUE,
  "scored_at" timestamp NOT NULL DEFAULT now(),
  "winner_model_id" text,
  "participants" integer NOT NULL DEFAULT 0,
  "metadata" jsonb
);

-- Forecast Ensemble Scores
CREATE TABLE IF NOT EXISTS "forecast_ensemble_scores" (
  "id" serial PRIMARY KEY,
  "round_id" text NOT NULL,
  "model_id" text NOT NULL,
  "skill_score" real NOT NULL,
  "scored_at" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb
);

-- Forecast Model Lifecycle
CREATE TABLE IF NOT EXISTS "forecast_model_lifecycle" (
  "id" serial PRIMARY KEY,
  "model_id" text NOT NULL UNIQUE,
  "model_name" text NOT NULL,
  "rounds" integer NOT NULL DEFAULT 0,
  "wins" integer NOT NULL DEFAULT 0,
  "total_skill" real NOT NULL DEFAULT 0,
  "last_skill" real NOT NULL DEFAULT 0,
  "decayed_skill" real NOT NULL DEFAULT 0,
  "consecutive_below_threshold" integer NOT NULL DEFAULT 0,
  "retired" boolean NOT NULL DEFAULT false,
  "last_scored_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- Forecast Coverage Metrics
CREATE TABLE IF NOT EXISTS "forecast_coverage_metrics" (
  "id" serial PRIMARY KEY,
  "region" text NOT NULL,
  "coverage" integer NOT NULL,
  "accuracy" integer NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb
);

-- ============================================================================
-- 5. ADVISORY TABLES
-- ============================================================================

-- Advisory Policy Versions
CREATE TABLE IF NOT EXISTS "advisory_policy_versions" (
  "id" serial PRIMARY KEY,
  "policy_id" text NOT NULL,
  "event_class" text NOT NULL,
  "version" text NOT NULL,
  "rule_bundle" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- Advisory Decisions
CREATE TABLE IF NOT EXISTS "advisory_decisions" (
  "id" serial PRIMARY KEY,
  "advisory_id" text NOT NULL UNIQUE,
  "event_class" text NOT NULL,
  "advisory_level" text NOT NULL,
  "policy_version" text NOT NULL,
  "rule_bundle_version" text NOT NULL,
  "model_enabled" boolean NOT NULL DEFAULT false,
  "model_used" boolean NOT NULL DEFAULT false,
  "model_fallback_used" boolean NOT NULL DEFAULT false,
  "model_version" text,
  "model_confidence" real NOT NULL DEFAULT 0,
  "evidence_bundle" jsonb NOT NULL,
  "generated_at" timestamp NOT NULL DEFAULT now()
);

-- ============================================================================
-- 6. CARBON & ENVIRONMENTAL TABLES
-- ============================================================================

-- Carbon Credits
CREATE TABLE IF NOT EXISTS "carbon_credits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_id" text NOT NULL UNIQUE,
  "owner" text NOT NULL,
  "carbon_offset" decimal(18,8) NOT NULL,
  "project_type" text NOT NULL,
  "verification_standard" text NOT NULL,
  "issuance_date" timestamp NOT NULL,
  "expiry_date" timestamp,
  "location" jsonb,
  "is_retired" boolean DEFAULT false,
  "issuer" text NOT NULL,
  "certification_hash" text,
  "for_sale" boolean DEFAULT false,
  "price" decimal(18,8),
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

-- Carbon Footprints
CREATE TABLE IF NOT EXISTS "carbon_footprints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "total_emissions" decimal(18,8) NOT NULL,
  "total_offsets" decimal(18,8) DEFAULT '0',
  "net_emissions" decimal(18,8) NOT NULL,
  "calculation_date" timestamp NOT NULL,
  "emission_sources" jsonb,
  "offset_sources" jsonb,
  "methodology" text NOT NULL DEFAULT 'ipcc_2021',
  "confidence" real DEFAULT 0.95,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

-- Carbon Trades
CREATE TABLE IF NOT EXISTS "carbon_trades" (
  "id" serial PRIMARY KEY,
  "credit_id" text NOT NULL,
  "buyer_address" text NOT NULL,
  "seller_address" text NOT NULL,
  "price" text NOT NULL,
  "quantity" text NOT NULL,
  "total_value" text,
  "transaction_hash" text,
  "traded_at" timestamp DEFAULT now(),
  "trade_type" text DEFAULT 'market',
  "metadata" jsonb
);

-- Environmental Submissions
CREATE TABLE IF NOT EXISTS "environmental_submissions" (
  "id" serial PRIMARY KEY,
  "submission_id" text NOT NULL UNIQUE,
  "submitter_id" text NOT NULL,
  "data_type" text NOT NULL,
  "data" jsonb NOT NULL,
  "location" jsonb NOT NULL,
  "validation_state" text NOT NULL DEFAULT 'pending',
  "submission_timestamp" timestamp NOT NULL DEFAULT now(),
  "device_type" text,
  "device_id" text,
  "sensor_accuracy" text,
  "battery_level" integer,
  "signal_strength" integer,
  "maintenance_status" text,
  "firmware_version" text,
  "metadata" jsonb
);

-- Environmental Offset Proofs
CREATE TABLE IF NOT EXISTS "environmental_offset_proofs" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "offset_points" integer NOT NULL,
  "is_verified" boolean DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "proof_data" jsonb,
  "metadata" jsonb
);

-- Validation Attestations
CREATE TABLE IF NOT EXISTS "validation_attestations" (
  "id" serial PRIMARY KEY,
  "submission_id" text NOT NULL,
  "validator_did" text NOT NULL,
  "validation_type" text NOT NULL,
  "is_valid" boolean NOT NULL,
  "confidence" integer NOT NULL,
  "validated_at" timestamp NOT NULL DEFAULT now(),
  "proof" jsonb,
  "metadata" jsonb
);

-- Reference Data Sources
CREATE TABLE IF NOT EXISTS "reference_data_sources" (
  "id" serial PRIMARY KEY,
  "source_id" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text,
  "data_type" text NOT NULL,
  "url" text,
  "api_key" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "trust_level" integer NOT NULL DEFAULT 50,
  "last_sync_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb
);

-- ============================================================================
-- 7. DEFI / AMM TABLES
-- ============================================================================

-- AMM Pairs
CREATE TABLE IF NOT EXISTS "amm_pairs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pair_address" text NOT NULL UNIQUE,
  "token0" text NOT NULL,
  "token1" text NOT NULL,
  "reserve0" decimal(36,18) NOT NULL,
  "reserve1" decimal(36,18) NOT NULL,
  "total_liquidity" decimal(36,18) NOT NULL,
  "swap_fee" integer DEFAULT 30,
  "volume24h" decimal(36,18) DEFAULT '0',
  "volume_week" decimal(36,18) DEFAULT '0',
  "fee_rewards24h" decimal(36,18) DEFAULT '0',
  "price_token0" decimal(36,18),
  "price_token1" decimal(36,18),
  "last_update_time" timestamp DEFAULT now(),
  "is_active" boolean DEFAULT true,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now()
);

-- AMM Swaps
CREATE TABLE IF NOT EXISTS "amm_swaps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user" text NOT NULL,
  "pair_address" text NOT NULL,
  "token_in" text NOT NULL,
  "token_out" text NOT NULL,
  "amount_in" decimal(36,18) NOT NULL,
  "amount_out" decimal(36,18) NOT NULL,
  "minimum_amount_out" decimal(36,18) NOT NULL,
  "price_impact" decimal(8,6),
  "fee" decimal(36,18) NOT NULL,
  "status" text DEFAULT 'completed',
  "timestamp" timestamp NOT NULL,
  "block_number" integer,
  "transaction_hash" text UNIQUE,
  "gas_used" integer,
  "metadata" jsonb
);

-- Liquidity Positions
CREATE TABLE IF NOT EXISTS "liquidity_positions" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "pool_id" text NOT NULL,
  "pair_address" text REFERENCES "amm_pairs"("pair_address"),
  "token0_amount" text NOT NULL,
  "token1_amount" text NOT NULL,
  "lp_tokens" text NOT NULL,
  "share_percentage" text,
  "entry_price" text,
  "status" text DEFAULT 'active',
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp,
  "withdrawn_at" timestamp,
  "metadata" jsonb
);

-- ============================================================================
-- 8. STAKING TABLES
-- ============================================================================

-- Staking Deposits
CREATE TABLE IF NOT EXISTS "staking_deposits" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL,
  "validator_id" text,
  "amount" text NOT NULL,
  "lockup_period" integer,
  "deposited_at" timestamp DEFAULT now(),
  "unlocks_at" timestamp,
  "status" text DEFAULT 'active',
  "transaction_hash" text,
  "metadata" jsonb
);

-- Staking Rewards
CREATE TABLE IF NOT EXISTS "staking_rewards" (
  "id" serial PRIMARY KEY,
  "staker_id" text NOT NULL,
  "deposit_id" integer REFERENCES "staking_deposits"("id"),
  "amount" text NOT NULL,
  "reward_type" text DEFAULT 'staking',
  "period" text,
  "claimed_at" timestamp,
  "created_at" timestamp DEFAULT now(),
  "transaction_hash" text,
  "metadata" jsonb
);

-- Validators
CREATE TABLE IF NOT EXISTS "validators" (
  "id" serial PRIMARY KEY,
  "address" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text,
  "stake" integer NOT NULL,
  "commission" text NOT NULL,
  "uptime" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "joined_at" timestamp NOT NULL DEFAULT now(),
  "last_active_at" timestamp,
  "consensus_type" text NOT NULL,
  "delegated_stake" integer DEFAULT 0,
  "capabilities" jsonb,
  "location" jsonb,
  "report_url" text,
  "verification_count" integer DEFAULT 0,
  "success_rate" text DEFAULT '0',
  "reputation" text DEFAULT '0',
  "slashing_history" jsonb,
  "metadata" jsonb
);

-- ============================================================================
-- 9. REWARD TABLES
-- ============================================================================

-- Compute Rewards
CREATE TABLE IF NOT EXISTS "compute_rewards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "job_id" text NOT NULL,
  "compute_provider" text NOT NULL,
  "reward_amount" decimal(18,8) NOT NULL,
  "reward_type" text NOT NULL,
  "job_complexity" integer NOT NULL,
  "execution_time" integer,
  "quality_score" real DEFAULT 1.0,
  "status" text DEFAULT 'pending',
  "distributed_at" timestamp,
  "transaction_hash" text,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now()
);

-- PoP Rewards
CREATE TABLE IF NOT EXISTS "pop_rewards" (
  "id" serial PRIMARY KEY,
  "submission_id" text NOT NULL,
  "recipient_did" text NOT NULL,
  "reward_type" text NOT NULL,
  "amount" text NOT NULL,
  "reason" text,
  "distributed_at" timestamp NOT NULL DEFAULT now(),
  "transaction_id" text,
  "metadata" jsonb
);

-- Reward Distribution Config
CREATE TABLE IF NOT EXISTS "reward_distribution_config" (
  "id" serial PRIMARY KEY,
  "active" boolean DEFAULT true,
  "distribution_rules" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "version" text NOT NULL DEFAULT '1.0',
  "description" text
);

-- Contributor Rewards
CREATE TABLE IF NOT EXISTS "contributor_rewards" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "contributor_type" text NOT NULL,
  "amount" integer NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "reason" text,
  "metadata" jsonb
);

-- Computational Work Proofs
CREATE TABLE IF NOT EXISTS "computational_work_proofs" (
  "id" serial PRIMARY KEY,
  "task_id" text NOT NULL,
  "node_id" text NOT NULL,
  "computation_type" text NOT NULL,
  "compute_resources_used" jsonb,
  "resource_hours" integer NOT NULL,
  "reward_amount" integer NOT NULL,
  "started_at" timestamp NOT NULL,
  "completed_at" timestamp,
  "is_verified" boolean DEFAULT false,
  "result_metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- ============================================================================
-- 10. ACHIEVEMENT TABLES
-- ============================================================================

-- Achievements
CREATE TABLE IF NOT EXISTS "achievements" (
  "id" serial PRIMARY KEY,
  "achievement_id" text NOT NULL UNIQUE,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "image_url" text,
  "criteria" jsonb NOT NULL,
  "points" integer NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "category" text NOT NULL,
  "rarity" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "metadata" jsonb
);

-- User Achievements
CREATE TABLE IF NOT EXISTS "user_achievements" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "achievement_id" integer NOT NULL REFERENCES "achievements"("id"),
  "awarded_at" timestamp NOT NULL DEFAULT now(),
  "progress" integer NOT NULL DEFAULT 100,
  "status" text NOT NULL DEFAULT 'completed',
  "metadata" jsonb
);

-- Achievement Categories
CREATE TABLE IF NOT EXISTS "achievement_categories" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL UNIQUE,
  "description" text,
  "icon" text,
  "color" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb
);

-- Miner Achievement Progress
CREATE TABLE IF NOT EXISTS "miner_achievement_progress" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL,
  "achievement_id" integer NOT NULL,
  "current_progress" integer NOT NULL DEFAULT 0,
  "target_progress" integer NOT NULL,
  "is_completed" boolean NOT NULL DEFAULT false,
  "completed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb
);

-- Miner Achievements
CREATE TABLE IF NOT EXISTS "miner_achievements" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL,
  "achievement_id" integer NOT NULL,
  "awarded_at" timestamp NOT NULL DEFAULT now(),
  "progress" integer NOT NULL DEFAULT 100,
  "status" text NOT NULL DEFAULT 'completed',
  "metadata" jsonb
);

-- ============================================================================
-- 11. IDENTITY & REPUTATION TABLES
-- ============================================================================

-- Decentralized Identities
CREATE TABLE IF NOT EXISTS "decentralized_identities" (
  "id" serial PRIMARY KEY,
  "did" text NOT NULL UNIQUE,
  "identity_type" text NOT NULL,
  "verification_level" text NOT NULL DEFAULT 'basic',
  "status" text NOT NULL DEFAULT 'active',
  "public_key" text NOT NULL,
  "private_key_hash" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb
);

-- Verifiable Credentials
CREATE TABLE IF NOT EXISTS "verifiable_credentials" (
  "id" serial PRIMARY KEY,
  "credential_id" text NOT NULL UNIQUE,
  "issuer_did" text NOT NULL,
  "subject_did" text NOT NULL,
  "credential_type" text NOT NULL,
  "claims" jsonb NOT NULL,
  "issuance_date" timestamp NOT NULL DEFAULT now(),
  "expiration_date" timestamp,
  "status" text NOT NULL DEFAULT 'active',
  "proof" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb
);

-- Trust Anchors
CREATE TABLE IF NOT EXISTS "trust_anchors" (
  "id" serial PRIMARY KEY,
  "anchor_did" text NOT NULL UNIQUE,
  "anchor_type" text NOT NULL,
  "trust_level" integer NOT NULL DEFAULT 1,
  "public_key" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb
);

-- Trust Endorsements
CREATE TABLE IF NOT EXISTS "trust_endorsements" (
  "id" serial PRIMARY KEY,
  "endorser_did" text NOT NULL,
  "subject_did" text NOT NULL,
  "endorsement_type" text NOT NULL,
  "trust_score" integer NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "expires_at" timestamp,
  "metadata" jsonb
);

-- Reputation Scores
CREATE TABLE IF NOT EXISTS "reputation_scores" (
  "id" serial PRIMARY KEY,
  "identity_did" text NOT NULL UNIQUE,
  "overall_score" integer NOT NULL DEFAULT 0,
  "data_quality" integer NOT NULL DEFAULT 0,
  "reliability" integer NOT NULL DEFAULT 0,
  "verification" integer NOT NULL DEFAULT 0,
  "contribution_value" integer NOT NULL DEFAULT 0,
  "participation_level" integer NOT NULL DEFAULT 0,
  "last_updated" timestamp NOT NULL DEFAULT now(),
  "total_events" integer NOT NULL DEFAULT 0,
  "confidence_level" text NOT NULL DEFAULT 'low',
  "metadata" jsonb
);

-- Reputation Events
CREATE TABLE IF NOT EXISTS "reputation_events" (
  "id" serial PRIMARY KEY,
  "identity_did" text NOT NULL,
  "event_type" text NOT NULL,
  "factor" text NOT NULL,
  "impact" integer NOT NULL,
  "description" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "related_entity" text,
  "metadata" jsonb
);

-- Reputation Rankings
CREATE TABLE IF NOT EXISTS "reputation_rankings" (
  "id" serial PRIMARY KEY,
  "identity_did" text NOT NULL,
  "category" text NOT NULL,
  "rank" integer NOT NULL,
  "score" integer NOT NULL,
  "period" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb
);

-- Contributor Reputation
CREATE TABLE IF NOT EXISTS "contributor_reputation" (
  "id" serial PRIMARY KEY,
  "address" text NOT NULL UNIQUE,
  "role" text NOT NULL,
  "composite_score" real NOT NULL DEFAULT 0,
  "data_quality_score" real NOT NULL DEFAULT 0,
  "consistency_score" real NOT NULL DEFAULT 0,
  "verification_accuracy_score" real NOT NULL DEFAULT 0,
  "community_contribution_score" real NOT NULL DEFAULT 0,
  "tenure_score" real NOT NULL DEFAULT 0,
  "bonus_multiplier" real NOT NULL DEFAULT 1,
  "tier" text NOT NULL DEFAULT 'Bronze',
  "badges" jsonb NOT NULL DEFAULT '[]',
  "history" jsonb NOT NULL DEFAULT '[]',
  "last_contribution_at" timestamp,
  "last_updated" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb
);

-- Contributor Reputation Events
CREATE TABLE IF NOT EXISTS "contributor_reputation_events" (
  "id" serial PRIMARY KEY,
  "address" text NOT NULL,
  "role" text NOT NULL,
  "event_type" text NOT NULL,
  "data_quality" real NOT NULL DEFAULT 0,
  "uptime" real NOT NULL DEFAULT 0,
  "verification_accuracy" real NOT NULL DEFAULT 0,
  "community_contribution" real NOT NULL DEFAULT 0,
  "details" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- Algorithm Advancements
CREATE TABLE IF NOT EXISTS "algorithm_advancements" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "algorithm_name" text NOT NULL,
  "description" text,
  "is_verified" boolean DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb
);

-- ============================================================================
-- 12. CROSS-CHAIN TABLES
-- ============================================================================

-- Cross-Chain Transfers
CREATE TABLE IF NOT EXISTS "cross_chain_transfers" (
  "id" serial PRIMARY KEY,
  "transfer_id" text NOT NULL UNIQUE,
  "from_chain" text NOT NULL,
  "to_chain" text NOT NULL,
  "from_address" text NOT NULL,
  "to_address" text NOT NULL,
  "amount" text NOT NULL,
  "token_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "initiated_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp,
  "bridge_provider" text NOT NULL,
  "fees" text,
  "metadata" jsonb
);

-- Cross-Chain Bridges
CREATE TABLE IF NOT EXISTS "cross_chain_bridges" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "provider" text NOT NULL,
  "source_chain" text NOT NULL DEFAULT 'wrfcoin',
  "target_chain" text NOT NULL,
  "contract_address" text,
  "provider_api_key" text,
  "status" text NOT NULL DEFAULT 'INACTIVE',
  "last_active" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "config" jsonb,
  "gas_limit" integer,
  "max_fee_amount" integer,
  "security_level" integer DEFAULT 1,
  "requires_approval" boolean DEFAULT false,
  "approver_roles" jsonb
);

-- Cross-Chain Transactions
CREATE TABLE IF NOT EXISTS "cross_chain_transactions" (
  "id" serial PRIMARY KEY,
  "transaction_id" text NOT NULL UNIQUE,
  "bridge_id" integer NOT NULL REFERENCES "cross_chain_bridges"("id"),
  "from_address" text NOT NULL,
  "to_address" text NOT NULL,
  "amount" integer NOT NULL,
  "fee" integer NOT NULL,
  "source_chain" text NOT NULL,
  "target_chain" text NOT NULL,
  "source_transaction_hash" text,
  "target_transaction_hash" text,
  "status" text NOT NULL DEFAULT 'PENDING',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "data" jsonb,
  "error_message" text,
  "nonce" integer,
  "recovery_hash" text
);

-- Cross-Chain Networks
CREATE TABLE IF NOT EXISTS "cross_chain_networks" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL UNIQUE,
  "chain_id" text NOT NULL UNIQUE,
  "rpc_url" text NOT NULL,
  "explorer_url" text,
  "native_token" text NOT NULL,
  "logo_url" text,
  "is_testnet" boolean DEFAULT false,
  "bridge_contracts" jsonb,
  "status" text NOT NULL DEFAULT 'ACTIVE',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- ============================================================================
-- 13. GOVERNANCE TABLES (from governance-schema.ts)
-- ============================================================================

-- Governance Proposals
CREATE TABLE IF NOT EXISTS "governance_proposals" (
  "id" serial PRIMARY KEY,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "proposal_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'DEPOSIT',
  "proposer" text NOT NULL,
  "deposit" numeric NOT NULL,
  "voting_start_time" timestamp,
  "voting_end_time" timestamp,
  "submit_time" timestamp NOT NULL DEFAULT now(),
  "total_yes" numeric DEFAULT '0',
  "total_no" numeric DEFAULT '0',
  "total_no_with_veto" numeric DEFAULT '0',
  "total_abstain" numeric DEFAULT '0',
  "parameters_to_change" jsonb,
  "hash" text,
  "metadata" jsonb,
  "targets" jsonb,
  "values" jsonb,
  "calldatas" jsonb,
  "voting_type" text,
  "voting_delay" integer,
  "voting_period" integer,
  "quorum_fraction" integer,
  "emergency_proposal" boolean DEFAULT false,
  "state" text,
  "start_block" text,
  "end_block" text,
  "for_votes" text DEFAULT '0',
  "against_votes" text DEFAULT '0',
  "abstain_votes" text DEFAULT '0',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "executed_at" timestamp
);

-- Governance Votes
CREATE TABLE IF NOT EXISTS "governance_votes" (
  "id" serial PRIMARY KEY,
  "proposal_id" text NOT NULL,
  "voter" text NOT NULL,
  "vote_option" text NOT NULL,
  "support" text NOT NULL,
  "weight" text NOT NULL DEFAULT '1',
  "reason" text,
  "timestamp" timestamp NOT NULL DEFAULT now(),
  "transaction_hash" text,
  "metadata" jsonb
);

-- Governance Parameters
CREATE TABLE IF NOT EXISTS "governance_parameters" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL UNIQUE,
  "value" text NOT NULL,
  "data_type" text NOT NULL,
  "description" text,
  "min_value" text,
  "max_value" text,
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "active" boolean NOT NULL DEFAULT true,
  "metadata" jsonb
);

-- Governance Parameter History
CREATE TABLE IF NOT EXISTS "governance_parameter_history" (
  "id" serial PRIMARY KEY,
  "parameter_id" integer NOT NULL REFERENCES "governance_parameters"("id"),
  "old_value" text NOT NULL,
  "new_value" text NOT NULL,
  "change_time" timestamp NOT NULL DEFAULT now(),
  "reason" text,
  "proposal_id" integer REFERENCES "governance_proposals"("id"),
  "metadata" jsonb
);

-- Governance Delegations
CREATE TABLE IF NOT EXISTS "governance_delegations" (
  "id" serial PRIMARY KEY,
  "delegator" text NOT NULL,
  "delegate" text NOT NULL,
  "amount" numeric NOT NULL DEFAULT '0',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "active" boolean NOT NULL DEFAULT true,
  "metadata" jsonb
);

-- Governance Foundation Members
CREATE TABLE IF NOT EXISTS "governance_foundation_members" (
  "id" serial PRIMARY KEY,
  "address" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "role" text NOT NULL,
  "joined_at" timestamp NOT NULL DEFAULT now(),
  "veto_rights" boolean NOT NULL DEFAULT true,
  "veto_rights_expiry" timestamp,
  "active" boolean NOT NULL DEFAULT true,
  "metadata" jsonb
);

-- Governance Foundation Actions
CREATE TABLE IF NOT EXISTS "governance_foundation_actions" (
  "id" serial PRIMARY KEY,
  "member_address" text NOT NULL,
  "action_type" text NOT NULL,
  "action_time" timestamp NOT NULL DEFAULT now(),
  "proposal_id" integer REFERENCES "governance_proposals"("id"),
  "description" text,
  "metadata" jsonb
);

-- Governance Phase Transitions
CREATE TABLE IF NOT EXISTS "governance_phase_transitions" (
  "id" serial PRIMARY KEY,
  "phase" text NOT NULL,
  "description" text,
  "start_date" timestamp NOT NULL,
  "end_date" timestamp,
  "foundation_veto_enabled" boolean NOT NULL DEFAULT true,
  "voting_weight_config" jsonb NOT NULL,
  "metadata" jsonb
);

-- ============================================================================
-- 14. MFA & AUTH TABLES (from mfa-schema.ts)
-- ============================================================================

-- User MFA Settings
CREATE TABLE IF NOT EXISTS "user_mfa_settings" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "mfa_enabled" boolean NOT NULL DEFAULT false,
  "totp_secret" text,
  "backup_codes" jsonb,
  "recovery_email" text,
  "sms_enabled" boolean DEFAULT false,
  "phone_number" text,
  "trusted_devices" jsonb,
  "last_backup_codes_generated" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- MFA Attempts
CREATE TABLE IF NOT EXISTS "mfa_attempts" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "attempt_type" text NOT NULL,
  "success" boolean NOT NULL,
  "ip_address" inet,
  "user_agent" text,
  "device_fingerprint" text,
  "failure_reason" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- User Sessions
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id" serial PRIMARY KEY,
  "session_id" text NOT NULL UNIQUE,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "ip_address" inet,
  "user_agent" text,
  "device_fingerprint" text,
  "device_name" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "expires_at" timestamp NOT NULL,
  "last_activity_at" timestamp NOT NULL DEFAULT now(),
  "mfa_verified" boolean DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- Trusted Devices
CREATE TABLE IF NOT EXISTS "trusted_devices" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "device_fingerprint" text NOT NULL,
  "device_name" text NOT NULL,
  "device_type" text,
  "browser" text,
  "operating_system" text,
  "ip_address" inet,
  "location" jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  "last_used" timestamp NOT NULL DEFAULT now(),
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- MFA Backup Code Usage
CREATE TABLE IF NOT EXISTS "mfa_backup_code_usage" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "code_hash" text NOT NULL,
  "used_at" timestamp NOT NULL DEFAULT now(),
  "ip_address" inet,
  "user_agent" text
);

-- SMS Verification Codes
CREATE TABLE IF NOT EXISTS "sms_verification_codes" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "phone_number" text NOT NULL,
  "code" text NOT NULL,
  "purpose" text NOT NULL,
  "is_used" boolean DEFAULT false,
  "attempts" integer DEFAULT 0,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- WebAuthn Credentials
CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "credential_id" text NOT NULL UNIQUE,
  "public_key" text NOT NULL,
  "counter" integer NOT NULL DEFAULT 0,
  "device_type" text,
  "transports" jsonb,
  "aaguid" text,
  "friendly_name" text,
  "backed_up" boolean DEFAULT false,
  "last_used_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- WebAuthn Challenges
CREATE TABLE IF NOT EXISTS "webauthn_challenges" (
  "id" serial PRIMARY KEY,
  "challenge_id" text NOT NULL UNIQUE,
  "challenge" text NOT NULL,
  "user_id" integer REFERENCES "users"("id"),
  "type" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "used_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- Security Events
CREATE TABLE IF NOT EXISTS "security_events" (
  "id" serial PRIMARY KEY,
  "user_id" integer REFERENCES "users"("id"),
  "event_type" text NOT NULL,
  "severity" text NOT NULL,
  "description" text NOT NULL,
  "ip_address" inet,
  "user_agent" text,
  "device_fingerprint" text,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- ============================================================================
-- 15. FILE MANAGEMENT TABLES (from file-schema.ts)
-- ============================================================================

-- Files
CREATE TABLE IF NOT EXISTS "files" (
  "id" serial PRIMARY KEY,
  "file_id" text NOT NULL UNIQUE,
  "user_id" integer NOT NULL,
  "original_name" text NOT NULL,
  "filename" text NOT NULL,
  "mime_type" text NOT NULL,
  "file_size" integer NOT NULL,
  "storage_provider" text NOT NULL DEFAULT 'S3',
  "storage_path" text NOT NULL,
  "checksum" text NOT NULL,
  "visibility" text NOT NULL DEFAULT 'PRIVATE',
  "is_encrypted" boolean NOT NULL DEFAULT false,
  "encryption_key_id" text,
  "uploaded_at" timestamp NOT NULL DEFAULT now(),
  "last_accessed_at" timestamp,
  "last_integrity_check" timestamp,
  "expires_at" timestamp,
  "status" text NOT NULL DEFAULT 'ACTIVE',
  "category" text DEFAULT 'DOCUMENT',
  "is_archived" boolean NOT NULL DEFAULT false,
  "archived_at" timestamp,
  "tags" jsonb,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "files_file_id_idx" ON "files" ("file_id");
CREATE INDEX IF NOT EXISTS "files_user_id_idx" ON "files" ("user_id");
CREATE INDEX IF NOT EXISTS "files_visibility_idx" ON "files" ("visibility");
CREATE INDEX IF NOT EXISTS "files_status_idx" ON "files" ("status");
CREATE INDEX IF NOT EXISTS "files_category_idx" ON "files" ("category");
CREATE INDEX IF NOT EXISTS "files_is_archived_idx" ON "files" ("is_archived");
CREATE INDEX IF NOT EXISTS "files_expires_at_idx" ON "files" ("expires_at");

-- File Permissions
CREATE TABLE IF NOT EXISTS "file_permissions" (
  "id" serial PRIMARY KEY,
  "file_id" text NOT NULL,
  "user_id" integer NOT NULL,
  "granted_by_user_id" integer NOT NULL,
  "permission" text NOT NULL,
  "granted_at" timestamp NOT NULL DEFAULT now(),
  "expires_at" timestamp,
  "is_active" boolean NOT NULL DEFAULT true,
  "conditions" jsonb,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "file_permissions_file_user_idx" ON "file_permissions" ("file_id", "user_id");
CREATE INDEX IF NOT EXISTS "file_permissions_file_id_idx" ON "file_permissions" ("file_id");
CREATE INDEX IF NOT EXISTS "file_permissions_user_id_idx" ON "file_permissions" ("user_id");
CREATE INDEX IF NOT EXISTS "file_permissions_permission_idx" ON "file_permissions" ("permission");
CREATE INDEX IF NOT EXISTS "file_permissions_active_idx" ON "file_permissions" ("is_active");

-- File Access Logs
CREATE TABLE IF NOT EXISTS "file_access_logs" (
  "id" serial PRIMARY KEY,
  "file_id" text NOT NULL,
  "user_id" integer NOT NULL,
  "action" text NOT NULL,
  "permission" text NOT NULL,
  "success" boolean NOT NULL,
  "error_code" text,
  "error_message" text,
  "ip_address" text,
  "user_agent" text,
  "session_id" text,
  "request_id" text,
  "accessed_at" timestamp NOT NULL DEFAULT now(),
  "duration" integer,
  "bytes_transferred" integer,
  "metadata" jsonb
);

CREATE INDEX IF NOT EXISTS "file_access_logs_file_id_idx" ON "file_access_logs" ("file_id");
CREATE INDEX IF NOT EXISTS "file_access_logs_user_id_idx" ON "file_access_logs" ("user_id");
CREATE INDEX IF NOT EXISTS "file_access_logs_action_idx" ON "file_access_logs" ("action");
CREATE INDEX IF NOT EXISTS "file_access_logs_timestamp_idx" ON "file_access_logs" ("accessed_at");
CREATE INDEX IF NOT EXISTS "file_access_logs_success_idx" ON "file_access_logs" ("success");

-- File Shares
CREATE TABLE IF NOT EXISTS "file_shares" (
  "id" serial PRIMARY KEY,
  "file_id" text NOT NULL,
  "shared_by_user_id" integer NOT NULL,
  "share_token" text NOT NULL UNIQUE,
  "share_type" text NOT NULL DEFAULT 'LINK',
  "permissions" jsonb NOT NULL,
  "max_accesses" integer,
  "current_accesses" integer NOT NULL DEFAULT 0,
  "password_protected" boolean NOT NULL DEFAULT false,
  "password_hash" text,
  "expires_at" timestamp,
  "is_active" boolean NOT NULL DEFAULT true,
  "recipient_email" text,
  "recipient_user_id" integer,
  "notification_sent" boolean NOT NULL DEFAULT false,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "file_shares_file_id_idx" ON "file_shares" ("file_id");
CREATE INDEX IF NOT EXISTS "file_shares_token_idx" ON "file_shares" ("share_token");
CREATE INDEX IF NOT EXISTS "file_shares_shared_by_idx" ON "file_shares" ("shared_by_user_id");
CREATE INDEX IF NOT EXISTS "file_shares_active_idx" ON "file_shares" ("is_active");

-- File Integrity Logs
CREATE TABLE IF NOT EXISTS "file_integrity_logs" (
  "id" serial PRIMARY KEY,
  "file_id" text NOT NULL,
  "user_id" integer NOT NULL,
  "verification_method" text NOT NULL,
  "algorithms_used" jsonb NOT NULL,
  "status" text NOT NULL,
  "verified_at" timestamp NOT NULL DEFAULT now(),
  "verification_time" integer,
  "issues_found" jsonb,
  "hash_results" jsonb,
  "storage_sources_checked" integer DEFAULT 0,
  "corruption_type" text,
  "recovery_recommendations" jsonb,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "file_integrity_logs_file_id_idx" ON "file_integrity_logs" ("file_id");
CREATE INDEX IF NOT EXISTS "file_integrity_logs_user_id_idx" ON "file_integrity_logs" ("user_id");
CREATE INDEX IF NOT EXISTS "file_integrity_logs_status_idx" ON "file_integrity_logs" ("status");
CREATE INDEX IF NOT EXISTS "file_integrity_logs_verified_at_idx" ON "file_integrity_logs" ("verified_at");
CREATE INDEX IF NOT EXISTS "file_integrity_logs_method_idx" ON "file_integrity_logs" ("verification_method");

-- File Versions
CREATE TABLE IF NOT EXISTS "file_versions" (
  "id" serial PRIMARY KEY,
  "version_id" text NOT NULL UNIQUE,
  "file_id" text NOT NULL,
  "version_number" integer NOT NULL,
  "storage_path" text NOT NULL,
  "storage_provider" text NOT NULL DEFAULT 'S3',
  "file_size" integer NOT NULL,
  "checksum" text NOT NULL,
  "created_by" integer NOT NULL,
  "comment" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "is_current_version" boolean NOT NULL DEFAULT false,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "archived_at" timestamp
);

CREATE INDEX IF NOT EXISTS "file_versions_file_id_idx" ON "file_versions" ("file_id");
CREATE INDEX IF NOT EXISTS "file_versions_version_id_idx" ON "file_versions" ("version_id");
CREATE INDEX IF NOT EXISTS "file_versions_file_version_idx" ON "file_versions" ("file_id", "version_number");
CREATE INDEX IF NOT EXISTS "file_versions_current_idx" ON "file_versions" ("file_id", "is_current_version");
CREATE INDEX IF NOT EXISTS "file_versions_created_by_idx" ON "file_versions" ("created_by");

-- File Encryption Keys
CREATE TABLE IF NOT EXISTS "file_encryption_keys" (
  "id" serial PRIMARY KEY,
  "key_id" text NOT NULL UNIQUE,
  "file_id" text NOT NULL,
  "encrypted_key" text NOT NULL,
  "iv" text NOT NULL,
  "auth_tag" text NOT NULL,
  "algorithm" text NOT NULL DEFAULT 'AES-256-GCM',
  "kek_handle" text NOT NULL,
  "key_version" integer NOT NULL DEFAULT 1,
  "is_active" boolean NOT NULL DEFAULT true,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "rotated_at" timestamp,
  "expires_at" timestamp
);

CREATE INDEX IF NOT EXISTS "file_encryption_keys_key_id_idx" ON "file_encryption_keys" ("key_id");
CREATE INDEX IF NOT EXISTS "file_encryption_keys_file_id_idx" ON "file_encryption_keys" ("file_id");
CREATE INDEX IF NOT EXISTS "file_encryption_keys_kek_handle_idx" ON "file_encryption_keys" ("kek_handle");
CREATE INDEX IF NOT EXISTS "file_encryption_keys_active_idx" ON "file_encryption_keys" ("is_active");

-- ============================================================================
-- 16. AUDIT & COMPLIANCE TABLES (from file-schema.ts)
-- ============================================================================

-- Security Audit Events
CREATE TABLE IF NOT EXISTS "security_audit_events" (
  "id" serial PRIMARY KEY,
  "event_type" text NOT NULL,
  "event_category" text NOT NULL,
  "user_id" integer,
  "target_user_id" integer,
  "file_id" text,
  "resource_type" text,
  "resource_id" text,
  "action" text NOT NULL,
  "result" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'MEDIUM',
  "ip_address" text,
  "user_agent" text,
  "session_id" text,
  "request_id" text,
  "details" jsonb,
  "error_code" text,
  "error_message" text,
  "geolocation" jsonb,
  "device_fingerprint" text,
  "risk_score" integer,
  "compliance_flags" jsonb,
  "remedial_actions" jsonb,
  "event_time" timestamp NOT NULL DEFAULT now(),
  "processed_at" timestamp,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "security_audit_events_event_type_idx" ON "security_audit_events" ("event_type");
CREATE INDEX IF NOT EXISTS "security_audit_events_user_id_idx" ON "security_audit_events" ("user_id");
CREATE INDEX IF NOT EXISTS "security_audit_events_file_id_idx" ON "security_audit_events" ("file_id");
CREATE INDEX IF NOT EXISTS "security_audit_events_event_time_idx" ON "security_audit_events" ("event_time");
CREATE INDEX IF NOT EXISTS "security_audit_events_severity_idx" ON "security_audit_events" ("severity");
CREATE INDEX IF NOT EXISTS "security_audit_events_result_idx" ON "security_audit_events" ("result");
CREATE INDEX IF NOT EXISTS "security_audit_events_resource_type_idx" ON "security_audit_events" ("resource_type");

-- System Activity Logs
CREATE TABLE IF NOT EXISTS "system_activity_logs" (
  "id" serial PRIMARY KEY,
  "activity_type" text NOT NULL,
  "activity_category" text NOT NULL,
  "component" text NOT NULL,
  "operation" text NOT NULL,
  "status" text NOT NULL,
  "priority" text NOT NULL DEFAULT 'MEDIUM',
  "file_id" text,
  "user_id" integer,
  "storage_provider" text,
  "network_provider" text,
  "start_time" timestamp NOT NULL,
  "end_time" timestamp,
  "duration" integer,
  "bytes_processed" integer,
  "resources_used" jsonb,
  "performance_metrics" jsonb,
  "health_indicators" jsonb,
  "error_details" jsonb,
  "warning_messages" jsonb,
  "configuration_used" jsonb,
  "environment_info" jsonb,
  "audit_trail" jsonb,
  "alerts_triggered" jsonb,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "system_activity_logs_activity_type_idx" ON "system_activity_logs" ("activity_type");
CREATE INDEX IF NOT EXISTS "system_activity_logs_component_idx" ON "system_activity_logs" ("component");
CREATE INDEX IF NOT EXISTS "system_activity_logs_status_idx" ON "system_activity_logs" ("status");
CREATE INDEX IF NOT EXISTS "system_activity_logs_start_time_idx" ON "system_activity_logs" ("start_time");
CREATE INDEX IF NOT EXISTS "system_activity_logs_file_id_idx" ON "system_activity_logs" ("file_id");
CREATE INDEX IF NOT EXISTS "system_activity_logs_user_id_idx" ON "system_activity_logs" ("user_id");
CREATE INDEX IF NOT EXISTS "system_activity_logs_priority_idx" ON "system_activity_logs" ("priority");

-- Audit Reports
CREATE TABLE IF NOT EXISTS "audit_reports" (
  "id" serial PRIMARY KEY,
  "report_id" text NOT NULL UNIQUE,
  "report_type" text NOT NULL,
  "report_category" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "generated_by" integer NOT NULL,
  "period_start" timestamp NOT NULL,
  "period_end" timestamp NOT NULL,
  "status" text NOT NULL DEFAULT 'GENERATING',
  "format" text NOT NULL DEFAULT 'JSON',
  "file_size" integer,
  "file_path" text,
  "download_url" text,
  "expires_at" timestamp,
  "parameters" jsonb,
  "summary" jsonb,
  "findings" jsonb,
  "recommendations" jsonb,
  "compliance_status" jsonb,
  "risk_assessment" jsonb,
  "action_items" jsonb,
  "distribution_list" jsonb,
  "generation_time" integer,
  "records_processed" integer,
  "error_log" jsonb,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "audit_reports_report_id_idx" ON "audit_reports" ("report_id");
CREATE INDEX IF NOT EXISTS "audit_reports_report_type_idx" ON "audit_reports" ("report_type");
CREATE INDEX IF NOT EXISTS "audit_reports_generated_by_idx" ON "audit_reports" ("generated_by");
CREATE INDEX IF NOT EXISTS "audit_reports_status_idx" ON "audit_reports" ("status");
CREATE INDEX IF NOT EXISTS "audit_reports_created_at_idx" ON "audit_reports" ("created_at");
CREATE INDEX IF NOT EXISTS "audit_reports_period_idx" ON "audit_reports" ("period_start", "period_end");

-- Compliance Audit Trail
CREATE TABLE IF NOT EXISTS "compliance_audit_trail" (
  "id" serial PRIMARY KEY,
  "audit_id" text NOT NULL UNIQUE,
  "compliance_framework" text NOT NULL,
  "requirement_id" text NOT NULL,
  "requirement_description" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "assessment_type" text NOT NULL,
  "assessment_result" text NOT NULL,
  "confidence_level" text NOT NULL,
  "assessor_id" integer,
  "assessor_type" text NOT NULL,
  "evidence_collected" jsonb,
  "controls_evaluated" jsonb,
  "findings" jsonb,
  "non_compliance_reasons" jsonb,
  "remediation_required" boolean NOT NULL DEFAULT false,
  "remediation_plan" jsonb,
  "remediation_deadline" timestamp,
  "risk_level" text NOT NULL DEFAULT 'MEDIUM',
  "business_impact" text,
  "regulatory_implications" jsonb,
  "previous_assessment_id" text,
  "changes_since_last_assessment" jsonb,
  "assessment_period" jsonb,
  "next_assessment_due" timestamp,
  "audit_trail_references" jsonb,
  "documentation_links" jsonb,
  "approval_status" text DEFAULT 'PENDING',
  "approved_by" integer,
  "approved_at" timestamp,
  "assessed_at" timestamp NOT NULL DEFAULT now(),
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "compliance_audit_trail_audit_id_idx" ON "compliance_audit_trail" ("audit_id");
CREATE INDEX IF NOT EXISTS "compliance_audit_trail_framework_idx" ON "compliance_audit_trail" ("compliance_framework");
CREATE INDEX IF NOT EXISTS "compliance_audit_trail_entity_idx" ON "compliance_audit_trail" ("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "compliance_audit_trail_result_idx" ON "compliance_audit_trail" ("assessment_result");
CREATE INDEX IF NOT EXISTS "compliance_audit_trail_assessed_at_idx" ON "compliance_audit_trail" ("assessed_at");
CREATE INDEX IF NOT EXISTS "compliance_audit_trail_risk_level_idx" ON "compliance_audit_trail" ("risk_level");
CREATE INDEX IF NOT EXISTS "compliance_audit_trail_next_due_idx" ON "compliance_audit_trail" ("next_assessment_due");

-- ============================================================================
-- 17. DATA LINEAGE TABLE (from schema-lineage.ts)
-- ============================================================================

-- Lineage Records
CREATE TABLE IF NOT EXISTS "lineage_records" (
  "id" serial PRIMARY KEY,
  "lineage_id" varchar(128) NOT NULL UNIQUE,
  "parent_lineage_id" varchar(128),
  "stage_id" varchar(64) NOT NULL,
  "station_id" varchar(128),
  "commit_id" varchar(128),
  "content_hash" varchar(128) NOT NULL,
  "signature" varchar(256),
  "processor_id" varchar(128) NOT NULL,
  "source_type" varchar(50) NOT NULL,
  "source_reference" varchar(255),
  "transformation_applied" text,
  "input_refs" jsonb,
  "metadata" jsonb,
  "is_valid" boolean DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- ============================================================================
-- 18. MISCELLANEOUS TABLES
-- ============================================================================

-- Wolfram Settings
CREATE TABLE IF NOT EXISTS "wolfram_settings" (
  "id" serial PRIMARY KEY,
  "api_key" text,
  "use_caching" boolean DEFAULT true,
  "cache_ttl" integer DEFAULT 86400000,
  "use_alternative_endpoint" boolean DEFAULT false,
  "alternative_endpoint" text,
  "max_queries_per_day" integer DEFAULT 1000,
  "prefer_short_answers" boolean DEFAULT true,
  "timeout_ms" integer DEFAULT 30000,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
