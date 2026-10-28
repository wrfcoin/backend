import { createHash, randomUUID } from "node:crypto";
import { rateLimitKey } from "../utils/rate-limit-key.js";
import {
  identity,
  normalizeWallet,
  newCode,
  type Source,
  type LicenceLookup,
  type EmailSender,
  type OwnershipProofReader,
} from "./proof.js";

export interface Sql {
  execute(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, any>[] }>;
}
export type Transaction = <T>(fn: (db: Sql) => Promise<T>) => Promise<T>;
export type Claim = {
  id: string;
  wallet: string;
  source: Source;
  device_id: string;
  state: string;
  hardware_key: string | null;
  proof_mode: string;
};
const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const codeDigest = (
  id: string,
  wallet: string,
  source: string,
  device: string,
  code: string,
) => digest(JSON.stringify([id, wallet, source, device, code]));

/** All data is quarantined and fixture-only. No reward, signing or submission dependency. */
export class BridgeClaims {
  constructor(
    private readonly deps: {
      transaction: Transaction;
      enabled: () => boolean;
      licences: LicenceLookup;
      email: EmailSender;
      proofs: OwnershipProofReader;
    },
  ) {}

  private gate(): void {
    if (!this.deps.enabled()) throw new Error("BRIDGES_DISABLED");
  }
  private async audit(db: Sql, claimId: string, event: string): Promise<void> {
    await db.execute(
      "INSERT INTO bridge_claim_audit(claim_id,event) VALUES ($1,$2)",
      [claimId, event],
    );
  }
  private async limit(db: Sql, wallet: string, ip: string): Promise<boolean> {
    // Persistent across processes; expired counters reclaimed. Keys contain no raw personal identifiers.
    await db.execute(
      "DELETE FROM bridge_rate_windows WHERE expires_at < now()",
    );
    for (const key of ["wallet:" + wallet, "ip:" + rateLimitKey(ip)]) {
      const result = await db.execute(
        `INSERT INTO bridge_rate_windows(key_hash,hits,expires_at)
        VALUES ($1,1,now()+interval '15 minutes') ON CONFLICT(key_hash) DO UPDATE
        SET hits=bridge_rate_windows.hits+1 RETURNING hits`,
        [digest(key)],
      );
      if (result.rows[0].hits > 20) return false;
    }
    return true;
  }

  async issue(
    walletRaw: string,
    sourceRaw: unknown,
    deviceRaw: unknown,
    ip: string,
  ) {
    this.gate();
    const wallet = normalizeWallet(walletRaw);
    const { source, deviceId } = identity(sourceRaw, deviceRaw);
    const licence =
      source === "aprs" ? await this.deps.licences.lookup(deviceId) : null;
    const emailProof =
      licence?.country === "US" &&
      licence.current &&
      licence.callsign === deviceId &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(licence.email);
    const mode =
      source === "aprs"
        ? emailProof
          ? "licence_email"
          : "reference_only"
        : ["wu", "wow"].includes(source)
          ? "public_field"
          : "account";
    const code = newCode();
    const challengeId = randomUUID();
    const result = await this.deps.transaction(async (db) => {
      if (!(await this.limit(db, wallet, ip))) return { error: "RATE_LIMITED" };
      await db.execute("SELECT pg_advisory_xact_lock(3569,hashtext($1))", [
        source + ":" + deviceId,
      ]);
      const existing = (
        await db.execute(
          "SELECT * FROM bridge_claims WHERE source=$1 AND device_id=$2 FOR UPDATE",
          [source, deviceId],
        )
      ).rows[0] as Claim | undefined;
      if (existing && existing.wallet !== wallet)
        return { error: "DEVICE_CLAIMED" };
      if (existing?.state === "revoked" || existing?.state === "verified")
        return { error: "CLAIM_NOT_PENDING" };
      const claimId = existing?.id ?? randomUUID();
      if (!existing)
        await db.execute(
          "INSERT INTO bridge_claims(id,wallet,source,device_id,proof_mode) VALUES ($1,$2,$3,$4,$5)",
          [claimId, wallet, source, deviceId, mode],
        );
      await db.execute(
        "UPDATE bridge_challenges SET consumed_at=now() WHERE claim_id=$1 AND consumed_at IS NULL",
        [claimId],
      );
      await db.execute(
        `INSERT INTO bridge_challenges(id,claim_id,digest,licence_digest,expires_at) VALUES ($1,$2,$3,$4,now()+interval '10 minutes')`,
        [
          challengeId,
          claimId,
          codeDigest(challengeId, wallet, source, deviceId, code),
          emailProof && licence ? digest(JSON.stringify(licence)) : null,
        ],
      );
      await this.audit(db, claimId, "challenge_issued");
      return { claimId, challengeId, mode };
    });
    if ("error" in result) throw new Error(result.error);
    if (mode === "licence_email" && licence) {
      try {
        await this.deps.email.send(licence.email, code);
      } catch {
        await this.deps.transaction((db) =>
          db.execute(
            "UPDATE bridge_challenges SET consumed_at=now() WHERE id=$1",
            [challengeId],
          ),
        );
        throw new Error("DELIVERY_FAILED");
      }
    }
    // Never return the email code or licence address to the requester.
    return {
      ...result,
      ...(["public_field", "account"].includes(mode) ? { code } : {}),
      fixtureOnly: true,
      rewardEligible: false,
    };
  }

