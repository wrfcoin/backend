-- Quality Metrics History Table Migration
-- Created: 2025-07-26
-- Purpose: Store historical quality metrics for data analysis and reporting

-- Create quality_metrics_history table
CREATE TABLE IF NOT EXISTS quality_metrics_history (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  quality_score INTEGER NOT NULL CHECK (quality_score >= 0 AND quality_score <= 100),
  coverage_data JSONB NOT NULL DEFAULT '{}',
  lint_issues INTEGER NOT NULL DEFAULT 0,
  security_vulnerabilities INTEGER NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for time-based queries
CREATE INDEX IF NOT EXISTS idx_quality_metrics_timestamp ON quality_metrics_history(timestamp);
CREATE INDEX IF NOT EXISTS idx_quality_metrics_created_at ON quality_metrics_history(created_at);
CREATE INDEX IF NOT EXISTS idx_quality_metrics_quality_score ON quality_metrics_history(quality_score);

-- Insert sample data for testing
INSERT INTO quality_metrics_history (quality_score, coverage_data, lint_issues, security_vulnerabilities, metadata) VALUES
(85, '{"test_coverage": 85, "code_coverage": 80, "documentation": 90}', 5, 0, '{"source": "automated_scan", "version": "1.0"}'),
(78, '{"test_coverage": 78, "code_coverage": 75, "documentation": 85}', 8, 1, '{"source": "automated_scan", "version": "1.0"}'),
(92, '{"test_coverage": 92, "code_coverage": 88, "documentation": 95}', 2, 0, '{"source": "manual_review", "version": "1.0"}');

-- Basic CRUD operations for testing

-- SELECT: Get recent quality metrics
-- SELECT * FROM quality_metrics_history ORDER BY timestamp DESC LIMIT 10;

-- INSERT: Add new quality metric
-- INSERT INTO quality_metrics_history (quality_score, coverage_data, lint_issues, security_vulnerabilities, metadata) 
-- VALUES (88, '{"test_coverage": 88, "code_coverage": 85, "documentation": 92}', 3, 0, '{"source": "ci_pipeline"}');

-- UPDATE: Update existing record (if needed)
-- UPDATE quality_metrics_history SET metadata = metadata || '{"reviewed": true}' WHERE id = 1;

-- DELETE: Remove old records (cleanup operation)
-- DELETE FROM quality_metrics_history WHERE timestamp < (NOW() - INTERVAL '30 days');