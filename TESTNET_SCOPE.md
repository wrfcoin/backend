# WRFCoin Testnet MVP Scope

Last Updated: 2026-04-02
Owners: Backend (Dan lane), Infra coordination required
Refs: #464, #471

## Decision

Testnet MVP uses `main-api` on port `4001` as the canonical backend entrypoint.
The api-gateway and several standalone microservices are intentionally deferred
for this phase unless explicitly added to infra compose.

## In Scope (Current Testnet Compose)

- `main-api` (`wrfcoin-backend`, `4001`)
- `governance` (`wrfcoin-governance`, `8000`)
- `iot-sensor` (`wrfcoin-iot`, `3002`)
- `weather-earnings` (`wrfcoin-weather-earnings`, `8001`)

## Retired

- `wallet` (`wrfcoin-wallet`, `4000`) — `server/wallet_server.js` removed in backend#1116; its
  mnemonic endpoints live under `main-api`'s `/api/wallet` (`server/routes/wallet-routes.js`).
  infra's `wrfcoin-wallet` compose service and `esbuild-backend.sh` entry need a companion removal.

## Deferred (Not in Testnet Compose MVP)

- `api-gateway` (`8080`)
- `nft-marketplace-service` (`4002`)
- `user-management-service` (`4003`)
- `cross-chain` (`3000`)
- `compute-networks` (`6000`)
- `ai-ml` (`6001`)
- `compute-contribution` (`6003`)
- `storage-networks` (`7000`)
- `node-discovery` (service-level API)

## Backend Behavior

- In api-gateway code, set `TESTNET_MVP_SCOPE=true` to default NFT/User routes
  to `MAIN_SERVICE_URL` unless explicit `NFT_SERVICE_URL`/`USER_SERVICE_URL`
  values are provided.
- This avoids implicit connection-refused behavior when optional downstream
  services are absent in testnet.

## Frontend Handoff (Cindy)

- Gate or hide UI paths that require deferred services:
  - Cross-chain bridge flows
  - Compute dashboard/contribution surfaces
  - Storage network browser
  - Any route requiring standalone API gateway-only endpoints
- Prefer direct calls to `main-api` endpoints for MVP testnet UX.
