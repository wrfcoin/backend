import type { Transaction } from "./claims.js";
import { normalizeWallet, type Source } from "./proof.js";
import { validateBridgeReading, type Reading } from "./observations.js";

/** Only implementation: no live MADIS client or public transmission exists. */
export class DryRunMadisForwarder {
  private readonly recorded: Array<{
    observationId: string;
    reading: Reading;
  }> = [];
  async record(observationId: string, reading: Reading): Promise<void> {
    this.recorded.push({ observationId, reading: { ...reading } });
  }
  count(): number {
    return this.recorded.length;
  }
}
export class BridgeForwarding {
  constructor(
    private readonly deps: {
      transaction: Transaction;
      enabled: () => boolean;
      sink: DryRunMadisForwarder;
      redistribution: (
        source: Source,
      ) => "allowed" | "forbidden" | "unverified";
      tierPpm: (claimId: string) => Promise<number>;
      thresholdPpm: number;
    },
  ) {
    if (
      !Number.isSafeInteger(deps.thresholdPpm) ||
      deps.thresholdPpm < 1 ||
      deps.thresholdPpm > 1000000
    )
      throw new Error("INVALID_THRESHOLD");
  }
  async optIn(
    walletRaw: string,
    claimId: string,
    optedIn: boolean,
  ): Promise<void> {
    const wallet = normalizeWallet(walletRaw);
    if (typeof optedIn !== "boolean") throw new Error("INVALID_PREFERENCE");
    await this.deps.transaction(async (db) => {
      const claim = (
        await db.execute(
          "SELECT id FROM bridge_claims WHERE id=$1 AND wallet=$2 FOR UPDATE",
          [claimId, wallet],
        )
      ).rows[0];
      if (!claim) throw new Error("NOT_FOUND");
      await db.execute(
        "INSERT INTO bridge_forwarding_preferences(claim_id,opted_in) VALUES ($1,$2) ON CONFLICT(claim_id) DO UPDATE SET opted_in=$2",
        [claimId, optedIn],
      );
    });
  }
  async forward(observationId: string): Promise<string> {
    if (!this.deps.enabled()) return "disabled";
    return this.deps.transaction(async (db) => {
      const row = (
        await db.execute(
          `SELECT o.*,c.state,c.source,p.opted_in FROM bridge_observations o JOIN bridge_claims c ON c.id=o.claim_id LEFT JOIN bridge_forwarding_preferences p ON p.claim_id=c.id WHERE o.id=$1 FOR UPDATE OF o,c`,
          [observationId],
        )
      ).rows[0];
      if (!row) throw new Error("NOT_FOUND");
      let decision = "dry_run";
      if (!row.opted_in) decision = "opted_out";
      else if (row.state !== "verified" || row.held)
        decision = "unverified_or_held";
      else if (this.deps.redistribution(row.source) !== "allowed")
        decision = "redistribution_blocked";
      else {
        const tier = await this.deps.tierPpm(row.claim_id);
        if (
          !Number.isSafeInteger(tier) ||
          tier < this.deps.thresholdPpm ||
          tier > 1000000
        )
          decision = "below_threshold";
      }
      const audit = await db.execute(
        "INSERT INTO bridge_forwarding_audit(observation_id,decision) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id",
        [observationId, decision],
      );
      if (decision === "dry_run" && audit.rows.length) {
        validateBridgeReading(row.values_json);
        await this.deps.sink.record(observationId, row.values_json);
      }
      return decision;
    });
  }
}
