# Achievement payout pilot authorization

The backend gate remains default OFF: only
`ACHIEVEMENT_PAYOUT_SIGNED_ENABLED=true` enables signed admission. This change
does not enable the pilot, provision a key, or authorize deployment.

## Signed bytes

The Ed25519 message is the UTF-8 encoding of a compact JSON array of strings,
without whitespace or a trailing newline, in this exact order:

```text
[domain, chainId, claimId, achievementId, canonicalRecipient, amountBaseUnits, nonce]
```

Domain is `wrfcoin_achievement_payout_authorization_v1`. `achievementId` is
1–128 ASCII characters: the first must be a letter or digit, and subsequent
characters may be letters, digits, `_`, `.`, or `-`. Whitespace, newline,
Unicode, quotes, backslashes, colons and slashes are refused while ON. OFF
behavior is unchanged. `claimId` uses the existing `buildClaimId` contract
(`ach:v1:<userId>:<achievementId>`, or the SHA256 form when over 128 bytes).
All array values are JSON strings, including decimal chain ID and amount;
use standard JSON escaping for the claim ID. Recipient is 40 lowercase hex
characters without `0x`; nonce is 64 lowercase hex characters. There is no
numeric JSON, bincode, BOM or alternative domain framing.

`__tests__/fixtures/achievement-payout-v1.json` is a cross-implementation
vector containing the tuple, exact UTF-8/hex message, SHA256, raw public key
and signature. It was constructed using Python compact JSON and OpenSSL
Ed25519 with RFC 8032 section 7.1 test-1 public test material. Never use that
test key operationally. Node tests compare bytes and verify the signature.

## Nonce and migration policy

Migration `0030_achievement_payout_nonce_unique` adds a partial unique index
over `metadata.payoutAuthorization.nonce` for achievement liabilities with a
non-null nonce. This matches the existing admission query's **global nonce
namespace**, across users, canonical recipients, chains and configured signer
rotations. It is intentionally stricter than a per-recipient namespace. All
nonce producers must supply globally unique nonces. A terminal liability keeps
its reservation. Unsigned legacy rows and other contribution types are outside
this index; the database index is unconditional because persisted signed
reservations must remain protected even while the runtime gate is OFF.

The migration is journaled and transactional. Existing signed-nonce duplicates
cause migration failure; it never deletes liabilities to make an index build
pass. Inspect and resolve any such data with an owner-approved procedure before
deployment. The application retains its global advisory lock for cap admission;
the index independently rejects duplicate inserts from a path missing that lock.

A hand-created `idx_achievement_payout_nonce_unique` is not proof that 0030 was
applied. If its journal entry is absent, 0030 fails with PostgreSQL `42P07`
(relation already exists), even when the hand-created definition matches. A
non-unique or differently scoped index with that name fails the same way.
Do not add `IF NOT EXISTS` or fabricate a journal receipt: either could conceal
drift. Preserve the definition and liabilities, stop writers, and follow the
controlled replacement procedure in [the migration runbook](ops/database-migrations.md#0030-hand-created-index-before-journal-application).

## Settled signed and legacy repeat claims

With the gate ON, a repeat claim whose owner-scoped ledger row records
`settlement=settled` returns HTTP 200 with exactly:

```json
{"success":true,"alreadyClaimed":true,"settlement":{"state":"settled","terminal":true}}
```

This is an acknowledgement of persisted backend state, not a fresh chain probe.
It creates no liability, calls no payout client, writes nothing, and exposes no
reward metadata, recipient, signature or transaction hash. The existing
authentication/earned-achievement and owner-scoped ledger lookup still apply.
This minimal response also applies to **already-settled signed rows**, not
only unsigned legacy rows. With the flag ON it is unconditional after that
owner-scoped settled-row check; it does not require a new authorization for the
repeat acknowledgement. Clients must not expect `reward`, `message`,
`settlement.status`, `settlement.txHash`, `settlement.onChain`,
`settlement.note` or `settlement.attempts` on this response. It is not a newly
issued reward or a fresh confirmation of chain settlement.
Pending, settling, failed, reversed or unmarked unsigned legacy rows continue
to return 403 under the signed gate. OFF retains the prior route behavior.

### Post-GO switch-on compatibility prerequisite

Keep the flag OFF until the owner separately approves activation and affected
clients handle the minimal acknowledgement for both signed and unsigned settled
rows. Test a settled signed repeat with ON and OFF, and confirm clients show an
already-claimed acknowledgement without inventing an amount, reward identifier
or transaction hash. Read historical details from the authenticated ledger/history
view when supported, rather than treating omitted fields as a new zero payout.
New/pending signed claim responses remain on their existing settlement path.

Source inspection identified the mobile gamification consumer at
`lib/features/gamification/data/repositories/gamification_repository_impl.dart`
and `data/models/reward_model.dart` in the mobile repo. It unwraps `reward` when
present, otherwise parses the response itself; missing fields become an empty
reward ID, zero amount and null transaction hash. That does not explicitly
model this already-claimed acknowledgement. Mobile compatibility therefore
needs an owner-reviewed client fix and runtime verification before switch-on.
No claim-route consumer was found in the searched frontend `src/` tree; that
bounded source search does not certify external or released clients. This
backend documentation change does not activate the flag or modify those clients.

## Failed and reversed liabilities

Neither failed nor reversed metadata releases pilot cap headroom. All
achievement liabilities retain their daily/global reservation for 24 hours
and their recipient lifetime reservation permanently. A failed backend attempt
can have an unknown on-chain outcome; a `reversed` metadata label is not proof
of an authenticated consensus reversal. Releasing headroom automatically could
allow additional issuance after an earlier transaction settled. This conservative
policy also retains nonces permanently. No owner reset or reversal mechanism
is implemented here. The existing legacy emission-budget policy is unchanged.

## Verification

Use Node 24.15.0 and the repository's standalone Jest entrypoint. Real-PG
tests use `BACKFILL_TEST_PG_URL` pointing to disposable PostgreSQL 15. The original
payout cases use isolated per-process schemas; the journal-chain cases create
fresh databases. Set
`ACHIEVEMENT_PAYOUT_REQUIRE_PG=1` to fail instead of skip without that URL.
CI sets it and runs a named payout PostgreSQL step. The original payout suite
applies 0030 at the existing rewards-table boundary. The separate
`achievement-payout-migrations-real-pg.test.ts` control creates a fresh disposable
database for each case, applies every committed 0000–0029 migration in journal
order through Drizzle, then applies the production journal through 0030 and
checks ordered hashes/timestamps. It also proves hand-created matching and wrong
indexes fail loudly without changing receipts or liabilities, then validates
controlled replacement. CI runs a named required-PG step using its existing
loopback PostgreSQL service; missing URL with the require flag fails.
The concurrency case admits two separately signed claims in two real
transactions before either inserts, omits the advisory lock, proves database
blocking, and requires exactly one committed row and one unique violation.
