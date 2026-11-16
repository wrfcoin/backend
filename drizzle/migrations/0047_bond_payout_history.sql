-- Per-bond node-pay history. The node keeps only a few node-settlement epochs and drops an epoch soon
-- after it is PAID (GET /node/settlement/<e> then answers UNKNOWN), so a bonded node's payout record over
-- many epochs has to be kept off chain. One row per (bond, epoch) the recorder observed; no row means
-- "never observed" (unknown), which is NOT the same as unpaid. Rows older than 40 epochs are pruned.
-- Public chain data only (deployment ids, epochs, amounts, payout addresses); no personal data, no
-- consensus write.
--
-- Down (reversible): DROP TABLE bond_payout_history; DROP TABLE bond_payout_history_state;
CREATE TABLE bond_payout_history (
  bond_id text NOT NULL CHECK (bond_id ~ '^[0-9a-f]{64}$'),
  epoch bigint NOT NULL CHECK (epoch >= 0),
  -- paid: in the epoch's payouts (or inferred from the payout account, see source); unpaid: the epoch
  -- settled (PAID/UNISSUED) or froze without paying this bond; pending: in the frozen provisional split,
  -- not yet matured.
  status text NOT NULL CHECK (status IN ('paid','unpaid','pending')),
  amount numeric(39,0) CHECK (amount >= 0),
  -- The epoch's maturity height (the block that credits the payout).
  height bigint CHECK (height >= 0),
  -- settlement: read from GET /node/settlement/<e>; earned_total: a pending payout confirmed by the
  -- payout account's earned_balance_total rising by at least the amount after maturity.
  source text NOT NULL CHECK (source IN ('settlement','earned_total')),
  payout_address text CHECK (payout_address ~ '^0x[0-9a-f]{40}$'),
  -- earned_balance_total of payout_address when the pending row was first written (and the tip then).
  baseline_earned numeric(39,0) CHECK (baseline_earned >= 0),
  baseline_height bigint CHECK (baseline_height >= 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bond_id, epoch)
);
--> statement-breakpoint
CREATE INDEX bond_payout_history_epoch ON bond_payout_history(epoch);
--> statement-breakpoint
CREATE INDEX bond_payout_history_pending ON bond_payout_history(payout_address) WHERE status = 'pending';
--> statement-breakpoint
-- The node-pay epoch and tip height the recorder last read (one row).
CREATE TABLE bond_payout_history_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  tip_epoch bigint NOT NULL CHECK (tip_epoch >= 0),
  tip_height bigint NOT NULL CHECK (tip_height >= 0),
  observed_at timestamptz NOT NULL DEFAULT now()
);
