-- Migration for Account Abstraction Features

-- Smart Wallets table
CREATE TABLE IF NOT EXISTS "smart_wallets" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER REFERENCES "users"("id"),
  "address" VARCHAR(64) NOT NULL UNIQUE,
  "mode" VARCHAR(20) NOT NULL DEFAULT 'standard',
  "owner" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP DEFAULT now(),
  "updated_at" TIMESTAMP DEFAULT now(),
  "requirements" JSONB DEFAULT '{}',
  "scripts" JSONB DEFAULT '{}',
  "recovery_options" JSONB DEFAULT '[]',
  "metadata_uri" TEXT,
  "chain_id" INTEGER DEFAULT 1,
  "version" VARCHAR(10) DEFAULT '1.0'
);

-- Delegations table
CREATE TABLE IF NOT EXISTS "delegations" (
  "id" SERIAL PRIMARY KEY,
  "delegation_id" VARCHAR(64) NOT NULL UNIQUE,
  "smart_wallet_id" INTEGER REFERENCES "smart_wallets"("id"),
  "grantor" VARCHAR(64) NOT NULL,
  "delegate" VARCHAR(64) NOT NULL,
  "auth_type" VARCHAR(20) NOT NULL DEFAULT 'single_use',
  "operation_types" JSONB DEFAULT '["transfer"]',
  "valid_from" TIMESTAMP DEFAULT now(),
  "valid_until" TIMESTAMP,
  "max_amount" VARCHAR(64),
  "target_restrictions" JSONB DEFAULT '[]',
  "condition_script" TEXT,
  "revoked" BOOLEAN DEFAULT false,
  "signature" TEXT,
  "last_used_nonce" INTEGER DEFAULT 0,
  "created_at" TIMESTAMP DEFAULT now(),
  "updated_at" TIMESTAMP DEFAULT now()
);

-- Sponsors table
CREATE TABLE IF NOT EXISTS "sponsors" (
  "id" SERIAL PRIMARY KEY,
  "smart_wallet_id" INTEGER REFERENCES "smart_wallets"("id"),
  "sponsor" VARCHAR(64) NOT NULL,
  "max_daily_amount" VARCHAR(64),
  "used_today" VARCHAR(64) DEFAULT '0',
  "last_reset_date" TIMESTAMP DEFAULT now(),
  "allowed_operation_types" JSONB DEFAULT '["transfer"]',
  "allowed_targets" JSONB DEFAULT '[]',
  "active" BOOLEAN DEFAULT true,
  "created_at" TIMESTAMP DEFAULT now(),
  "updated_at" TIMESTAMP DEFAULT now()
);

-- User Operations table
CREATE TABLE IF NOT EXISTS "user_operations" (
  "id" SERIAL PRIMARY KEY,
  "operation_id" VARCHAR(64) NOT NULL UNIQUE,
  "smart_wallet_id" INTEGER REFERENCES "smart_wallets"("id"),
  "sender" VARCHAR(64) NOT NULL,
  "target" VARCHAR(64),
  "value" VARCHAR(64) DEFAULT '0',
  "data" TEXT,
  "nonce" INTEGER NOT NULL,
  "max_fee" VARCHAR(64) DEFAULT '0',
  "operation_type" VARCHAR(20) DEFAULT 'transfer',
  "signature" TEXT,
  "sponsor_signature" TEXT,
  "valid_until" TIMESTAMP,
  "valid_after" TIMESTAMP,
  "delegate" VARCHAR(64),
  "paymaster" VARCHAR(64),
  "call_script_hash" VARCHAR(64),
  "metadata_uri" TEXT,
  "weather_data_reference" TEXT,
  "status" VARCHAR(20) DEFAULT 'pending',
  "transaction_id" VARCHAR(64),
  "created_at" TIMESTAMP DEFAULT now(),
  "updated_at" TIMESTAMP DEFAULT now()
);

-- Bundles table
CREATE TABLE IF NOT EXISTS "bundles" (
  "id" SERIAL PRIMARY KEY,
  "bundle_id" VARCHAR(64) NOT NULL UNIQUE,
  "status" VARCHAR(20) DEFAULT 'pending',
  "block_number" INTEGER,
  "operation_count" INTEGER DEFAULT 0,
  "total_fees" VARCHAR(64) DEFAULT '0',
  "bundler" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP DEFAULT now(),
  "updated_at" TIMESTAMP DEFAULT now()
);

-- Bundle Operations table
CREATE TABLE IF NOT EXISTS "bundle_operations" (
  "id" SERIAL PRIMARY KEY,
  "bundle_id" INTEGER REFERENCES "bundles"("id"),
  "operation_id" INTEGER REFERENCES "user_operations"("id"),
  "execution_index" INTEGER NOT NULL,
  "status" VARCHAR(20) DEFAULT 'pending',
  "created_at" TIMESTAMP DEFAULT now(),
  "updated_at" TIMESTAMP DEFAULT now()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS "smart_wallets_user_id_idx" ON "smart_wallets"("user_id");
CREATE INDEX IF NOT EXISTS "smart_wallets_address_idx" ON "smart_wallets"("address");
CREATE INDEX IF NOT EXISTS "delegations_smart_wallet_id_idx" ON "delegations"("smart_wallet_id");
CREATE INDEX IF NOT EXISTS "delegations_delegate_idx" ON "delegations"("delegate");
CREATE INDEX IF NOT EXISTS "sponsors_smart_wallet_id_idx" ON "sponsors"("smart_wallet_id");
CREATE INDEX IF NOT EXISTS "user_operations_smart_wallet_id_idx" ON "user_operations"("smart_wallet_id");
CREATE INDEX IF NOT EXISTS "user_operations_sender_idx" ON "user_operations"("sender");
CREATE INDEX IF NOT EXISTS "user_operations_status_idx" ON "user_operations"("status");
CREATE INDEX IF NOT EXISTS "bundles_bundler_idx" ON "bundles"("bundler");
CREATE INDEX IF NOT EXISTS "bundle_operations_bundle_id_idx" ON "bundle_operations"("bundle_id");
CREATE INDEX IF NOT EXISTS "bundle_operations_operation_id_idx" ON "bundle_operations"("operation_id");