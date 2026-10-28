# Dual-publish and MADIS forwarding (draft policy)

Refs wrfcoin/backend-archive#1498. Stations are never required to repoint or
remove existing destinations. Duplicate destinations must be disclosed and
resolved before an additional downstream feed is activated.

## Provider research, checked 2026-10-28

[NOAA provider resources](https://madis.ncep.noaa.gov/provider_resources.shtml)
direct individual stations toward CWOP and describe contacting MADIS Support
with network name, site count and point of contact for a provider relationship.
The owner must authorize any contact; none was sent. Provider onboarding must
settle station metadata, agreed input format/transport, cadence and restrictions.
An arbitrary HTTP POST is not a MADIS provider agreement.

[NWS CWOP guidance](https://www.weather.gov/fgz/cwop) describes registering a
station ID and configuring station software, then checking whether data arrives.
[NOAA surface QC](https://madis.ncep.noaa.gov/madis_sfc_qc.shtml) is a separate
quality-control layer; passing our internal checks does not assert NOAA QC
acceptance. Before a pilot, validate station position/elevation, units,
timestamps, instrument siting, range/temporal/spatial checks and missing values.

Recommendation: preserve station owners' direct CWOP destinations first. For a
future aggregated network, request a provider agreement only after source proof,
redistribution rights and duplication policy are resolved. Do not forward vendor
feeds under an assumption that publicly readable data is freely redistributable.
All three vendor terms notes currently say TOS-UNVERIFIED. Format, licensing,
retention and provider acceptance are prerequisites, not completed evidence.

## Implemented dry-run boundary

`BridgeForwarding` defaults to an injected disabled gate. `DryRunMadisForwarder`
is the only sink; it makes no network calls. There is no live MADIS encoder or
sender. A future encoder must implement the format agreed with the provider.
The internal consumer checks the current verified claim, a released QC hold,
opt-in, source redistribution permission and a supplied trust-tier threshold
under row locks. Opt-out is per claim and wallet-authorized. Decisions are
persisted in `bridge_forwarding_audit`; repeat successful dry-runs are idempotent.
The ordinary ingest path leaves every observation held, so it cannot forward.
Tests explicitly release a fixture hold to exercise the positive dry-run branch.

Thresholds and live QC release need owner ratification. No production API
accepts a caller's asserted verification/tier/redistribution flag. There is no
reward path and no claim of a live MADIS provider, submission or acceptance.
