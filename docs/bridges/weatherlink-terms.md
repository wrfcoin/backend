# WeatherLink v2 connector terms check

Refs wrfcoin/backend-archive#1497. Checked 2026-10-28. **TOS-UNVERIFIED**.

[Authentication](https://weatherlink.github.io/v2-api/authentication) uses an
API key query parameter and an `X-Api-Secret` header. Do not log request URLs or
headers. The fixture connector binds the station UUID and uses read-only access.
[Published limits](https://weatherlink.github.io/v2-api/rate-limits) are 1,000
calls/hour and ten/second per key. Handle 429 and bounded Retry-After backoff.

[Data permissions](https://weatherlink.github.io/v2-api/data-permissions)
explicitly distinguish owned and shared stations. Being able to read a station
is insufficient ownership evidence; shared inventory fails proof.

These pages are API access documentation, not a verified redistribution licence.
No current redistribution agreement was established. Live collection and
forwarding remain disabled. A future adapter must verify how current inventory
responses establish ownership and physical aliases; recorded fixture envelope
fields do not assert the shape of a live vendor ownership attestation.
