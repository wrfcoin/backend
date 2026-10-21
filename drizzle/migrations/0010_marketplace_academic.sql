-- Marketplace subscriptions and academic partnership rollout (backend#593)

CREATE TABLE IF NOT EXISTS "marketplace_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "tier" varchar(20) NOT NULL DEFAULT 'free',
  "api_key" varchar(128) NOT NULL UNIQUE,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_subscriptions_user_id_idx"
  ON "marketplace_subscriptions" ("user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_subscriptions_api_key_idx"
  ON "marketplace_subscriptions" ("api_key");

CREATE TABLE IF NOT EXISTS "marketplace_usage" (
  "id" serial PRIMARY KEY,
  "subscription_id" uuid NOT NULL REFERENCES "marketplace_subscriptions"("id") ON DELETE cascade,
  "date" varchar(10) NOT NULL,
  "request_count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_usage_sub_date_idx"
  ON "marketplace_usage" ("subscription_id", "date");

CREATE TABLE IF NOT EXISTS "academic_applications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "email" varchar(255) NOT NULL,
  "institution" varchar(255) NOT NULL,
  "research_description" text NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "provisioned_api_key" varchar(128),
  "reviewed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "academic_applications_user_id_idx"
  ON "academic_applications" ("user_id");

CREATE INDEX IF NOT EXISTS "academic_applications_status_idx"
  ON "academic_applications" ("status");

CREATE UNIQUE INDEX IF NOT EXISTS "academic_applications_email_idx"
  ON "academic_applications" ("email");