  async verify(
    walletRaw: string,
    challengeId: string,
    code: unknown,
    ip: string,
  ) {
    this.gate();
    const wallet = normalizeWallet(walletRaw);
    if (
      !/^[0-9a-f-]{36}$/.test(challengeId) ||
      typeof code !== "string" ||
      !/^[0-9a-f]{32}$/.test(code)
    )
      throw new Error("PROOF_REQUIRED");
    // Read the source outside the transaction; conditional state/expiry checks below close races.
    const claim = await this.deps.transaction(
      async (db) =>
        (
          await db.execute(
            `SELECT c.* FROM bridge_claims c JOIN bridge_challenges h ON h.claim_id=c.id WHERE h.id=$1 AND c.wallet=$2`,
            [challengeId, wallet],
          )
        ).rows[0] as Claim | undefined,
    );
    if (!claim) throw new Error("PROOF_REQUIRED");
    const proof =
      claim.source === "aprs"
        ? null
        : await this.deps.proofs.read(wallet, claim.source, claim.device_id);
    const licence =
      claim.source === "aprs"
        ? await this.deps.licences.lookup(claim.device_id)
        : null;
    const result = await this.deps.transaction(async (db) => {
      if (!(await this.limit(db, wallet, ip))) return "RATE_LIMITED";
      // Serialize all identity decisions, including aliases in different source namespaces.
      await db.execute("SELECT pg_advisory_xact_lock(3569,0)");
      const locked = (
        await db.execute("SELECT * FROM bridge_claims WHERE id=$1 FOR UPDATE", [
          claim.id,
        ])
      ).rows[0] as Claim;
      const challenge = (
        await db.execute(
          "SELECT *, expires_at>now() AS fresh FROM bridge_challenges WHERE id=$1 FOR UPDATE",
          [challengeId],
        )
      ).rows[0];
      if (
        locked.state === "revoked" ||
        locked.state === "verified" ||
        !challenge?.fresh ||
        challenge.consumed_at ||
        challenge.attempts >= 5
      )
        return "CHALLENGE_EXPIRED_OR_USED";
      await db.execute(
        "UPDATE bridge_challenges SET attempts=attempts+1 WHERE id=$1",
        [challengeId],
      );
      if (
        challenge.digest !==
        codeDigest(challengeId, wallet, claim.source, claim.device_id, code)
      ) {
        await this.audit(db, claim.id, "proof_refused");
        return "PROOF_REQUIRED";
      }
      let hardwareKey: string;
      if (claim.source === "aprs") {
        if (
          locked.proof_mode !== "licence_email" ||
          !licence?.current ||
          licence.country !== "US"
        )
          return "REFERENCE_ONLY";
        if (challenge.licence_digest !== digest(JSON.stringify(licence)))
          return "LICENCE_CHANGED";
        // Licence email binds a callsign, not a physical device; retain isolated fixture-only scope.
        hardwareKey = "licence:US:" + claim.device_id;
      } else {
        if (proof?.revoked) {
          await db.execute(
            "UPDATE bridge_claims SET state='suspended',reason='vendor_revoked' WHERE id=$1",
            [claim.id],
          );
          return "VENDOR_REVOKED";
        }
        if (
          !proof?.owned ||
          proof.wallet !== wallet ||
          proof.source !== claim.source ||
          proof.deviceId !== claim.device_id ||
          !/^[a-zA-Z0-9:_-]{1,160}$/.test(proof.hardwareKey)
        )
          return "PROOF_REQUIRED";
        if (locked.proof_mode === "public_field" && proof.observedCode !== code)
          return "PROOF_REQUIRED";
        hardwareKey = proof.hardwareKey;
        if (
          claim.source === "ambient" &&
          hardwareKey !== "mac:" + claim.device_id
        )
          return "PROOF_REQUIRED";
      }
      const collision = await db.execute(
        "SELECT id FROM bridge_claims WHERE hardware_key=$1 AND id<>$2",
        [hardwareKey, claim.id],
      );
      if (collision.rows.length) return "DEVICE_CLAIMED";
      if (hardwareKey.startsWith("mac:")) {
        const mac = hardwareKey.slice(4);
        await db.execute("SELECT pg_advisory_xact_lock(1261,hashtext($1))", [
          mac,
        ]);
        const native = await db.execute(
          `SELECT station_id FROM weather_stations WHERE is_active=true AND regexp_replace(lower(btrim(metadata->>'mac')),'[^0-9a-f]','','g')=$1 LIMIT 1`,
          [mac],
        );
        if (native.rows.length) return "DEVICE_CLAIMED";
      }
      await db.execute(
        "UPDATE bridge_claims SET state='verified',hardware_key=$2,verified_at=now(),reason=NULL WHERE id=$1",
        [claim.id, hardwareKey],
      );
      await db.execute(
        "UPDATE bridge_challenges SET consumed_at=now() WHERE id=$1",
        [challengeId],
      );
      await this.audit(db, claim.id, "fixture_verified");
      return "verified";
    });
    if (result !== "verified") throw new Error(result);
    return { state: result, fixtureOnly: true, rewardEligible: false };
  }

