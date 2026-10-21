import { readFileSync } from "node:fs";

jest.mock(
  "../database/index.js",
  () => ({
    executeQuery: jest.fn(),
  }),
  { virtual: true },
);

import {
  getStationRewardProgress,
  projectStationRewardProgress,
  StationRewardProgressNotFound,
  type RewardProgressPool,
} from "../server/services/station-reward-progress.js";
import { persistWeatherSubmission } from "../server/services/weather-submission-persistence.js";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const OWNER = "0xowner";
const STATION = {
  station_id: "station-2456",
  owner_address: OWNER,
  created_at: "2026-07-28T10:00:00.000Z",
};

function observationCycle(overrides: Record<string, unknown> = {}) {
  return {
    cycle_id: "weather-submission:42",
    station_id: STATION.station_id,
    owner_address: OWNER,
    observation_id: "42",
    observation_digest: "a".repeat(64),
    observation_observed_at: "2026-07-28T11:55:00.000Z",
    observation_accepted_at: "2026-07-28T11:55:01.000Z",
    lifecycle_state: "OBSERVATION_RECEIVED",
    failure_code: null,
    stalled_since: null,
    evidence_refreshed_at: "2026-07-28T11:59:00.000Z",
    ...overrides,
  };
}

function chainCycle(overrides: Record<string, unknown> = {}) {
  return observationCycle({
    lifecycle_state: "VERIFYING",
    network_id: "testnet",
    chain_id: "777",
    genesis_hash: `0x${"b".repeat(64)}`,
    commit_id: `0x${"c".repeat(64)}`,
    commit_mined_height: "101",
    commit_mined_hash: `0x${"d".repeat(64)}`,
    approvals: 1,
    rejections: 0,
    required_quorum: 2,
    ...overrides,
  });
}

