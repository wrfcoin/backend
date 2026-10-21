-- Create wormhole_transfers table
-- This table stores cross-chain transfer data from Wormhole protocol

CREATE TABLE IF NOT EXISTS wormhole_transfers (
  id serial PRIMARY KEY,
  transfer_id text NOT NULL UNIQUE,
  from_chain integer NOT NULL,
  to_chain integer NOT NULL,
  from_address text NOT NULL,
  to_address text NOT NULL,
  amount text NOT NULL,
  token_address text,
  status text NOT NULL DEFAULT 'pending',
  initiated_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp,
  transaction_hash text,
  destination_hash text,
  metadata jsonb,
  emitter_chain integer,
  emitter_address text,
  sequence bigint,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wormhole_transfers_transfer_id
  ON wormhole_transfers (transfer_id);

CREATE INDEX IF NOT EXISTS idx_wormhole_transfers_from_address
  ON wormhole_transfers (from_address);

CREATE INDEX IF NOT EXISTS idx_wormhole_transfers_to_address
  ON wormhole_transfers (to_address);

CREATE INDEX IF NOT EXISTS idx_wormhole_transfers_status
  ON wormhole_transfers (status);
