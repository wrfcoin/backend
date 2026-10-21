# `safeMount` build-tier audit — backend #937

Audit date: 2026-07-27

Audited base: `7c5cab007ae72260a6cb7943c19f156a46ce6414` (`origin/main`)

Production entrypoint: `dist/server/enhanced_unified_api_optimized.js`

## Scope and method

This is the complete inventory: **46 of 46** `safeMount` calls in the production
entrypoint were built and exercised. Nothing was capped, sampled, or omitted.
The denominator is parsed from
`server/enhanced_unified_api_optimized.ts` and guarded by an exact-count
ratchet, so a new or silently skipped mount fails the gate.

For each mount, `scripts/audit-safe-mount-build.mjs` starts an isolated Node
worker that:

1. anchors `createRequire()` at the real compiled entrypoint;
2. mirrors production's `.cjs`-first, extensionless-fallback resolution;
3. verifies that the resolved export is Express middleware;
4. mounts it at its deployed path; and
5. sends `OPTIONS` to a concrete path extracted from the router stack.

The probe rejects a request that never enters the mounted router or reaches the
sentinel catch-all. A 401 or 500 can therefore be a successful reachability
result: the request reached the router and stopped at its auth/config boundary.

Baseline on current `main`: **38 reachable, 8 broken**.

After the uniform interop repair in this branch: **42 reachable, 4 explicitly
ratcheted failures**.

## Full 46-router inventory after the uniform repair

