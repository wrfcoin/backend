import { readFileSync } from "node:fs";
import {
  parseVendorReading,
  RecordedVendorTransport,
  VENDOR_TERMS,
  type Vendor,
} from "../../server/bridges/vendors.js";
const fixtures = JSON.parse(
  readFileSync("__tests__/bridges/fixtures/vendors.json", "utf8"),
);
const devices = {
  ambient: "aabbccddee01",
  weatherlink: "00000000-0000-4000-8000-000000000001",
  netatmo: "module-01",
};
test.each(["ambient", "weatherlink", "netatmo"] as Vendor[])(
  "%s converts only the bound fixture device",
  (vendor) => {
    expect(
      parseVendorReading(vendor, devices[vendor], fixtures[vendor]),
    ).toMatchObject({ temperatureC: 20, humidityPct: 50 });
    expect(() =>
      parseVendorReading(vendor, "stranger", fixtures[vendor]),
    ).toThrow();
    expect(VENDOR_TERMS[vendor]).toBe("TOS-UNVERIFIED");
  },
);
test("missing measurements never become zero", () => {
  expect(() =>
    parseVendorReading("netatmo", "module-01", {
      body: { devices: [{ _id: "module-01", dashboard_data: {} }] },
    }),
  ).toThrow("INVALID_READING");
});
test("recorded vendor transport exposes no write or network method", async () => {
  const transport = new RecordedVendorTransport([
    { vendor: "ambient", wallet: "fixture", status: 200, devices: [] },
  ]);
  expect(
    (await transport.get("ambient", { apiKey: "fixture-only" })).status,
  ).toBe(200);
  expect(transport).not.toHaveProperty("post");
  expect(transport).not.toHaveProperty("fetch");
});
