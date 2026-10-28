import {
  test,
  before as beforeAll,
  after as afterAll,
  beforeEach,
} from "node:test";
import { expect } from "expect";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { BridgeClaims, type Transaction } from "../../server/bridges/claims.js";
import {
  BridgeObservations,
  lockstep,
  preferNative,
  type Reading,
} from "../../server/bridges/observations.js";
import {
  BridgeCredentialVault,
  RecordedVendorConnectors,
  RecordedVendorTransport,
  type VendorFixture,
} from "../../server/bridges/vendors.js";
import {
  BridgeForwarding,
  DryRunMadisForwarder,
} from "../../server/bridges/forwarding.js";
import {
  DryRunEmailSender,
  RecordedLicenceLookup,
  RecordedOwnershipProofReader,
  identity,
  type SourceProof,
  type Licence,
} from "../../server/bridges/proof.js";

const wallet = "0x" + "a".repeat(40),
  other = "0x" + "b".repeat(40);
const ip = "192.0.2.1";
let db: PGlite, tx: Transaction, service: BridgeClaims, mail: DryRunEmailSender;
let records: SourceProof[], licences: Licence[], enabled: boolean;
const migration = readFileSync(
  "drizzle/migrations/0036_bridge_claims.sql",
  "utf8",
);
const rollback = readFileSync(
  "drizzle/rollback/0036_bridge_claims.sql",
  "utf8",
);
beforeAll(async () => {
  const release = "node_modules/@electric-sql/pglite/dist/";
  db = new PGlite({
    fsBundle: new Blob([readFileSync(release + "pglite.data")]),
    pgliteWasmModule: new WebAssembly.Module(
      readFileSync(release + "pglite.wasm"),
    ),
    initdbWasmModule: new WebAssembly.Module(
      readFileSync(release + "initdb.wasm"),
    ),
  });
  await db.exec(
    "CREATE TABLE weather_stations(station_id text PRIMARY KEY,metadata jsonb,is_active boolean)",
  );
  await db.exec(migration);
  tx = (fn) =>
    db.transaction(async (t) =>
      fn({
        execute: async (sql, params = []) => ({
          rows: (await t.query(sql, [...params])).rows as any[],
        }),
      }),
    );
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec(
    "TRUNCATE bridge_claims,bridge_challenges,bridge_observations,bridge_claim_audit,bridge_rate_windows,weather_stations CASCADE",
  );
  enabled = true;
  records = [];
  licences = JSON.parse(
    readFileSync("__tests__/bridges/fixtures/licences.json", "utf8"),
  );
  mail = new DryRunEmailSender();
  service = new BridgeClaims({
    transaction: tx,
    enabled: () => enabled,
    email: mail,
    licences: new RecordedLicenceLookup(licences),
    proofs: new RecordedOwnershipProofReader(records),
  });
});
const issue = (
  source = "ambient",
  device = "aa:bb:cc:dd:ee:01",
  who = wallet,
) => service.issue(who, source, device, ip);
async function owned(
  source: SourceProof["source"] = "ambient",
  device = "aabbccddee01",
  key = "mac:aabbccddee01",
) {
  records.push({
    source,
    deviceId: device,
    wallet,
    owned: true,
    revoked: false,
    hardwareKey: key,
  });
  const c = await issue(source, device);
  await service.verify(wallet, c.challengeId!, c.code, ip);
  return c;
}
test("flag off refuses before creating state or delivering email", async () => {
  enabled = false;
  await expect(issue("aprs", "K0TST")).rejects.toThrow("BRIDGES_DISABLED");
  expect(mail.takeForTest()).toEqual([]);
  expect((await db.query("SELECT * FROM bridge_claims")).rows).toHaveLength(0);
});
for (const source of ["ambient", "weatherlink", "netatmo", "wu", "wow"])
  test(
    source + " public identifier and returned nonce alone do not verify",
    async () => {
      const c = await issue(
        source,
        source === "ambient" ? "aabbccddee01" : "device-01",
      );
      await expect(
        service.verify(wallet, c.challengeId!, c.code, ip),
      ).rejects.toThrow("PROOF_REQUIRED");
    },
  );
