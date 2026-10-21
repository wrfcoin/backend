# Wallet received-history mapping

`GET /wallet/:address/transactions` (under the application's API mount) remains
owner-scoped and Reader-backed. It forwards retained-transaction `limit`/`offset`
and optional `creditLimit`/`creditAfter` to core4's independent credit scan.

`schemaVersion:1` identifies older node summaries: existing `items` retain
nullable recipient/amount fields, `creditItems` is empty and credit metadata is
null. A node exposing `credit_events` gets `schemaVersion:2`. New transaction
items carry explicit direction, event ID, counterparty, kind, settlement and
`amountBaseUnits` (also exposed as the compatibility `amount` field). Missing
direction is `unknown`; it is never inferred from the sender for schema 2.

`creditItems` is a separate, nonchronological paid-rewards section. Only positive
decimal-string amounts for this beneficiary, with `settlement:paid`,
`direction:received`, matching contribution/forecast event-ID prefix and the
corresponding weather/forecast kind, are mapped. JSON numbers, fractions,
overflowing amounts, pending records and unsupported achievement events do not
establish income. No reward ledger, estimate, or local history is consulted.

`creditNextCursor` is scan progress, including on an empty credit page.
`creditRecordsExamined` / `creditScanLimit` report bounded node scan work;
`creditTotal` is null and is not guessed from those counts. `creditOrder` is
`commit_id_ascending`. Clients should reset cursors on refresh and continue
through empty scan pages when a next cursor exists, using bounded requests.
Credit transaction IDs, payment heights and timestamps remain null when the
node does not establish them. `complete:false` always applies: this is not a
full historical index and does not attribute achievement payouts.

Requires the additive core4 contract in wrfcoin/core4#3520 for schema 2.
Older nodes continue to serve schema 1 or the existing 501 capability gap.
