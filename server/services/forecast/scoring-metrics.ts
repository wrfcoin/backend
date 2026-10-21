export function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

export function round(value: number): number {
  return Number(value.toFixed(6));
}

export function brierScore(
  binaryPairs: Array<{ forecast: number; observed: number }>
): number {
  return (
    binaryPairs.reduce((sum, pair) => {
      const error = pair.forecast - pair.observed;
      return sum + error * error;
    }, 0) / binaryPairs.length
  );
}

export function crpsApprox(
  precipPairs: Array<{ predicted: number; observed: number }>
): number {
  const meanAbsPrecipError =
    precipPairs.reduce(
      (sum, pair) => sum + Math.abs(pair.predicted - pair.observed),
      0
    ) / precipPairs.length;
  return clamp01(meanAbsPrecipError);
}