test("APRS licence-email code is not returned; passcode or status nonce alone fails", async () => {
  const c = await issue("aprs", "K0TST-2");
  expect(c).not.toHaveProperty("code");
  expect(c).not.toHaveProperty("email");
  await expect(
    service.verify(wallet, c.challengeId!, "12345", ip),
  ).rejects.toThrow("PROOF_REQUIRED");
  await expect(
    service.verify(wallet, c.challengeId!, "0".repeat(32), ip),
  ).rejects.toThrow("PROOF_REQUIRED");
  const deliveries = mail.takeForTest();
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].address).toBe("licensee@example.invalid");
  expect(
    await service.verify(wallet, c.challengeId!, deliveries[0].code, ip),
  ).toEqual({ state: "verified", fixtureOnly: true, rewardEligible: false });
});
test("email proof is wallet bound and single use", async () => {
  const c = await issue("aprs", "K0TST");
  const code = mail.takeForTest()[0].code;
  await expect(service.verify(other, c.challengeId!, code, ip)).rejects.toThrow(
    "PROOF_REQUIRED",
  );
  await service.verify(wallet, c.challengeId!, code, ip);
  await expect(
    service.verify(wallet, c.challengeId!, code, ip),
  ).rejects.toThrow("CHALLENGE_EXPIRED_OR_USED");
});
test("expired challenge cannot verify", async () => {
  const c = await issue("aprs", "K0TST");
  const code = mail.takeForTest()[0].code;
  await db.query(
    "UPDATE bridge_challenges SET expires_at=now()-interval '1 second'",
  );
  await expect(
    service.verify(wallet, c.challengeId!, code, ip),
  ).rejects.toThrow("CHALLENGE_EXPIRED_OR_USED");
});
test("reissue invalidates old challenge and code", async () => {
  const first = await issue("aprs", "K0TST");
  const old = mail.takeForTest()[0].code;
  const second = await issue("aprs", "K0TST");
  const fresh = mail.takeForTest()[0].code;
  await expect(
    service.verify(wallet, first.challengeId!, old, ip),
  ).rejects.toThrow("CHALLENGE_EXPIRED_OR_USED");
  await expect(
    service.verify(wallet, second.challengeId!, old, ip),
  ).rejects.toThrow("PROOF_REQUIRED");
  await service.verify(wallet, second.challengeId!, fresh, ip);
});
test("changed licence mailbox invalidates issued challenge", async () => {
  const c = await issue("aprs", "K0TST");
  const code = mail.takeForTest()[0].code;
  licences[0].email = "changed@example.invalid";
  await expect(
    service.verify(wallet, c.challengeId!, code, ip),
  ).rejects.toThrow("LICENCE_CHANGED");
});
for (const callsign of ["VE0TST", "W0OLD", "N0NONE"])
  test(callsign + " has no licence-email path", async () => {
    const c = await issue("aprs", callsign);
    expect(c.mode).toBe("reference_only");
    expect(mail.takeForTest()).toEqual([]);
    await expect(
      service.verify(wallet, c.challengeId!, "0".repeat(32), ip),
    ).rejects.toThrow();
    expect((await service.status(wallet, c.claimId!)).state).toBe("pending");
  });
