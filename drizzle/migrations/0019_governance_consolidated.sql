-- Consolidated governance tables used by the mounted governance read routes.
-- Keep this migration aligned with shared/schema-governance-consolidated.ts.

CREATE TABLE IF NOT EXISTS "proposals_consolidated" (
  "id" serial PRIMARY KEY,
  "proposal_id" varchar(64) NOT NULL UNIQUE,
  "proposal_type" varchar(30) NOT NULL,
  "title" varchar(255) NOT NULL,
  "description" text NOT NULL,
  "proposer_address" varchar(64) NOT NULL,
  "proposal_data" jsonb NOT NULL,
  "voting_start_time" timestamp NOT NULL,
  "voting_end_time" timestamp NOT NULL,
  "execution_time" timestamp,
  "status" varchar(20) DEFAULT 'pending',
  "vote_count_for" bigint DEFAULT 0,
  "vote_count_against" bigint DEFAULT 0,
  "vote_count_abstain" bigint DEFAULT 0,
  "quorum_required" numeric(5, 2) NOT NULL,
  "majority_required" numeric(5, 2) NOT NULL,
  "votes" jsonb,
  "delegations" jsonb,
  "execution_result" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_proposals_consolidated_type" ON "proposals_consolidated" ("proposal_type");
CREATE INDEX IF NOT EXISTS "idx_proposals_consolidated_status" ON "proposals_consolidated" ("status");
CREATE INDEX IF NOT EXISTS "idx_proposals_consolidated_proposer" ON "proposals_consolidated" ("proposer_address");
CREATE INDEX IF NOT EXISTS "idx_proposals_consolidated_voting_start" ON "proposals_consolidated" ("voting_start_time");
CREATE INDEX IF NOT EXISTS "idx_proposals_consolidated_voting_end" ON "proposals_consolidated" ("voting_end_time");

CREATE TABLE IF NOT EXISTS "treasury_consolidated" (
  "id" serial PRIMARY KEY,
  "transaction_id" varchar(64) NOT NULL UNIQUE,
  "transaction_type" varchar(30) NOT NULL,
  "category" varchar(50),
  "from_address" varchar(64),
  "to_address" varchar(64),
  "token_address" varchar(64) NOT NULL,
  "amount" numeric(36, 18) NOT NULL,
  "usd_value" numeric(20, 8),
  "description" text,
  "proposal_id" varchar(64),
  "budget_data" jsonb,
  "contribution_data" jsonb,
  "reward_data" jsonb,
  "approval_status" varchar(20) DEFAULT 'pending',
  "approver_address" varchar(64),
  "transaction_hash" varchar(64),
  "block_number" integer,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "executed_at" timestamp
);

CREATE INDEX IF NOT EXISTS "idx_treasury_consolidated_type" ON "treasury_consolidated" ("transaction_type");
CREATE INDEX IF NOT EXISTS "idx_treasury_consolidated_category" ON "treasury_consolidated" ("category");
CREATE INDEX IF NOT EXISTS "idx_treasury_consolidated_approval" ON "treasury_consolidated" ("approval_status");
CREATE INDEX IF NOT EXISTS "idx_treasury_consolidated_proposal" ON "treasury_consolidated" ("proposal_id");
CREATE INDEX IF NOT EXISTS "idx_treasury_consolidated_from" ON "treasury_consolidated" ("from_address");

CREATE TABLE IF NOT EXISTS "foundation_consolidated" (
  "id" serial PRIMARY KEY,
  "record_id" varchar(64) NOT NULL UNIQUE,
  "record_type" varchar(30) NOT NULL,
  "member_address" varchar(64),
  "member_role" varchar(50),
  "member_permissions" jsonb,
  "action_type" varchar(50),
  "action_description" text,
  "action_data" jsonb,
  "phase_from" varchar(30),
  "phase_to" varchar(30),
  "transition_criteria" jsonb,
  "requires_approval" boolean DEFAULT true,
  "approval_status" varchar(20) DEFAULT 'pending',
  "approval_votes" jsonb,
  "executed_by" varchar(64),
  "execution_data" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "executed_at" timestamp,
  "expires_at" timestamp
);

CREATE INDEX IF NOT EXISTS "idx_foundation_consolidated_type" ON "foundation_consolidated" ("record_type");
CREATE INDEX IF NOT EXISTS "idx_foundation_consolidated_member" ON "foundation_consolidated" ("member_address");
CREATE INDEX IF NOT EXISTS "idx_foundation_consolidated_approval" ON "foundation_consolidated" ("approval_status");

CREATE TABLE IF NOT EXISTS "parameters_consolidated" (
  "id" serial PRIMARY KEY,
  "parameter_id" varchar(64) NOT NULL UNIQUE,
  "parameter_type" varchar(30) NOT NULL,
  "parameter_category" varchar(50) NOT NULL,
  "parameter_name" varchar(100) NOT NULL,
  "current_value" jsonb NOT NULL,
  "parameter_history" jsonb,
  "integration_scope" varchar(50),
  "integration_data" jsonb,
  "validation_rules" jsonb,
  "change_requirements" jsonb,
  "last_changed_by" varchar(64),
  "last_change_proposal" varchar(64),
  "emergency_override_allowed" boolean DEFAULT false,
  "is_active" boolean DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_parameters_consolidated_type" ON "parameters_consolidated" ("parameter_type");
CREATE INDEX IF NOT EXISTS "idx_parameters_consolidated_category" ON "parameters_consolidated" ("parameter_category");
CREATE INDEX IF NOT EXISTS "idx_parameters_consolidated_active" ON "parameters_consolidated" ("is_active");
