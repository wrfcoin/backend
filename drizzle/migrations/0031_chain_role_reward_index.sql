-- Read-side receipts only. No users/stations dependency and no consensus write.
CREATE TABLE chain_reward_index_state (
  chain_id text NOT NULL,
  genesis_hash text NOT NULL CHECK (genesis_hash ~ '^[0-9a-f]{64}$'),
  cursor_height bigint NOT NULL DEFAULT 0 CHECK (cursor_height >= 0),
  cursor_hash text,
  reorg_probe_height bigint CHECK (reorg_probe_height > 0 AND reorg_probe_height <= cursor_height),
  history_floor bigint NOT NULL DEFAULT 1 CHECK (history_floor = 1),
  parser_version integer NOT NULL DEFAULT 1 CHECK (parser_version = 1),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','running','ok','missing_archive','rate_limited','upstream','invalid','budget','db_error')),
  next_run_at timestamptz NOT NULL DEFAULT '-infinity',
  checked_at timestamptz,
  PRIMARY KEY (chain_id, genesis_hash),
  CHECK ((cursor_height = 0 AND cursor_hash IS NULL) OR (cursor_height > 0 AND cursor_hash ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE chain_reward_blocks (
  chain_id text NOT NULL,
  genesis_hash text NOT NULL,
  height bigint NOT NULL CHECK (height > 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^[0-9a-f]{64}$'),
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  block_time timestamptz NOT NULL,
  parser_version integer NOT NULL CHECK (parser_version = 1),
  PRIMARY KEY (chain_id, genesis_hash, height),
  UNIQUE (chain_id, genesis_hash, height, block_hash),
  FOREIGN KEY (chain_id, genesis_hash) REFERENCES chain_reward_index_state(chain_id, genesis_hash)
);
--> statement-breakpoint
CREATE TABLE chain_role_payouts (
  chain_id text NOT NULL,
  genesis_hash text NOT NULL,
  height bigint NOT NULL,
  block_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('producer','attester')),
  event_id text NOT NULL,
  payee_address text NOT NULL CHECK (payee_address ~ '^0x[0-9a-f]{40}$'),
  operator_identity text NOT NULL,
  amount numeric(39,0) NOT NULL CHECK (amount >= 0 AND amount <= 340282366920938463463374607431768211455),
  PRIMARY KEY (chain_id, genesis_hash, role, event_id),
  FOREIGN KEY (chain_id, genesis_hash, height, block_hash) REFERENCES chain_reward_blocks(chain_id, genesis_hash, height, block_hash) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX chain_role_payouts_payee ON chain_role_payouts(chain_id, genesis_hash, role, payee_address, height);
CREATE INDEX chain_reward_blocks_time ON chain_reward_blocks(chain_id, genesis_hash, block_time);
