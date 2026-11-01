/**
 * GET /api/capabilities — platform-wide feature readiness.
 *
 * Bridges frontend's already-built readiness system
 * (frontend/src/hooks/useCapabilities.ts, frontend/src/contexts/CapabilitiesContext.tsx)
 * to the backend's already-built capability-readiness model
 * (shared/types/capability-readiness.ts), generalising the per-domain pattern
 * `server/routes/bridges.js` already implements at
 * GET /api/bridges/capabilities/readiness from bridges-only to platform-wide.
 *
 * Frontend polls this every 60s. Static inventory below can classify a feature
 * as configured, but only a fresh bounded functional observation with semantic
 * proof can classify it operational (backend#1158).
 *
 * PUBLIC DISCLOSURE BOUNDARY (infra#1046 owner decision, 2026-09-26): this
 * response is served to anonymous internet clients through the public edge.
 * Every string it returns comes from a fixed vocabulary — feature id, status
 * enum, PUBLIC_REASON_CODES, readiness mode, release classification, ISO
 * timestamp. Seed notes, provider observation source/detail, provider error
 * text, env var names and env values are never serialized. There is no
 * detailed operator variant; the curated per-feature notes live in this file.
 */

import express, { Router } from 'express';
import { earningsEnabled } from '../services/chain-rewards/earnings.js';
import { forecastersEnabled } from '../services/chain-rewards/forecaster-stats.js';
import { competitionsEnabled } from '../services/chain-rewards/competition-stats.js';
import { payoutNotifyEnabled } from '../services/payout-notify/watcher.js';
import { calibrationCertificatesEnabled } from '../services/calibration-certificates.js';
import { forecastVerificationEnabled } from '../services/forecast-verification/observed-verification-job.js';
import { friendChallengesEnabled } from '../services/friend-challenges.js';
import { duelsEnabled } from '../services/forecast-duels.js';

/** Same per-request flag proof-card-routes.ts reads. */
const proofCardsEnabled = () => process.env.PROOF_CARDS_ENABLED === 'true';

/** Same per-request flag network-nodes-routes.ts reads. */
const networkNodesEnabled = () => process.env.NETWORK_NODES_READ_ENABLED === 'true';
import type {
  CapabilityMode,
  CapabilityReadinessResult,
} from '../../shared/types/capability-readiness.js';

export type CapabilityEvidenceClass =
  | 'configured'
  | 'reachable'
  | 'degraded'
  | 'operational'
  | 'simulated'
  | 'unavailable';

export type FeatureStatus = CapabilityEvidenceClass;

export interface CapabilityObservation {
  capabilityId: string;
  evidenceClass: CapabilityEvidenceClass;
  observedAt: string;
  source: string;
  detail: string;
  functional?: boolean;
  proof?: {
    kind: 'semantic';
    assertion: string;
  };
}

export type CapabilityEvidenceProvider = () => Promise<
  Record<string, CapabilityObservation>
>;

const CAPABILITY_EVIDENCE_CLASSES: readonly CapabilityEvidenceClass[] = [
  'configured',
  'reachable',
  'degraded',
  'operational',
  'simulated',
  'unavailable',
];

/**
 * The only reason vocabulary the public response may carry. Adding a code is
 * a public-contract change: update the disclosure-boundary test with it.
 */
export const PUBLIC_REASON_CODES = [
  'ok', // fresh functional observation with semantic proof
  'not_wired', // static inventory: no backend surface for this feature
  'unverified', // static inventory: configured, no functional observation
  'simulated', // explicit simulator/fixture, never release-eligible
  'reachable', // observation: reachable, semantics not proven
  'degraded', // observation: partial service
  'unavailable', // observation: dependency down
  'proof_missing', // operational claim without functional semantic proof
  'evidence_stale', // observation older than the freshness window
  'evidence_invalid', // malformed observation (timestamp or class)
  'provider_failed', // evidence provider threw or timed out
] as const;

export type PublicReasonCode = (typeof PUBLIC_REASON_CODES)[number];