  async status(walletRaw: string, claimId: string) {
    this.gate();
    const wallet = normalizeWallet(walletRaw);
    const row = await this.deps.transaction(
      async (db) =>
        (
          await db.execute(
            "SELECT id,source,device_id,state,reason FROM bridge_claims WHERE id=$1 AND wallet=$2",
            [claimId, wallet],
          )
        ).rows[0],
    );
    if (!row) throw new Error("NOT_FOUND");
    return { ...row, fixtureOnly: true, rewardEligible: false };
  }

  async revoke(walletRaw: string, claimId: string): Promise<void> {
    this.gate();
    const wallet = normalizeWallet(walletRaw);
    await this.deps.transaction(async (db) => {
      const rows = await db.execute(
        "UPDATE bridge_claims SET state='revoked',reason='owner_disconnect' WHERE id=$1 AND wallet=$2 RETURNING id",
        [claimId, wallet],
      );
      if (!rows.rows.length) throw new Error("NOT_FOUND");
      await db.execute(
        "DELETE FROM bridge_vendor_credentials WHERE claim_id=$1",
        [claimId],
      );
      await db.execute(
        "UPDATE bridge_challenges SET consumed_at=now() WHERE claim_id=$1",
        [claimId],
      );
      await this.audit(db, claimId, "revoked");
    });
  }

  async reverify(claimId: string): Promise<void> {
    this.gate();
    const claim = await this.deps.transaction(
      async (db) =>
        (await db.execute("SELECT * FROM bridge_claims WHERE id=$1", [claimId]))
          .rows[0] as Claim | undefined,
    );
    if (!claim || claim.state !== "verified") return;
    let proof;
    try {
      proof =
        claim.source === "aprs"
          ? null
          : await this.deps.proofs.read(
              claim.wallet,
              claim.source,
              claim.device_id,
            );
    } catch {
      proof = null;
    }
    if (
      !proof ||
      proof.revoked ||
      !proof.owned ||
      proof.hardwareKey !== claim.hardware_key ||
      proof.wallet !== claim.wallet ||
      proof.source !== claim.source ||
      proof.deviceId !== claim.device_id
    ) {
      await this.deps.transaction(async (db) => {
        await db.execute(
          "UPDATE bridge_claims SET state='suspended',reason='reverification_required' WHERE id=$1 AND state='verified'",
          [claimId],
        );
        await this.audit(db, claimId, "suspended");
      });
    }
  }
}
