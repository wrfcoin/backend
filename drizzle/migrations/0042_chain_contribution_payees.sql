-- Which address had a real weather contribution settle in which block, for the leaderboard's streak
-- tab. Read-side only: no users/stations dependency and no consensus write. Rows come from the SAME
-- block reads as chain_role_payouts and cascade with chain_reward_blocks on a reorg rewind.
--
-- Down (reversible): DROP TABLE chain_contribution_payees;
--   ALTER TABLE chain_reward_blocks DROP COLUMN contribution_scanned;
--
-- `day` is the block's UTC date, kept here so a streak read never joins the block table.
CREATE TABLE chain_contribution_payees (
  chain_id text NOT NULL,
  genesis_hash text NOT NULL,
  height bigint NOT NULL CHECK (height > 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^[0-9a-f]{64}$'),
  contributor_address text NOT NULL CHECK (contributor_address ~ '^0x[0-9a-f]{40}$'),
  day date NOT NULL,
  PRIMARY KEY (chain_id, genesis_hash, height, contributor_address),
  FOREIGN KEY (chain_id, genesis_hash, height, block_hash)
    REFERENCES chain_reward_blocks(chain_id, genesis_hash, height, block_hash) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX chain_contribution_payees_day
  ON chain_contribution_payees(chain_id, genesis_hash, day, contributor_address);
--> statement-breakpoint
-- Blocks indexed before this table existed have not been looked at. The indexer re-reads those at its
-- normal paced budget; until none are left the streak tab returns no rows rather than short streaks.
ALTER TABLE chain_reward_blocks ADD COLUMN contribution_scanned boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Only an attester settlement can put a row in the table above, so other blocks need no re-read.
UPDATE chain_reward_blocks b SET contribution_scanned = true
  WHERE NOT EXISTS (
    SELECT 1 FROM chain_role_payouts p
    WHERE p.chain_id = b.chain_id AND p.genesis_hash = b.genesis_hash AND p.height = b.height AND p.role = 'attester'
  );
--> statement-breakpoint
CREATE INDEX chain_reward_blocks_contribution_unscanned
  ON chain_reward_blocks(chain_id, genesis_hash, height) WHERE NOT contribution_scanned;