|   # | Mount                          | Built module                              | Result                                  | Representative build-tier request                                |
| --: | ------------------------------ | ----------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
|   1 | `/api/blockchain`              | `./routes/blockchain-routes`              | reachable (200)                         | `OPTIONS /api/blockchain/status`                                 |
|   2 | `/api/wallet`                  | `./routes/wallet-routes`                  | reachable (401)                         | `OPTIONS /api/wallet/build-tier-probe`                           |
|   3 | `/api/wallet-auth`             | `./routes/wallet-auth-routes`             | **BROKEN #941:** wrong build target     | —                                                                |
|   4 | `/api/weather/streak`          | `./routes/weather-streak-routes`          | reachable (401)                         | `OPTIONS /api/weather/streak/mint-trigger`                       |
|   5 | `/api/streaks`                 | `./routes/streak-routes`                  | reachable (401)                         | `OPTIONS /api/streaks/build-tier-probe`                          |
|   6 | `/api/weather`                 | `./routes/weather-routes`                 | reachable (200)                         | `OPTIONS /api/weather/data/build-tier-probe`                     |
|   7 | `/api`                         | `./routes/weather-alerts-routes`          | **fixed by #937**; reachable (401)      | `OPTIONS /api/weather/alerts/active`                             |
|   8 | `/api`                         | `./routes/weather-report-routes`          | **fixed by #937**; reachable (401)      | `OPTIONS /api/weather/report/narrative`                          |
|   9 | `/api/transport/sms`           | `./routes/sms-observation-gateway-routes` | **fixed by #937**; reachable (200)      | `OPTIONS /api/transport/sms/observations`                        |
|  10 | `/api/auth/social`             | `./routes/social-auth-routes`             | reachable (200)                         | `OPTIONS /api/auth/social/google`                                |
|  11 | `/api/gas`                     | `./routes/gas-relay-routes`               | reachable (401)                         | `OPTIONS /api/gas/sponsor`                                       |
|  12 | `/api/chain`                   | `./routes/chain-routes`                   | reachable (401)                         | `OPTIONS /api/chain/submit-userop`                               |
|  13 | `/api/bridges`                 | `./routes/bridges`                        | reachable (200)                         | `OPTIONS /api/bridges/capabilities/readiness`                    |
|  14 | `/api/bridges/wormhole`        | `./routes/wormhole-transfer-routes`       | **fixed by #937**; reachable (401)      | `OPTIONS /api/bridges/wormhole/inbound/process`                  |
|  15 | `/api/sensors`                 | `./routes/sensor-ingest-routes`           | reachable (401)                         | `OPTIONS /api/sensors/reading`                                   |
|  16 | `/api/quality`                 | `./routes/operator-quality-routes`        | reachable (401)                         | `OPTIONS /api/quality/my-events`                                 |
|  17 | `/api/nft`                     | `./routes/nft-routes`                     | reachable (401)                         | `OPTIONS /api/nft/`                                              |
|  18 | `/api/governance`              | `./routes/governance-routes`              | reachable (200)                         | `OPTIONS /api/governance/delegations/delegator/build-tier-probe` |
|  19 | `/api/sanctions/orchestration` | `./routes/sanctions-orchestration-routes` | reachable (401)                         | `OPTIONS /api/sanctions/orchestration/cases`                     |
|  20 | `/api/sanctions`               | `./routes/policy-audit-routes`            | reachable (401)                         | `OPTIONS /api/sanctions/build-tier-probe/reason`                 |
|  21 | `/api/appeals`                 | `./routes/appeals-routes`                 | reachable (401)                         | `OPTIONS /api/appeals/`                                          |
|  22 | `/api/integrity/risk`          | `./routes/abuse-risk-routes`              | reachable (401)                         | `OPTIONS /api/integrity/risk/factors`                            |
|  23 | `/api/integrity/sybil`         | `./routes/sybil-detection-routes`         | reachable (401)                         | `OPTIONS /api/integrity/sybil/thresholds`                        |
|  24 | `/api/integrity/calibration`   | `./routes/integrity-calibration-routes`   | reachable (401)                         | `OPTIONS /api/integrity/calibration/config/active`               |
|  25 | `/api/environment/reports`     | `./routes/environment-reports-routes`     | reachable (401)                         | `OPTIONS /api/environment/reports/soil/ingest`                   |
|  26 | `/api/onboarding`              | `./routes/onboarding-routes`              | reachable (200)                         | `OPTIONS /api/onboarding/faucet/challenge`                       |
|  27 | `/api/reputation`              | `./routes/reputationRoutes`               | reachable (401)                         | `OPTIONS /api/reputation/events`                                 |
|  28 | `/api/mining`                  | `./routes/mining-routes`                  | reachable (401)                         | `OPTIONS /api/mining/setup/hardware`                             |
|  29 | `/api/ai`                      | `./routes/ai-plugin-routes`               | reachable (200)                         | `OPTIONS /api/ai/`                                               |
|  30 | `/api/model-context`           | `./routes/model-context-routes`           | reachable (200)                         | `OPTIONS /api/model-context/`                                    |
|  31 | `/api/mcp`                     | `./routes/mcp-routes`                     | reachable (401)                         | `OPTIONS /api/mcp/models`                                        |
|  32 | `/api/n8n`                     | `./routes/n8n-routes`                     | **BROKEN #942:** runtime initialization | —                                                                |
|  33 | `/api/oracle`                  | `./routes/oracle-routes`                  | reachable (401)                         | `OPTIONS /api/oracle/requests`                                   |
|  34 | `/api/oracle`                  | `./routes/oracle-detail-routes`           | reachable (401)                         | `OPTIONS /api/oracle/status`                                     |
|  35 | `/api/pythia`                  | `./routes/pythia-routes`                  | reachable (200)                         | `OPTIONS /api/pythia/predictions`                                |
|  36 | `/api/documentation`           | `./routes/documentation-routes`           | reachable (200)                         | `OPTIONS /api/documentation/`                                    |
|  37 | `/api/modules`                 | `./routes/module-controller-routes`       | **BROKEN #943:** missing runtime module | —                                                                |
|  38 | `/api/node-os`                 | `./routes/node-os-routes`                 | **BROKEN #936:** missing source module  | —                                                                |
|  39 | `/api/rpc`                     | `./routes/rpc-routes`                     | reachable (500)                         | `OPTIONS /api/rpc/`                                              |
|  40 | `/api/node-control`            | `./routes/node-control-routes`            | reachable (500)                         | `OPTIONS /api/node-control/status`                               |
|  41 | `/api/keys`                    | `./routes/key-manager-routes`             | reachable (500)                         | `OPTIONS /api/keys/generate`                                     |
|  42 | `/api/kpi/alignment`           | `./routes/alignment-kpi-routes`           | reachable (401)                         | `OPTIONS /api/kpi/alignment/forecast-coverage`                   |
|  43 | `/api/achievement`             | `./routes/achievementRoutes`              | reachable (401)                         | `OPTIONS /api/achievement/build-tier-probe`                      |
|  44 | `/api/v1/rewards`              | `./routes/rewards`                        | reachable (401)                         | `OPTIONS /api/v1/rewards/config`                                 |
|  45 | `/api/privacy`                 | `./routes/privacyRoutes`                  | reachable (401)                         | `OPTIONS /api/privacy/stealth-address`                           |
|  46 | `/api/storage`                 | `./routes/storage-realtime-routes`        | reachable (200)                         | `OPTIONS /api/storage/weather/realtime/build-tier-probe`         |

