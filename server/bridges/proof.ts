import { randomBytes } from "node:crypto";

export type Source =
  "ambient" | "weatherlink" | "netatmo" | "wu" | "wow" | "aprs";
export type Licence = {
  callsign: string;
  country: string;
  email: string;
  current: boolean;
};
export interface LicenceLookup {
  lookup(callsign: string): Promise<Licence | null>;
}
export interface EmailSender {
  send(address: string, code: string): Promise<void>;
}

/** Test transport only: never logs, opens a socket, or sends real mail. */
export class DryRunEmailSender implements EmailSender {
  private deliveries: Array<{ address: string; code: string }> = [];
  async send(address: string, code: string): Promise<void> {
    this.deliveries.push({ address, code });
  }
  takeForTest(): Array<{ address: string; code: string }> {
    return this.deliveries.splice(0);
  }
}

/** No network lookup implementation exists. Do not feed user-submitted records here. */
export class RecordedLicenceLookup implements LicenceLookup {
  constructor(private readonly records: readonly Licence[]) {}
  async lookup(callsign: string): Promise<Licence | null> {
    const record = this.records.find((r) => r.callsign === callsign);
    return record ? { ...record } : null;
  }
}

export interface SourceProof {
  source: Source;
  deviceId: string;
  wallet: string;
  owned: boolean;
  revoked: boolean;
  /** Authenticated physical identity, NEVER taken from request JSON. */
  hardwareKey: string;
  /** Public-account fields must be read independently from the controlled source. */
  observedCode?: string;
}
export interface OwnershipProofReader {
  read(
    wallet: string,
    source: Source,
    deviceId: string,
  ): Promise<SourceProof | null>;
}

export class RecordedOwnershipProofReader implements OwnershipProofReader {
  constructor(private readonly records: readonly SourceProof[]) {}
  async read(
    wallet: string,
    source: Source,
    deviceId: string,
  ): Promise<SourceProof | null> {
    const record = this.records.find(
      (r) =>
        r.wallet === wallet && r.source === source && r.deviceId === deviceId,
    );
    return record ? { ...record } : null;
  }
}

export function identity(
  source: unknown,
  raw: unknown,
): { source: Source; deviceId: string } {
  if (
    !["ambient", "weatherlink", "netatmo", "wu", "wow", "aprs"].includes(
      String(source),
    ) ||
    typeof raw !== "string"
  ) {
    throw new Error("INVALID_IDENTITY");
  }
  let deviceId = raw.trim();
  if (source === "ambient") {
    if (
      !/^(?:[0-9a-fA-F]{12}|(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}|(?:[0-9a-fA-F]{2}-){5}[0-9a-fA-F]{2})$/.test(
        deviceId,
      )
    )
      throw new Error("INVALID_IDENTITY");
    deviceId = deviceId.replace(/[:-]/g, "").toLowerCase();
  } else if (source === "aprs") {
    if (!/^[A-Z0-9]{3,9}(?:-(?:[0-9]|1[0-5]))?$/i.test(deviceId))
      throw new Error("INVALID_IDENTITY");
    deviceId = deviceId.toUpperCase().split("-")[0];
  } else {
    if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(deviceId))
      throw new Error("INVALID_IDENTITY");
    if (source === "weatherlink" || source === "netatmo")
      deviceId = deviceId.toLowerCase();
  }
  return { source: source as Source, deviceId };
}

export function normalizeWallet(wallet: string): string {
  if (!/^(0x|wrf)[a-fA-F0-9]{40}$/.test(wallet))
    throw new Error("AUTH_REQUIRED");
  return wallet.toLowerCase();
}
export function newCode(): string {
  return randomBytes(16).toString("hex");
}
