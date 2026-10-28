# SMS research previews and zero-budget boundary

Refs wrfcoin/backend-archive#1500. `ALERT_SMS_DELIVERY=0` is the only accepted
setting; unset also disables delivery. Setting it to 1 fails construction.
`DryRunSender` is the sole alert implementation and records only hash-addressed
previews. It cannot dial, contact an aggregator or construct a vendor client.
The engine never imports it. No SMS, push or email is sent, including confirmation.

The shared `sms-gateway.ts` boundary defines inbound envelopes consumed by the
existing observation service and dry-run consent controls, plus outbound previews.
Existing signed observation decoding is unchanged. There is no new public ingress:
a future adapter must authenticate sender identity before passing consent controls.
No live phone ownership verification or gateway provisioning is claimed.

The model retains HMAC-SHA256 of a canonical E.164 number, coarse 0.1-degree cell,
hazards, language and timestamped consent. A random 32-byte research hash key is
required; it is not a gateway credential and must remain stable for a research
session. Neither plaintext numbers nor exact coordinates are persisted or returned.
Repeated subscribe cannot undo STOP; authenticated STOP acts synchronously before
the next preview. YES after STOP is refused. Expiry is 30 days. `purge` removes
expired subscriptions and deduplication keys, old daily counters and previews.
There is a 1000-subscription research cap and no public subscription endpoint.

`AlertSmsResearchStore` serialises offline state updates under a row lock; the
1500 manual up/down migration pair has not been applied. Its zero-budget policy
is fixed. In-memory simulations can explicitly supply a nonzero hypothetical budget.
Default limits: 2 previews/number/day, 100 globally/day, zero cents/day. Counters
and deduplication share the persisted research state. The original inbound
observation queue's existing retention/privacy behaviour is outside this change.

Planning cost = recipients × message segments × price/segment + gateway/number
rental + taxes/carrier fees. The test policy's 5 cents/segment is an illustrative
parameter, not a provider quote. Every accepted English/French template consumes
one GSM-7 segment (conservative basic alphabet, <=160 characters); long or non-GSM
source pointers reject rather than lose the official source. No URL shortener is
called. A real gateway would need provider-specific cost and opt-in rules reviewed.

Zero budget implies zero paid messages. Partner-funded gateways, donated credits
and government cell-broadcast collaboration are possibilities for owner research,
not commitments. Phone routing storage, authenticated opt-in ownership, funding,
local legal review and the historical false-alarm baseline remain delivery blockers.