export interface FeatureStatusEntry {
  status: FeatureStatus;
  reasonCode: PublicReasonCode;
}

export interface PublicReleaseReadiness {
  pass: boolean;
  classification: 'PUBLIC_RELEASE' | 'NON_RELEASE';
  requiredCapabilities: string[];
  failures: Array<{ capabilityId: string; reasonCode: PublicReasonCode }>;
}

export interface CapabilitiesResponse {
  features: Record<string, FeatureStatusEntry>;
  readiness: Record<string, CapabilityReadinessResult>;
  publicReleaseReadiness: PublicReleaseReadiness;
  timestamp: string;
}

export interface BuildStampResponse {
  available: boolean;
  revision?: string;
  created?: string;
  source?: 'oci-build-args';
  error?: {
    code: 'BUILD_METADATA_UNAVAILABLE';
    message: string;
  };
}

interface FeatureSeed {
  key: string;
  /** Static inventory only. Never sufficient to produce operational status. */
  status: FeatureStatus;
  /** Maintainer note. NEVER serialized — see PUBLIC DISCLOSURE BOUNDARY. */
  note: string;
}

export interface CapabilitiesRouterOptions {
  evidenceProvider?: CapabilityEvidenceProvider;
  maxEvidenceAgeMs?: number;
  probeTimeoutMs?: number;
  clock?: () => Date;
}

/**
 * One entry per key in frontend/src/config/features.ts's FEATURES object
 * (67 keys as of 2026-09-16). The two repos can't share a type import
 * (separate git repos, HTTP-only boundary — see workspace CLAUDE.md), so
 * this list is a synced fixture, not a derived one: if features.ts adds or
 * renames a key, this list drifts silently until someone re-syncs it. The
 * accompanying test asserts the response carries exactly these keys, but it
 * cannot detect a key that's missing entirely — that has to be caught by
 * periodically diffing against features.ts by hand.
 *
 * `status` is the old static inventory classification and is used only to
 * distinguish configured/release-required entries from absent ones. It is
 * never returned as operational without runtime evidence.
 */
