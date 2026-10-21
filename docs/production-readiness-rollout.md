# Production Readiness Rollout

This note tracks the `backend#84` rollout for standardized operational probes and graceful shutdown behavior.

## Standardized In This PR

- `server/server.js`
- `server/wallet_server.js` (retired in backend#1116 — mnemonic endpoints now live in `server/routes/wallet-routes.js` under `/api/wallet`)
- `server/cross_chain_protocol_server.js`
- `server/minimal_api_server.js`
- `server/simplified_api_server.js`
- `server/testnet_api_server.js`
- `server/iot_sensor_networks_server.js`
- `server/storage_networks_server.js` (historical rollout entry; retired by backend#1117 in favor of the external IPFS daemon)
- `server/ai_ml_networks_server.js`
- `server/compute_networks_server.ts`
- `server/partner_coordination_server.ts`
- `server/performance_dashboard_api.js`
- `server/nas_storage_server.js` (historical rollout entry; retired by backend#1117 in favor of the external IPFS daemon)
- `server/backup_recovery_server.js`
- `server/compute_contribution_server.js`
- `server/governance_api_server.js`
- `server/simple-test-server.js`
- `server/vault-server.ts`
- `server/simple-http-server.js`
- `server/wvm_demo_server.js`
- `server/compute_networks_server_fixed.js`
- `server/iot_sensor_networks_server_fixed.ts`
- `server/blockchain-server-simple.js`
- `server/websocket-server.js`
- `server/enhanced_crosschain_server.ts`
- `server/nas_storage_server.ts` (historical rollout entry; retired by backend#1117 in favor of the external IPFS daemon)
- `server/cross_chain_websocket_server.js`
- `server/governance_server_minimal.js`
- `server/governance_server_stable.js`
- `server/governance_server.js`
- `server/unified_api_server.ts`
- `server/main_api_server.ts`
- `server/secure_messaging_server.js`
- `server/ws_server.js`
- `server/memory_optimized_server.js`

These entry points now use the shared operational helpers introduced in `backend#84`:

- `server/middleware/create-health-middleware.js`
- `server/utils/graceful-shutdown.js`

The standardized pattern provides:

- `GET /health`
- `GET /ready`
- `GET /live`
- a draining state before HTTP listener shutdown

## Main API Probe Contract

`server/main_api_server.ts` uses the shared probe helpers with this contract:

- `GET /live` is process liveness for `:4001` and does not depend on downstream blockchain connectivity.
- `GET /ready` is route readiness for launch-critical `main_api` traffic on `:4001`.
- `GET /health` is aggregate diagnostic status for `:4001` and may report `degraded` while still returning HTTP `200`.

For `main_api`, launch API websocket reconnect state is reported as a degraded dependency detail, not a readiness or liveness failure. Relaunch and other operators should use `/ready` for startup gating, `/live` for steady-state liveness, and `/health` for diagnostic context.

## Still Pending Broader Rollout

The following server entry points still need retrofit work before `#64` and `#65` can be considered fully closed across the broader backend surface:

None. All entry points have been updated.

## Scope Decision

`backend#84` is currently the production-readiness foundation and staged rollout PR.

- If the remaining server list above is completed in this branch, `#64` and `#65` can be closed directly from the same PR.
- If the remaining server list is too large or too risky for a single PR, follow-up rollout PRs should be opened and `#64` and `#65` should remain open until the broader inventory is covered.
