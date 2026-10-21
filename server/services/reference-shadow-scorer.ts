import { Counter, Gauge, Histogram } from 'prom-client';
import type { CanonicalReading } from '../../shared/commit-reveal-hash.js';
import type { ReferenceTier, ReferenceTieringContext } from '../../shared/reference-tier.js';
import { metricsRegistry } from '../utils/metrics.js';
import {
  ReferenceVerifierClient,
  type ReferenceSourceResiduals,
  type ReferenceVerificationScore,
} from './reference-verifier-client.js';

type QueryResult = { rows: Record<string, unknown>[] };

export interface ReferenceScoreDb {
  execute: (sql: string, params?: unknown[]) => Promise<QueryResult>;
}

export interface ReferenceRevealInput {
  tieringContext?: ReferenceTieringContext;
  commitmentId: number;
  stationId: string;
  observedAtUnix: number;
  reading: CanonicalReading;
}

export interface ReferenceShadowResult {
  tier: ReferenceTier;
  bandsVersion: number;
}

export interface ReferenceShadowScorerLike {
  scoreReveal(input: ReferenceRevealInput): Promise<ReferenceShadowResult>;
}

function getMetric<T>(name: string, create: () => T): T {
  return (metricsRegistry.getSingleMetric(name) as T | undefined) ?? create();
}

const scoreCounter = getMetric(
  'wrfcoin_reference_shadow_scores_total',
  () =>
    new Counter({
      name: 'wrfcoin_reference_shadow_scores_total',
      help: 'Advisory oracle-reference shadow scores by tier',
      labelNames: ['tier'],
      registers: [metricsRegistry],
    }),
);

const failureCounter = getMetric(
  'wrfcoin_reference_shadow_failures_total',
  () =>
    new Counter({
      name: 'wrfcoin_reference_shadow_failures_total',
      help: 'Advisory oracle-reference failures by stage',
      labelNames: ['stage'],
      registers: [metricsRegistry],
    }),
);

const residualHistogram = getMetric(
  'wrfcoin_reference_residual_absolute',
  () =>
    new Histogram({
      name: 'wrfcoin_reference_residual_absolute',
      help: 'Absolute observed-minus-reference residuals by source and canonical variable',
      labelNames: ['source', 'variable'],
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100],
      registers: [metricsRegistry],
    }),
);

const fingerprintCorrelation = getMetric(
  'wrfcoin_reference_fingerprint_correlation',
  () =>
    new Gauge({
      name: 'wrfcoin_reference_fingerprint_correlation',
      help: 'Per-station correlation between analysis residual and forecast error',
      labelNames: ['station_id'],
      registers: [metricsRegistry],
    }),
);

function finiteCoordinate(value: unknown, name: string): number {
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate)) {
    throw new Error(`station has no finite ${name}`);
  }
  return coordinate;
}

function finiteOptional(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function metadataObject(value: unknown): Record<string, unknown> | undefined {
  let meta = value;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      return undefined;
    }
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  return meta as Record<string, unknown>;
}

/**
 * Registered sensor elevation, written by station registration as
 * `metadata.elevation_m` (core4#3285: operator override, else USGS DEM +
 * sensor height; absent when neither could be established).
 */
function metadataElevation(value: unknown): number | undefined {
  return finiteOptional(metadataObject(value)?.elevation_m);
}

export type ReferencePressureKind = 'absolute' | 'relative';

/** `metadata.pressure_kind` as registered, or null when unknown. */
export function metadataPressureKind(value: unknown): ReferencePressureKind | null {
  const kind = metadataObject(value)?.pressure_kind;
  return kind === 'absolute' || kind === 'relative' ? kind : null;
}

/**
 * How the reveal's `pressure_hpa` is compared (core4#3285).
 *
 * oracle-reference's pressure reference is model MSLP, and it is reduced
 * hypsometrically to the station elevation ONLY when `elevation_m` is sent
 * (elevation affects no other variable there). What the station's
 * `pressure_hpa` actually is decides which of the two is the right comparand:
 *
 * - `absolute` (station pressure at the sensor, e.g. the configured WS-5000 where
 *   Ambient relative = absolute): send the elevation, so the reference is
 *   MSLP reduced to the sensor.
 * - `relative` (Ambient `baromrelin` with an owner sea-level offset, e.g.
 *   a reference station; the backend's own Ambient readers use `baromrelin`): send NO
 *   elevation, so the reference stays sea-level MSLP. Sending it would create
 *   a false residual of about +0.12 hPa per metre (~+29 hPa at 242 m).
 * - `absolute` but NO registered elevation (DEM failed, no override, or
 *   nulled by a relocation): the pressure residual is SKIPPED, as for unknown.
 * - unknown (no `pressure_kind` registered): neither pairing can be trusted,
 *   so the pressure residual is SKIPPED rather than guessed; the other
 *   variables are scored as before. No elevation is sent.
 *
 * `CanonicalReading` carries no pressure-kind flag and is hash-significant, so
 * the kind is a registered station property, not a per-reading field. This
 * scorer does not use a submitted `pressure_sea_level_hpa` and has no
 * counterpart of the attester's NWS altimeter-setting pairing.
 */
export function referencePressurePlan(metadata: unknown): {
  includePressure: boolean;
  elevationM: number | undefined;
} {
  const kind = metadataPressureKind(metadata);
  if (kind === 'absolute') {
    const elevationM = metadataElevation(metadata);
    // Absolute pressure with NO registered elevation would be compared with
    // unreduced sea-level MSLP: a false residual of ~-0.12 hPa/m.
    // Without the elevation there is no trustworthy comparand.
    return elevationM === undefined
      ? { includePressure: false, elevationM: undefined }
      : { includePressure: true, elevationM };
  }
  if (kind === 'relative') {
    return { includePressure: true, elevationM: undefined };
  }
  return { includePressure: false, elevationM: undefined };
}