const FEATURE_SEEDS: FeatureSeed[] = [
  { key: 'earningsRead', status: 'unavailable', note: 'Default-OFF indexed producer/attester earnings; contribution and forecast coverage remain gated' },
  { key: 'networkNodesRead', status: 'unavailable', note: 'Default-OFF (NETWORK_NODES_READ_ENABLED) /api/network/nodes (network-nodes-routes.ts): producers from core4\'s genesis roster with activity counted from block producer keys, bonded nodes found via settlement epochs and NETWORK_NODES_BOND_IDS then checked with /node/bonds, attesters from oracle status; core4 has no list route for producers or bonds' },
  { key: 'calibrationCertificates', status: 'unavailable', note: 'Default-OFF station calibration certificates (/api/calibration-certificates, core4#388/#435, backend#931): trust-root-signed ed25519 certificates stored off chain (migration 0038, applied by hand on CT101) and re-verified on every public read; trust roots only from CALIBRATION_TRUST_ROOTS_JSON (owner decision pending; recommended: the owner key alone on testnet). Nothing is written to core4 calibration_attestations: no live transaction writes that state and it feeds reward weight (consensus change)' },
  { key: 'forecastersRead', status: 'unavailable', note: 'Default-OFF forecaster track record (/api/forecasters, core4#3604 A4) read from the chain-rewards indexer forecast rows; skill and per-forecaster paid totals are not yet exposed by the node' },
  { key: 'wallet', status: 'operational', note: '/api/wallet and /api/wallet-auth are mounted (wallet-routes.js, wallet-auth-legacy-routes.js)' },
  // backend#1167: sub-capability of wallet, not a frontend features.ts key.
  // The capability model has no "partial" class, so window-limited history is
  // reported as `degraded` only when a fresh observation proves core4 serves
  // /addresses/{address}/transactions; statically (no observation) it stays
  // `unavailable` and is never release-required or promoted to operational.
  { key: 'wallet.history', status: 'unavailable', note: 'GET /api/wallet/:address/transactions proxies core4 /addresses/{address}/transactions (owner-bound, requires WRFCOIN_READER_TOKEN) and is window-limited (complete:false); without a fresh observation that core4 serves the route it is reported unavailable, and at best degraded (partial), never operational' },
  { key: 'explorer', status: 'operational', note: '/api/blockchain is mounted, proxying core4 launch API reads' },
  { key: 'pop', status: 'operational', note: 'weatherCommitRevealService (commit/reveal/listCommitments) is wired directly into enhanced_unified_api_optimized.ts at /api/weather/commit, /api/weather/reveal, /api/weather/commitments/:stationId — not the unmounted local-simulator server/routes/popRoutes.ts (see backend#1124)' },
  { key: 'mining', status: 'operational', note: '/api/mining is mounted (mining-routes.js)' },
  { key: 'weather', status: 'operational', note: '/api/weather plus the bare-/api weather-alerts-routes.ts and weather-report-routes.ts are mounted' },
  { key: 'governance', status: 'operational', note: '/api/governance is mounted (governance-routes.ts)' },
  { key: 'nfts', status: 'operational', note: '/api/nft is mounted (nft-routes.js)' },
  { key: 'settings', status: 'operational', note: 'client-side preferences only; no backend route exists or is needed' },
  { key: 'resources', status: 'operational', note: '/api/documentation is mounted (documentation-routes.js)' },
  { key: 'crossChain', status: 'operational', note: '/api/bridges is mounted (bridges.js) — this is the existing per-provider readiness precedent this endpoint generalises; see readiness.storage/computeMarketplace/aiMarketplace below for the same model applied to other domains' },
  { key: 'carbon', status: 'unavailable', note: 'no backend route found for the carbon-credit domain as of 2026-09-16' },
  { key: 'aiIntegration', status: 'unavailable', note: 'mock-only /api/ai is retired; no configured, authenticated, health-proven provider route exists (backend#1157)' },
  { key: 'privacy', status: 'operational', note: '/api/privacy is mounted (privacyRoutes.ts, mobile#216 stealth-address flow)' },
  { key: 'defi', status: process.env.DEFI_NODE_URL?.trim() ? 'simulated' : 'unavailable', note: 'DEFI_NODE_URL set: opt-in read/quote simulator, no custody or settlement route; unset: /api/defi returns an honest not-wired response' },
  { key: 'staking', status: 'unavailable', note: 'no backend route found for staking as of 2026-09-16' },
  { key: 'sharding', status: 'unavailable', note: 'server/routes/shardingRoutes.ts was deleted as confirmed-dead, unreferenced code in backend PR#1128 (backend#1123)' },
  { key: 'iot', status: 'operational', note: '/api/sensors is mounted (sensor-ingest-routes.ts, physics-validated ingestion)' },
  { key: 'messaging', status: 'unavailable', note: 'no backend route found for messaging as of 2026-09-16' },
  { key: 'storage', status: 'degraded', note: '/api/storage (storage-realtime-routes.js) is real but scoped to weather-station realtime reads only, not the full IPFS/Filecoin/Arweave storage-networks server — see readiness.storage below' },
  { key: 'cortex', status: 'unavailable', note: 'no backend route found for cortex as of 2026-09-16' },
  { key: 'standards', status: 'unavailable', note: 'no backend route found for standards as of 2026-09-16' },
  { key: 'developer', status: 'unavailable', note: 'No functional developer-capability observation exists; MCP context is retired and mount presence is not proof' },
  { key: 'analytics', status: 'operational', note: '/api/kpi/alignment is mounted (alignment-kpi-routes.ts, backend#34)' },
  { key: 'integrations', status: 'unavailable', note: 'No functional integration observation exists; MCP context is retired and mount presence is not proof' },
  { key: 'infrastructure', status: 'operational', note: '/api/node-os and /api/node-control are mounted' },
  { key: 'smartContracts', status: 'operational', note: '/api/chain is mounted (chain-routes.js, ERC-4337 UserOperation submission)' },
  { key: 'mobile', status: 'operational', note: 'client app-shell toggle; the mobile app consumes the same mounted APIs as the web frontend' },
  { key: 'gamification', status: 'operational', note: '/api/achievement and /api/v1/rewards are mounted' },
  { key: 'incentives', status: 'operational', note: '/api/v1/rewards is mounted (rewards.ts, #215 earn-to-claim loop)' },
  { key: 'system', status: 'operational', note: '/api/node-os and /api/node-control are mounted' },
  { key: 'oracle', status: 'operational', note: '/api/oracle is mounted via oracle-routes.js, oracle-detail-routes.js, the static oracleSubmitRoutes mount, and the directly-imported oracle-work-routes.ts' },
  { key: 'partners', status: 'unavailable', note: 'academic-routes.ts exists but is not mounted anywhere in enhanced_unified_api_optimized.ts' },
  { key: 'achievements', status: 'operational', note: '/api/achievement is mounted (achievementRoutes.ts)' },
  { key: 'identity', status: 'unavailable', note: 'identityRoutes.ts exists but is not mounted anywhere in enhanced_unified_api_optimized.ts' },
  { key: 'feeMarket', status: 'unavailable', note: 'no backend route found for feeMarket as of 2026-09-16' },
  { key: 'liquidStaking', status: 'unavailable', note: 'liquid staking stays native per core4 ADR-001 (see infra#943 defi-protocols#69 ADR); no backend-proxied route exists yet' },
  { key: 'fleet', status: 'unavailable', note: 'no backend route found for fleet as of 2026-09-16' },
  { key: 'forecast', status: 'operational', note: '/api/pythia (predictive-oracle sidecar) and /api/weather are mounted' },
  { key: 'explorerMap', status: 'operational', note: 'client map rendering over the real /api/weather and /api/blockchain data' },
  { key: 'pipelines', status: 'unavailable', note: 'data-flow-routes.js exists but is not mounted anywhere in enhanced_unified_api_optimized.ts' },
  { key: 'aiMarketplace', status: 'unavailable', note: 'no AI-marketplace route is proxied into the main API; ai_ml_networks_server.js runs as a separate optional microservice behind infra\'s "full" profile — see readiness.aiMarketplace below' },
  { key: 'carbonReporting', status: 'unavailable', note: 'no backend route found for carbonReporting as of 2026-09-16' },
  { key: 'collaboration', status: 'unavailable', note: 'no backend route found for collaboration as of 2026-09-16' },
  { key: 'computeMarketplace', status: 'unavailable', note: 'no compute-marketplace route is proxied into the main API; compute_networks_server.ts runs as a separate optional microservice behind infra\'s "full" profile — see readiness.computeMarketplace below' },
  { key: 'community', status: 'unavailable', note: 'no backend route found for community as of 2026-09-16' },
  { key: 'forecastStudio', status: 'unavailable', note: 'no dedicated route beyond the base forecast (/api/pythia, /api/weather) as of 2026-09-16' },
  { key: 'notifications', status: 'unavailable', note: 'Default-OFF payout notifications (/api/notifications, backend#389): wallet-login subscriptions delivered by Web Push or ntfy, no email or personal data; migration 0037. Needs PAYOUT_NOTIFY_ENABLED' },
  { key: 'leaderboard', status: 'operational', note: '/api/weather/leaderboard is mounted (weather-leaderboard-routes.ts, backend#695/#1131)' },
  { key: 'governanceAdvanced', status: 'operational', note: 'same backing as governance: /api/governance is mounted' },
  { key: 'realTime', status: 'operational', note: 'initializeRealtimeWebSocketServer(server) is real and called at startup' },
  { key: 'pwa', status: 'operational', note: 'client-side (service worker/manifest); no backend dependency' },
  { key: 'validatorOps', status: 'unavailable', note: 'no backend route found for validatorOps as of 2026-09-16 — correctly stays gated (CAPABILITY_PROMOTABLE_FEATURES in CapabilitiesContext.tsx)' },
  { key: 'networkInsights', status: 'unavailable', note: 'no backend route found for networkInsights as of 2026-09-16 — correctly stays gated (CAPABILITY_PROMOTABLE_FEATURES in CapabilitiesContext.tsx)' },
  { key: 'stationAnalytics', status: 'unavailable', note: 'no backend route found for stationAnalytics as of 2026-09-16 (operator-quality-routes.ts is a different domain: operator scoring, not station analytics)' },
  { key: 'weatherIntelligence', status: 'unavailable', note: 'no backend route found distinct from forecast/pythia as of 2026-09-16' },
  { key: 'bridgeAdvanced', status: 'operational', note: 'same backing as crossChain: /api/bridges is mounted' },
  { key: 'fieldTools', status: 'unavailable', note: 'no dedicated route found for fieldTools as of 2026-09-16' },
  { key: 'advancedOnboarding', status: 'operational', note: '/api/onboarding is mounted (#857 deployed entrypoint)' },
  { key: 'zkVerification', status: 'unavailable', note: 'wrfcoin/core4#2176 ("ZK proving stack maturation") is still open — real proofs are not yet live' },
  { key: 'executionDebugger', status: 'unavailable', note: 'no dedicated debugger endpoint found as of 2026-09-16' },
  { key: 'accessibilityHub', status: 'operational', note: 'client-side; no backend dependency' },
  { key: 'i18n', status: 'operational', note: 'client-side; no backend dependency' },
  { key: 'exportManager', status: 'operational', note: 'export-routes.ts (handleWeatherExportRequest) is directly wired into enhanced_unified_api_optimized.ts' },
  { key: 'weatherGlobe', status: 'operational', note: 'client 3D rendering over the real /api/weather data' },
  // backend#1178: mounted on the live entrypoint. Mutators need a wallet login
  // token for the acting wallet; activation records `activated` and pays
  // nothing (no on-chain referral payout exists). Configured, not operational:
  // no functional evidence probe exists for it yet.
  { key: 'referrals', status: 'configured', note: '/api/referrals is mounted (referral-routes.ts, migration 0023_referrals); generate/activate require a wallet JWT for the acting wallet; activation records status activated with reward state not_paid — no on-chain referral payout exists (backend#1178)' },
  { key: 'impact', status: 'unavailable', note: 'no backend route found for impact as of 2026-09-16' },
  { key: 'leaderboardRegions', status: 'operational', note: '/api/weather/leaderboard is mounted with region filtering (backend#695/#1131) — frontend\'s "pending" comment in features.ts is now stale, this is wired' },
  // backend#1178: the rest of the growth cluster stays DEFERRED — these routers
  // were only ever mounted in the never-deployed unified_api_server.ts. Like
  // wallet.history these are backend-side records, not features.ts keys.
  { key: 'duels', status: 'unavailable', note: 'Default-OFF (FORECAST_DUELS_ENABLED) FREE-PLAY /api/duels (duel-routes.ts, backend#228/#1424, migration 0041_forecast_duels): no stake, escrow or payout; players link their own forecast commits before the lock, hand in the commit record after the reveal (hash = commit id, valid_at = target hour), and a resolver judges from each commit\'s finalized forecast reward on chain (reward-evidence): higher wins, equal draws. Funded duels stay a separate consensus feature (forecast_duels_v1), not built' },
  { key: 'competitions', status: 'unavailable', note: 'Default-OFF weekly forecast competition (/api/competitions, backend#251), points only, computed from the forecast index rows /api/forecasters reads; finished weeks frozen by migration 0036. Needs CHAIN_REWARD_INDEX_ENABLED and FORECAST_COMPETITIONS_ENABLED' },
  { key: 'challenges', status: 'unavailable', note: 'Default-OFF (FRIEND_CHALLENGES_ENABLED) /api/challenges (challenge-routes.ts, backend#249, migration 0040_friend_challenges): friend challenges for the phone screen (mobile#260) and the web board; create/join/read need a wallet JWT for the acting wallet, the board by invite code is public. Points only, nothing is paid. Counts are readings from stations the wallet owns that landed on chain in the window (node observation scan), never a count the phone reports' },
  { key: 'proofCards', status: 'unavailable', note: 'Default-OFF (PROOF_CARDS_ENABLED) /api/proofs/:commitId (proof-card-routes.ts, backend#229): one station reading and the block it landed in, read from the node (reward-evidence, observation scan, /chain/block); no backend table. A reveal outside the bounded scan is reported not_located, never guessed' },
  { key: 'forecastVerification', status: 'unavailable', note: 'Default-OFF (FORECAST_VERIFICATION_ENABLED) /api/forecast-verification (forecast-verification-routes.ts default export, backend PR#72 / #1494, migration 0039): on-chain forecasts whose forecaster hands in the commit record (sha3 must equal the chain commit id, node must report a revealed forecast for that station) are scored against the hourly mean of the chain\'s own readings for the station, and against NOAA\'s hourly forecast captured before the forecast was issued. No reading in the target hour => unavailable, never a guessed truth. Read-side only, never feeds rewards' },
  { key: 'marketplace', status: 'unavailable', note: 'DEFERRED, not mounted (marketplace-routes.ts): only unified_api_server.ts mounted it and that entrypoint never deploys (backend#1178)' },
  { key: 'academic', status: 'unavailable', note: 'DEFERRED, not mounted (academic-routes.ts): only unified_api_server.ts mounted it and that entrypoint never deploys (backend#1178)' },
  { key: 'subscription', status: 'unavailable', note: 'DEFERRED, not mounted (subscription-routes.ts): only the never-deployed unified_api_server.ts mounted it (backend#1178)' },
  { key: 'webhooks', status: 'unavailable', note: 'NOT mounted (webhook-routes.ts): user-registered URLs are an SSRF surface; payout notifications ship as /api/notifications (Web Push/ntfy, backend#389) instead' },
  { key: 'telemetry', status: 'unavailable', note: 'DEFERRED, not mounted (telemetry-routes.ts): only the never-deployed unified_api_server.ts mounted it (backend#1178)' },
  { key: 'contributorSummary', status: 'unavailable', note: 'DEFERRED, not mounted (contributor-summary-routes.ts): only the never-deployed unified_api_server.ts mounted it (backend#1178)' },
];

