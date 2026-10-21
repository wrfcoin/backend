import bands from './fixtures/reference_bands.json' with { type: 'json' };

export type ReferenceTier = 'good' | 'degraded' | 'outlier';
export type ReferenceFoldRule = 'worst' | 'second_worst';
export interface ReferenceResidual { source: string; variable: string; residual: number }
export interface ReferenceTieringContext {
  /** Chain height and feature-schedule height supplied by the caller, never wall time. */
  height: number;
  grossGuardActivationHeight: number | null;
}
type Band = { good_max: number; marginal_max: number; gross_max?: number };
type Bands = { version: number; sources: Record<string, Record<string, Band>> };

export const EXPECTED_REFERENCE_BANDS_VERSION = 3;
export const REFERENCE_BANDS_VERSION = bands.version;
export const REFERENCE_FOLD_RULE: ReferenceFoldRule = 'second_worst';
export const FOLD_RULE_BY_BANDS_VERSION: Record<number, ReferenceFoldRule> = {
  1: 'worst', 2: 'second_worst', 3: 'second_worst',
};
if (bands.version !== EXPECTED_REFERENCE_BANDS_VERSION ||
    REFERENCE_FOLD_RULE !== FOLD_RULE_BY_BANDS_VERSION[bands.version]) {
  throw new Error('reference bands version/fold rule differs from deployed core4 9ef92a235');
}
const rank: Record<ReferenceTier, number> = { good: 0, degraded: 1, outlier: 2 };

export function grossGuardActiveAt(context?: ReferenceTieringContext): boolean {
  if (!context) return false; // backward-compatible, explicitly pre-activation
  for (const value of [context.height, ...(context.grossGuardActivationHeight === null ? [] : [context.grossGuardActivationHeight])]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('reference chain heights must be nonnegative safe integers');
    }
  }
  return context.grossGuardActivationHeight !== null && context.height >= context.grossGuardActivationHeight;
}

function bandFor(source: string, variable: string): Band | undefined {
  const sources = (bands as Bands).sources;
  if (!Object.prototype.hasOwnProperty.call(sources, source)) return undefined;
  const variables = sources[source];
  return Object.prototype.hasOwnProperty.call(variables, variable) ? variables[variable] : undefined;
}

export function variableTier(source: string, variable: string, residual: number): ReferenceTier | null {
  const band = bandFor(source, variable);
  if (!band) return null;
  if (!Number.isFinite(residual)) return 'outlier';
  const magnitude = Math.abs(residual);
  return magnitude <= band.good_max ? 'good' : magnitude <= band.marginal_max ? 'degraded' : 'outlier';
}

/** Exact core4 second-worst fold; retain the old branch for explicit truth-table testing. */
export function foldVariableTiers(tiers: readonly ReferenceTier[], rule: ReferenceFoldRule = REFERENCE_FOLD_RULE): ReferenceTier {
  if (rule !== 'worst' && rule !== 'second_worst') throw new Error('unknown reference fold rule');
  if (tiers.length === 0) return 'good';
  const ordered = [...tiers].sort((a, b) => rank[a] - rank[b]);
  if (rule === 'worst') return ordered[ordered.length - 1];
  const outliers = tiers.filter(t => t === 'outlier').length;
  if (outliers >= 2 || (outliers === 1 && tiers.length === 1)) return 'outlier';
  const kept = outliers === 1 || tiers.length >= 3 ? ordered.slice(0, -1) : ordered;
  return outliers === 1 ? 'degraded' : kept[kept.length - 1];
}

/**
 * Advisory mirror of core4 65134a64 `ReferenceComparison::tier_under_with_unverified`
 * (core4#3285 owner ruling): `unverified` submitted variables that could have been
 * checked but had no trustworthy reference value each count as an Outlier in the fold
 * (removing them would hand the #3098 worst-variable drop to another variable). With
 * `unverified === 0` this is exactly the plain tier. Under the #3131 gross guard, a lone
 * real Outlier beyond its gross limit (>= 2 REAL scored variables) still tiers Outlier.
 * No reward or enforcement effect.
 */
export function tierReferenceResiduals(
  residuals: readonly ReferenceResidual[],
  context?: ReferenceTieringContext,
  unverified = 0,
): ReferenceTier {
  if (!Number.isSafeInteger(unverified) || unverified < 0) {
    throw new Error('unverified must be a nonnegative safe integer');
  }
  const grossGuardActive = grossGuardActiveAt(context);
  const tiers: ReferenceTier[] = [];
  let gross = false;
  for (const { source, variable, residual } of residuals) {
    const tier = variableTier(source, variable, residual);
    if (tier === null) continue;
    tiers.push(tier);
    const band = bandFor(source, variable)!;
    gross ||= tier === 'outlier' && Number.isFinite(residual) &&
      band.gross_max !== undefined && Math.abs(residual) > band.gross_max;
  }
  if (grossGuardActive && tiers.length >= 2 && tiers.filter(t => t === 'outlier').length === 1 && gross) return 'outlier';
  for (let i = 0; i < unverified; i += 1) tiers.push('outlier');
  return foldVariableTiers(tiers);
}