function observationFromReading(
  reading: CanonicalReading,
  includePressure: boolean,
): Record<string, number> {
  return {
    temperature_c: reading.temperature_c,
    ...(includePressure ? { pressure_hpa: reading.pressure_hpa } : {}),
    humidity_pct: reading.humidity_pct,
    wind_speed_ms: reading.wind_mps,
    rainfall_mm: reading.rainfall_mm,
  };
}

type FingerprintPair = {
  analysisResidual: number;
  forecastError: number;
};

/**
 * Pick one deterministic analysis/forecast pair per score for the station
 * fingerprint. Forecast residuals are observed-minus-forecast, so negating
 * them yields forecast-minus-observed error.
 */
function fingerprintPair(
  perSource: ReferenceSourceResiduals[],
): FingerprintPair | null {
  const bySource = new Map(
    perSource.map((entry) => [entry.source, entry.residuals]),
  );
  const candidates: Array<FingerprintPair & { magnitude: number }> = [];

  for (const model of ['hrrr', 'gfs']) {
    const analysis = bySource.get(model);
    const forecast = bySource.get(`${model}_fx`);
    if (!analysis || !forecast) continue;

    for (const [variable, analysisResidual] of Object.entries(analysis)) {
      const forecastResidual = forecast[variable];
      if (!Number.isFinite(forecastResidual)) continue;
      candidates.push({
        analysisResidual,
        forecastError: -forecastResidual,
        magnitude: Math.abs(analysisResidual),
      });
    }
  }

  candidates.sort((a, b) => b.magnitude - a.magnitude);
  const selected = candidates[0];
  return selected
    ? {
      analysisResidual: selected.analysisResidual,
      forecastError: selected.forecastError,
    }
    : null;
}

export class ReferenceShadowScorer implements ReferenceShadowScorerLike {
  constructor(
    private readonly db: ReferenceScoreDb,
    private readonly client: ReferenceVerifierClient = new ReferenceVerifierClient(),
  ) {}

  async scoreReveal(
    input: ReferenceRevealInput,
  ): Promise<ReferenceShadowResult> {
    let station: Record<string, unknown>;
    try {
      const stationResult = await this.db.execute(
        `SELECT latitude, longitude, metadata
         FROM weather_stations
         WHERE station_id = $1
         LIMIT 1`,
        [input.stationId],
      );
      if (!stationResult.rows[0]) {
        throw new Error('station registration not found');
      }
      station = stationResult.rows[0];
    } catch (error) {
      failureCounter.inc({ stage: 'station_lookup' });
      throw error;
    }

    const pressurePlan = referencePressurePlan(station.metadata);
    let score: ReferenceVerificationScore;
    try {
      score = await this.client.scoreObservation({
        stationId: input.stationId,
        ...(input.tieringContext ? { tieringContext: input.tieringContext } : {}),
        lat: finiteCoordinate(station.latitude, 'latitude'),
        lon: finiteCoordinate(station.longitude, 'longitude'),
        elevationM: pressurePlan.elevationM,
        observedAtUnix: input.observedAtUnix,
        observation: observationFromReading(
          input.reading,
          pressurePlan.includePressure,
        ),
      });
    } catch (error) {
      failureCounter.inc({ stage: 'oracle_request' });
      throw error;
    }

    const pair = fingerprintPair(score.perSource);
    try {
      await this.db.execute(
        `INSERT INTO reference_scores (
           commitment_id,
           station_id,
           tier,
           bands_version,
           worst_source,
           worst_variable,
           worst_residual,
           worst_ratio,
           residuals,
           analysis_residual,
           forecast_error,
           scored_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, now())
         ON CONFLICT (commitment_id) DO NOTHING`,
        [
          input.commitmentId,
          input.stationId,
          score.tier,
          score.bandsVersion,
          score.worst?.source ?? null,
          score.worst?.variable ?? null,
          score.worst?.residual ?? null,
          score.worstRatio,
          JSON.stringify(score.perSource),
          pair?.analysisResidual ?? null,
          pair?.forecastError ?? null,
        ],
      );
    } catch (error) {
      failureCounter.inc({ stage: 'persistence' });
      throw error;
    }

    scoreCounter.inc({ tier: score.tier });
    for (const residual of score.residuals) {
      residualHistogram.observe(
        { source: residual.source, variable: residual.variable },
        Math.abs(residual.residual),
      );
    }

    if (pair) {
      const correlationResult = await this.db
        .execute(
          `SELECT corr(analysis_residual, forecast_error)::double precision AS correlation,
                COUNT(*)::integer AS sample_count
         FROM reference_scores
         WHERE station_id = $1
           AND analysis_residual IS NOT NULL
           AND forecast_error IS NOT NULL`,
          [input.stationId],
        )
        .catch(() => ({ rows: [] }));
      const correlation = finiteOptional(
        correlationResult.rows[0]?.correlation,
      );
      const sampleCount = Number(correlationResult.rows[0]?.sample_count ?? 0);
      if (correlation !== undefined && sampleCount >= 2) {
        fingerprintCorrelation.set(
          { station_id: input.stationId },
          correlation,
        );
      }
    }

    return { tier: score.tier, bandsVersion: score.bandsVersion };
  }
}
