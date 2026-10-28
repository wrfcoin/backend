import { bridgeTierPreview } from "../../server/bridges/trust-tier.js";
const base = {
  enabled: true,
  baseUnits: 1000n,
  agreementPpm: 1_000_000,
  uptimePpm: 1_000_000,
  completedDays: 0,
  nativeTierPpm: 1_000_000,
  scarcityPercent: 150,
};
test("default-off and explicitly disabled previews are zero", () => {
  expect(bridgeTierPreview({ ...base, enabled: undefined }).previewUnits).toBe(
    0n,
  );
  expect(bridgeTierPreview({ ...base, enabled: false }).previewUnits).toBe(0n);
});
test("reliability progresses and saturates below native", () => {
  expect(bridgeTierPreview(base).tierPpm).toBe(250000);
  expect(bridgeTierPreview({ ...base, completedDays: 10 }).tierPpm).toBe(
    500000,
  );
  expect(bridgeTierPreview({ ...base, completedDays: 100 }).tierPpm).toBe(
    750000,
  );
});
test("disagreement and uptime gaps reduce the tier", () => {
  expect(bridgeTierPreview({ ...base, agreementPpm: 500000 }).tierPpm).toBe(
    125000,
  );
  expect(bridgeTierPreview({ ...base, uptimePpm: 0 }).tierPpm).toBe(0);
});
test("native cap is applied before the single scarcity multiplication", () => {
  expect(bridgeTierPreview({ ...base, nativeTierPpm: 100000 })).toEqual({
    tierPpm: 100000,
    previewUnits: 150n,
    rewardEligible: false,
  });
  expect(bridgeTierPreview({ ...base, nativeTierPpm: 0 }).previewUnits).toBe(
    0n,
  );
  expect(
    bridgeTierPreview({ ...base, baseUnits: 3n, completedDays: 20 })
      .previewUnits,
  ).toBe(3n);
});
test("large amounts retain integer precision and cannot authorize earnings", () => {
  const result = bridgeTierPreview({ ...base, baseUnits: 10n ** 30n });
  expect(result.previewUnits).toBe(375n * 10n ** 27n);
  expect(result.rewardEligible).toBe(false);
});
test.each([NaN, Infinity, -1, 1.5, 1000001])(
  "invalid evidence %s fails closed",
  (value) => {
    expect(
      bridgeTierPreview({ ...base, agreementPpm: value }).previewUnits,
    ).toBe(0n);
  },
);
