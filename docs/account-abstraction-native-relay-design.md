# Native account transaction relay and sponsorship design

Refs #1137; parent [core4#2167](https://github.com/wrfcoin/core4/issues/2167).
Status: proposed for review, 2026-10-02. Documentation only; no router mount,
node admission, key custody, funding, scheduling or runtime readiness delivered.

## Decision and source boundary

The owner ruled that account abstraction uses a native transaction type on
2026-10-02. The reviewed [native account ADR](https://github.com/wrfcoin/core4/blob/df6264ef4/docs/adr/2026-10-02-2167-native-smart-accounts.md)
(core4#3403) is the protocol direction. The older, still-open
[core4#3206](https://github.com/wrfcoin/core4/issues/3206) describes alternatives;
its historical UserOperation proposal does not override this ruling. Backend
relays complete client-signed `NativeSmartAccount` transactions through the
ordinary native transaction path. It does not introduce an ERC-4337 bundler,
UserOperation queue or EVM gas abstraction for native WRFCoin.

Read alongside the workspace `docs/plans/overnight-2026-09-24/e1-readiness-plan.md`
(SOL-C, 2026-10-02). Findings below were checked against local Git objects and
backend source, without network/node calls or runtime tests:

| Snapshot | Confirmed source finding |
| --- | --- |
| Backend main `65efa14d7b6e4561c6ce4e08b0f6b66f2b11d1a7` | `server/routes/account-abstraction-routes.ts:839` and `:988` verify legacy JSON/secp256k1 or wallet authorization then fabricate random transaction IDs at `:953`/`:1079`, pending status and gasless/fee claims. Neither handler submits to core4. Searches of server imports and the production entrypoint find no mount; test imports exist. Issue #1137's older description of an entirely real service is stale. |
| Same backend | `server/controllers/accountAbstractionController.ts:26` uses Ethereum-address and legacy gas/operation schemas. `shared/schema-account-abstraction.ts:39`/`:58` stores delegation/sponsor metadata; these tables are not consensus permissions, balances or sponsor deposits. |
| Core4 B3 release `65134a64492135b6ac81344dd0d2edd8dfaf1309` | `shared-protocol/src/crypto/chain_binding.rs:845`/`:870` holds `session_keys`, `social_recovery`, and `paymaster` unschedulable. Production `native-chain/src/bin/launch_api/transition_extractor.rs:46` has no session/recovery/paymaster emitter. No native account transaction or account submit route exists in this release. |
| Same core4 release | `shared-protocol/src/accounts/paymaster.rs:20`/`:31` documents surrounding authorization/cost assumptions and placeholder economics. Helper existence cannot establish funded, authorized sponsorship. |
| E1 plan | Signing-version steps are refused by B3. `account_authorization_dispatch` is a limited foundation; a known feature name, domain registry entry or v2 signing helper does not make the native AA path reachable. |

These are source findings, **RUNTIME-UNVERIFIED**. Core4#3420 supplies signing
subjects, independent goldens and inventory only. Its role/fee follow-up and the
prepared bounded codec likewise do not deliver State authority, fee computation,
transaction-to-transition integration or production routes.

## Release dependency and funding gate

Full native AA, sessions, recovery and sponsorship require a new node release.
A backend deploy or E1 feature extension on B3 cannot supply the missing code.
The new `native_smart_accounts` feature stays unscheduled and unschedulable during
this work; this design requests no activation, genesis edit or env workaround.
Signing subjects explicitly bind V2 domain framing; that fact alone requires
neither a live chain-wide signing-v2 cut nor acceptance of unsupported version
steps. The final release must define and test its object-specific version policy.

Before any AA funding or user-facing enablement, require reviewed native type,
State validation/apply and persistent migration; feature-off root/checkpoint byte
parity; actual mounted admission/status routes; signer/codec parity; deterministic
fee and sponsor policy; old-key/session invalidation after recovery; and local
producer, restart, replay, snapshot and reorg tests at activation boundaries.
Core4#3169/#3170 economics and owner economic-policy decisions remain dependencies.
Enabling backend transport does not authorize funding or feature scheduling.

## HTTP contract proposal

Use a new factory router mounted explicitly under `/api/accounts`; do not mount
the legacy router unchanged. Paths and JSON schema below are proposals to freeze
with core4's reviewed RPC contract and client fixtures before implementation:

| Backend path | Purpose and authority |
| --- | --- |
| `GET /api/accounts/capabilities` | Authenticated capability report: chain/network/genesis, tip identity, node release and supported native schema, feature status and tariff revision. Missing or stale authoritative capability evidence returns unavailable, never enabled by an env flag alone. |
| `GET /api/accounts/:address` and bounded `/sessions`, `/recovery` projections | Backend wallet-login authentication, current authorized subject binding, then server-held Reader credential to proposed core4 `/accounts/{address}` routes. No user credentials forwarded upstream. |
| `POST /api/accounts/transactions` | A complete client-signed native transaction, including independent sponsor/session proofs when applicable, forwarded to proposed core4 `/transactions/accounts`. JWT controls relay access; native signatures authorize spending. |
| `GET /api/accounts/transactions/:hash` | Current authorized viewer only; authoritative node admission/inclusion/outcome projection. Never invent a receipt for an unknown hash. |

Keep the generic legacy `/meta-transaction`, `/sponsored-transaction`, operation,
bundle, delegation, wallet-creation and recovery handlers unmounted. If a future
compatibility URL is offered, return an explicit unavailable response directing
the caller to the native contract; do not reinterpret legacy JSON signatures.
The service registry will label the replacement unavailable until the mounted
path and native release gates pass. Coordinate the entrypoint with backend#955.

A wallet-login subject is an actor identity, not always the smart-account target.
Owner/session submissions bind the authenticated key/address to the signed actor,
then the node checks that actor's role and current epoch/grant. A guardian or
external recovery executor authenticates as their own actor. Recovery reads must
not require possession of the lost owner's key: an authenticated guardian can
request a bounded projection only after authoritative current policy membership
is established. Sensitive owner history uses current owner authorization; caches
must not grant a former owner access after recovery. Reader possession alone
never authorizes account mutation or arbitrary private account enumeration.

## Byte preservation and keys

The client constructs canonical native bytes and signs locally. The user owner,
session and guardian keys never enter request bodies, server storage, logs, argv
or backend signing code. The sponsor signs with its own external wallet/offline
signer; this design introduces no backend signing-key store, including for
sponsors. Sponsor infrastructure and signing availability remain separate.

The submit schema carries the reviewed native transaction envelope with its
canonical signed payload. Freeze it against the final core4 transport schema;
do not assume the prepared subject codec is already the full transaction codec.
Represent every u64/u128 amount, nonce, height and cap as canonical decimal text
at JSON boundaries. Enforce exact address/key/signature encodings, unknown-field
refusal, body limits before parsing and the codec's 16-KiB payload bound before
allocation. Agree a separate outer HTTP/envelope limit with core4 before enabling.
Reject secret-key fields and legacy operation/gas fields; never log rejected body
contents. No default chain identity, amount coercion or signature reserialization.

Forward only to a configured allowlisted core4 origin with bounded timeout,
redirect refusal and response size. The client cannot supply a node URL. Use
Reader credentials only for reads and allowlist outbound headers. Cache-control
and redacted diagnostics prevent tokens, signatures and account records leaking
through shared caches or errors. A backend precheck is advisory; the node must
repeat canonical bounds, signatures, epochs, nonce equality, fee/cap/coverage,
session/recovery rules and staged execution against authoritative state.

## Sponsorship flow and conservation

1. Fetch authenticated chain identity, tip/nonces, current epoch/policy and the
   reviewed deterministic tariff. Quotes are advisory and bind a tariff revision
   and short block-height window; a quote is not a promise of inclusion or funding.
2. The client chooses calls and account/sponsor caps and signs the complete account
   subject locally. The sponsor approves by independently signing the digest of
   that complete unsigned account preimage plus its own nonce, cap and window.
   An edit to target/calls/value/epoch/nonce/window/terms requires fresh signatures.
3. Relay the unchanged complete envelope. JWT, sponsor database row, sponsor ID,
   balance cache or a caller-supplied success/actual-cost field cannot authorize
   fees or change the fee payer. No sponsor approval is manufactured by backend.
4. Core4 verifies proofs, then actor/target and sponsor nonces/epochs, then computes
   a positive actual fee under consensus tariff and checks both signed caps and
   balance/deposit coverage before staged calls. A zero account or sponsor cap is
   refused at this stage. Admission reserves no consensus balance and is advisory.
5. Only node inclusion/receipt establishes charged fee, consumed counters and
   action outcome. The ADR specifies failed-execution charging with call rollback;
   backend must reproduce that receipt rather than infer outcome from HTTP status.

Sponsor deposits and delayed withdrawals live on chain. Backend never escrows
user WRFCoin, moves deposit balances in SQL or charges a second fee. Session fees
follow the ADR's target-paid/sponsor-paid rule; the session credential is not a
separate fee balance. Node policy bounds sponsor enrollment, per-sender use,
failure rates and aggregate capacity. Backend adds per-identity/body/queue limits;
a user cannot bypass consensus quotas by obtaining a fresh JWT or database row.

## Truthful responses, retries and recovery

Return `503 AA_UNAVAILABLE` while configuration, Reader reads, release capability
or native feature support is missing; authentication remains enforced. Unsupported
schemas/fields are `400`, unauthorized access `403`, node nonce/epoch/policy
conflicts `409`, relay throttling `429`, malformed upstream responses `502`, and
unknown submission outcomes `504 SUBMISSION_UNKNOWN`. Do not include raw upstream
bodies or credentials. Keep the final node error mapping versioned and tested.

A validated node admission response may return `202` with the node's canonical
transaction hash and status `admitted`; it does not mean included, successful,
final or gasless. Show inclusion height/block hash and exact charged base units
only from a node receipt. Unknown hashes stay unknown. Reorgs can return a receipt
to pending/unknown; cache entries are tip-bound and invalidated, not SQL settlement.

On timeout the client polls its locally derived transaction hash, then may retry
the identical signed envelope within its validity window. Bounded idempotency
entries map that hash to the same request bytes; conflicting bytes are refused.
No server changes nonce, extends expiry or re-signs. Canonical nonce checks prevent
double debit across retries/restarts/reorgs. A new nonce/epoch requires client
refresh and approval; recovery invalidates old-owner and old-session submissions,
including queued ones, and all authority-dependent caches are invalidated.

## Implementation slices and required evidence

Design approval precedes implementation of this contract. Then deliver:

1. A mounted availability/capability boundary and registry entry, default disabled,
   with no legacy-controller import or signing side effect. The mount/readiness
   guard must distinguish intentional unavailable behavior from a missing router.
2. Reader-backed authorized account projections only after native read routes
   exist, with updated-owner/guardian visibility tests and credential isolation.
3. Client-signed submit/status relay only after native wire/apply and RPC contracts
   land; independent cross-language vectors, bounds and node-owned receipts.
4. Full sponsor/session/recovery flow drills and owner review before funding.

For each behavior, retain RED on current main and mutations: fabricated success,
removed feature/release gate, JWT-as-spending-authority, outbound Reader token on
submit, arbitrary upstream URL, modified signed bytes, amount over 2^53, zero cap,
stale nonce/epoch, expired session and post-recovery former-owner read/submit.
Exercise the actual application mount and compiled dist imports, not only a
router imported by a leaf test. Cover upstream outage/malformed response/timeout,
identical retry, mixed-version nodes, failed-batch charging, deposit withdrawal
race, quota limit+1 and reorg/replay receipt parity. Full backend tsc/Jest and native
consensus gates run for implementation; a mock receipt does not establish node
execution. This design runs no such behavioral suite and claims no GREEN runtime.

Deployment of this document requires no env, migration, image or node change.
Later backend enablement defaults off, uses existing configured core4 origin and
Reader secret transport, needs an image rebuild and reviewed node release gates.
Legacy SQL AA tables remain metadata; no migration imports them into native
permissions, nonces or balances. Any removal is a separate reviewed change. Policy
and codec publication retain their predecessor requirements; no merge or schedule
is authorized by this note.
