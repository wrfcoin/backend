-- Referral codes for the /api/referrals router, mounted on the live entrypoint
-- by backend#1178. Keep this migration aligned with the `referrals` table in
-- shared/schema-engagement.ts.
--
-- Only `referrals` is created. The other tables in schema-engagement.ts
-- (challenges, challenge_participants, competitions, competition_scores) and
-- forecast_duels belong to routers that stay deliberately unmounted, so this
-- file is hand-written and schema-engagement.ts is NOT registered in
-- drizzle.config.ts (drizzle-kit would otherwise generate DDL for them too).
--
-- reward_amount_wrf keeps the schema's DEFAULT 0 and nullable type; the router
-- writes NULL on activation because no referral payout exists.

CREATE TABLE IF NOT EXISTS "referrals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "referral_code" varchar(32) NOT NULL,
  "referrer_address" varchar(255) NOT NULL,
  "referee_address" varchar(255),
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "reward_amount_wrf" integer DEFAULT 0,
  "activated_at" timestamp,
  "rewarded_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "referrals_referral_code_unique" UNIQUE ("referral_code")
);

CREATE UNIQUE INDEX IF NOT EXISTS "referrals_code_idx" ON "referrals" ("referral_code");
CREATE INDEX IF NOT EXISTS "referrals_referrer_idx" ON "referrals" ("referrer_address");
CREATE INDEX IF NOT EXISTS "referrals_referee_idx" ON "referrals" ("referee_address");
CREATE INDEX IF NOT EXISTS "referrals_status_idx" ON "referrals" ("status");
