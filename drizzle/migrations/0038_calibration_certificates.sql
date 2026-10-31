-- Station calibration certificates (core4#388/#435, backend#931; server/services/calibration-certificates.ts).
-- Off-chain record of trust-root-signed calibration certificates and their signed revocations. No
-- consensus write: core4 `calibration_attestations` stays empty until a chain transaction exists.
-- Stations are keyed by their PUBLIC alias (st_ + 12 hex); the raw station id is never stored. No
-- personal data: identity is the alias and, optionally, the owner's wallet inside the signed JSON.
--
-- CT101's backend does not run migrations at startup: apply this file by hand before setting
-- CALIBRATION_CERTIFICATES_ENABLED=true.
--
-- Down (reversible): DROP TABLE calibration_certificate_revocations; DROP TABLE calibration_certificates;
CREATE TABLE IF NOT EXISTS calibration_certificates (
  -- CIDv1 (base32, raw codec, sha2-256) of the canonical signed JSON: 'b' + 58 base32 characters.
  cid text PRIMARY KEY CHECK (cid ~ '^b[a-z2-7]{58}$'),
  artifact_id text NOT NULL UNIQUE CHECK (length(artifact_id) BETWEEN 1 AND 128),
  station_alias text NOT NULL CHECK (station_alias ~ '^st_[0-9a-f]{12}$'),
  artifact jsonb NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS calibration_certificates_station
  ON calibration_certificates(station_alias, issued_at DESC, submitted_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS calibration_certificate_revocations (
  artifact_id text PRIMARY KEY REFERENCES calibration_certificates(artifact_id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('superseded','sensor_replaced','sensor_moved','calibration_error','key_compromise','other')),
  revoked_at timestamptz NOT NULL,
  root_id text NOT NULL CHECK (length(root_id) BETWEEN 1 AND 128),
  revocation jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
