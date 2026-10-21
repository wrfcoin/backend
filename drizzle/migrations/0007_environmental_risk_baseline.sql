-- Seed baseline environmental datasets so fresh launches do not start with a degraded
-- environmental risk posture.

INSERT INTO "carbon_credits" (
  "token_id",
  "owner",
  "carbon_offset",
  "project_type",
  "verification_standard",
  "issuance_date",
  "issuer",
  "certification_hash",
  "for_sale",
  "metadata"
)
SELECT
  'bootstrap-credit-001',
  'bootstrap-risk-wallet',
  '12.00000000',
  'weather_monitoring',
  'Gold Standard',
  TIMESTAMP '2026-03-11 00:00:00+00',
  'WRF bootstrap issuer',
  'ipfs://wrf/bootstrap-credit-001',
  false,
  '{"seededBy":"environmental-risk-bootstrap","issue":178,"purpose":"fresh-launch-risk-baseline"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM "carbon_credits"
)
ON CONFLICT ("token_id") DO NOTHING;

INSERT INTO "carbon_footprints" (
  "user_id",
  "total_emissions",
  "total_offsets",
  "net_emissions",
  "calculation_date",
  "methodology",
  "confidence",
  "metadata"
)
SELECT
  'bootstrap-risk-profile',
  '10.00000000',
  '12.00000000',
  '-2.00000000',
  TIMESTAMP '2026-03-11 00:00:00+00',
  'bootstrap_v1',
  0.95,
  '{"seededBy":"environmental-risk-bootstrap","issue":178,"purpose":"fresh-launch-risk-baseline"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM "carbon_footprints"
);

INSERT INTO "weather_data_quality" (
  "station_id",
  "submission_id",
  "quality_score",
  "confidence",
  "anomaly_detected",
  "validation_status",
  "validated_by",
  "metadata"
)
SELECT
  'bootstrap-station-001',
  'bootstrap-quality-001',
  96,
  0.95,
  false,
  'validated',
  'system-bootstrap',
  '{"seededBy":"environmental-risk-bootstrap","issue":178,"purpose":"fresh-launch-risk-baseline"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM "weather_data_quality"
);
