/** Hypothetical display-only computation; the scarcity value comes from core4 /network/scarcity. */
export function bridgeTierPreview(input: {
  enabled?: boolean;
  baseUnits: bigint;
  agreementPpm: number;
  uptimePpm: number;
  completedDays: number;
  nativeTierPpm: number;
  scarcityPercent: number;
}): { tierPpm: number; previewUnits: bigint; rewardEligible: false } {
  const zero = { tierPpm: 0, previewUnits: 0n, rewardEligible: false as const };
  if (input.enabled !== true) return zero;
  if (
    typeof input.baseUnits !== "bigint" ||
    input.baseUnits < 0n ||
    ![input.agreementPpm, input.uptimePpm, input.nativeTierPpm].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000,
    ) ||
    !Number.isSafeInteger(input.completedDays) ||
    input.completedDays < 0 ||
    !Number.isSafeInteger(input.scarcityPercent) ||
    input.scarcityPercent < 100
  )
    return zero;
  const ceiling = BigInt(250_000 + 25_000 * Math.min(input.completedDays, 20));
  const reliability =
    (ceiling * BigInt(input.agreementPpm) * BigInt(input.uptimePpm)) /
    1_000_000_000_000n;
  const tier =
    reliability < BigInt(input.nativeTierPpm)
      ? reliability
      : BigInt(input.nativeTierPpm);
  return {
    tierPpm: Number(tier),
    previewUnits:
      (input.baseUnits * tier * BigInt(input.scarcityPercent)) / 100_000_000n,
    rewardEligible: false,
  };
}
