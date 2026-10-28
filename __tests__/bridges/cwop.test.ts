import { readFileSync } from "node:fs";
import {
  parseCwop,
  CwopReferenceClient,
  RecordedAprsTransport,
} from "../../server/bridges/cwop.js";
const fixture = JSON.parse(
  readFileSync("__tests__/bridges/fixtures/cwop.json", "utf8"),
);
test("valid packet converts units but retains unsigned non-earning provenance", () => {
  expect(parseCwop(fixture.valid, fixture.receivedAt)).toMatchObject({
    callsign: "K0TST",
    latitude: 40,
    longitude: -105,
    temperatureC: 20,
    humidityPct: 50,
    pressureHpa: 1013.2,
    provenance: "unsigned_aprs_reference",
    rewardEligible: false,
  });
});
test("negative Fahrenheit, 100% humidity and UTC timestamp decode correctly", () => {
  const r = parseCwop(fixture.timestamped, fixture.receivedAt);
  expect(r.temperatureC).toBeCloseTo(-21.6667, 3);
  expect(r.humidityPct).toBe(100);
  expect(r.observedAt).toBe("2026-10-28T11:59:00.000Z");
});
test.each(["malformed", "status", "long", "newline"])(
  "rejects %s packets",
  (kind) => {
    const packet =
      kind === "malformed"
        ? fixture.malformed
        : kind === "status"
          ? "K0TST>APRS:>claim-code"
          : kind === "long"
            ? "x".repeat(513)
            : fixture.valid + "\n";
    expect(() => parseCwop(packet, fixture.receivedAt)).toThrow();
  },
);
test("disabled, unauthenticated and duplicate ingest fail closed", async () => {
  let enabled = false,
    authenticated = false;
  const ingest = jest.fn();
  const client = new CwopReferenceClient({
    enabled: () => enabled,
    authenticated: () => authenticated,
    transport: new RecordedAprsTransport([
      fixture.valid,
      fixture.valid,
      fixture.malformed,
    ]),
    now: () => Date.parse(fixture.receivedAt),
    ingest,
  });
  expect((await client.poll()).accepted).toBe(0);
  enabled = true;
  await expect(client.poll()).rejects.toThrow("AUTH_REQUIRED");
  authenticated = true;
  expect(await client.poll()).toEqual({
    accepted: 1,
    duplicates: 1,
    rejected: 1,
  });
  expect((await client.poll()).accepted).toBe(0);
  expect(ingest).toHaveBeenCalledTimes(1);
});
test("spoofed callsign remains unsigned and never earns regardless of passcode knowledge", () => {
  const r = parseCwop(
    fixture.valid.replace("K0TST", "W0TST"),
    fixture.receivedAt,
  );
  expect(r.rewardEligible).toBe(false);
  expect(r.provenance).toBe("unsigned_aprs_reference");
});
test("transport errors back off and do not ingest", async () => {
  let now = Date.parse(fixture.receivedAt);
  const read = jest.fn(async () => {
    throw new Error("offline");
  });
  const client = new CwopReferenceClient({
    enabled: () => true,
    authenticated: () => true,
    transport: { read },
    now: () => now,
    ingest: async () => {
      throw new Error("must not ingest");
    },
  });
  await expect(client.poll()).rejects.toThrow("APRS_READ_UNAVAILABLE");
  now += 60000;
  await client.poll();
  expect(read).toHaveBeenCalledTimes(1);
  now += 60000;
  await expect(client.poll()).rejects.toThrow("APRS_READ_UNAVAILABLE");
  expect(read).toHaveBeenCalledTimes(2);
});
