-- Friend challenges (backend#249; owner demo queue 2026-11-01, item 8). Points only: nothing here pays.
--
-- NOT applied at startup: the deployed backend does not run migrations. Apply by hand before setting
-- FRIEND_CHALLENGES_ENABLED=true. Rerunnable (IF NOT EXISTS).
--
-- Down (reversible): DROP TABLE friend_challenge_readings; DROP TABLE friend_challenge_station_cursor;
--   DROP TABLE friend_challenge_participants; DROP TABLE friend_challenges;
--
-- Identity is the wallet address (owner ruling 2026-11-01: no personal data). The 2026-04 drizzle
-- `challenges` / `challenge_participants` tables in shared/schema-engagement.ts were never migrated and
-- are not used.
CREATE TABLE IF NOT EXISTS friend_challenges (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f-]{36}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 200),
  format text NOT NULL CHECK (format IN ('head_to_head', 'team')),
  target_score integer NOT NULL CHECK (target_score BETWEEN 1 AND 100000),
  invite_code text NOT NULL UNIQUE CHECK (invite_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  creator_address text NOT NULL CHECK (creator_address ~ '^0x[0-9a-f]{40}$'),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  -- Set once by the counting job when the challenge ends or someone reaches the target; counts freeze.
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS friend_challenges_open ON friend_challenges (starts_at) WHERE completed_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS friend_challenges_creator ON friend_challenges (creator_address, ends_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS friend_challenge_participants (
  challenge_id text NOT NULL REFERENCES friend_challenges(id) ON DELETE CASCADE,
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  team_name text CHECK (team_name IN ('North Front', 'Rain Riders')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  -- Readings from the wallet's stations that landed on chain inside the window (counting job).
  score integer NOT NULL DEFAULT 0 CHECK (score >= 0),
  stations integer CHECK (stations >= 0),
  score_updated_at timestamptz,
  PRIMARY KEY (challenge_id, address)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS friend_challenge_participants_address ON friend_challenge_participants (address);
--> statement-breakpoint
-- Per-station scan position on the node's observation route (next_after height, next_offset).
CREATE TABLE IF NOT EXISTS friend_challenge_station_cursor (
  station_id text PRIMARY KEY CHECK (length(station_id) BETWEEN 1 AND 128),
  next_after bigint NOT NULL CHECK (next_after >= 0),
  next_offset integer NOT NULL CHECK (next_offset >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One row per chain reading (ContributionReveal) of a tracked station: commit id, landing height and the
-- station's observation time. No reading values are stored.
CREATE TABLE IF NOT EXISTS friend_challenge_readings (
  station_id text NOT NULL CHECK (length(station_id) BETWEEN 1 AND 128),
  commit_id text NOT NULL CHECK (length(commit_id) BETWEEN 1 AND 128),
  height bigint NOT NULL CHECK (height > 0),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (station_id, commit_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS friend_challenge_readings_time ON friend_challenge_readings (station_id, observed_at);
