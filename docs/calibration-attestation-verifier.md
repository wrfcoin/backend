# Calibration Attestation Artifact Verifier (Issue #435)

## Scope

This verifier is an off-chain backend pipeline for calibration attestation artifacts referenced by reveal CIDs.

- Consensus path stays deterministic and on-chain.
- Backend performs nondeterministic artifact trust checks:
  - fetch artifact by CID
  - schema/structure validation
  - issuer trust-root and certificate-chain validation
  - certificate expiry and revocation validation
  - cloned artifact detection across stations

## Deterministic Output Contract

The backend emits a normalized summary for indexer/protocol-facing policy consumers.

Schema version:

- `calibration_attestation_verifier_summary/v1`

Fields:

- `verificationId: string` - deterministic hash over request + decision material
- `status: 'verified' | 'rejected' | 'error'`
- `reasonCodes: string[]` - stable sorted reason-code list
- `commitId: string`
- `stationId: string`
- `canonicalCalibrationAttestationCid: string`
- `artifactId: string | null`
- `artifactDigestSha256: string | null`
- `issuerId: string | null`
- `trustRootId: string | null`
- `verifiedAt: string` (ISO timestamp)

Reason codes:

- `CAL_OK`
- `CAL_CID_INVALID`
- `CAL_ARTIFACT_FETCH_ERROR`
- `CAL_ARTIFACT_NOT_FOUND`
- `CAL_ARTIFACT_SCHEMA_INVALID`
- `CAL_SUBJECT_STATION_MISMATCH`
- `CAL_ATTESTATION_TIME_WINDOW_INVALID`
- `CAL_ATTESTATION_NOT_YET_VALID`
- `CAL_ATTESTATION_EXPIRED`
- `CAL_CERT_CHAIN_MISSING`
- `CAL_CERT_CHAIN_BROKEN`
- `CAL_CERT_NOT_YET_VALID`
- `CAL_CERT_EXPIRED`
- `CAL_CERT_REVOKED`
- `CAL_TRUST_ROOT_UNCONFIGURED`
- `CAL_ISSUER_UNTRUSTED_ROOT`
- `CAL_ARTIFACT_CLONED`

## API Surfaces

- `POST /api/calibration-attestations/verify`
- `GET /api/calibration-attestations/status/:verificationId`
- `GET /api/calibration-attestations/status/by-commit/:commitId`
- `GET /api/indexer/calibration-attestations/verification-summaries`

## Trust Root Configuration

### Trust roots

Set `CALIBRATION_TRUST_ROOTS_JSON` to a JSON array of active trust roots:

```json
[
  {
    "rootId": "wrf-root-ca-1",
    "subject": "WRF Root CA",
    "fingerprintSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "active": true
  }
]
```

If no active trust roots are configured, verification fails closed with `CAL_TRUST_ROOT_UNCONFIGURED`.

### Revocations

Configure revocations with either:

- `CALIBRATION_REVOKED_CERTIFICATES_JSON` (preferred)
- `CALIBRATION_REVOKED_CERT_FINGERPRINTS` (comma-separated SHA-256 fingerprints)

Example JSON:

```json
[
  {
    "fingerprintSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "reason": "key_compromise",
    "revokedAt": "2026-02-10T00:00:00.000Z"
  }
]
```

## Operational Model

1. Canonicalize CID into provider-bound form (`ipfs:`, `filecoin:`, `arweave:`).
2. Resolve artifact by canonical CID.
3. Validate schema version and required fields.
4. Enforce subject station binding (`subject.stationId` must match expected station).
5. Validate attestation validity window (`issuedAt < expiresAt`, not stale/not future).
6. Validate certificate chain:
   - chain exists and links parent/child correctly
   - each cert has valid SHA-256 fingerprint and validity window
   - root cert matches an active configured trust root
7. Enforce revocation checks against configured revocation feed.
8. Enforce clone detection:
   - `artifactId` already verified for a different station -> `CAL_ARTIFACT_CLONED`
9. Emit normalized summary for API/indexer consumers.

## Example Outputs

Verified:

```json
{
  "schemaVersion": "calibration_attestation_verifier_summary/v1",
  "status": "verified",
  "reasonCodes": ["CAL_OK"],
  "commitId": "commit-valid-1",
  "stationId": "station-a",
  "canonicalCalibrationAttestationCid": "ipfs:bafybeigdyrzt2w7m3u5kwf5m6u4w7j2g3ctj7hwv7xwm3pt6z4f6xv2f3e",
  "artifactId": "artifact-shared-001",
  "issuerId": "WRF Calibration Issuer A",
  "trustRootId": "wrf-root-ca-1"
}
```

Rejected (revoked certificate):

```json
{
  "schemaVersion": "calibration_attestation_verifier_summary/v1",
  "status": "rejected",
  "reasonCodes": ["CAL_CERT_REVOKED"],
  "commitId": "commit-revoked-1",
  "stationId": "station-a",
  "canonicalCalibrationAttestationCid": "arweave:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "artifactId": "artifact-revoked-003",
  "issuerId": "WRF Calibration Issuer A",
  "trustRootId": "wrf-root-ca-1"
}
```
