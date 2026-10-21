import {
  REFERENCE_BANDS_VERSION,
  REFERENCE_FOLD_RULE,
  grossGuardActiveAt,
  type ReferenceFoldRule,
  type ReferenceTieringContext,
  tierReferenceResiduals,
  type ReferenceResidual,
  type ReferenceTier,
} from '../../shared/reference-tier.js';

export interface ReferenceObservation {
  tieringContext?: ReferenceTieringContext;
  stationId: string;
  lat: number;
  lon: number;
  elevationM?: number;
  observedAtUnix: number;
  observation: Record<string, number>;
}

export interface ReferenceSourceResiduals {
  source: string;
  residuals: Record<string, number>;
  bandRatios: Record<string, number>;
  reference: Record<string, number>;
  error?: string;
}

export interface ReferenceVerificationScore {
  tier: ReferenceTier;
  bandsVersion: number;
  foldRule: ReferenceFoldRule;
  grossGuardActive: boolean;
  residuals: ReferenceResidual[];
  perSource: ReferenceSourceResiduals[];
  worst: {
    source: string;
    variable: string;
    residual: number;
    bandRatio: number;
  } | null;
  worstRatio: number | null;
}

export interface ReferenceVerifierClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type ResidualsWireResponse = {
  results?: Array<{
    bands_version?: unknown;
    worst_ratio?: unknown;
    worst?: {
      source?: unknown;
      variable?: unknown;
      residual?: unknown;
      band_ratio?: unknown;
    } | null;
    per_source?: Array<{
      source?: unknown;
      residuals?: Record<string, unknown>;
      band_ratios?: Record<string, unknown>;
      reference?: Record<string, unknown>;
      error?: unknown;
    }>;
  }>;
  service?: {
    bands_version?: unknown;
  };
};

const DEFAULT_REFERENCE_URL = 'http://oracle-reference:8010';
const DEFAULT_TIMEOUT_MS = 5_000;

function finiteRecord(value: unknown, field: string): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`oracle-reference returned invalid ${field}`);
  }

  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new Error(`oracle-reference returned non-finite ${field}.${key}`);
    }
    result[key] = raw;
  }
  return result;
}

function optionalFinite(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`oracle-reference returned invalid ${field}`);
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Strict client for oracle-reference's residual-only contract.
 *
 * Sidecar tier metadata is advisory and is not trusted as the verdict. This client validates the pinned
 * bands version and applies the backend's core4-parity tier mirror locally.
 */
export class ReferenceVerifierClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ReferenceVerifierClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ||
        process.env.ORACLE_REFERENCE_URL ||
        DEFAULT_REFERENCE_URL,
    );
    this.timeoutMs =
      options.timeoutMs ??
      Number(process.env.ORACLE_REFERENCE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async scoreObservation(
    input: ReferenceObservation,
  ): Promise<ReferenceVerificationScore> {
    const grossGuardActive = grossGuardActiveAt(input.tieringContext);
    const controller = new globalThis.AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/residuals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          observations: [
            {
              station_id: input.stationId,
              lat: input.lat,
              lon: input.lon,
              ...(input.elevationM === undefined
                ? {}
                : { elevation_m: input.elevationM }),
              observed_at_unix: input.observedAtUnix,
              observation: input.observation,
            },
          ],
          mode: 'ratio',
          ...(input.tieringContext ? { tiering_context: {
            height: input.tieringContext.height,
            gross_guard_activation_height: input.tieringContext.grossGuardActivationHeight,
          } } : {}),
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(
        `oracle-reference /v1/residuals failed (${response.status}): ${raw.slice(0, 500)}`,
      );
    }

    let body: ResidualsWireResponse;
    try {
      body = JSON.parse(raw) as ResidualsWireResponse;
    } catch {
      throw new Error('oracle-reference /v1/residuals returned invalid JSON');
    }

    const result = body.results?.[0];
    if (!result || !Array.isArray(result.per_source)) {
      throw new Error('oracle-reference /v1/residuals returned no result');
    }

    const bandsVersion = Number(
      result.bands_version ?? body.service?.bands_version,
    );
    if (bandsVersion !== REFERENCE_BANDS_VERSION) {
      throw new Error(
        `oracle-reference bands version ${String(bandsVersion)} does not match pinned version ${REFERENCE_BANDS_VERSION}`,
      );
    }

    const residuals: ReferenceResidual[] = [];
    const perSource: ReferenceSourceResiduals[] = result.per_source.map(
      (sourceResult) => {
        if (
          typeof sourceResult.source !== 'string' ||
          sourceResult.source.length === 0
        ) {
          throw new Error(
            'oracle-reference returned a residual source without a name',
          );
        }

        const sourceResiduals = finiteRecord(
          sourceResult.residuals ?? {},
          'residuals',
        );
        for (const [variable, residual] of Object.entries(sourceResiduals)) {
          residuals.push({ source: sourceResult.source, variable, residual });
        }

        return {
          source: sourceResult.source,
          residuals: sourceResiduals,
          bandRatios: finiteRecord(
            sourceResult.band_ratios ?? {},
            'band_ratios',
          ),
          reference: finiteRecord(sourceResult.reference ?? {}, 'reference'),
          ...(typeof sourceResult.error === 'string'
            ? { error: sourceResult.error }
            : {}),
        };
      },
    );

    if (residuals.length === 0) {
      throw new Error('oracle-reference returned no comparable residuals');
    }

    let worst: ReferenceVerificationScore['worst'] = null;
    if (result.worst !== null && result.worst !== undefined) {
      if (
        typeof result.worst.source !== 'string' ||
        typeof result.worst.variable !== 'string'
      ) {
        throw new Error(
          'oracle-reference returned an invalid worst residual identity',
        );
      }
      const residual = optionalFinite(result.worst.residual, 'worst.residual');
      const bandRatio = optionalFinite(
        result.worst.band_ratio,
        'worst.band_ratio',
      );
      if (residual === null || bandRatio === null) {
        throw new Error(
          'oracle-reference returned an incomplete worst residual',
        );
      }
      worst = {
        source: result.worst.source,
        variable: result.worst.variable,
        residual,
        bandRatio,
      };
    }

    return {
      tier: tierReferenceResiduals(residuals, input.tieringContext),
      foldRule: REFERENCE_FOLD_RULE,
      grossGuardActive,
      bandsVersion,
      residuals,
      perSource,
      worst,
      worstRatio: optionalFinite(result.worst_ratio, 'worst_ratio'),
    };
  }
}
