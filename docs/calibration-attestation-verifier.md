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

Set `CALIBRATION_TRUST_ROOTS_JSON` to a JSON array of active trust roots. Pin each root by its raw
ed25519 public key (`publicKeyHex`); the fingerprint is derived as sha256 of the key bytes:

```json
[
  {
    "rootId": "wrfcoin-owner-testnet",
    "subject": "WRFCoin owner (testnet)",
    "publicKeyHex": "<64 hex: the owner-held key's public half>",
    "active": true
  }
]
```

An older entry may pin `fingerprintSha256` instead. An entry whose `publicKeyHex` and
`fingerprintSha256` disagree, or that pins nothing valid, is dropped. If no active trust roots are
configured, verification fails closed with `CAL_TRUST_ROOT_UNCONFIGURED`.

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

## Station calibration certificates (public flow)

Mounted at `/api/calibration-certificates` (`server/routes/calibration-certificate-routes.ts`,
`server/services/calibration-certificates.ts`). Default OFF: every path is 404 unless
`CALIBRATION_CERTIFICATES_ENABLED=true`. Needs migration `0038_calibration_certificates`.

Demo: *a station owner gets a calibration certificate for their sensor and anyone can see it on the
station's page.*

### Who does what

1. **The station owner asks** the trust root for a certificate, outside the API (for example a
   GitHub issue), giving only the station's public alias (`st_` + 12 hex, shown on the station page)
   and their wallet address. No names, emails or other personal data are collected or stored.
2. **The trust root checks the sensor** (method of its choosing) and signs with its offline key:

   ```sh
   npx tsx scripts/calibration-certificate.ts keygen --key ~/calibration-root.pem \
       --root-id wrfcoin-owner-testnet --subject "WRFCoin owner (testnet)"   # once; prints the public entry
   npx tsx scripts/calibration-certificate.ts sign --key ~/calibration-root.pem \
       --subject "WRFCoin owner (testnet)" --station st_0123456789ab --owner 0x... --days 365 \
       --sensor "Davis 6152 temp/RH" --method "two-point salt test" --reference "NIST-traceable thermometer" \
       --out cert.json
   npx tsx scripts/calibration-certificate.ts verify --file cert.json --roots "$(cat roots.json)"
   npx tsx scripts/calibration-certificate.ts submit --file cert.json --api http://<backend>:4001
   ```

   `sign` converts a raw station id to its alias locally; the raw id is never written into the
   certificate. The private key is never printed or sent.
3. **The backend verifies** (`POST /api/calibration-certificates`): schema, subject is an alias of a
   known station, signature by an active trust root, validity window, revocation, artifact-id
   clone. The signature is the authorization; nothing unsigned is stored. The certificate is stored
   under its content id (CIDv1, raw codec, sha2-256 of the canonical JSON: the same id
   `ipfs add --cid-version=1 --raw-leaves` would give, so it can be pinned later unchanged).
4. **Anyone reads** `GET /api/calibration-certificates/station/:alias`: `status` (`calibrated`,
   `expired`, `revoked`, `not_trusted`, `invalid` or `none`), the newest certificate with its full
   signed JSON, up to five older ones, and the trust-root public keys, so the certificate can be
   re-verified independently. Status is recomputed on every read: expiry, a revocation and a removed
   trust root all show without a background job. The frontend station page shows it as a badge.

### Expiry and revocation

- Each certificate carries `issuedAt`/`expiresAt` (CLI default 365 days, at most 5 years). After
  `expiresAt` the station reads `expired`.
- `npx tsx scripts/calibration-certificate.ts revoke --key ... --artifact-id <id> --reason
  sensor_replaced --out rev.json`, then `submit --file rev.json`. Only an active trust root's
  signature is accepted (`POST /api/calibration-certificates/revocations`); the first revocation of a
  certificate stands. Reasons: `superseded`, `sensor_replaced`, `sensor_moved`, `calibration_error`,
  `key_compromise`, `other`.
- Removing a root from `CALIBRATION_TRUST_ROOTS_JSON` turns its certificates `not_trusted`.

### Exposure

The public edge admits only `GET /api/calibration-certificates/station/st_<12 hex>` with no query
(infra `public_onboarding.caddy`, behind `PUBLIC_READONLY_API=on`). The two POSTs are reached from
the operator network. Reads: 30/min per client; writes: 10/min per client; bodies at most 16 KiB.

### Chain (not built: consensus change)

core4 already has the record type, but there is no live way to write it:

- `StateTransition::RecordCalibrationAttestation` and `ChainState.calibration_attestations`
  (`shared-protocol/src/blockchain/state.rs`) exist, verify a `Calibrator`-role signing key from
  `signing_keys`, and are part of the state root.
- The only code that produced that transition was `native-chain/src/legacy/proof_of_publishing.rs`
  (a `calibration_attestation` field inside a reveal), and `native-chain/src/legacy` is not compiled
  (`native-chain/src/lib.rs` has no `legacy` module). No live `TransactionType` maps to it.
- `has_active_calibration` decides `contributor_class_for_station` (`VerifiedStation`), which sets
  the trust weight used for rewards. Writing calibration records therefore changes rewards: it is
  consensus code (new transaction type or reveal field, feature-scheduled, all three producers
  upgraded together, determinism differential).
- What is live: a reveal's `provenance.calibration_attestation_cid` is canonicalized and bound to the
  station in `commit_reveal_state.calibration_cid_bindings` (first station wins; a reuse by another
  station is refused). That binds a CID to a station on chain but does not make the station
  "calibrated" and is not read by anything here.

So certificates live off chain for now, publicly verifiable by signature. Putting them on chain is
an owner decision (see DECISIONS.md) and a separate consensus feature.
