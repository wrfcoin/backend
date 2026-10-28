# Ambient connector terms check

Refs wrfcoin/backend-archive#1497. Checked 2026-10-28. **TOS-UNVERIFIED**.

The [vendor API specification](https://github.com/ambient-weather/api-docs/blob/master/apiary.apib)
documents an application key plus a user API key, account device inventory by
MAC, and limits of one request/second per user key and three/second per app key.
The connector is read-only and handles 429 with backoff. Existing
wrfcoin/backend `server/services/station-registration-service.ts` already
validates account MAC membership and encrypts credentials; it is not replaced.

The attempted [terms page](https://ambientweather.com/terms-of-use) was not
readable. API access documentation does not establish redistribution permission.
No vendor redistribution permission is claimed. New bridge collection and
forwarding remain disabled pending a readable current agreement and owner
source verification. These restrictions do not alter existing Ambient services.

Fixtures use synthetic device IDs and readings. Authenticated physical aliases
and account-owned status are explicit fixture evidence, not fields inferred from
public maps. Real integration must independently establish those facts.
