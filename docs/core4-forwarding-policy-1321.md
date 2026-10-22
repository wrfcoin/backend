# Remaining core4 forwarding policies (#1321)

This audit applies the owner's #1284 policy A to the remaining caller-header
forwarding sites. Backend login credentials must not become core4 credentials.
Only request/correlation IDs may cross alongside a selected server credential.

| Site | Selected policy and caller boundary | Evidence / remaining decision |
| --- | --- | --- |
| Mining snapshot (`getMiningSnapshot`) | Shared public node reads: configured Reader plus tracing, or tracing only when missing. Existing backend login remains required. | Mounted regression checks all four calls and anonymous refusal. No caller fallback. |
| Blockchain `/status` | Shared aggregate read: configured Reader plus tracing for all four calls. Preserve existing public dashboard without Reader; denied stake metrics remain honest `null`. | Mounted regression checks all four calls, including missing Reader; existing stake refusal test. |
| RPC `blockchain.getStatus`, `blockchain.getBlock` | API-key authenticated shared reads with server Reader; missing Reader returns 503 before core4. | Explicit `RPC_METHOD_POLICY`, mounted regression and existing handler tests. |
| RPC `wallet.getBalance` | Owner-bound Reader read: verified wallet JWT `sub` must equal the requested address. | Policy table drives authentication and common ownership gate; #1284 owner checks remain in the handler. Guard requires address-read handlers to select `owner-reader`. |
| RPC `tx.submit` | Existing signed permissionless envelope; tracing only, with no server or caller credential. | Mounted regression and existing six-field contract tests. Core4 validates the signed envelope. |
| RPC `oracle.getForecast` | Local NOAA service; no core4 credential. | Explicit local policy; unchanged service behavior. |
| Wallet signed relay (`submitSignedTransfer`) | Existing backend login and signed `from`/JWT `sub` binding, then configured Contributor plus tracing. Missing/blank Contributor returns 503 without a call. | Mounted regressions cover replacement, missing configuration and foreign sender refusal. Core4 `transactions.rs:148` requires Contributor and verifies the signature. Compose passes only the existing variable, default empty. |
| Oracle-detail forwarding | Removed on main by #1317; do not restore. | No remaining forwarding call. Repo-wide guard rejects a reintroduction. |
| Mining `/start`, `/setup/start` → `/blocks/mine` | Verified admin roles array, server Operator + tracing. Reward address comes only from validated `WRFCOIN_MINING_REWARD_ADDRESS`; empty request body required. | Mounted tests cover both aliases, malformed roles, forged JWT, overrides, missing config/token and exact headers/body. |
| NFT mint / transfer | Verified admin + Operator. Mint payload and transfer asset/recipient are fixed in server JSON configuration; transfer URL must match the configured NFT. | Sends actual core4 `MintNftRequest` / `TransferNftRequest` fields. Core4 mutation-disabled/live-chain refusals pass through. List/detail Reader policy unchanged. |
| Governance proposals | Verified admin + Operator, fixed proposal configuration and separately configured funded proposer address. No JWT `id`/address or caller-header attribution. | Sends core4 `GovernanceProposalPayload`, rather than legacy UI title/type fields that core4 cannot deserialize. Empty request body required. |
| Governance votes | Signed ed25519 wallet JWT `sub` equals the derived signer address; strict signature verifies the exact core4 V2 vote preimage. Server Contributor + tracing and only the verified `sub` as `x-voter-address`. | Mounted real JWT/crypto tests cover valid approval/rejection, foreign wallet/key/proposal/choice/network/chain, unsigned ballots and missing credentials/signing configuration. Core4 derives voting power; caller overrides are rejected. |
| Privacy `/stealth-address` | Existing JWT session/revocation checks, then verified admin + Operator. Public spend/view keys and optional payment ID are fixed in server configuration. | The upstream creates an ephemeral secret in `privacy_key_registry`; non-admins never reach it. No new registry access proxy. |

