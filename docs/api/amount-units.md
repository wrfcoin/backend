# Station earnings and treasury amount units

Refs wrfcoin/mobile#370; backend#1429. This r19 metadata contract does not submit or execute transactions.

## Station earnings

The mounted GET `/api/stations/:id/earnings` response contains `amountUnits`:

```json
{
  "denomination": "WRF",
  "baseUnitDecimals": 8,
  "baseUnitsPerUnit": "100000000",
  "available": true,
  "fields": {
    "earnings[].amountBaseUnits": "base_units",
    "earnings[].amountWrf": "display_units",
    "totals.rewardedBaseUnits": "base_units",
    "totals.rewardedWrf": "display_units"
  }
}
```

Base-unit fields are integer strings; display-unit fields are decimal WRF
strings already converted with BigInt. Convert only base-unit fields, using
string/BigInt arithmetic. For example `9007199254740993` base units corresponds
to `90071992.54740993` WRF; never pass either field through a JS double.
The scale is anchored to core4
`65134a64492135b6ac81344dd0d2edd8dfaf1309`,
`shared-protocol/src/common/constants.rs:39`, and `shared/currency.ts`.

`available` describes the whole recent window: false when the Reader/upstream
is absent, the observation window is incomplete, or a commit's evidence is
unknown. Individual records still require `rewarded=true` and a non-null
amount. Pending/non-rewarded/unknown amounts remain null. A proven subtotal in
a partially unknown window is a known subset, never a complete earnings total.
`window.scope` is `recent-observations`; these are not lifetime earnings.
A missing Reader/upstream returns an empty earnings list, no totals and
`amountUnits.available=false`; known denomination does not invent a zero.
Public consumers must use the existing `st_` station alias/privacy policy.

The mobile PWS dashboard currently requests GET `/api/oracle/stations`, which
has no mounted handler at the audited source. This change does not add that
source. Its bare `earnings` field remains unavailable/unknown until a separate
source-backed integration. Do not attach this route's unit to a different
endpoint's similarly named field.

## Governance treasury

GET `/api/governance/treasury` declares
`data.amountUnits.fields` for `balance`, `totalDeposits`, `totalWithdrawals`.
GET `/api/governance/analytics/treasury` declares it for `balance`,
`totalInflow`, `totalOutflow`. Both return:

```json
{
  "denomination": null,
  "baseUnitDecimals": null,
  "baseUnitsPerUnit": null,
  "available": false,
  "reason": "treasury_units_not_established",
  "fields": { "balance": "unknown" }
}
```

The example abbreviates `fields`; every listed monetary field maps to
`unknown` in the actual response. Legacy amount strings remain for API
compatibility. Their monetary interpretation is unavailable, even when the
ledger is empty or one token happens to dominate it. Mobile must retain
unknown/unavailable and must not divide these values by 10^8 or append WRF.
Rows accept arbitrary `tokenAddress` and caller amounts; the aggregate ignores
asset identity. DB `decimal(36,18)` precision and eight-decimal response
formatting establish neither a denomination nor a token scale. The writer
records pending/approved intents, not canonical WRF execution. A reviewed
per-asset executed source or native treasury account is required before
publishing known treasury units. No journal/migration or writer changes here.
