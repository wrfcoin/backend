-- Forecaster track record (wrfcoin/core4#3604, Phase A item A4). Read-side only: no users/stations
-- dependency and no consensus write. Rows come from the SAME block reads as chain_role_payouts
-- (block metadata `reward_entries` with reason `forecast:<commit_id>`, plus the block's forecast
-- counters) and cascade with chain_reward_blocks on a reorg rewind, so a rewind needs no extra step.
--
-- Down (reversible): DROP TABLE chain_forecast_block_stats; DROP TABLE chain_forecast_decision_events;
--
-- One row per OBSERVATION of a decision: the producer repeats a pending decision in every block until
-- it finalizes, so a commit_id may appear at several heights. Readers take min(height) as the first
-- decision and never sum `amount` (nominal until finalized; paid totals come from the block counters).
CREATE TABLE chain_forecast_decision_events (
  chain_id text NOT NULL,
  genesis_hash text NOT NULL,
  height bigint NOT NULL CHECK (height > 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^[0-9a-f]{64}$'),
  commit_id text NOT NULL CHECK (length(commit_id) BETWEEN 1 AND 256),
  forecaster_address text NOT NULL CHECK (forecaster_address ~ '^0x[0-9a-f]{40}$'),
  station_id text NOT NULL,
  amount numeric(39,0) NOT NULL CHECK (amount >= 0 AND amount <= 340282366920938463463374607431768211455),
  provenance_class text NOT NULL CHECK (provenance_class IN ('real','synthetic','unclassified')),
  -- Filled only when the node exposes the revealed receipt and manifest in the block detail.
  -- core4 dd1801a3 exposes commit_id only, so these stay NULL and the API says "not yet available".
  skill_score double precision CHECK (skill_score >= 0 AND skill_score <= 1),
  rmse double precision,
  mae double precision,
  bias double precision,
  horizon_hours integer CHECK (horizon_hours >= 0),
  variables text[],
  PRIMARY KEY (chain_id, genesis_hash, height, commit_id),
  FOREIGN KEY (chain_id, genesis_hash, height, block_hash)
    REFERENCES chain_reward_blocks(chain_id, genesis_hash, height, block_hash) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX chain_forecast_decision_events_forecaster
  ON chain_forecast_decision_events(chain_id, genesis_hash, forecaster_address, height);
--> statement-breakpoint
CREATE INDEX chain_forecast_decision_events_commit
  ON chain_forecast_decision_events(chain_id, genesis_hash, commit_id, height);
--> statement-breakpoint
-- Per-block forecast counters as the producer wrote them. The chain names the minted figures
-- forecast_rewards_decided_count / _total; skipped_records counts reward_entries the read-side
-- parser could not interpret (surfaced as incomplete coverage, never silently dropped).
CREATE TABLE chain_forecast_block_stats (
  chain_id text NOT NULL,
  genesis_hash text NOT NULL,
  height bigint NOT NULL CHECK (height > 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^[0-9a-f]{64}$'),
  minted_count bigint CHECK (minted_count >= 0),
  minted_total numeric(39,0) CHECK (minted_total >= 0),
  with_receipt_count bigint CHECK (with_receipt_count >= 0),
  baseline_count bigint CHECK (baseline_count >= 0),
  skipped_records integer NOT NULL DEFAULT 0 CHECK (skipped_records >= 0),
  PRIMARY KEY (chain_id, genesis_hash, height),
  FOREIGN KEY (chain_id, genesis_hash, height, block_hash)
    REFERENCES chain_reward_blocks(chain_id, genesis_hash, height, block_hash) ON DELETE CASCADE
);