## Complete baseline failure taxonomy

All eight baseline failures are accounted for:

| Requested class              | Count | Routers                                               | Exact cause and disposition                                                                                                                                           |
| ---------------------------- | ----: | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESM/CommonJS interop         |     4 | weather-alerts, weather-report, SMS gateway, Wormhole | Emitted ESM invoked unbound `require()`. SMS also retained an explicit `.js` require even though a `.cjs` shim existed. Fixed uniformly in the build.                 |
| Wrong relative path/target   |     1 | wallet-auth                                           | A `.js` Express router and `.ts` service share one basename. `tsc` wins the output path, so `safeMount` loads a service object rather than middleware. Filed as #941. |
| Missing module               |     2 | modules, node-os                                      | `toml` is undeclared/uninstalled (#943); `src/node_os/node_os_core` does not exist (#936).                                                                            |
| Runtime initialization error |     1 | n8n                                                   | The route registers controller method names that the compiled controller no longer exports, so Express receives an undefined callback. Filed as #942.                 |

No current failure was caused by a simple `../` depth error. Governance's
historical wrong-depth source import and ESM/CJS `error-response.js` failure are
already fixed on this audited base; `/api/governance` now reaches the compiled
router. Pythia's historical `rateLimiting.js` interop defect is likewise fixed;
`/api/pythia` reaches its compiled router.

## Uniform interop repair

`scripts/copy-build-assets.mjs` now applies one build-wide rule to every emitted
JavaScript file:

- if a relative `require('./x')` or `require('./x.js')` has an emitted
  `./x.cjs` sibling, repoint it to that shim;
- if an emitted ESM module actually invokes `require()` and has no top-level
  binding, inject a `createRequire(import.meta.url)` binding.

This is not a four-router allowlist. The repair scans the entire artifact and
uses the TypeScript parser to distinguish real calls from strings/comments.
The durable artifact test independently parses every emitted ESM module and
rejects any real unbound `require()` call.

## Adjacent dynamic routers named during #935

`subscription-routes`, `webhook-routes`, and
`contributor-summary-routes` are not silently missing from the denominator:
they are **not** among the production optimized entrypoint's 46 `safeMount`
calls. They are dynamic imports in the alternate
`server/unified_api_server.ts` entrypoint.

They were checked separately against the current compiled artifact:

- `subscription-routes` loads and exposes its router/factory exports;
- `webhook-routes` loads and exposes its router/factory exports;
- `contributor-summary-routes` loads successfully, including its module-level
  metric initialization. The previously observed
  `getSingleMetric`-of-undefined initialization error does not reproduce on
  current `main`.

Those checks are reported separately rather than inflating the production
`safeMount` denominator.

## Durable gate and falsifiability

Green command:

```text
npm run build
npm run audit:safe-mount-build
```

Expected terminal marker:

```text
BUILD_TIER_SAFE_MOUNT_GATE_OK total=46 reachable=42 known_broken=4
```

RED-on-revert was demonstrated by disabling only the uniform `createRequire`
injection and rebuilding:

- the artifact invariant listed 79 emitted ESM files with real unbound
  `require()` calls;
- the production-seam audit regressed from 42/46 to 38/46;
- weather-alerts, weather-report, SMS gateway, and Wormhole became unexpected
  failures; and
- the gate exited 1 with `expected 4, found 8`.

Restoring the build-wide repair and rebuilding returns both checks to green.
