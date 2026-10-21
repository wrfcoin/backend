# Developer State Seeding

Use the main backend debug route to scaffold funded or pre-staked developer accounts in local or test environments:

```bash
curl -X POST http://127.0.0.1:4001/debug/seed-account \
  -H "Authorization: Bearer $WRFCOIN_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"address":"0x1111111111111111111111111111111111111111","amount":250,"stakeAmount":100}'
```

Requirements:

- `NODE_ENV` must not be `production`
- `WRFCOIN_OPERATOR_TOKEN` must be set on the backend process
- the request must include `Authorization: Bearer $WRFCOIN_OPERATOR_TOKEN`

The endpoint is idempotent for a given address. Repeating the call overwrites the same in-memory developer state for that address instead of creating duplicates.

## Request contract

Required request body fields:

- `address`: Ethereum-style `0x...` address or `wrf...` address
- `amount`: non-negative integer balance to expose from `GET /api/wallet/:address`

Optional request body fields:

- `stakeAmount`: non-negative integer validator stake to expose from `GET /api/validators`

Successful responses return:

```json
{
  "status": "success",
  "address": "0x1111111111111111111111111111111111111111",
  "amount": 250,
  "stakeAmount": 100,
  "validatorSeeded": true
}
```

## Seeded state

After the example request above:

- `GET /api/wallet/0x1111111111111111111111111111111111111111` returns `250 WRF`
- `GET /api/validators` includes `0x1111111111111111111111111111111111111111` with `stake: 100`
- rerunning the same request restores that same funded and pre-staked developer state

## What is intentionally not seeded

- persistent blockchain state outside this backend process
- transaction history, blocks, or chain events
- governance, weather, and bridge route-store data
- authenticated users, sessions, and API tokens beyond the required operator token
- HSM keys, signatures, and other external service state

## Before / after behavior

Before seeding:

- `GET /api/wallet/:address` returns the default mock wallet balance
- `GET /api/validators` returns no seeded validator for that address

After seeding:

- `GET /api/wallet/:address` reflects the requested funded balance
- `GET /api/validators` reflects the requested pre-staked validator state when `stakeAmount > 0`
