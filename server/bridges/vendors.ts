import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Transaction } from "./claims.js";
import {
  identity,
  normalizeWallet,
  type OwnershipProofReader,
  type Source,
  type SourceProof,
} from "./proof.js";
import { validateBridgeReading, type Reading } from "./observations.js";

export type Vendor = "ambient" | "weatherlink" | "netatmo";
export const VENDOR_TERMS: Record<Vendor, "TOS-UNVERIFIED"> = {
  ambient: "TOS-UNVERIFIED",
  weatherlink: "TOS-UNVERIFIED",
  netatmo: "TOS-UNVERIFIED",
};
export type VendorCredentials = {
  apiKey?: string;
  applicationKey?: string;
  apiSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  scopes?: string[];
};
export class BridgeCredentialVault {
  constructor(
    private readonly transaction: Transaction,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error("INVALID_ENCRYPTION_KEY");
  }
  async put(
    walletRaw: string,
    claimId: string,
    credentials: VendorCredentials,
  ): Promise<void> {
    const wallet = normalizeWallet(walletRaw);
    await this.transaction(async (db) => {
      const claim = (
        await db.execute(
          "SELECT * FROM bridge_claims WHERE id=$1 AND wallet=$2 FOR UPDATE",
          [claimId, wallet],
        )
      ).rows[0];
      if (!claim || claim.state === "revoked")
        throw new Error("CLAIM_UNAVAILABLE");
      if (!["ambient", "weatherlink", "netatmo"].includes(claim.source))
        throw new Error("INVALID_VENDOR");
      const complete =
        claim.source === "ambient"
          ? credentials.apiKey && credentials.applicationKey
          : claim.source === "weatherlink"
            ? credentials.apiKey && credentials.apiSecret
            : credentials.accessToken &&
              credentials.scopes?.length === 1 &&
              credentials.scopes[0] === "read_station";
      if (!complete) throw new Error("READ_ONLY_CREDENTIALS_REQUIRED");
      const plaintext = JSON.stringify(credentials);
      if (plaintext.length > 16384) throw new Error("CREDENTIALS_TOO_LARGE");
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(
        Buffer.from(
          JSON.stringify([claimId, wallet, claim.source, claim.device_id]),
        ),
      );
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      await db.execute(
        `INSERT INTO bridge_vendor_credentials(claim_id,ciphertext,iv,tag) VALUES ($1,$2,$3,$4) ON CONFLICT(claim_id) DO UPDATE SET ciphertext=$2,iv=$3,tag=$4`,
        [
          claimId,
          ciphertext.toString("hex"),
          iv.toString("hex"),
          cipher.getAuthTag().toString("hex"),
        ],
      );
    });
  }
  async get(
    walletRaw: string,
    claimId: string,
  ): Promise<VendorCredentials | null> {
    const wallet = normalizeWallet(walletRaw);
    return this.transaction(async (db) => {
      const row = (
        await db.execute(
          `SELECT v.*,c.source,c.device_id FROM bridge_vendor_credentials v JOIN bridge_claims c ON c.id=v.claim_id WHERE c.id=$1 AND c.wallet=$2 AND c.state<>'revoked'`,
          [claimId, wallet],
        )
      ).rows[0];
      if (!row) return null;
      try {
        const cipher = createDecipheriv(
          "aes-256-gcm",
          this.key,
          Buffer.from(row.iv, "hex"),
        );
        cipher.setAAD(
          Buffer.from(
            JSON.stringify([claimId, wallet, row.source, row.device_id]),
          ),
        );
        cipher.setAuthTag(Buffer.from(row.tag, "hex"));
        return JSON.parse(
          Buffer.concat([
            cipher.update(Buffer.from(row.ciphertext, "hex")),
            cipher.final(),
          ]).toString("utf8"),
        ) as VendorCredentials;
      } catch {
        throw new Error("CREDENTIALS_UNAVAILABLE");
      }
    });
  }
  async suspendAndDelete(claimId: string): Promise<void> {
    await this.transaction(async (db) => {
      await db.execute(
        "DELETE FROM bridge_vendor_credentials WHERE claim_id=$1",
        [claimId],
      );
      await db.execute(
        "UPDATE bridge_claims SET state='suspended',reason='vendor_revoked' WHERE id=$1 AND state<>'revoked'",
        [claimId],
      );
    });
  }
}

/** Explicit fixture envelope: ownership evidence is not inferred from mere readable API data. */
export type VendorFixture = {
  vendor: Vendor;
  wallet: string;
  status: number;
  retryAfterSeconds?: number;
  devices: Array<{
    id: string;
    relationship: "owned" | "shared";
    hardwareKey: string;
  }>;
  payload?: unknown;
};
export interface VendorReadTransport {
  get(vendor: Vendor, credentials: VendorCredentials): Promise<VendorFixture>;
}
export class RecordedVendorTransport implements VendorReadTransport {
  constructor(private readonly fixtures: readonly VendorFixture[]) {}
  async get(
    vendor: Vendor,
    _credentials: VendorCredentials,
  ): Promise<VendorFixture> {
    const fixture = this.fixtures.find((f) => f.vendor === vendor);
    if (!fixture) throw new Error("FIXTURE_MISSING");
    return structuredClone(fixture);
  }
}

