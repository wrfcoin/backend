# Cross-Chain WebSocket Event Pipeline Resource Impact

## Scope
`backend/server/cross_chain_websocket_server.js` synthetic broadcast removal and subscriber-aware broadcast short-circuiting.

## Idle Runtime Comparison (default config)

- Baseline (before):
  - Synthetic timers active by default:
    - `NEW_BLOCK` every 15s
    - `BRIDGE_TRANSFER` every 25s
    - `MINING_UPDATE` every 20s
  - Callback executions per minute (idle): ~11.4 synthetic ticks/minute.
  - JSON payload creation happened even when no channel subscribers existed.

- Current (after):
  - Synthetic timers are disabled by default.
  - Synthetic timers only run when `WS_ENABLE_SYNTHETIC_EVENTS=true` in local development.
  - Default idle synthetic callback executions per minute: `0`.
  - Channel broadcasts now skip work early when subscriber count is `0`.

## Network Impact (idle)

- Baseline (before): random channel payloads could be sent whenever subscribed clients were present.
- Current (after): no synthetic channel payloads in default config; only canonical source events are forwarded.
- Result: idle channel-event network traffic from synthetic generators is reduced to `0` by default.

## Notes

- Heartbeat behavior is unchanged.
- Canonical cross-chain bridge events are now ingested from the shared cross-chain event bus and broadcast with validated contract shape.