The owner selected these policies in issue #1321 (comment 5901566064). Mining, NFT and proposal
admin trust is `server/middleware/authMiddleware.js`: HS256 JWT verification,
issuer `wrfcoin-platform`, audience `wrfcoin-api`, access-token type and 15-minute
maximum age, followed by an exact `admin` member of a **roles array**. Scalar
`role=admin`, string `roles=notadmin`, and unverified injected identities cannot
pass. Wallet login fixes `role=wallet`; it does not mint admin roles. Both gates
use `hasAdminRole` from `server/utils/admin-role.js` for exact roles-array
membership on an already verified identity; the predicate itself does not
authenticate tokens. Privacy uses the already verified identity from `server/middleware/auth.ts`
(`authenticateJWT`), supporting its configured HS256 or RS256 algorithm, session
and revocation checks, then checks the same exact admin roles-array membership.
It does not re-verify that bearer with an incompatible algorithm. Mounted real
RS256 regressions also refuse HS256, wrong registered claims, invalid roles,
revoked tokens and missing sessions.

**No in-repo admin-token issuer exists yet.** The internal roles-array helper
`AuthenticationService.generateToken` (`server/middleware/auth.ts:620`) has no
non-test caller; its bound export is not a wired admin issuance route or CLI.
Admin write routes are therefore disabled for tokens obtainable through the
in-repo login flows. An owner-approved admin issuance/provisioning path is still
needed. This change builds no issuer and changes no configured-action payload
model. Admin issuance and on-chain proposer funding remain owner-operated and
runtime-unverified (issue #1329 items 1-issuer and 2).

The canonical roles-array consumers also use this predicate (issue #1329, A15):

| Consumer | Admin decision and preserved behavior |
| --- | --- |
| `server/middleware/auth.ts` role and permission middleware | Admin override requires the exact array member. Required-role membership also checks `Array.isArray`, so a string cannot bypass the predicate through the ordinary role branch. Explicit permissions and ordinary array roles retain their existing checks. |
| `server/services/state-sync-orchestration.ts` | Only the verified session's exact roles-array member grants admin. Scalar `role=admin` and case-folded array members no longer grant admin. The prior code already excluded string `roles`; its wallet/operator/observer mapping remains, with non-string members safely ignored. |
| `shared/middleware/communication-middleware.ts` | Default admin rate-limit exemption uses the predicate. String `roles=notadmin` or `roles=admin` cannot skip the limiter. |
| `server/controllers/simulationController.ts` | Admin execute/cancel/setRate decisions use the predicate; absent or malformed roles produce `SIM_MISSING_ROLE` and `wouldSucceed=false`. Proposal creation and distribution also require an allowed array role, retaining ordinary user/operator membership. These remain read-only simulation responses, not real writes. |
| Governance lifecycle update/activate/finalize/execute | Admin exception uses the verified roles array rather than scalar `role`. The existing creator exception, proposal-state checks and honest execution-unavailable 503 remain. No fixed-config proposal/NFT payload model change. |

A repo-wide source audit also found separate contracts. The owner authorized
preserving and documenting these, rather than converting their identity models:

| Other match | Existing contract retained |
| --- | --- |
| `server/utils/dbSecurityUtils.js`, `server/middleware/openforis-rate-limiter.ts` | Independent scalar-role DB authorization / OpenForis tier and development-skip model. OpenForis's permissions-based tier selection is also retained; this audit does not prove its input validation. |
| `shared/rbac.ts`, `server/middleware/rbac-middleware.ts`, `microservices/api-gateway/src/middleware/auth-middleware.ts`, `src/routes/file-versioning-routes.ts` | Role hierarchies, including super-admin and intentionally parsed scalar/comma-separated roles. These are not canonical exact-admin overrides. |
| `graphql/context.ts` | Verified-wallet address membership in the configured admin-address allowlist; no role-array input. No configured values inspected. |
| `shared/middleware/object-authorization.ts`, `server/services/identity-governance-service.ts` | Configurable privileged-role / action-policy lists with their own scalar/array normalization. No canonical admin credential is issued or lent by converting these policies. |
| `middleware/emergency-response.js`, regulatory/audit routes | Delegate to their existing role middleware; canonical `auth.ts` delegates inherit its hardened array checks. |
| `server/services/state-sync-orchestration.ts` permission mapping | Consumes an already resolved `SyncRole` enum, not raw JWT roles; exact admin/operator comparisons remain. |
| `server/api-explorer.js`, gateway auth service, websocket policies, upload limits, validation schemas and shared role/type definitions | Demo output, identity construction, supported-role lists or role configuration, not canonical admin predicates. Explorer demo tokens do not supply a valid canonical admin JWT. |
| `server/services/query-cache-security.ts` | Privileged-role matching selects encryption; it is not an authorization grant and defaults to encryption. |

This scoped audit is not a security approval of the independent contracts.

All admin write routes take `{}`; nonempty bodies return 400. This deliberately
retires ordinary-user mining/NFT/privacy writes and legacy UI proposal payloads
from this surface. Malformed or missing server configuration returns a generic
503 without the raw configuration; missing/blank role tokens never fall back
to caller credentials. JSON config rejects unknown fields and unsafe integers.

| Deployment variable | Required configured shape |
| --- | --- |
| `WRFCOIN_OPERATOR_TOKEN` | Existing core4 Operator token; not generated here. |
| `WRFCOIN_MINING_REWARD_ADDRESS` | Core4 `0x` + 40 hex reward address. |
| `WRFCOIN_ADMIN_NFT_MINT_CONFIG` | JSON `{id, owner, metadata?, price?}`; valid address, asset ID, safe unsigned integer price. Weather-mint payloads are not exposed by this admin action. |
| `WRFCOIN_ADMIN_NFT_TRANSFER_CONFIG` | JSON `{id, to}`; configured asset and valid recipient address. |
| `WRFCOIN_ADMIN_STEALTH_CONFIG` | JSON `{spend_key, view_key, payment_id?}`; 32-byte hex public keys and optional 8-byte hex payment ID. |
| `WRFCOIN_ADMIN_GOVERNANCE_PROPOSAL_CONFIG` | JSON `{proposal_id, parameter, value, voting_deadline?, deposit?}` matching core4; optional numbers restricted to safe unsigned integers. Core4 validates governed parameter/value and available funds. |
| `WRFCOIN_GOVERNANCE_PROPOSER_ADDRESS` | Fixed funded on-chain proposer address; never a backend user ID. |
| `WRFCOIN_CONTRIBUTOR_TOKEN` | Existing Contributor token, also used by signed wallet relay. |
| `WRFCOIN_GOVERNANCE_SIGNING_VERSION` | `1` (legacy preimage) or `2` (domain-separated); server config only, never caller-selected. Missing/other values refuse voting with 503. Must equal the chain's active protocol version. |
| `WRFCOIN_GOVERNANCE_CHAIN_ID`, `WRFCOIN_GOVERNANCE_NETWORK_ID` | Explicit nonempty strings matching core4's signing identity (required under both versions). No defaults. Match core4's `WRFCOIN_CHAIN_ID` / `WRFCOIN_NETWORK_ID`; these backend variables are scoped to governance so empty values cannot override wallet-login defaults. |

Compose passes these variables through with empty defaults under the standing
owner authorization. No values or secrets are provisioned. Operators must
verify the chain's active V2 protocol and identity before enabling voting; a
later chain signing-version change requires updating the verifier. This PR
does not inspect or change deployed configuration.

Vote bodies contain `support` (boolean) or `voteType` (`FOR`/`AGAINST`),
`signer_public_key` (32-byte hex), `signature` (64-byte hex), and optional display
`reason`. Conflicting aliases and extra fields, including unsigned voting-power
claims, are rejected. Under `WRFCOIN_GOVERNANCE_SIGNING_VERSION=1` the signature
covers the raw UTF-8 bytes `governance-vote-v1|<proposal_id>|approve` (or `reject`)
(core4 @65134a64 `shared-protocol/src/blockchain/transaction.rs:1695-1706`, verified at
`:1755`); it binds no chain/network/voting power. Under `=2` the signature covers core4's
`GovernanceVotePayload` V2 bytes, not JSON: u64-LE length-prefixed domain tag
`wrfcoin.governance_vote.v1`, chain ID, network ID, u32-LE version 2, then the
length-prefixed body. Body fields are length-prefixed proposal ID, one-byte
approve, `voting_power=None` discriminator 0, `signer_public_key=Some`
discriminator 1 and the length-prefixed original public-key hex. Sources:
core4 `crypto/domain_impls.rs:444`, `crypto/chain_binding.rs:913`,
`blockchain/transaction.rs:1730`. Verification reuses strict ed25519 checks from
wallet login and SHA3-256 key/address derivation. EVM-login JWTs cannot vote on
this ed25519 protocol. Core4 state rejects duplicate ballots for the same
proposal/voter (`blockchain/state.rs:3854`) and enforces snapshot voting power
and transaction nonce; no separate backend replay cache is invented. Actual
queue/chain acceptance and ballot replay enforcement are runtime-unverified.

The repo-wide AST guard has **zero forwarding exceptions**. It tracks
helper/import aliases, member and bracket calls, spreads, intermediate options,
assignment/destructured headers and local wrapper returns. It also catches
`get`/`header` accessors (including bracket calls), `{headers} = request`, renamed
request parameters, and raw `fetch`/`globalThis.fetch` plus local aliases and
default `node-fetch` imports. Fetch sinks are checked regardless of destination;
this may conservatively flag a caller-header flow to a non-core4 URL. Canonical policy
helpers must come from the actual `server/utils` modules; fake local helpers
are rejected. Existing wallet/oracle safe local builders are consolidated onto
those helpers without changing their auth or caller ownership checks. Wrapper
functions are accepted only when every return calls a verified policy helper.
The repository scan covers `.js` and `.ts` files, excluding dependencies, tests,
mocks, Git metadata, build output and coverage; `.cjs`, `.mjs`, `.jsx` and `.tsx`
are outside that scan. This is a static tripwire, not a whole-program security proof. A function's first
parameter is treated as a potential request regardless of its name; later
parameters need an explicit `Request`/`Express.Request` annotation or the existing
`req`/`request` spelling. Later untyped renamed request parameters are not inferred
from call sites; later outbound-client options parameters are not request sources.
Analysis does not propagate arbitrary cross-module calls, object-stored request
aliases, extracted/bound getter methods, computed getter/sink names or custom
HTTP clients. Imported canonical sanitizer implementations are trusted here;
their credential/tracing behavior requires the mounted runtime regressions.
G1–G7 and issue #1329's five bypass families have positive and negative controls,
including generic-client options and auth-only header reads. Every RPC
handler still needs an explicit policy; batches and inherited methods refuse
before dispatch. Mounted `getStatus` assertions check all three upstream headers
and catch caller-header reintroduction (issue #1326 P2). Its existing strict
Reader availability remains; this PR makes no public-RPC fallback decision.

Evidence uses local synthetic JWTs/keys and upstream fixtures. It proves backend
credential selection, configured parameter/identity/signature binding and
refusal boundaries, not actual core4 role acceptance, live NFT mutation support,
proposer funding or privacy registry lifecycle. `/api/keys` is handled separately:
the owner chose to provision `ENCRYPTION_KEY`, the manager merged infra#1132's
pass-through, and the owner provisions the key. This resolves the lane's decision
block; it does not prove that deployed key provisioning or route health succeeded.

## Issuing an admin token (#1329 item 1)

Admin-only routes need a JWT whose `roles` array contains `admin`. No HTTP endpoint issues
one. The only issuer is a **host CLI**, run by the operator on the machine that holds
`JWT_SECRET`:

```bash
JWT_SECRET=... REDIS_URL=redis://... node scripts/issue-admin-token.cjs [--ttl-minutes 1..15] [--subject ops-name] > token.txt
```

- Both variables come from the CLI process's own environment. It reads no `.env` file. The secret is never printed or logged.
- The token is printed to **stdout only**, once. TTL defaults to 10 minutes and is capped at 15. Anything else exits 1 without issuing.
- The admin gate (`middleware/authMiddleware.js` `requireAdmin`) requires a **live session** for the token's `sessionId` (a read-only Redis lookup; missing, foreign or unverifiable means 401). The CLI therefore writes the `session:<id>` record to the same Redis with a TTL equal to the token lifetime. If Redis is unreachable, no token is emitted.
- Every issuance writes one JSON audit line to stderr (user, session id, expiry, host user, host, pid, `SUDO_USER`). It contains no token or secret. Set `ADMIN_TOKEN_AUDIT_LOG=/path` to also append it to a file (mode 0600).
- HS256 only. The admin gate verifies with `JWT_SECRET`/HS256 and does not use `keys/jwt-public.pem`; the CLI refuses to run when `JWT_PRIVATE_KEY_PATH` is set.
- **Early revocation:** delete the Redis key `session:<sessionId>` (the id is in the audit line). `requireAdmin` reads the session with a single read-only Redis GET (`RedisSessionService.getSessionRedisOnly`): it does not renew the TTL, so a concurrent delete cannot be undone by a request, and it never falls back to process-local state (a Redis error refuses with 401). The session must also be this token's own (`userId` matches, role `admin`). It does **not** consult the separate token-revocation list that `middleware/auth.ts` uses, so `revokeToken` alone does not stop an admin token; delete the session key, or let the (at most 15-minute) token expire. A request already past the gate when you delete the key completes.

## Admin-supplied bodies and audit log (#1329 item 2)

For NFT mint (`POST /api/nft`), NFT transfer (`POST /api/nft/:id/transfer`) and governance
proposals (`POST /api/governance/proposals`), a verified admin may send a body:

| Route | Allowed body (strict; unknown fields rejected) |
| --- | --- |
| NFT mint | `{id, owner (0x+40 hex), metadata? (JSON, <= 8 KiB), price? (safe unsigned int)}` |
| NFT transfer | `{to (0x+40 hex)}`; the NFT id is the URL id (`[A-Za-z0-9._-]{1,128}`) |
| Proposal | `{proposal_id, parameter, value, voting_deadline?, deposit?}`; same schema as the config |

- An **empty body** keeps the existing behaviour: the configured payload is used (and for transfer the URL must match the configured id).
- An invalid body returns `400 ADMIN_BODY_INVALID` naming only the offending field names, never their values.
- Mining reward address (`WRFCOIN_MINING_REWARD_ADDRESS`), stealth keys (`WRFCOIN_ADMIN_STEALTH_CONFIG`) and the proposer address (`WRFCOIN_GOVERNANCE_PROPOSER_ADDRESS`) stay **config-fixed**; a non-empty body on mining or stealth is still refused.
- The Operator token stays server-side.
- **Audit:** every admin core4 write that passes validation logs `admin_core4_write` twice (security logger): `outcome=attempt` before the upstream call and `ok` or `refused` (with upstream status) after it. Fields: action, actor (JWT userId), sessionId, `source` (`body` or `config`), path, and identifiers only (NFT id, owner/recipient address, proposal id, parameter). Never keys, metadata, tokens or headers. Rejected calls are not logged here (they never reach core4).

For chain `888` / network `testnet`, verify the recorded genesis schedule and
owner-published genesis hash `553a3758386d9631037d7469686acb4a121ced81dcf5cde256e2d05667c5f332` before selecting the signing
version. The placeholder is not a usable hash; previous-chain activation
heights do not select a version for this genesis.