/** Read features that are honestly `configured` (never operational without evidence) once their flags are on. */
const FLAG_GATED_READS = new Set(['earningsRead', 'forecastersRead', 'proofCards', 'networkNodesRead', 'competitions', 'notifications', 'calibrationCertificates', 'forecastVerification', 'challenges', 'duels']);

const DEFAULT_MAX_EVIDENCE_AGE_MS = 5 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

function evidenceAgeMs(observedAt: string, evaluatedAt: Date): number | null {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return null;
  return evaluatedAt.getTime() - observedMs;
}

/** Runtime shape check: providers are external input, not trusted types. */
function isWellFormedObservation(observation: CapabilityObservation): boolean {
  const proof: unknown = observation.proof;
  return (
    typeof observation.evidenceClass === 'string' &&
    typeof observation.observedAt === 'string' &&
    typeof observation.source === 'string' &&
    typeof observation.detail === 'string' &&
    (observation.functional === undefined || typeof observation.functional === 'boolean') &&
    (proof === undefined ||
      (typeof proof === 'object' &&
        proof !== null &&
        typeof (proof as { kind?: unknown }).kind === 'string' &&
        typeof (proof as { assertion?: unknown }).assertion === 'string'))
  );
}

function evaluateFeature(
  seed: FeatureSeed,
  observation: CapabilityObservation | undefined,
  evaluatedAt: Date,
  maxEvidenceAgeMs: number,
  providerFailed: boolean,
): FeatureStatusEntry {
  if (!observation) {
    if (seed.status === 'simulated') {
      return { status: 'simulated', reasonCode: 'simulated' };
    }
    const configured = seed.status !== 'unavailable';
    return {
      status: configured ? 'configured' : 'unavailable',
      reasonCode: providerFailed ? 'provider_failed' : configured ? 'unverified' : 'not_wired',
    };
  }

  // The provider is trusted for classification only; its free-text fields
  // (source, detail, proof assertion) are inputs to the proof check and are
  // never echoed. A wrongly-typed field or an evidence class outside the
  // enum is malformed evidence.
  if (
    !isWellFormedObservation(observation) ||
    !CAPABILITY_EVIDENCE_CLASSES.includes(observation.evidenceClass)
  ) {
    return { status: 'unavailable', reasonCode: 'evidence_invalid' };
  }

  const ageMs = evidenceAgeMs(observation.observedAt, evaluatedAt);
  if (ageMs === null || ageMs < -5_000) {
    return { status: 'unavailable', reasonCode: 'evidence_invalid' };
  }

  if (ageMs > maxEvidenceAgeMs) {
    return { status: 'unavailable', reasonCode: 'evidence_stale' };
  }

  const semanticProof =
    observation.proof?.kind === 'semantic' &&
    observation.proof.assertion.trim().length > 0;
  const provenance =
    observation.source.trim().length > 0 && observation.detail.trim().length > 0;
  if (
    observation.evidenceClass === 'operational' &&
    (!observation.functional || !semanticProof || !provenance)
  ) {
    // Reachability or HTTP 200 is insufficient for operational.
    return { status: 'degraded', reasonCode: 'proof_missing' };
  }

  const reasonByClass: Record<CapabilityEvidenceClass, PublicReasonCode> = {
    operational: 'ok',
    configured: 'unverified',
    reachable: 'reachable',
    degraded: 'degraded',
    simulated: 'simulated',
    unavailable: 'unavailable',
  };
  return {
    status: observation.evidenceClass,
    reasonCode: reasonByClass[observation.evidenceClass],
  };
}

