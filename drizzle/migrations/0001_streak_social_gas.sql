CREATE TABLE IF NOT EXISTS "streak_milestones_claimed" (
  "wallet_address"  text        NOT NULL,
  "milestone_days"  integer     NOT NULL,
  "claimed_at"      timestamptz DEFAULT now(),
  "tx_hash"         text,
  PRIMARY KEY ("wallet_address", "milestone_days")
);
CREATE TABLE IF NOT EXISTS "social_accounts" (
  "sub"            text NOT NULL,
  "provider"       text NOT NULL,
  "email"          text,
  "wallet_address" text NOT NULL,
  "created_at"     timestamptz DEFAULT now(),
  PRIMARY KEY ("sub", "provider")
);
CREATE INDEX IF NOT EXISTS "idx_social_accounts_wallet"
  ON "social_accounts" ("wallet_address");
CREATE TABLE IF NOT EXISTS "gas_sponsor_log" (
  "id"             serial      PRIMARY KEY,
  "wallet_address" text        NOT NULL,
  "user_op_hash"   text,
  "sponsored_at"   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_gas_sponsor_log_wallet_time"
  ON "gas_sponsor_log" ("wallet_address", "sponsored_at");
