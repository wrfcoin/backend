import { createHash } from "node:crypto";
import type { Transaction } from "./claims.js";

export type Reading = {
  observedAt: string;
  temperatureC: number;
  humidityPct: number;
  pressureHpa: number;
};
const vector = (r: Reading) => [r.temperatureC, r.humidityPct, r.pressureHpa];
export function validateBridgeReading(r: Reading): void {
  if (
    !Number.isFinite(Date.parse(r.observedAt)) ||
    !vector(r).every(Number.isFinite) ||
    r.temperatureC < -100 ||
    r.temperatureC > 70 ||
    r.humidityPct < 0 ||
    r.humidityPct > 100 ||
    r.pressureHpa < 300 ||
    r.pressureHpa > 1200
  )
    throw new Error("INVALID_READING");
}
/** Matching timestamps and tolerance-bounded changing samples; flat weather alone cannot flag fraud. */
export function lockstep(a: Reading[], b: Reading[]): boolean {
  const pairs = a
    .map(
      (r) =>
        [
          r,
          b.find((s) => Date.parse(s.observedAt) === Date.parse(r.observedAt)),
        ] as const,
    )
    .filter((p): p is readonly [Reading, Reading] => !!p[1]);
  if (
    pairs.length < 12 ||
    new Set(pairs.map(([r]) => vector(r).join(","))).size < 3
  )
    return false;
  return pairs.every(([r, s]) =>
    vector(r).every((v, i) => Math.abs(v - vector(s)[i]) <= [0.1, 1, 0.2][i]),
  );
}

/** Isolated quarantine sink. Even verified fixtures never enter the signed-reading/reward path. */
export class BridgeObservations {
  constructor(
    private readonly transaction: Transaction,
    private readonly enabled: () => boolean,
  ) {}
  async ingest(claimId: string, reading: Reading) {
    if (!this.enabled()) throw new Error("BRIDGES_DISABLED");
    validateBridgeReading(reading);
    return this.transaction(async (db) => {
      await db.execute("SELECT pg_advisory_xact_lock(3570,0)");
      const claim = (
        await db.execute("SELECT * FROM bridge_claims WHERE id=$1 FOR UPDATE", [
          claimId,
        ])
      ).rows[0];
      if (!claim || ["revoked", "suspended"].includes(claim.state))
        throw new Error("CLAIM_UNAVAILABLE");
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(vector(reading)))
        .digest("hex");
      const inserted = await db.execute(
        `INSERT INTO bridge_observations(claim_id,feed_id,observed_at,values_json,fingerprint) VALUES ($1::uuid,$1::text,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
        [claimId, reading.observedAt, JSON.stringify(reading), fingerprint],
      );
      if (!inserted.rows.length)
        return { duplicate: true, held: true, rewardEligible: false };
      const history = (
        await db.execute(
          `SELECT * FROM bridge_observations WHERE observed_at BETWEEN $1::timestamptz-interval '24 hours' AND $1::timestamptz ORDER BY observed_at DESC LIMIT 10000`,
          [reading.observedAt],
        )
      ).rows;
      const exact = history.filter(
        (r) =>
          r.feed_id !== claimId &&
          r.fingerprint === fingerprint &&
          Date.parse(r.observed_at) === Date.parse(reading.observedAt),
      );
      const own = history
        .filter((r) => r.feed_id === claimId)
        .slice(0, 12)
        .map((r) => r.values_json as Reading);
      const others = [
        ...new Set(
          history
            .filter((r) => r.feed_id !== claimId)
            .map((r) => r.feed_id as string),
        ),
      ];
      const copied = others.filter((feed) =>
        lockstep(
          own,
          history
            .filter((r) => r.feed_id === feed)
            .map((r) => r.values_json as Reading),
        ),
      );
      if (exact.length || copied.length) {
        const ids = [
          claimId,
          ...exact.map((r) => r.claim_id).filter(Boolean),
          ...copied,
        ];
        await db.execute(
          "UPDATE bridge_claims SET state='suspended',reason='duplicate_feed' WHERE id=ANY($1::uuid[]) AND state<>'revoked'",
          [ids],
        );
        await db.execute(
          "INSERT INTO bridge_claim_audit(claim_id,event) VALUES ($1,'duplicate_feed')",
          [claimId],
        );
      }
      return {
        duplicate: exact.length > 0 || copied.length > 0,
        held: true,
        rewardEligible: false,
      };
    });
  }
}

/** Native precedence is independent of arrival order; bridge readings never displace native ones. */
export function preferNative<T extends { native: boolean }>(
  records: readonly T[],
): T[] {
  return records.some((r) => r.native)
    ? records.filter((r) => r.native)
    : [...records];
}
