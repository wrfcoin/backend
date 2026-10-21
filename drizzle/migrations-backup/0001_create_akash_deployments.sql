-- Migration: Create Akash Deployments Table
-- Description: Creates a table to store Akash Network deployment information

CREATE TABLE akash_deployments (
  id SERIAL PRIMARY KEY,
  deployment_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  image TEXT NOT NULL,
  cpu INTEGER NOT NULL,
  memory TEXT NOT NULL,
  storage TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMP,
  status TEXT NOT NULL,
  manifest JSONB NOT NULL,
  environment JSONB,
  endpoints JSONB,
  metrics JSONB
);

-- Create indexes to improve query performance
CREATE INDEX idx_akash_deployments_deployment_id ON akash_deployments(deployment_id);
CREATE INDEX idx_akash_deployments_status ON akash_deployments(status);
CREATE INDEX idx_akash_deployments_created_at ON akash_deployments(created_at);