/** Fixture-only connector implements the proof reader used by the claim lifecycle. */
export class RecordedVendorConnectors implements OwnershipProofReader {
  private readonly nextAllowed = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly snapshots = new Map<string, VendorFixture>();
  constructor(
    private readonly deps: {
      enabled: () => boolean;
      transaction: Transaction;
      vault: BridgeCredentialVault;
      transport: VendorReadTransport;
      now: () => number;
    },
  ) {}
  async read(
    walletRaw: string,
    source: Source,
    deviceId: string,
  ): Promise<SourceProof | null> {
    if (
      !this.deps.enabled() ||
      !["ambient", "weatherlink", "netatmo"].includes(source)
    )
      return null;
    const wallet = normalizeWallet(walletRaw),
      vendor = source as Vendor,
      id = identity(source, deviceId).deviceId;
    const claim = await this.deps.transaction(
      async (db) =>
        (
          await db.execute(
            "SELECT id FROM bridge_claims WHERE wallet=$1 AND source=$2 AND device_id=$3 AND state<>$4",
            [wallet, source, id, "revoked"],
          )
        ).rows[0],
    );
    if (!claim) return null;
    const credentials = await this.deps.vault.get(wallet, claim.id);
    if (!credentials) return null;
    const now = this.deps.now(),
      key = wallet + ":" + vendor;
    if (now < (this.nextAllowed.get(key) ?? 0))
      throw new Error("VENDOR_BACKOFF");
    // Ten-second fixture polling is below the documented Ambient/WeatherLink per-key caps.
    this.nextAllowed.set(key, now + 10000);
    const response = await this.deps.transport.get(vendor, credentials);
    if (response.status === 429) {
      const failures = Math.min((this.failures.get(key) ?? 0) + 1, 8);
      this.failures.set(key, failures);
      const retry =
        Number.isFinite(response.retryAfterSeconds) &&
        response.retryAfterSeconds! > 0
          ? Math.min(response.retryAfterSeconds!, 3600) * 1000
          : 0;
      this.nextAllowed.set(
        key,
        now + Math.max(retry, Math.min(3600000, 10000 * 2 ** failures)),
      );
      throw new Error("VENDOR_BACKOFF");
    }
    if (response.status === 401 || response.status === 403) {
      await this.deps.vault.suspendAndDelete(claim.id);
      return {
        source,
        deviceId: id,
        wallet,
        owned: false,
        revoked: true,
        hardwareKey: "",
      };
    }
    if (
      response.status !== 200 ||
      response.wallet !== wallet ||
      response.vendor !== vendor
    )
      return null;
    this.failures.delete(key);
    const device = response.devices.find(
      (d) =>
        identity(source, d.id).deviceId === id && d.relationship === "owned",
    );
    if (!device) return null;
    this.snapshots.set(claim.id, response);
    return {
      source,
      deviceId: id,
      wallet,
      owned: true,
      revoked: false,
      hardwareKey: device.hardwareKey,
    };
  }

  async collect(
    wallet: string,
    vendor: Vendor,
    deviceId: string,
    ingest: (claimId: string, reading: Reading) => Promise<unknown>,
  ): Promise<void> {
    const proof = await this.read(wallet, vendor, deviceId);
    if (!proof?.owned || proof.revoked) throw new Error("PROOF_REQUIRED");
    const claim = await this.deps.transaction(
      async (db) =>
        (
          await db.execute(
            "SELECT id FROM bridge_claims WHERE wallet=$1 AND source=$2 AND device_id=$3 AND state='verified'",
            [normalizeWallet(wallet), vendor, proof.deviceId],
          )
        ).rows[0],
    );
    if (!claim) throw new Error("CLAIM_UNAVAILABLE");
    const snapshot = this.snapshots.get(claim.id);
    if (!snapshot) throw new Error("FIXTURE_MISSING");
    await ingest(
      claim.id,
      parseVendorReading(vendor, proof.deviceId, snapshot.payload),
    );
  }
}

/** Recorded response subset only. No missing values or missing device IDs become defaults. */
export function parseVendorReading(
  vendor: Vendor,
  deviceId: string,
  payload: unknown,
): Reading {
  const body = payload as any;
  let reading: Reading;
  if (vendor === "ambient") {
    const d = Array.isArray(body)
      ? body.find(
          (r: any) => identity("ambient", r.macAddress).deviceId === deviceId,
        )?.lastData
      : null;
    if (
      !d ||
      ![d.dateutc, d.tempf, d.humidity, d.baromabsin].every(Number.isFinite)
    )
      throw new Error("INVALID_READING");
    reading = {
      observedAt: new Date(d.dateutc).toISOString(),
      temperatureC: ((d.tempf - 32) * 5) / 9,
      humidityPct: d.humidity,
      pressureHpa: d.baromabsin * 33.8638866667,
    };
  } else if (vendor === "weatherlink") {
    if (!body || String(body.station_id_uuid).toLowerCase() !== deviceId)
      throw new Error("DEVICE_MISMATCH");
    const d = body.sensors
      ?.flatMap((s: any) => s.data ?? [])
      .find((r: any) =>
        [r.ts, r.temp, r.hum, r.bar_absolute].every(Number.isFinite),
      );
    if (!d) throw new Error("INVALID_READING");
    reading = {
      observedAt: new Date(d.ts * 1000).toISOString(),
      temperatureC: ((d.temp - 32) * 5) / 9,
      humidityPct: d.hum,
      pressureHpa: d.bar_absolute * 33.8638866667,
    };
  } else {
    const devices = body?.body?.devices;
    const module = Array.isArray(devices)
      ? devices
          .flatMap((d: any) => [d, ...(d.modules ?? [])])
          .find((m: any) => String(m._id).toLowerCase() === deviceId)
      : null;
    const d = module?.dashboard_data;
    if (
      !d ||
      ![d.time_utc, d.Temperature, d.Humidity, d.Pressure].every(
        Number.isFinite,
      )
    )
      throw new Error("INVALID_READING");
    reading = {
      observedAt: new Date(d.time_utc * 1000).toISOString(),
      temperatureC: d.Temperature,
      humidityPct: d.Humidity,
      pressureHpa: d.Pressure,
    };
  }
  validateBridgeReading(reading);
  return reading;
}
