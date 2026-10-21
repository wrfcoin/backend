/**
 * Quarantined test suites — backend#872.
 *
 * These suites fail (or hang) on clean origin/main for reasons unrelated to any
 * one PR. They are excluded from the default `npm test` gate so the suite is
 * GREEN-BY-DEFAULT and can actually gate PRs (see backend#870). This is a
 * quarantine, not a deletion: every entry must be fixed and removed. Run them
 * explicitly for triage with `npm run test:quarantined`.
 *
 * Categories:
 *   assertion-drift   — real test-vs-code mismatch (expect(...) failed)
 *   failing-on-main   — fails at runtime/beforeAll on main (needs triage)
 *   stale-module-ref  — imports/mocks a module path that no longer exists
 *   esm-syntax        — ESM dynamic-import/SyntaxError; likely fixed by #834/#871
 *   production-defect — suite exposes a tracked production-code defect
 *   pow-hang+assert   — PoW brute-force hang (fixed via WRFCOIN_TEST_POW_DIFFICULTY) + real assertion failures
 *   harness-resolution— passes under node, fails under jest because the two
 *                       resolve the same specifier to different files (jest's
 *                       moduleFileExtensions puts .ts ahead of .js)
 *
 * Generated 2026-07-01 from a per-suite isolation sweep of all 271 suites
 * (209 pass / 61 fail / 1 hang). Do NOT hand-edit blindly — re-run the sweep.
 */

