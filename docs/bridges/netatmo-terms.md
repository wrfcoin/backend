# Netatmo connector terms check

Refs wrfcoin/backend-archive#1497. Checked 2026-10-28. **TOS-UNVERIFIED**.

The requested auth design is OAuth2 authorization-code flow with only
`read_station`, device binding by module ID, and encrypted access/refresh tokens.
No write scope is accepted by the fixture vault. No real OAuth exchange is
implemented or claimed. Public weather map access is never ownership evidence.

The official [weather](https://dev.netatmo.com/apidocumentation/weather),
[authentication](https://dev.netatmo.com/apidocumentation/oauth),
[rate-limit](https://dev.netatmo.com/guideline) and
[legal](https://dev.netatmo.com/legal) pages returned navigation shells to the
reader. Current numeric limits and redistribution conditions could not be
verified. The fixture connector backs off on 429 and never forwards real data.
Live collection stays disabled pending current documentation, read-only scope
verification, ownership semantics, terms review and owner source verification.

No rights in WeatherXM or other third-party data are inferred from these checks;
there is no such connector or forwarding permission in this change.
