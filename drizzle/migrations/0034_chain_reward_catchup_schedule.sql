-- Persist rate pacing and failure backoff across restarts/lock owners.
ALTER TABLE chain_reward_index_state
  ADD COLUMN last_read_at timestamptz,
  ADD COLUMN failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count BETWEEN 0 AND 5);