describe("station reward progress evidence projection", () => {
  it("registration without a cycle remains awaiting observation with no reward", () => {
    const progress = projectStationRewardProgress(STATION, null, NOW);

    expect(progress.registration.state).toBe("REGISTERED");
    expect(progress.state).toBe("AWAITING_OBSERVATION");
    expect(progress.observation).toBeNull();
    expect(progress.contribution).toBeNull();
    expect(progress.reward).toBeNull();
  });

  it("a durable canonical cycle advances only to observation received", () => {
    const progress = projectStationRewardProgress(
      STATION,
      observationCycle(),
      NOW,
    );

    expect(progress.state).toBe("OBSERVATION_RECEIVED");
    expect(progress.observation).toMatchObject({
      id: "42",
      digest: "a".repeat(64),
      observedAt: "2026-07-28T11:55:00.000Z",
    });
    expect(progress.reward).toBeNull();
  });

  it("an observation without its canonical digest fails closed", () => {
    const progress = projectStationRewardProgress(
      STATION,
      observationCycle({ observation_digest: null }),
      NOW,
    );

    expect(progress.state).toBe("UNKNOWN");
    expect(progress.evidenceFresh).toBe(false);
    expect(progress.reward).toBeNull();
  });

  it("one mined approval reports verifying without claiming a reward", () => {
    const progress = projectStationRewardProgress(STATION, chainCycle(), NOW);

    expect(progress.state).toBe("VERIFYING");
    expect(progress.contribution).toMatchObject({
      approvals: 1,
      requiredQuorum: 2,
      commitMinedHeight: 101,
    });
    expect(progress.reward).toBeNull();
  });

  it("a claimed rewarded state without exact block/account evidence fails closed", () => {
    const progress = projectStationRewardProgress(
      STATION,
      chainCycle({
        lifecycle_state: "REWARDED",
        approvals: 2,
        quorum_mined_at: "2026-07-28T11:57:00.000Z",
      }),
      NOW,
    );

    expect(progress.state).toBe("UNKNOWN");
    expect(progress.evidenceFresh).toBe(false);
    expect(progress.reward).toBeNull();
    expect(progress.diagnostic?.code).toBe("REWARD_MISSING");
  });

  it("advances to rewarded only with exact nonzero reward and reconciled account credit", () => {
    const commitId = `0x${"c".repeat(64)}`;
    const progress = projectStationRewardProgress(
      STATION,
      chainCycle({
        lifecycle_state: "REWARDED",
        approvals: 2,
        quorum_mined_at: "2026-07-28T11:57:00.000Z",
        reveal_mined_height: "102",
        reveal_mined_hash: `0x${"e".repeat(64)}`,
        reward_amount_base_units: "25",
        reward_address: OWNER,
        reward_reason: `contribution:${commitId}`,
        reward_block_height: "102",
        reward_block_hash: `0x${"e".repeat(64)}`,
        reward_block_time: "2026-07-28T11:58:00.000Z",
        account_earned_before: "100",
        account_earned_after: "125",
        finality_policy: "BFT",
        authoritative_finalized_height: "102",
        canonical_hash_checked_at: "2026-07-28T11:58:30.000Z",
        finalized_at: "2026-07-28T11:59:00.000Z",
      }),
      NOW,
    );

    expect(progress.state).toBe("REWARDED");
    expect(progress.reward).toMatchObject({
      amountBaseUnits: "25",
      address: OWNER,
      reason: `contribution:${commitId}`,
      blockHeight: 102,
      accountEarnedAfter: "125",
      finalityPolicy: "BFT",
      authoritativeFinalizedHeight: 102,
    });
  });

  it("wrong reward reason or stale chain evidence cannot render rewarded", () => {
    const complete = chainCycle({
      lifecycle_state: "REWARDED",
      approvals: 2,
      quorum_mined_at: "2026-07-28T11:57:00.000Z",
      reveal_mined_height: "102",
      reveal_mined_hash: `0x${"e".repeat(64)}`,
      reward_amount_base_units: "25",
      reward_address: OWNER,
      reward_reason: "contribution:wrong",
      reward_block_height: "102",
      reward_block_hash: `0x${"e".repeat(64)}`,
      reward_block_time: "2026-07-28T11:58:00.000Z",
      account_earned_before: "100",
      account_earned_after: "125",
      finality_policy: "BFT",
      authoritative_finalized_height: "102",
      canonical_hash_checked_at: "2026-07-28T11:58:30.000Z",
      finalized_at: "2026-07-28T11:59:00.000Z",
    });
    expect(projectStationRewardProgress(STATION, complete, NOW).state).toBe(
      "UNKNOWN",
    );

    const stale = {
      ...complete,
      reward_reason: `contribution:${complete.commit_id}`,
      evidence_refreshed_at: "2026-07-28T11:00:00.000Z",
    };
    const staleProgress = projectStationRewardProgress(STATION, stale, NOW);
    expect(staleProgress.state).toBe("UNKNOWN");
    expect(staleProgress.diagnostic?.code).toBe("CORE_UNAVAILABLE");

    const future = {
      ...complete,
      reward_reason: `contribution:${complete.commit_id}`,
      evidence_refreshed_at: "2026-07-28T12:01:00.000Z",
    };
    const futureProgress = projectStationRewardProgress(STATION, future, NOW);
    expect(futureProgress.state).toBe("UNKNOWN");
    expect(futureProgress.diagnostic?.code).toBe("CORE_UNAVAILABLE");
  });

  it("wrong reward address or insufficient finalized height cannot render rewarded", () => {
    const complete = chainCycle({
      lifecycle_state: "REWARDED",
      approvals: 2,
      quorum_mined_at: "2026-07-28T11:57:00.000Z",
      reveal_mined_height: "102",
      reveal_mined_hash: `0x${"e".repeat(64)}`,
      reward_amount_base_units: "25",
      reward_address: OWNER,
      reward_reason: `contribution:${`0x${"c".repeat(64)}`}`,
      reward_block_height: "102",
      reward_block_hash: `0x${"e".repeat(64)}`,
      reward_block_time: "2026-07-28T11:58:00.000Z",
      account_earned_before: "100",
      account_earned_after: "125",
      finality_policy: "BFT",
      authoritative_finalized_height: "102",
      canonical_hash_checked_at: "2026-07-28T11:58:30.000Z",
      finalized_at: "2026-07-28T11:59:00.000Z",
    });

    expect(
      projectStationRewardProgress(
        STATION,
        { ...complete, reward_address: "0xwrong" },
        NOW,
      ).state,
    ).toBe("UNKNOWN");
    expect(
      projectStationRewardProgress(
        STATION,
        { ...complete, authoritative_finalized_height: "101" },
        NOW,
      ).state,
    ).toBe("UNKNOWN");
  });

  it("queries by both authenticated owner and station and hides non-owned rows", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool: RewardProgressPool = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [] };
      }),
    };

    await expect(
      getStationRewardProgress(pool, STATION.station_id, OWNER, NOW),
    ).rejects.toBeInstanceOf(StationRewardProgressNotFound);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain(
      "WHERE station_id = $1 AND lower(owner_address) = lower($2)",
    );
    expect(calls[0].params).toEqual([STATION.station_id, OWNER]);
  });

  it("matches a MIXED-case stored owner for a lowercase (ed25519) caller, both queries", async () => {
    const MIXED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    const LOWER = MIXED.toLowerCase();
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const stored = { ...STATION, owner_address: MIXED };
    const cycle = observationCycle({ owner_address: MIXED });
    // Row-backed: evaluates the owner predicate as Postgres would for the SQL
    // actually sent, so exact equality would hide the owner's own station.
    const matches = (sql: string, row: { owner_address: string }, want: unknown) =>
      /lower\(owner_address\) = lower\(\$2\)/.test(sql)
        ? row.owner_address.toLowerCase() === String(want).toLowerCase()
        : row.owner_address === want;
    const pool: RewardProgressPool = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("FROM weather_stations")) {
          return { rows: matches(sql, stored, params[1]) ? [stored] : [] };
        }
        if (sql.includes("FROM station_reward_cycles")) {
          return { rows: matches(sql, cycle, params[1]) ? [cycle] : [] };
        }
        return { rows: [] };
      }),
    };

    const progress = await getStationRewardProgress(pool, STATION.station_id, LOWER, NOW);
    expect(calls).toHaveLength(2);
    // The cycle row was found (not the no-cycle projection).
    expect(progress.state).toBe("OBSERVATION_RECEIVED");
  });

  it("reward address vs owner comparison is case-insensitive but still rejects a different address", () => {
    const MIXED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    const complete = chainCycle({
      owner_address: MIXED,
      lifecycle_state: "REWARDED",
      approvals: 2,
      quorum_mined_at: "2026-07-28T11:57:00.000Z",
      reveal_mined_height: "102",
      reveal_mined_hash: `0x${"e".repeat(64)}`,
      reward_amount_base_units: "25",
      reward_address: MIXED.toLowerCase(),
      reward_reason: `contribution:${`0x${"c".repeat(64)}`}`,
      reward_block_height: "102",
      reward_block_hash: `0x${"e".repeat(64)}`,
      reward_block_time: "2026-07-28T11:58:00.000Z",
      account_earned_before: "100",
      account_earned_after: "125",
      finality_policy: "BFT",
      authoritative_finalized_height: "102",
      canonical_hash_checked_at: "2026-07-28T11:58:30.000Z",
      finalized_at: "2026-07-28T11:59:00.000Z",
    });
    expect(projectStationRewardProgress(STATION, complete, NOW).state).toBe("REWARDED");
    expect(
      projectStationRewardProgress(STATION, { ...complete, reward_address: "0x" + "9".repeat(40) }, NOW).state,
    ).toBe("UNKNOWN");
    expect(
      projectStationRewardProgress(STATION, { ...complete, reward_address: null }, NOW).state,
    ).toBe("UNKNOWN");
  });

  it("migration keeps lineage durable and monetary fields integer-safe", () => {
    const migration = readFileSync(
      "drizzle/migrations/0016_station_reward_progress.sql",
      "utf8",
    );
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "station_reward_cycles"',
    );
    expect(migration).toContain('"owner_address"              text NOT NULL');
    expect(migration).toContain('"observation_digest"         text NOT NULL');
    expect(migration).toContain('"reward_amount_base_units"   text');
    expect(migration).toContain('"reward_address"             text');
    expect(migration).toContain('"finality_policy"            text');
    expect(migration).toContain(
      '"authoritative_finalized_height" bigint',
    );
    expect(migration).toContain('"station_reward_cycle_events"');
    const journal = readFileSync(
      "drizzle/migrations/meta/_journal.json",
      "utf8",
    );
    expect(journal).toContain('"tag": "0016_station_reward_progress"');
    expect(migration).not.toMatch(
      /reward_amount_base_units[^\\n]*(real|numeric|double)/i,
    );
  });

  it("canonical observation persistence atomically creates the owner-bound cycle", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const execute = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return {
        rows: [
          {
            id: 42,
            submitted_at: "2026-07-28T11:55:01.000Z",
            reward_cycle_created: true,
          },
        ],
      };
    });

    const persisted = await persistWeatherSubmission(
      {
        stationId: STATION.station_id,
        timestamp: "2026-07-28T11:55:00.000Z",
        temperature: 21.5,
        humidity: 55,
        windDirection: 0,
        transportMeta: {
          walletAddress: "untrusted-request-wallet",
          source: "ambient",
        },
      },
      { execute },
    );

    expect(persisted.submissionId).toBe(42);
    expect(calls).toHaveLength(2);
    const write = calls[1];
    expect(write.sql).toContain("INSERT INTO weather_submissions");
    expect(write.sql).toContain("INSERT INTO station_reward_cycles");
    expect(write.sql).toContain("station.owner_address");
    expect(write.sql).toContain("JOIN weather_stations station");
    expect(write.params[18]).toMatch(/^[0-9a-f]{64}$/);
    expect(write.params).not.toContain("owner_address");
  });
});
