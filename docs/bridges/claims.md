# Bridge claims: quarantined fixture implementation

Refs wrfcoin/core4-archive#3569. Design: https://github.com/wrfcoin/core4/pull/51.

`BRIDGE_CLAIMS_ENABLED=0` is the default. The mounted `/api/bridge-claims`
routes require the existing verified wallet-login bearer; a wallet in request
JSON is ignored. No bridge code signs or submits observations, creates a station
registration, or calls rewards. Every response is explicitly non-earning. The
database enforces `fixture_only=true`; enabling the flag cannot promote fixture
proof to real ownership. The default server installs empty recorded readers, so
it cannot verify real devices or deliver real mail.

## API

- `POST /api/bridge-claims`: `{source,deviceId}`. Returns claim and challenge IDs,
  proof mode, and a code for account/public-field test challenges. For licence
  email, neither code nor destination address is returned.
- `POST /api/bridge-claims/challenges/:id/verify`: `{code}`. Wallet, source and
  canonical device come from stored challenge state, never replacement request
  fields. A code alone is insufficient for vendor/public-field sources.
- `GET /api/bridge-claims/:id`: own status only.
- `DELETE /api/bridge-claims/:id`: terminal revocation; no automatic release of
  hardware reservations. Contested identities require the existing ownership
  dispute/recovery policy; issuance cannot transfer them.

The only email implementation is `DryRunEmailSender`, storing deliveries in
private test memory with no logging or sockets. The only licence lookup reads
records supplied to `RecordedLicenceLookup`. Fictional `.invalid` addresses
and callsign aliases exercise the owner-ratified US licence-email flow.
Non-US, missing and expired licence records have no proof path. A changed
licence-record digest invalidates the outstanding code. Email records are not
stored in the database. Stale listed email and licence-mailbox compromise remain
risks; this flow proves mailbox control, not hardware cryptography.

Vendor/public-field proof uses only independently injected recorded evidence.
Shared readable inventory is not ownership. A public-field adapter must observe
the exact code at the controlled source. Real adapters, token storage and vendor
terms are separate connector work. Do not turn fixture readers into public
request parameters. APRS status packets and derived passcodes are never proof.

Challenges expire after ten minutes, consume once, bind wallet/source/device,
and permit five attempts. Issuance/verification share persistent limits of
twenty actions per fifteen minutes per wallet and normalized IP (`/64` for
IPv6). Error responses redact adapter failures. Audit events contain fixed
reason labels, not credentials. Pending reservations require adjudication if
contested; there is no public override for an attacker to take them over.

`(source,device_id)` is globally unique in the registry. Authenticated hardware
aliases additionally share a unique `hardware_key`. Ambient verification and
existing registration share their advisory lock; the migration's trigger also
protects the reverse arrival order. Cross-source physical identity is only as
strong as the adapter's authenticated alias evidence. Licence email reserves a
base callsign across SSIDs 0–15; it cannot identify all cross-network aliases.
These unresolved physical identities remain unsuitable for reward activation.

`BridgeObservations.ingest` is an internal, isolated quarantine consumer, not a
public unauthenticated ingestion endpoint. It holds every reading, ignores a
repeated packet, and suspends copied feeds on exact or twelve-sample varying
lockstep matches. No native ingestion path is replaced or downranked. There is
no native reward-path integration in this implementation. Historical lookup is
bounded to 24 hours / 10,000 samples; saturation is not evidence of uniqueness.
Production retention/index tuning remains an activation prerequisite.

## Migration and evidence

Up: registered `drizzle/migrations/0036_bridge_claims.sql`. Down:
`drizzle/rollback/0036_bridge_claims.sql`, after exporting quarantine/audit data
and stopping bridge requests. Down deliberately avoids `CASCADE`, refuses
unexpected external dependencies, and leaves existing weather stations intact.
No live database migration was run.

The Jest integration wrapper invokes Node's test runner with an embedded
PostgreSQL engine (PGlite), avoiding a live database or container. It executes
the actual SQL migration, transactions, triggers and rollback. It does not prove
multi-process PostgreSQL advisory-lock scheduling; that requires an isolated
PostgreSQL deployment test before activation. Route tests separately exercise
the mounted Express authentication/flag/error boundary.

Run under the repository's Node 24 version:
`npx tsc --noEmit`, `npx jest --config __tests__/jest.standalone.cjs --runInBand __tests__/bridges`,
then `npm test -- --runInBand`. No ULS, vendor, APRS-IS or SMTP calls occur.
