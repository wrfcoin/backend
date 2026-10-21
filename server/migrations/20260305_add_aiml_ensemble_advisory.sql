CREATE TABLE IF NOT EXISTS forecast_ensemble_submissions (
  id SERIAL PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  round_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  contributor_address TEXT,
  domain_bounds JSONB NOT NULL,
  valid_time_range JSONB NOT NULL,
  forecast_ref JSONB NOT NULL,
  metrics JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  scored_at TIMESTAMP,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_ensemble_submissions_round_id
  ON forecast_ensemble_submissions(round_id);

CREATE INDEX IF NOT EXISTS idx_ensemble_submissions_model_id
  ON forecast_ensemble_submissions(model_id);

CREATE TABLE IF NOT EXISTS forecast_ensemble_rounds (
  id SERIAL PRIMARY KEY,
  round_id TEXT NOT NULL UNIQUE,
  scored_at TIMESTAMP NOT NULL DEFAULT NOW(),
  winner_model_id TEXT,
  participants INTEGER NOT NULL DEFAULT 0,
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS forecast_ensemble_scores (
  id SERIAL PRIMARY KEY,
  round_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  skill_score REAL NOT NULL,
  scored_at TIMESTAMP NOT NULL DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_ensemble_scores_round_model
  ON forecast_ensemble_scores(round_id, model_id);

CREATE TABLE IF NOT EXISTS forecast_model_lifecycle (
  id SERIAL PRIMARY KEY,
  model_id TEXT NOT NULL UNIQUE,
  model_name TEXT NOT NULL,
  rounds INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  total_skill REAL NOT NULL DEFAULT 0,
  last_skill REAL NOT NULL DEFAULT 0,
  decayed_skill REAL NOT NULL DEFAULT 0,
  consecutive_below_threshold INTEGER NOT NULL DEFAULT 0,
  retired BOOLEAN NOT NULL DEFAULT FALSE,
  last_scored_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS advisory_policy_versions (
  id SERIAL PRIMARY KEY,
  policy_id TEXT NOT NULL,
  event_class TEXT NOT NULL,
  version TEXT NOT NULL,
  rule_bundle JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_advisory_policy_unique
  ON advisory_policy_versions(event_class, version);

CREATE TABLE IF NOT EXISTS advisory_decisions (
  id SERIAL PRIMARY KEY,
  advisory_id TEXT NOT NULL UNIQUE,
  event_class TEXT NOT NULL,
  advisory_level TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  rule_bundle_version TEXT NOT NULL,
  model_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  model_used BOOLEAN NOT NULL DEFAULT FALSE,
  model_fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  model_version TEXT,
  model_confidence REAL NOT NULL DEFAULT 0,
  evidence_bundle JSONB NOT NULL,
  generated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advisory_decisions_event_time
  ON advisory_decisions(event_class, generated_at DESC);
