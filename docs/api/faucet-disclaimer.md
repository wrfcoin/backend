# Faucet expectations

`POST /api/onboarding/faucet/claim` returns a `disclaimer` string on success,
as does `POST /api/onboarding/faucet/challenge`. This preserves the existing
string contract; clients should display it alongside the test-token receipt.

The field contains this one-line summary followed by the canonical URL:

This is a test network. It may be reset without notice. Balances and tokens have no monetary value. No migration to mainnet is promised or implied. Please attach no production bridges, exchange listings or irreplaceable assets. https://wrfcoin-testnet.taila1c049.ts.net/testnet-disclaimer.html

The canonical policy is maintained in core4, not in this API documentation.