async function loadEvidence(
  provider: CapabilityEvidenceProvider,
  timeoutMs: number,
): Promise<{ evidence: Record<string, CapabilityObservation>; failed: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`probe timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const evidence: unknown = await Promise.race([provider(), timeout]);
    if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
      console.warn('[capabilities] evidence provider returned a non-object result');
      return { evidence: {}, failed: true };
    }
    return { evidence: evidence as Record<string, CapabilityObservation>, failed: false };
  } catch (error) {
    // Provider error text can carry internal URLs/addresses: server log only,
    // the public response gets the fixed `provider_failed` code.
    console.warn(
      '[capabilities] evidence provider failed:',
      error instanceof Error ? error.message : String(error),
    );
    return { evidence: {}, failed: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildReadiness(
  features: Record<string, FeatureStatusEntry>,
  updatedAt: string,
): Record<string, CapabilityReadinessResult> {
  const readiness: Record<string, CapabilityReadinessResult> = {};
  for (const capabilityId of ['pop', 'storage', 'computeMarketplace', 'aiMarketplace']) {
    const feature = features[capabilityId];
    const mode: CapabilityMode =
      feature.status === 'operational'
        ? 'production-verified'
        : feature.status === 'simulated'
          ? 'simulated'
          : feature.status === 'unavailable'
            ? 'unavailable'
            : 'degraded';
    // `reason` is required by the shared readiness shape (and rendered by the
    // frontend readiness badge); publicly it carries the code, never text.
    readiness[capabilityId] = {
      capabilityId,
      mode,
      reason: feature.reasonCode,
      reasonCode: feature.reasonCode,
      updatedAt,
      signals: {},
    };
  }
  return readiness;
}

export function createCapabilitiesRouter(
  options: CapabilitiesRouterOptions = {},
): express.Router {
  const router: Router = express.Router();
  const evidenceProvider = options.evidenceProvider ?? (async () => ({}));
  const maxEvidenceAgeMs =
    options.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const clock = options.clock ?? (() => new Date());

  router.get('/build', (_req, res) => {
    const revision = process.env.WRFCOIN_BUILD_REVISION?.trim() ?? '';
    const created = process.env.WRFCOIN_BUILD_CREATED?.trim() ?? '';
    const validRevision = /^[0-9a-f]{40}$/.test(revision);
    const createdMs = Date.parse(created);

    if (!validRevision || !Number.isFinite(createdMs)) {
      const response: BuildStampResponse = {
        available: false,
        error: {
          code: 'BUILD_METADATA_UNAVAILABLE',
          message: 'A full lowercase Git revision and valid OCI creation timestamp are required',
        },
      };
      res.status(503).json(response);
      return;
    }

    const response: BuildStampResponse = {
      available: true,
      revision,
      created: new Date(createdMs).toISOString(),
      source: 'oci-build-args',
    };
    res.json(response);
  });

  router.get('/capabilities', async (_req, res) => {
    // Express 4 does not catch a rejected async handler (the request would
    // hang and the rejection could crash Node), so fail closed here with a
    // fixed body. Error text stays in the server log.
    try {
      res.json(await buildCapabilitiesResponse());
    } catch (error) {
      console.error(
        '[capabilities] failed to build response:',
        error instanceof Error ? error.message : String(error),
      );
      if (!res.headersSent) {
        res.status(500).json({
          error: { code: 'CAPABILITIES_UNAVAILABLE', reasonCode: 'provider_failed' },
        });
      }
    }
  });

  async function buildCapabilitiesResponse(): Promise<CapabilitiesResponse> {
    const evaluatedAt = clock();
    const { evidence, failed } = await loadEvidence(
      evidenceProvider,
      probeTimeoutMs,
    );
    const features: Record<string, FeatureStatusEntry> = {};
    for (const seed of FEATURE_SEEDS) {
      if ((seed.key === 'earningsRead' && !earningsEnabled()) || (seed.key === 'forecastersRead' && !forecastersEnabled())
        || (seed.key === 'proofCards' && !proofCardsEnabled())
        || (seed.key === 'networkNodesRead' && !networkNodesEnabled())
        || (seed.key === 'competitions' && !competitionsEnabled())
        || (seed.key === 'notifications' && !payoutNotifyEnabled())
        || (seed.key === 'calibrationCertificates' && !calibrationCertificatesEnabled())
        || (seed.key === 'forecastVerification' && !forecastVerificationEnabled())
        || (seed.key === 'challenges' && !friendChallengesEnabled())
        || (seed.key === 'duels' && !duelsEnabled())) {
        features[seed.key] = { status: 'unavailable', reasonCode: 'not_wired' };
        continue;
      }
      const observation = evidence[seed.key];
      features[seed.key] = evaluateFeature(
        FLAG_GATED_READS.has(seed.key) ? { ...seed, status: 'configured' } : seed,
        observation?.capabilityId === seed.key ? observation : undefined,
        evaluatedAt,
        maxEvidenceAgeMs,
        failed,
      );
    }

    const requiredCapabilities = FEATURE_SEEDS
      .filter((seed) => seed.status !== 'unavailable')
      .map((seed) => seed.key);
    const failures = requiredCapabilities
      .filter((capabilityId) => features[capabilityId].status !== 'operational')
      .map((capabilityId) => ({
        capabilityId,
        reasonCode: features[capabilityId].reasonCode,
      }));

    const response: CapabilitiesResponse = {
      features,
      readiness: buildReadiness(features, evaluatedAt.toISOString()),
      publicReleaseReadiness: {
        pass: failures.length === 0,
        classification: failures.length === 0 ? 'PUBLIC_RELEASE' : 'NON_RELEASE',
        requiredCapabilities,
        failures,
      },
      timestamp: evaluatedAt.toISOString(),
    };
    return response;
  }

  return router;
}

const defaultRouter = createCapabilitiesRouter();
export default defaultRouter;
