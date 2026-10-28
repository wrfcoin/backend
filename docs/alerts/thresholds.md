# Shadow threshold research configuration

This engine is default-off (`ALERT_ENGINE_SHADOW=1` enables shadow evaluation only).
It has no sender, vendor SDK, credentials, notification callbacks or network client.
No region is automatically enrolled. The caller supplies a region-specific config.
These research defaults are NOT adopted national warning criteria or deployment approval.

| Metric | Research trigger | Source and limitation |
|---|---:|---|
| Rain rate | 30 mm/hour | [HKO amber guidance](https://www.hko.gov.hk/en/wservice/warning/rainstor.htm): widespread hourly rain exceeding 30 mm with continuation expected. Our >= comparison is deliberately conservative for shadow research. |
| Rain accumulation | 30 mm over the preceding complete hour | Same HKO guidance; input must represent a measured rolling hour, never a lifetime rain counter. |
| Heat index | 40.56 C (105 F rounded upward) | [NWS Boston criteria](https://www.weather.gov/box/criteria) specify duration and regional context. This instantaneous research trigger does not implement their warning policy. |
| Gust | 25.93 m/s (58 mph rounded upward) | [NWS Detroit criteria](https://www.weather.gov/dtx/noPrecip_defs); gust only, never average wind substituted. |

Release ratio 0.8, 10-minute freshness and one-hour cooldown are engineering research
choices, not nationally sourced safety thresholds. Require two distinct stations
within the same 0.1-degree cell (about 16km maximum diagonal), or one station and a
verified forecast covering that cell, hazard and time. Missing data never clears an
episode. A sustained or stuck reading cannot repeatedly emit; corroborated clear
readings are needed to release hysteresis. State must be preserved across replay batches.

Interim trust rule: verified + oracle ReadingQualityTier `good` + referenceAvailable.
Public core4 `shared-protocol/src/weather/quality_tier.rs` defines `good`, `degraded`,
`outlier`; `good` alone is insufficient because unavailable references default to good.
Station-registry Bronze/Silver/Gold is NOT substituted for the oracle reading tier.
Pressure is never an input or corroborator. #3570 bridging remains a dependency.

Input boundary: only a trusted offline export adapter may populate these fields. The
backend weather_data schema does not expose the oracle tier/reference provenance.
There is deliberately no public POST route that accepts self-asserted verification.
A live verified-readback adapter is deferred until that evidence is available.
Station tokens in exports must be anonymised (no owner names); exact coordinates,
phone numbers and owner fields are not part of the evaluator's input or events.

Persistence: `ShadowAlertStore` serialises evaluation with a locked PostgreSQL row
and persists events and hysteresis/cooldown state in one transaction. Manual migration
`drizzle/manual/1499-alert-shadow-up.sql` has a paired down migration. Neither is
applied in this sprint. This shadow research store retains its audit history; a
bounded-retention policy is required before continuous operation at scale.
The existing JWT-protected alert router exposes GET `/api/weather/alerts/shadow`;
flag-off returns 404; unavailable storage returns 503. It exposes no producer route.
