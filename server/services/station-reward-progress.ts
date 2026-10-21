/**
 * Wallet-scoped station reward progress (core4#2456).
 *
 * This projection is deliberately conservative: it reports only the furthest
 * state supported by durable evidence. Local reward estimates, ingestion
 * provider status, HTTP acceptance, nominal rates, and reveal labels never
 * select REWARDED.
 */

export interface RewardProgressPool {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type RewardProgressState =
  | "AWAITING_OBSERVATION"
  | "OBSERVATION_RECEIVED"
  | "VERIFYING"
  | "QUORUM_REACHED"
  | "FINALIZING_REWARD"
  | "REWARDED"
  | "UNKNOWN";

const CHAIN_EVIDENCE_FRESH_MS = 5 * 60 * 1000;
const CHAIN_STATES = new Set([
  "VERIFYING",
  "QUORUM_REACHED",
  "FINALIZING_REWARD",
  "REWARDED",
]);

export class StationRewardProgressNotFound extends Error {
  constructor() {
    super("station not found");
    this.name = "StationRewardProgressNotFound";
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sha256(value: unknown): string | null {
  const normalized = text(value);
  return normalized && /^[0-9a-f]{64}$/i.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function unsignedBaseUnits(value: unknown): bigint | null {
  const normalized = text(value);
  if (!normalized || !/^(0|[1-9][0-9]*)$/.test(normalized)) {
    return null;
  }
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

function chainIdentity(cycle: Record<string, unknown>) {
  const networkId = text(cycle.network_id);
  const chainId = text(cycle.chain_id);
  const genesisHash = text(cycle.genesis_hash);
  return networkId && chainId && genesisHash
    ? { networkId, chainId, genesisHash }
    : null;
}

function unknownDiagnostic(
  cycle: Record<string, unknown>,
  asOf: string,
  code = "UNKNOWN",
) {
  return {
    code,
    observedAt: iso(cycle.evidence_refreshed_at) ?? asOf,
    stalledSince: iso(cycle.stalled_since),
    retrySafe: code === "CORE_UNAVAILABLE" || code === "COMMIT_NOT_MINED",
  };
}

function validateClaimedState(
  cycle: Record<string, unknown>,
  now: Date,
): {
  state: RewardProgressState;
  evidenceFresh: boolean;
  diagnostic: ReturnType<typeof unknownDiagnostic> | null;
} {
  const asOf = now.toISOString();
  const claimed = text(cycle.lifecycle_state);
  const failureCode = text(cycle.failure_code);
  if (claimed === "FAILED" || failureCode) {
    return {
      state: "UNKNOWN",
      evidenceFresh: false,
      diagnostic: unknownDiagnostic(cycle, asOf, failureCode ?? "UNKNOWN"),
    };
  }

  const observed = text(cycle.observation_id);
  const observationDigest = sha256(cycle.observation_digest);
  const observedAt = iso(cycle.observation_observed_at);
  const acceptedAt = iso(cycle.observation_accepted_at);
  if (!observed || !observationDigest || !observedAt || !acceptedAt) {
    return {
      state: "UNKNOWN",
      evidenceFresh: false,
      diagnostic: unknownDiagnostic(cycle, asOf),
    };
  }
  if (claimed === "OBSERVATION_RECEIVED") {
    return { state: claimed, evidenceFresh: true, diagnostic: null };
  }

  if (!claimed || !CHAIN_STATES.has(claimed)) {
    return {
      state: "UNKNOWN",
      evidenceFresh: false,
      diagnostic: unknownDiagnostic(cycle, asOf),
    };
  }

  const chain = chainIdentity(cycle);
  const commitId = text(cycle.commit_id);
  const commitHeight = integer(cycle.commit_mined_height);
  const commitHash = text(cycle.commit_mined_hash);
  const approvals = integer(cycle.approvals);
  const requiredQuorum = integer(cycle.required_quorum);
  if (
    !chain ||
    !commitId ||
    commitHeight === null ||
    commitHeight < 0 ||
    !commitHash ||
    approvals === null ||
    approvals < 0 ||
    requiredQuorum === null ||
    requiredQuorum <= 0
  ) {
    return {
      state: "UNKNOWN",
      evidenceFresh: false,
      diagnostic: unknownDiagnostic(cycle, asOf),
    };
  }

  const refreshedAt = iso(cycle.evidence_refreshed_at);
  const evidenceAgeMs =
    refreshedAt === null
      ? null
      : now.getTime() - new Date(refreshedAt).getTime();
  const evidenceFresh =
    evidenceAgeMs !== null &&
    evidenceAgeMs >= 0 &&
    evidenceAgeMs <= CHAIN_EVIDENCE_FRESH_MS;
  if (!evidenceFresh) {
    return {
      state: "UNKNOWN",
      evidenceFresh: false,
      diagnostic: unknownDiagnostic(cycle, asOf, "CORE_UNAVAILABLE"),
    };
  }

  if (claimed === "VERIFYING") {
    if (
      approvals >= requiredQuorum ||
      integer(cycle.reveal_mined_height) !== null
    ) {
      return {
        state: "UNKNOWN",
        evidenceFresh: false,
        diagnostic: unknownDiagnostic(cycle, asOf),
      };
    }
    return { state: claimed, evidenceFresh: true, diagnostic: null };
  }

  if (approvals < requiredQuorum || !iso(cycle.quorum_mined_at)) {
    return {
      state: "UNKNOWN",
      evidenceFresh: false,
      diagnostic: unknownDiagnostic(cycle, asOf, "QUORUM_STALLED"),
    };
  }
  if (claimed === "QUORUM_REACHED") {
    return { state: claimed, evidenceFresh: true, diagnostic: null };
  }

  const revealHeight = integer(cycle.reveal_mined_height);
  const revealHash = text(cycle.reveal_mined_hash);
  const rewardAmount = unsignedBaseUnits(cycle.reward_amount_base_units);
  const rewardAddress = text(cycle.reward_address);
  const ownerAddress = text(cycle.owner_address);
  const rewardReason = text(cycle.reward_reason);
  const rewardHeight = integer(cycle.reward_block_height);
  const rewardHash = text(cycle.reward_block_hash);
  const rewardTime = iso(cycle.reward_block_time);
  const earnedBefore = unsignedBaseUnits(cycle.account_earned_before);
  const earnedAfter = unsignedBaseUnits(cycle.account_earned_after);
  if (
    revealHeight === null ||
    revealHeight < 0 ||
    !revealHash ||
    rewardAmount === null ||
    rewardAmount <= 0n ||
    !ownerAddress ||
    !rewardAddress ||
    rewardAddress.toLowerCase() !== ownerAddress.toLowerCase() ||
    rewardReason !== `contribution:${commitId}` ||
    rewardHeight === null ||
    rewardHeight < 0 ||
    !rewardHash ||
    !rewardTime ||
    earnedBefore === null ||
    earnedAfter === null ||
    earnedAfter < earnedBefore + rewardAmount
  ) {
    return {
      state: "UNKNOWN",
      evidenceFresh: false,
      diagnostic: unknownDiagnostic(cycle, asOf, "REWARD_MISSING"),
    };
  }
  if (claimed === "FINALIZING_REWARD") {
    return { state: claimed, evidenceFresh: true, diagnostic: null };
  }

  const finalityPolicy = text(cycle.finality_policy);
  const authoritativeFinalizedHeight = integer(
    cycle.authoritative_finalized_height,
  );
  const canonicalHashCheckedAt = iso(cycle.canonical_hash_checked_at);
  if (
    (finalityPolicy !== "BFT" &&
      finalityPolicy !== "PROBABILISTIC_DEPTH") ||
    authoritativeFinalizedHeight === null ||
    authoritativeFinalizedHeight < rewardHeight ||
    !canonicalHashCheckedAt ||
    !iso(cycle.finalized_at)
  ) {
    return {
      state: "UNKNOWN",
      evidenceFresh: false,
      diagnostic: unknownDiagnostic(cycle, asOf, "REWARD_MISSING"),
    };
  }
  return { state: "REWARDED", evidenceFresh: true, diagnostic: null };
}

export type ChainRewardEvidence =
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "history_limited" }
  | { kind: "observed"; commitId: string; observedAt: string | null; height: number | null; blocker: string | null }
  | {
      kind: "rewarded";
      commitId: string;
      observedAt: string | null;
      amountBaseUnits: string;
      address: string | null;
      reason: string | null;
      blockHeight: number | null;
      blockHash: string | null;
      blockTime: string | null;
      finalized: boolean;
    };

/**
 * No `station_reward_cycles` row exists (nothing writes that table). Answer from the chain
 * instead of pretending nothing has happened: only what core4's own reward-evidence verdict
 * proves is REWARDED; an observed-but-unpaid commit is OBSERVATION_RECEIVED; an unreadable
 * chain is UNKNOWN (never AWAITING_OBSERVATION). `source` says the state is chain-derived.
 */
function projectFromChainEvidence(
  base: { stationId: string; ownerAddress: string; asOf: string; registration: { state: "REGISTERED"; registeredAt: string | null } },
  evidence: Exclude<ChainRewardEvidence, { kind: "none" }>,
) {
  const shell = {
    schemaVersion: 1,
    stationId: base.stationId,
    ownerAddress: base.ownerAddress,
    asOf: base.asOf,
    registration: base.registration,
    chain: null,
    source: "chain-evidence" as const,
  };
  if (evidence.kind === "history_limited") {
    // The recent window is empty but does not cover the station's history: we cannot say the
    // station has never been observed, so we do not say AWAITING_OBSERVATION.
    return {
      ...shell,
      state: "UNKNOWN" as const,
      evidenceFresh: true,
      observation: null,
      contribution: null,
      reward: null,
      diagnostic: { code: "HISTORY_WINDOW_LIMIT", observedAt: base.asOf, stalledSince: null, retrySafe: false },
    };
  }
  if (evidence.kind === "unavailable") {
    return {
      ...shell,
      state: "UNKNOWN" as const,
      evidenceFresh: false,
      observation: null,
      contribution: null,
      reward: null,
      diagnostic: { code: "CORE_UNAVAILABLE", observedAt: base.asOf, stalledSince: null, retrySafe: true },
    };
  }
  const observation = { id: evidence.commitId, digest: null, observedAt: evidence.observedAt, acceptedAt: null };
  if (evidence.kind === "observed") {
    return {
      ...shell,
      state: "OBSERVATION_RECEIVED" as const,
      evidenceFresh: true,
      observation,
      contribution: { commitId: evidence.commitId, commitMinedHeight: evidence.height, commitMinedHash: null, approvals: null, rejections: null, requiredQuorum: null, revealMinedHeight: null, revealMinedHash: null },
      reward: null,
      diagnostic: evidence.blocker ? { code: evidence.blocker.toUpperCase(), observedAt: base.asOf, stalledSince: null, retrySafe: true } : null,
    };
  }
  // rewarded
  return {
    ...shell,
    state: "REWARDED" as const,
    evidenceFresh: true,
    observation,
    contribution: { commitId: evidence.commitId, commitMinedHeight: null, commitMinedHash: null, approvals: null, rejections: null, requiredQuorum: null, revealMinedHeight: null, revealMinedHash: null },
    reward: {
      amountBaseUnits: evidence.amountBaseUnits,
      address: evidence.address,
      reason: evidence.reason,
      blockHeight: evidence.blockHeight,
      blockHash: evidence.blockHash,
      blockTime: evidence.blockTime,
      accountEarnedAfter: null,
      finalityPolicy: null,
      authoritativeFinalizedHeight: null,
      canonicalHashCheckedAt: null,
      finalizedAt: null,
    },
    diagnostic: null,
  };
}

export function projectStationRewardProgress(
  station: Record<string, unknown>,
  cycle: Record<string, unknown> | null,
  now = new Date(),
  chainEvidence: ChainRewardEvidence | null = null,
) {
  const stationId = text(station.station_id);
  const ownerAddress = text(station.owner_address);
  if (!stationId || !ownerAddress) {
    throw new StationRewardProgressNotFound();
  }
  const asOf = now.toISOString();
  const registration = {
    state: "REGISTERED" as const,
    registeredAt: iso(station.created_at),
  };

  if (!cycle && chainEvidence && chainEvidence.kind !== "none") {
    return projectFromChainEvidence({ stationId, ownerAddress, asOf, registration }, chainEvidence);
  }
  if (!cycle) {
    return {
      schemaVersion: 1,
      stationId,
      ownerAddress,
      state: "AWAITING_OBSERVATION" as const,
      asOf,
      evidenceFresh: true,
      registration,
      chain: null,
      observation: null,
      contribution: null,
      reward: null,
      diagnostic: null,
    };
  }

  const verdict = validateClaimedState(cycle, now);
  const commitId = text(cycle.commit_id);
  const rewardAmount = text(cycle.reward_amount_base_units);
  return {
    schemaVersion: 1,
    stationId,
    ownerAddress,
    state: verdict.state,
    asOf,
    evidenceFresh: verdict.evidenceFresh,
    registration,
    chain: chainIdentity(cycle),
    observation: {
      id: text(cycle.observation_id),
      digest: sha256(cycle.observation_digest),
      observedAt: iso(cycle.observation_observed_at),
      acceptedAt: iso(cycle.observation_accepted_at),
    },
    contribution: commitId
      ? {
          commitId,
          commitMinedHeight: integer(cycle.commit_mined_height),
          commitMinedHash: text(cycle.commit_mined_hash),
          approvals: integer(cycle.approvals),
          rejections: integer(cycle.rejections),
          requiredQuorum: integer(cycle.required_quorum),
          revealMinedHeight: integer(cycle.reveal_mined_height),
          revealMinedHash: text(cycle.reveal_mined_hash),
        }
      : null,
    reward:
      verdict.state === "FINALIZING_REWARD" || verdict.state === "REWARDED"
        ? {
            amountBaseUnits: rewardAmount,
            address: text(cycle.reward_address),
            reason: text(cycle.reward_reason),
            blockHeight: integer(cycle.reward_block_height),
            blockHash: text(cycle.reward_block_hash),
            blockTime: iso(cycle.reward_block_time),
            accountEarnedAfter: text(cycle.account_earned_after),
            finalityPolicy: text(cycle.finality_policy),
            authoritativeFinalizedHeight: integer(
              cycle.authoritative_finalized_height,
            ),
            canonicalHashCheckedAt: iso(cycle.canonical_hash_checked_at),
            finalizedAt: iso(cycle.finalized_at),
          }
        : null,
    diagnostic: verdict.diagnostic,
  };
}

export async function getStationRewardProgress(
  pool: RewardProgressPool,
  stationId: string,
  ownerAddress: string,
  now = new Date(),
  options: { chainEvidence?: (stationId: string) => Promise<ChainRewardEvidence> } = {},
) {
  const stationResult = await pool.query(
    `SELECT station_id, owner_address, created_at
       FROM weather_stations
      WHERE station_id = $1 AND lower(owner_address) = lower($2)
      LIMIT 1`,
    [stationId, ownerAddress],
  );
  const station = stationResult.rows[0];
  if (!station) {
    throw new StationRewardProgressNotFound();
  }

  const cycleResult = await pool.query(
    `SELECT *
       FROM station_reward_cycles
      WHERE station_id = $1 AND lower(owner_address) = lower($2)
      ORDER BY observation_accepted_at DESC, cycle_id DESC
      LIMIT 1`,
    [stationId, ownerAddress],
  );
  const cycle = cycleResult.rows[0] ?? null;
  // Only consult the chain when the table has nothing for this station.
  const chainEvidence = !cycle && options.chainEvidence ? await options.chainEvidence(stationId) : null;
  return projectStationRewardProgress(station, cycle, now, chainEvidence);
}