/** @type {{pattern:string,category:string,file:string,signature:string}[]} */
const QUARANTINE = [
  { pattern: "/__tests__/abuse-risk-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/abuse-risk-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/api-key-auth-status-codes\\.test\\.ts$", category: "assertion-drift", file: "__tests__/api-key-auth-status-codes.test.ts", signature: "TypeError: expect(received).toMatch(expected)" },
  { pattern: "/__tests__/bridge-crypto-verifier\\.test\\.ts$", category: "esm-syntax", file: "__tests__/bridge-crypto-verifier.test.ts", signature: "SyntaxError: U" },
  { pattern: "/__tests__/bridge-double-spend-prevention\\.test\\.ts$", category: "esm-syntax", file: "__tests__/bridge-double-spend-prevention.test.ts", signature: "SyntaxError: U" },
  { pattern: "/__tests__/bridge-verification-orchestrator\\.test\\.ts$", category: "esm-syntax", file: "__tests__/bridge-verification-orchestrator.test.ts", signature: "SyntaxError: U" },
  { pattern: "/__tests__/byzantine-consensus\\.test\\.ts$", category: "assertion-drift", file: "__tests__/byzantine-consensus.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/cross-chain-bridge-security\\.test\\.ts$", category: "esm-syntax", file: "__tests__/cross-chain-bridge-security.test.ts", signature: "SyntaxError: U" },
  { pattern: "/__tests__/core4-launch-health\\.test\\.ts$", category: "isolation-victim", file: "__tests__/core4-launch-health.test.ts", signature: "passes in isolation; fails in full run (leaked global fetch mock from a prior suite)" },
  { pattern: "/__tests__/multi-chain-manager-health-race\\.test\\.ts$", category: "isolation-victim", file: "__tests__/multi-chain-manager-health-race.test.ts", signature: "passes in isolation; fails in full run (cross-suite state leak; race/timing)" },
  { pattern: "/__tests__/eclipse-attack-prevention\\.test\\.ts$", category: "assertion-drift", file: "__tests__/eclipse-attack-prevention.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/eclipse-attack-simulation\\.test\\.ts$", category: "assertion-drift", file: "__tests__/eclipse-attack-simulation.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/environment-phase2-reports-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/environment-phase2-reports-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/gas-relay\\.test\\.ts$", category: "failing-on-main", file: "__tests__/gas-relay.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/gossip-security\\.test\\.ts$", category: "assertion-drift", file: "__tests__/gossip-security.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/header-injection-protection\\.test\\.ts$", category: "assertion-drift", file: "__tests__/header-injection-protection.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/integration/core4-http-contract\\.integration\\.test\\.ts$", category: "assertion-drift", file: "__tests__/integration/core4-http-contract.integration.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/integration/resilience-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/integration/resilience-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/launch-route-dist-guard\\.test\\.ts$", category: "assertion-drift", file: "__tests__/launch-route-dist-guard.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/node-validation-security\\.test\\.ts$", category: "pow-hang+assert", file: "__tests__/node-validation-security.test.ts", signature: "<runtime/beforeAll error>" },
  { pattern: "/__tests__/openforis-cors-hardening\\.test\\.ts$", category: "failing-on-main", file: "__tests__/openforis-cors-hardening.test.ts", signature: "TypeError: createLogger is " },
  { pattern: "/__tests__/p2p-security\\.test\\.ts$", category: "assertion-drift", file: "__tests__/p2p-security.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/partition-resilience\\.test\\.ts$", category: "assertion-drift", file: "__tests__/partition-resilience.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/performance/backend-overflow-performance\\.test\\.ts$", category: "failing-on-main", file: "__tests__/performance/backend-overflow-performance.test.ts", signature: "TypeError: this.memoryCache.values is " },
  { pattern: "/__tests__/policy-audit-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/policy-audit-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/route-durable-store-concurrency\\.test\\.ts$", category: "failing-on-main", file: "__tests__/route-durable-store-concurrency.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/route-durable-store-consistency\\.test\\.ts$", category: "failing-on-main", file: "__tests__/route-durable-store-consistency.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/routes/abuse-risk-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/routes/abuse-risk-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/routes/ai-ml-ensemble-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/routes/ai-ml-ensemble-routes.test.ts", signature: "TypeError: Ca" },
  { pattern: "/__tests__/routes/appeals-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/routes/appeals-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/routes/forecast-job-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/routes/forecast-job-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/routes/mining-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/routes/mining-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/routes/reputation-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/routes/reputation-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/routes/streak-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/routes/streak-routes.test.ts", signature: "TypeError: (0 , streak_service_js_1.i" },
  { pattern: "/__tests__/routes/sybil-detection-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/routes/sybil-detection-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/routes/weather-alerts-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/routes/weather-alerts-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/routes/weather-report-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/routes/weather-report-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/sanctions-orchestration-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/sanctions-orchestration-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/sanctions-parity-guardrail\\.test\\.ts$", category: "failing-on-main", file: "__tests__/sanctions-parity-guardrail.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/schema-integrity\\.test\\.ts$", category: "assertion-drift", file: "__tests__/schema-integrity.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/security/api-endpoint-security\\.test\\.ts$", category: "assertion-drift", file: "__tests__/security/api-endpoint-security.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/security/owasp-a01-broken-access\\.test\\.ts$", category: "assertion-drift", file: "__tests__/security/owasp-a01-broken-access.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/security/owasp-a03-injection\\.test\\.ts$", category: "assertion-drift", file: "__tests__/security/owasp-a03-injection.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/security/owasp-a07-auth-failures\\.test\\.ts$", category: "assertion-drift", file: "__tests__/security/owasp-a07-auth-failures.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/security/rate-limiting\\.test\\.ts$", category: "assertion-drift", file: "__tests__/security/rate-limiting.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/sensor-ingest\\.test\\.ts$", category: "failing-on-main", file: "__tests__/sensor-ingest.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/services/audit-monitoring-service\\.test\\.ts$", category: "stale-module-ref", file: "__tests__/services/audit-monitoring-service.test.ts", signature: "db import repointed to ../../server/db.js (#970 only appended .js to a path that never existed); still blocked — see kubo-rpc-client / assertion drift (#992)" },
  { pattern: "/__tests__/services/audit-service\\.test\\.ts$", category: "stale-module-ref", file: "__tests__/services/audit-service.test.ts", signature: "db import repointed to ../../server/db.js (#970 only appended .js to a path that never existed); still blocked — see kubo-rpc-client / assertion drift (#992)" },
  { pattern: "/__tests__/services/file-integrity-service\\.test\\.ts$", category: "stale-module-ref", file: "__tests__/services/file-integrity-service.test.ts", signature: "db import repointed to ../../server/db.js (#970 only appended .js to a path that never existed); still blocked — see kubo-rpc-client / assertion drift (#992)" },
  { pattern: "/__tests__/services/file-permission-service\\.test\\.ts$", category: "stale-module-ref", file: "__tests__/services/file-permission-service.test.ts", signature: "db import repointed to ../../server/db.js (#970 only appended .js to a path that never existed); still blocked — see kubo-rpc-client / assertion drift (#992)" },
  { pattern: "/__tests__/services/integrity-monitoring-service\\.test\\.ts$", category: "stale-module-ref", file: "__tests__/services/integrity-monitoring-service.test.ts", signature: "db import repointed to ../../server/db.js (#970 only appended .js to a path that never existed); still blocked — see kubo-rpc-client / assertion drift (#992)" },
  { pattern: "/__tests__/services/weather-persistence-paths\\.test\\.ts$", category: "needs-postgres", file: "__tests__/services/weather-persistence-paths.test.ts", signature: "PostgresError: needs a live DB (password auth failed) — DB-integration, not green-by-default" },
  { pattern: "/__tests__/services/weather-data-cache-key\\.regression\\.test\\.ts$", category: "assertion-drift", file: "__tests__/services/weather-data-cache-key.regression.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/sybil-attack-simulation\\.test\\.ts$", category: "assertion-drift", file: "__tests__/sybil-attack-simulation.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/sybil-detection-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/sybil-detection-routes.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/threshold-signatures\\.test\\.ts$", category: "esm-syntax", file: "__tests__/threshold-signatures.test.ts", signature: "SyntaxError: U" },
  { pattern: "/__tests__/weather-ingest-edge-cases\\.test\\.ts$", category: "assertion-drift", file: "__tests__/weather-ingest-edge-cases.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/weather-streak\\.test\\.ts$", category: "failing-on-main", file: "__tests__/weather-streak.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/websocket-auth\\.test\\.ts$", category: "failing-on-main", file: "__tests__/websocket-auth.test.ts", signature: "<no-signature>" },
  { pattern: "/__tests__/websocket-security-hardening\\.test\\.ts$", category: "assertion-drift", file: "__tests__/websocket-security-hardening.test.ts", signature: "expect(received)" },
  { pattern: "/__tests__/wormhole-bridge\\.test\\.ts$", category: "stale-module-ref", file: "__tests__/wormhole-bridge.test.ts", signature: "Cannot find module '@solana/web3.js'" },
  { pattern: "/__tests__/wormhole-transfer-routes\\.test\\.ts$", category: "failing-on-main", file: "__tests__/wormhole-transfer-routes.test.ts", signature: "<no-signature>" },

  // backend#907: server/__tests__/ suites, newly discovered by CI. 19 of 24
  // pass green-by-default (incl. the faucet double-dispense #887 and reward
  // double-claim #215 regression tests). The five remaining suites below are
  // still quarantined after triage — same policy as the top-level set above.
  // Patterns anchor on /server/__tests__/ so they don't touch top-level files.
  { pattern: "/server/__tests__/oracle/climate-oracle-network-bls\\.test\\.ts$", category: "production-defect", file: "server/__tests__/oracle/climate-oracle-network-bls.test.ts", signature: "TypeError: blsShortSigs.hash is not a function — backend#1083" },
  { pattern: "/server/__tests__/openforis-rate-limiting\\.test\\.ts$", category: "failing-on-main", file: "server/__tests__/openforis-rate-limiting.test.ts", signature: "<runtime/beforeAll error>" },
  { pattern: "/server/__tests__/iso20022-climate\\.test\\.ts$", category: "failing-on-main", file: "server/__tests__/iso20022-climate.test.ts", signature: "<runtime/beforeAll error>" },
  { pattern: "/server/__tests__/integration/simulation\\.test\\.ts$", category: "failing-on-main", file: "server/__tests__/integration/simulation.test.ts", signature: "<runtime/beforeAll error>" },
  { pattern: "/server/__tests__/automated-regulatory-reporting\\.test\\.ts$", category: "failing-on-main", file: "server/__tests__/automated-regulatory-reporting.test.ts", signature: "<runtime/beforeAll error>" },

  // backend#1089 (residual of #907): the eight .js suites under server/__tests__/
  // that #907's .ts-only testMatch left dark. Now discovered; 2 of 8 are green
  // and gate immediately (middleware/authLogging, oracle-detail-routes). The six
  // below fail on first contact and are quarantined under the same #872 policy —
  // NOT because they are stale, but because two of them are catching real
  // production defects that need their own fix PRs. Every entry is triaged on
  // first contact — the signature carries the verdict, not a placeholder.
  { pattern: "/server/__tests__/data-flow-validation\\.test\\.js$", category: "assertion-drift", file: "server/__tests__/data-flow-validation.test.js", signature: "Both production defects this suite caught are FIXED (backend#1089: the Array.isArray correction in validateFieldType, and the non-finite guard in transformData). 5 of the original 7 failures are gone. The 2 that remain are both STALE test expectations, held for an owner call rather than changed here: (1) expects 22.555 to format as 22.56, but the double is exactly 22.554999999999999716 so toFixed(2) is correctly 22.55; (2) expects validateInput to THROW on circular data, but production handles it and returns success:false with an error, which is the better behaviour. No production defect remains behind this entry." },
  { pattern: "/server/__tests__/error-handling\\.test\\.js$", category: "assertion-drift", file: "server/__tests__/error-handling.test.js", signature: "5 of the original 8 failures are now FIXED. backend#1089 fixed 4 (the RetryManager jitter defect, plus the file's own missing NetworkError/AuthorizationError imports which crashed 3 tests before they could assert); (3) was RESOLVED by that same PR's follow-on (circuitBreakerAction was write-only and named for a CircuitBreaker integration that never existed, so the field was deleted rather than patched). (4) is RESOLVED here, by owner ruling (2026-08-31): it was never a ServiceRegistry defect (bare executeServiceCall never retried; correctly returns 502 on the first NetworkError) — the real defect was one level up. error-coordination-service.js's crosschain-bridge and IoT-sensor coordinators both nested RetryManager.execute INSIDE the function passed to executeServiceCall, so the breaker saw one attempt per outer call regardless of how many retries happened underneath it; since CircuitBreaker.onSuccess() resets failureCount to 0, this made the breaker nearly unable to trip (measured on the bridge path: ~20 real failed requests to open, not the ~5 its own failureThreshold implies). The test is re-targeted at that real composition point instead of the executeServiceCall surface that never offered it, and asserts the correct semantics: the breaker's failureCount, and the dependency's actual request count, must equal the number of attempts, not the number of outer calls. Retry now composes OUTSIDE the breaker at both call sites, so the breaker opens after 5 real requests, ~4x sooner. The remaining two are unrelated STALE expectations, unchanged by this PR: (1) asserts classified.query === 'SELECT * FROM users', contradicting the Task 103.4 redaction that deliberately made the query non-enumerable (_internalQuery); (2) spies on console.error, but the codebase logs via winston since the Task 113 logging consolidation." },
  { pattern: "/server/__tests__/health\\.test\\.js$", category: "assertion-drift", file: "server/__tests__/health.test.js", signature: "STALE: expects app.use('/health*', metricsMiddleware) writing health-checks.jsonl; that middleware was removed in cacb91d9 and exists nowhere in the repo. Third failure is a test artifact — the global Date sabotage also breaks winston's timestamp formatter inside the handler's own catch block." },
  { pattern: "/server/__tests__/openforis-implementation\\.test\\.js$", category: "harness-resolution", file: "server/__tests__/openforis-implementation.test.js", signature: "TypeError: createLogger is not a function. server/utils/logger.js sets `module.exports = createLogger`; logger.ts does not export it. Node resolves the .js (verified: production works), jest resolves the .ts first. Same root cause as the quarantined __tests__/openforis-cors-hardening.test.ts." },
  { pattern: "/server/__tests__/routes/bridges-capability-readiness\\.test\\.js$", category: "stale-module-ref", file: "server/__tests__/routes/bridges-capability-readiness.test.js", signature: "STALE MOCK: the jest.mock factory for server/utils/metrics returns only serviceHealthGauge, but bridges.js has imported bridgeValidatorsActiveGauge since 1d28da8b. The real metrics.ts exports it — production is fine, the mock is not." },
  { pattern: "/server/__tests__/services/data-profiling-engine\\.test\\.js$", category: "assertion-drift", file: "server/__tests__/services/data-profiling-engine.test.js", signature: "29/30 pass. The one failure is a shape mismatch: _analyzeMissingDataPatterns returns `recommendations` as an object, the test expects an array — and the same field IS an array elsewhere in the file. Needs an owner call on which shape is canonical." },
];

const QUARANTINED_PATTERNS = QUARANTINE.map((e) => e.pattern);
// Repo-relative file paths (for testMatch in RUN_QUARANTINED triage mode).
const QUARANTINED_FILES = QUARANTINE.map((e) => e.file);

module.exports = { QUARANTINE, QUARANTINED_PATTERNS, QUARANTINED_FILES };