test("SSID aliases share one callsign claim; MAC aliases share one device", async () => {
  await issue("aprs", "K0TST");
  await expect(issue("aprs", "K0TST-15", other)).rejects.toThrow(
    "DEVICE_CLAIMED",
  );
  await issue();
  await expect(issue("ambient", "AA-BB-CC-DD-EE-01", other)).rejects.toThrow(
    "DEVICE_CLAIMED",
  );
  expect(identity("aprs", "k0tst-0").deviceId).toBe("K0TST");
});
test("authenticated aliases cannot claim the same hardware across sources", async () => {
  await owned();
  records.push({
    source: "weatherlink",
    deviceId: "station-01",
    wallet,
    owned: true,
    revoked: false,
    hardwareKey: "mac:aabbccddee01",
  });
  const c = await issue("weatherlink", "station-01");
  await expect(
    service.verify(wallet, c.challengeId!, c.code, ip),
  ).rejects.toThrow("DEVICE_CLAIMED");
});
test("native Ambient registration wins before claim verification", async () => {
  await db.query("INSERT INTO weather_stations VALUES ($1,$2,true)", [
    "native-01",
    JSON.stringify({ mac: "AA:BB:CC:DD:EE:01" }),
  ]);
  await expect(owned()).rejects.toThrow("DEVICE_CLAIMED");
});
test("native registration cannot steal an existing bridge hardware reservation", async () => {
  await owned();
  await expect(
    db.query("INSERT INTO weather_stations VALUES ($1,$2,true)", [
      "native-02",
      JSON.stringify({ mac: "aa-bb-cc-dd-ee-01" }),
    ]),
  ).rejects.toThrow("BRIDGE_DEVICE_CLAIMED");
});
test("shared readable inventory is not ownership", async () => {
  records.push({
    source: "ambient",
    deviceId: "aabbccddee01",
    wallet,
    owned: false,
    revoked: false,
    hardwareKey: "mac:aabbccddee01",
  });
  const c = await issue();
  await expect(
    service.verify(wallet, c.challengeId!, c.code, ip),
  ).rejects.toThrow("PROOF_REQUIRED");
});
test("public feed proof requires independently observed exact challenge", async () => {
  const c = await issue("wu", "station-01");
  records.push({
    source: "wu",
    deviceId: "station-01",
    wallet,
    owned: true,
    revoked: false,
    hardwareKey: "serial:fixture-01",
    observedCode: "wrong",
  });
  await expect(
    service.verify(wallet, c.challengeId!, c.code, ip),
  ).rejects.toThrow("PROOF_REQUIRED");
  records[0].observedCode = c.code;
  await service.verify(wallet, c.challengeId!, c.code, ip);
});
test("revoked vendor token suspends and disconnect is terminal", async () => {
  const c = await owned();
  records[0].revoked = true;
  await service.reverify(c.claimId!);
  expect((await service.status(wallet, c.claimId!)).state).toBe("suspended");
  await service.revoke(wallet, c.claimId!);
  expect((await service.status(wallet, c.claimId!)).state).toBe("revoked");
  await expect(issue()).rejects.toThrow("CLAIM_NOT_PENDING");
});
test("concurrent challenge consumption permits exactly one verification", async () => {
  const c = await issue("aprs", "K0TST");
  const code = mail.takeForTest()[0].code;
  const results = await Promise.allSettled([
    service.verify(wallet, c.challengeId!, code, ip),
    service.verify(wallet, c.challengeId!, code, ip),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});
test("attempt budget cannot reset through failed verification transactions", async () => {
  const c = await issue("aprs", "K0TST");
  const code = mail.takeForTest()[0].code;
  for (let i = 0; i < 5; i++)
    await expect(
      service.verify(wallet, c.challengeId!, "0".repeat(32), ip),
    ).rejects.toThrow("PROOF_REQUIRED");
  await expect(
    service.verify(wallet, c.challengeId!, code, ip),
  ).rejects.toThrow("CHALLENGE_EXPIRED_OR_USED");
});
test("exact duplicate on isolated ingest is ignored and cross-feed duplicate holds claims", async () => {
  const a = await owned();
  const b = await issue("wu", "station-02");
  const ingest = new BridgeObservations(tx, () => enabled);
  const reading = {
    observedAt: "2026-10-28T00:00:00Z",
    temperatureC: 20,
    humidityPct: 50,
    pressureHpa: 1000,
  };
  expect((await ingest.ingest(a.claimId!, reading)).duplicate).toBe(false);
  expect((await ingest.ingest(a.claimId!, reading)).duplicate).toBe(true);
  expect((await ingest.ingest(b.claimId!, reading)).duplicate).toBe(true);
  expect((await service.status(wallet, a.claimId!)).state).toBe("suspended");
  expect(
    (await db.query("SELECT * FROM bridge_observations")).rows,
  ).toHaveLength(2);
});
test("lockstep tolerance requires twelve changing samples and native precedence ignores arrival order", () => {
  const a: Reading[] = Array.from({ length: 12 }, (_, i) => ({
    observedAt: new Date(i * 60000).toISOString(),
    temperatureC: 20 + i,
    humidityPct: 50,
    pressureHpa: 1000,
  }));
  expect(
    lockstep(
      a,
      a.map((r) => ({ ...r, temperatureC: r.temperatureC + 0.05 })),
    ),
  ).toBe(true);
  expect(lockstep(a.slice(0, 11), a)).toBe(false);
  const flat = a.map((r) => ({ ...r, temperatureC: 20 }));
  expect(lockstep(flat, flat)).toBe(false);
  expect(preferNative([{ native: false }, { native: true }])).toEqual([
    { native: true },
  ]);
  expect(preferNative([{ native: true }, { native: false }])).toEqual([
    { native: true },
  ]);
});
test("migration reverses without deleting existing registrations and can be reapplied", async () => {
  await db.query("INSERT INTO weather_stations VALUES ($1,$2,true)", [
    "native-retained",
    "{}",
  ]);
  await db.exec(rollback);
  expect((await db.query("SELECT * FROM weather_stations")).rows).toHaveLength(
    1,
  );
  await db.exec(migration);
  expect((await db.query("SELECT * FROM bridge_claims")).rows).toHaveLength(0);
});

test("vendor credentials encrypt at rest, bind to claimant, and delete on disconnect", async () => {
  const c = await issue();
  const vault = new BridgeCredentialVault(tx, Buffer.alloc(32, 17));
  const secret = {
    apiKey: "synthetic-key-only",
    applicationKey: "synthetic-app-only",
  };
  await vault.put(wallet, c.claimId!, secret);
  expect(
    JSON.stringify(
      (await db.query("SELECT * FROM bridge_vendor_credentials")).rows,
    ),
  ).not.toContain(secret.apiKey);
  expect(await vault.get(wallet, c.claimId!)).toEqual(secret);
  expect(await vault.get(other, c.claimId!)).toBeNull();
  await service.revoke(wallet, c.claimId!);
  expect(
    (await db.query("SELECT * FROM bridge_vendor_credentials")).rows,
  ).toHaveLength(0);
});
test("fixture vendor revocation deletes tokens and suspends the verified claim", async () => {
  const c = await owned();
  const vault = new BridgeCredentialVault(tx, Buffer.alloc(32, 18));
  await vault.put(wallet, c.claimId!, {
    apiKey: "fixture-only",
    applicationKey: "fixture-only",
  });
  const fixtures: VendorFixture[] = [
    { vendor: "ambient", wallet, status: 401, devices: [] },
  ];
  const connectors = new RecordedVendorConnectors({
    enabled: () => true,
    transaction: tx,
    vault,
    transport: new RecordedVendorTransport(fixtures),
    now: () => 0,
  });
  const lifecycle = new BridgeClaims({
    transaction: tx,
    enabled: () => true,
    email: mail,
    licences: new RecordedLicenceLookup(licences),
    proofs: connectors,
  });
  await lifecycle.reverify(c.claimId!);
  expect((await service.status(wallet, c.claimId!)).state).toBe("suspended");
  expect(await vault.get(wallet, c.claimId!)).toBeNull();
});
test("fixture 429 backs off; public/shared device access is not ownership", async () => {
  const c = await issue("weatherlink", "station-01");
  const vault = new BridgeCredentialVault(tx, Buffer.alloc(32, 19));
  await vault.put(wallet, c.claimId!, {
    apiKey: "fixture-only",
    apiSecret: "fixture-only",
  });
  const fixtures: VendorFixture[] = [
    {
      vendor: "weatherlink",
      wallet,
      status: 429,
      retryAfterSeconds: 60,
      devices: [],
    },
  ];
  let now = 0;
  const connectors = new RecordedVendorConnectors({
    enabled: () => true,
    transaction: tx,
    vault,
    transport: new RecordedVendorTransport(fixtures),
    now: () => now,
  });
  await expect(
    connectors.read(wallet, "weatherlink", "station-01"),
  ).rejects.toThrow("VENDOR_BACKOFF");
  now = 30000;
  await expect(
    connectors.read(wallet, "weatherlink", "station-01"),
  ).rejects.toThrow("VENDOR_BACKOFF");
  now = 60000;
  fixtures[0].status = 200;
  fixtures[0].devices = [
    { id: "station-01", relationship: "shared", hardwareKey: "serial:01" },
  ];
  expect(await connectors.read(wallet, "weatherlink", "station-01")).toBeNull();
});
test("Netatmo rejects write scopes", async () => {
  const c = await issue("netatmo", "module-01");
  const vault = new BridgeCredentialVault(tx, Buffer.alloc(32, 20));
  await expect(
    vault.put(wallet, c.claimId!, {
      accessToken: "fixture-only",
      scopes: ["read_station", "write_station"],
    }),
  ).rejects.toThrow("READ_ONLY_CREDENTIALS_REQUIRED");
});

test("forwarding filters verification, holds, tier, terms and opt-out; only dry-run is possible", async () => {
  const c = await owned();
  const sink = new DryRunMadisForwarder();
  let gate = false,
    tier = 750000,
    terms: "allowed" | "forbidden" | "unverified" = "unverified";
  const forwarding = new BridgeForwarding({
    transaction: tx,
    enabled: () => gate,
    sink,
    redistribution: () => terms,
    tierPpm: async () => tier,
    thresholdPpm: 500000,
  });
  const reading = {
    observedAt: "2026-10-28T00:00:00Z",
    temperatureC: 20,
    humidityPct: 50,
    pressureHpa: 1000,
  };
  await new BridgeObservations(tx, () => true).ingest(c.claimId!, reading);
  const observation = String(
    (await db.query("SELECT id FROM bridge_observations")).rows[0].id,
  );
  expect(await forwarding.forward(observation)).toBe("disabled");
  gate = true;
  expect(await forwarding.forward(observation)).toBe("opted_out");
  await forwarding.optIn(wallet, c.claimId!, true);
  expect(await forwarding.forward(observation)).toBe("unverified_or_held");
  // Explicit fixture QC release; no production API can release a quarantine hold.
  await db.query("UPDATE bridge_observations SET held=false WHERE id=$1", [
    observation,
  ]);
  expect(await forwarding.forward(observation)).toBe("redistribution_blocked");
  terms = "allowed";
  tier = 100000;
  expect(await forwarding.forward(observation)).toBe("below_threshold");
  tier = 750000;
  expect(await forwarding.forward(observation)).toBe("dry_run");
  expect(await forwarding.forward(observation)).toBe("dry_run");
  expect(sink.count()).toBe(1);
  await forwarding.optIn(wallet, c.claimId!, false);
  expect(await forwarding.forward(observation)).toBe("opted_out");
  expect(sink.count()).toBe(1);
  await expect(forwarding.optIn(other, c.claimId!, true)).rejects.toThrow(
    "NOT_FOUND",
  );
  expect(
    (await db.query("SELECT * FROM bridge_forwarding_audit")).rows,
  ).toHaveLength(5);
});
