-- Oracle Network Schema Migration
-- Created: 2025-05-21T19:42:46.498Z

-- Create enums if they don't exist
DO $$ 
BEGIN
  -- Check if oracle_request_status exists
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'oracle_request_status') THEN
    CREATE TYPE oracle_request_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'ERROR', 'CANCELLED');
  END IF;
  
  -- Check if oracle_response_status exists
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'oracle_response_status') THEN
    CREATE TYPE oracle_response_status AS ENUM ('READY', 'DELIVERED', 'ERROR', 'EXPIRED');
  END IF;
  
  -- Check if oracle_data_type exists
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'oracle_data_type') THEN
    CREATE TYPE oracle_data_type AS ENUM ('TEMPERATURE', 'PRECIPITATION', 'HUMIDITY', 'WIND', 'PRESSURE', 'AIR_QUALITY', 'FORECAST', 'HISTORICAL', 'AGGREGATE', 'CLIMATE_IMPACT');
  END IF;
  
  -- Check if bridge_provider exists
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bridge_provider') THEN
    CREATE TYPE bridge_provider AS ENUM ('AXELAR', 'LAYERZERO', 'WORMHOLE', 'HYPERLANE', 'CUSTOM');
  END IF;
  
  -- Check if bridge_status exists
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bridge_status') THEN
    CREATE TYPE bridge_status AS ENUM ('ACTIVE', 'INACTIVE', 'PAUSED', 'UPGRADING', 'FAILED');
  END IF;
END $$;

-- Create oracle_requests table
CREATE TABLE IF NOT EXISTS oracle_requests (
  id VARCHAR(64) PRIMARY KEY,
  data_type oracle_data_type NOT NULL,
  parameters JSONB NOT NULL,
  source_chain VARCHAR(100),
  source_address VARCHAR(100),
  callback_function VARCHAR(100),
  required_confidence DOUBLE PRECISION DEFAULT 0.8,
  max_validator_fee DOUBLE PRECISION,
  deadline TIMESTAMP,
  status oracle_request_status NOT NULL DEFAULT 'PENDING',
  processed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  request_hash VARCHAR(64),
  request_tx_id VARCHAR(100),
  error TEXT,
  priority INTEGER DEFAULT 1,
  requester_id INTEGER
);

-- Create oracle_responses table
CREATE TABLE IF NOT EXISTS oracle_responses (
  id VARCHAR(64) PRIMARY KEY,
  request_id VARCHAR(64) NOT NULL REFERENCES oracle_requests(id),
  data_type oracle_data_type NOT NULL,
  data JSONB NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  validator_count INTEGER NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  responded_at TIMESTAMP NOT NULL,
  status oracle_response_status NOT NULL DEFAULT 'READY',
  source_chain VARCHAR(100),
  source_address VARCHAR(100),
  delivered_at TIMESTAMP,
  transaction_hash VARCHAR(100),
  hash VARCHAR(64) NOT NULL,
  error TEXT
);

-- Create cross_chain_bridges table
CREATE TABLE IF NOT EXISTS cross_chain_bridges (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  provider bridge_provider NOT NULL,
  source_chain VARCHAR(100) NOT NULL DEFAULT 'wrfcoin',
  target_chain VARCHAR(100) NOT NULL,
  contract_address VARCHAR(100),
  provider_api_key VARCHAR(255),
  status bridge_status NOT NULL DEFAULT 'INACTIVE',
  last_active TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  config JSONB,
  gas_limit INTEGER,
  max_fee_amount DOUBLE PRECISION,
  security_level INTEGER DEFAULT 1,
  requires_approval BOOLEAN DEFAULT FALSE,
  approver_roles TEXT[]
);

-- Create validator_oracle_participation table
CREATE TABLE IF NOT EXISTS validator_oracle_participation (
  id SERIAL PRIMARY KEY,
  validator_id VARCHAR(64) NOT NULL,
  request_id VARCHAR(64) NOT NULL REFERENCES oracle_requests(id),
  response_data JSONB,
  confidence DOUBLE PRECISION,
  timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  signature VARCHAR(255),
  accuracy DOUBLE PRECISION,
  reward_amount DOUBLE PRECISION,
  reward_tx_id VARCHAR(100)
);

-- Create bridge_transactions table
CREATE TABLE IF NOT EXISTS bridge_transactions (
  id SERIAL PRIMARY KEY,
  bridge_id INTEGER NOT NULL REFERENCES cross_chain_bridges(id),
  source_chain VARCHAR(100) NOT NULL,
  target_chain VARCHAR(100) NOT NULL,
  source_address VARCHAR(100),
  target_address VARCHAR(100),
  amount DOUBLE PRECISION,
  fee DOUBLE PRECISION,
  data JSONB,
  source_tx_hash VARCHAR(100),
  target_tx_hash VARCHAR(100),
  status VARCHAR(20) NOT NULL,
  timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  error TEXT
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_oracle_requests_status ON oracle_requests(status);
CREATE INDEX IF NOT EXISTS idx_oracle_requests_data_type ON oracle_requests(data_type);
CREATE INDEX IF NOT EXISTS idx_oracle_responses_request_id ON oracle_responses(request_id);
CREATE INDEX IF NOT EXISTS idx_oracle_responses_status ON oracle_responses(status);
CREATE INDEX IF NOT EXISTS idx_validator_oracle_participation_request_id ON validator_oracle_participation(request_id);
CREATE INDEX IF NOT EXISTS idx_validator_oracle_participation_validator_id ON validator_oracle_participation(validator_id);
CREATE INDEX IF NOT EXISTS idx_bridge_transactions_bridge_id ON bridge_transactions(bridge_id);
CREATE INDEX IF NOT EXISTS idx_bridge_transactions_status ON bridge_transactions(status);
CREATE INDEX IF NOT EXISTS idx_cross_chain_bridges_status ON cross_chain_bridges(status);

-- Add data_accuracy column to validators table if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'validators' AND column_name = 'data_accuracy'
  ) THEN
    ALTER TABLE validators ADD COLUMN data_accuracy DECIMAL(5, 2);
  END IF;
END $$;
