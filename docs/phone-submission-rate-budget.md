# Phone reading request budgets

`POST /api/oracle/submit-data/prepare` and `POST /api/oracle/submit-data` each
allow 30 attempts per minute per verified wallet, after JWT authentication.
One reading's prepare does not consume its signed-submit budget. A token refresh,
different JWT id, address casing or another station cannot grant more quota.
Rejected validation attempts count. A verified token without a wallet address
uses a bounded IP fallback. Missing, forged and refresh tokens remain refused.

The live API's global IP limiter still applies before these routes. Its default
is 100 requests per minute (`RATE_LIMIT_API_MAX_REQUESTS` can configure it).
With no other traffic, that budget allows at most 50 complete two-request
reading pairs per IP per minute across wallets, while one wallet's route limit
allows at most 30. Other requests and rejected attempts also use the global budget.
This change does not size that aggregate budget for an unknown phone population.

Route budgets use the existing process-local express-rate-limit MemoryStore.
Multiple backend processes have separate route counters; this is not a distributed
wallet quota. Global Redis/IP controls, upstream limits and admission checks retain
their existing contracts. No live load, population capacity or attester throughput
was measured. No env addition, migration or protocol change is required.

The offline HTTP controls verify real JWTs and the actual limiter/router using
synthetic store and node boundaries. They include 30 complete signed prepare/submit
pairs, per-phase exhaustion, shared-IP wallet isolation, normalization, refusal
before store/node work and the exact one-minute Date boundary.

Refs #1422, #1284, #1313.
