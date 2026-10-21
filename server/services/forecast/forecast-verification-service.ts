import crypto from 'crypto';
import type { ForecastAccuracyMetrics } from '../../../shared/generated-types/index.js';
import type { CategoricalScores } from '../../../shared/generated-types/index.js';
import {
  brierScore,
  crpsApprox,
  clamp01,
  round,
} from './scoring-metrics.js';
const NOAAWeatherService = require('../noaa-nws-api-service');

const PRECIP_THRESHOLDS_IN = [0.01, 0.25, 1.0] as const;
const MAX_VALID_WINDOW_MS = 72 * 60 * 60 * 1000;
const DEFAULT_MAX_GRID_AXIS_SIZE = 500;
const DEFAULT_MAX_OBSERVATION_COUNT = 5000;
const DEFAULT_OBSERVATION_TOLERANCE_MS = 6 * 60 * 60 * 1000;

interface DomainBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

interface ValidTimeRange {
  start: string;
  end: string;
}

interface ForecastField {
  latitudes: number[];
  longitudes: number[];
  values: number[][];
}

interface ForecastGridBundle {
  temperature: ForecastField;
  windSpeed: ForecastField;
  precipitation: ForecastField;
}

interface StationObservation {
  stationId: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  temperature: number;
  windSpeed: number;
  precipitation: number;
}

export interface ForecastVerificationRequest {
  forecastRef: {
    cid: string;
    model: string;
    runId: string;
  };
  validTimeRange: ValidTimeRange;
  domainBounds: DomainBounds;
  grid: ForecastGridBundle;
  observations?: StationObservation[];
}

type ContinuousMetric = Pick<ForecastAccuracyMetrics, 'mae' | 'rmse' | 'bias'>;

// Maps local `thresholdIn` to generated `threshold` field name.
type PrecipCategoricalMetric = Pick<CategoricalScores, 'pod' | 'far' | 'csi'> & {
  thresholdIn: CategoricalScores['threshold'];
};

interface ForecastSkillInputs {
  brier_score: number;
  crps_score: number;
  forecast_probability: number;
  observed_outcome: number;
  forecast_skill: number;
}

export interface ForecastVerificationReport {
  schemaVersion: string;
  reportId: string;
  reportHash: string;
  forecastRef: {
    cid: string;
    model: string;
    runId: string;
  };
  validTimeRange: ValidTimeRange;
  domainBounds: DomainBounds;
  stationCount: number;
  qualityControl: {
    rawObservationCount: number;
    uniqueStationCount: number;
    qcRejectedCount: number;
    observationWindowUsed: ValidTimeRange;
  };
  continuous: {
    temperature: ContinuousMetric;
    windSpeed: ContinuousMetric;
  };
  categorical: {
    precipitation: PrecipCategoricalMetric[];
  };
  skillInputs: ForecastSkillInputs;
  brier_score: number;
  crps_score: number;
  forecast_probability: number;
  observed_outcome: number;
  forecast_skill: number;
  producedAt: string;
  producer: string;
}

interface ObservationProvider {
  fetchObservations(
    domainBounds: DomainBounds,
    validTimeRange: ValidTimeRange
  ): Promise<StationObservation[]>;
}

interface ForecastVerificationServiceOptions {
  observationProvider?: ObservationProvider;
  allowObservationOverride?: boolean;
  maxGridAxisSize?: number;
  maxObservationCount?: number;
  observationTimeToleranceMs?: number;
}

class VerificationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'VerificationError';
    this.statusCode = statusCode;
  }
}

export class VerificationValidationError extends VerificationError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'VerificationValidationError';
  }
}

export class VerificationUpstreamError extends VerificationError {
  constructor(message: string) {
    super(message, 502);
    this.name = 'VerificationUpstreamError';
  }
}

export function mapVerificationErrorStatus(error: unknown): number {
  if (error instanceof VerificationError) {
    return error.statusCode;
  }
  return 500;
}

class NoaaObservationProvider implements ObservationProvider {
  private readonly noaa: any;

  constructor() {
    this.noaa = new NOAAWeatherService();
  }

  async fetchObservations(
    domainBounds: DomainBounds,
    _validTimeRange: ValidTimeRange
  ): Promise<StationObservation[]> {
    const centerLat = (domainBounds.north + domainBounds.south) / 2;
    const centerLon = (domainBounds.east + domainBounds.west) / 2;
    const nearby = await this.noaa.getNearbyStations(centerLat, centerLon, 20);
    const stations = Array.isArray(nearby?.stations) ? nearby.stations : [];

    const observations: StationObservation[] = [];
    let stationFetchFailures = 0;
    for (const station of stations) {
      const stationLat = station?.coordinates?.latitude;
      const stationLon = station?.coordinates?.longitude;
      if (!isFiniteNumber(stationLat) || !isFiniteNumber(stationLon)) {
        continue;
      }

      try {
        const obs = await this.noaa.getCurrentObservations(stationLat, stationLon);
        observations.push({
          stationId: obs.stationId || station.id,
          latitude: stationLat,
          longitude: stationLon,
          timestamp: obs.timestamp || new Date().toISOString(),
          temperature: celsiusFromNoaa(obs.temperature?.value),
          windSpeed: mpsFromNoaa(obs.windSpeed?.value),
          precipitation: inchesFromNoaa(obs.precipitationLastHour?.value),
        });
      } catch {
        stationFetchFailures++;
      }
    }

    if (observations.length === 0 && stationFetchFailures > 0) {
      throw new Error('NOAA observations unavailable for candidate stations');
    }

    return observations;
  }
}

export class ForecastVerificationService {
  private readonly observationProvider: ObservationProvider;
  private readonly allowObservationOverride: boolean;
  private readonly maxGridAxisSize: number;
  private readonly maxObservationCount: number;
  private readonly observationTimeToleranceMs: number;

  constructor(options: ForecastVerificationServiceOptions = {}) {
    this.observationProvider =
      options.observationProvider || new NoaaObservationProvider();
    this.allowObservationOverride = options.allowObservationOverride || false;
    this.maxGridAxisSize = options.maxGridAxisSize || DEFAULT_MAX_GRID_AXIS_SIZE;
    this.maxObservationCount =
      options.maxObservationCount || DEFAULT_MAX_OBSERVATION_COUNT;
    this.observationTimeToleranceMs =
      options.observationTimeToleranceMs || DEFAULT_OBSERVATION_TOLERANCE_MS;
  }

  async verifyForecast(
    input: ForecastVerificationRequest
  ): Promise<ForecastVerificationReport> {
    validateRequest(input, this.maxGridAxisSize);
    const parsedWindow = parseTimeRange(input.validTimeRange);
    const usesObservationOverride =
      Array.isArray(input.observations) && input.observations.length > 0;

    let rawObservations: StationObservation[];
    if (usesObservationOverride) {
      if (!this.allowObservationOverride) {
        throw new VerificationValidationError(
          'observations override is not allowed for this verification endpoint'
        );
      }
      rawObservations = input.observations;
    } else {
      try {
        rawObservations = await this.observationProvider.fetchObservations(
          input.domainBounds,
          input.validTimeRange
        );
      } catch {
        throw new VerificationUpstreamError(
          'Failed to fetch observations from NOAA observation provider'
        );
      }
    }

    if (rawObservations.length > this.maxObservationCount) {
      throw new VerificationValidationError(
        `Too many observations submitted; max allowed is ${this.maxObservationCount}`
      );
    }

    const cleaned = normalizeObservations(
      rawObservations,
      input.domainBounds,
      parsedWindow,
      usesObservationOverride ? 0 : this.observationTimeToleranceMs
    );

    if (!cleaned.observations.length) {
      if (!usesObservationOverride) {
        throw new VerificationUpstreamError(
          'No usable NOAA observations found for requested forecast window/domain'
        );
      }
      throw new VerificationValidationError(
        'No observations available for forecast verification in requested domain/time.'
      );
    }

    const temperaturePairs = cleaned.observations.map(observation => {
      const predicted = nearestNeighbor(
        input.grid.temperature,
        observation.latitude,
        observation.longitude
      );
      return { predicted, observed: observation.temperature };
    });

    const windPairs = cleaned.observations.map(observation => {
      const predicted = nearestNeighbor(
        input.grid.windSpeed,
        observation.latitude,
        observation.longitude
      );
      return { predicted, observed: observation.windSpeed };
    });

    const precipPairs = cleaned.observations.map(observation => {
      const predicted = nearestNeighbor(
        input.grid.precipitation,
        observation.latitude,
        observation.longitude
      );
      return { predicted, observed: observation.precipitation };
    });

    const continuous = {
      temperature: continuousMetrics(temperaturePairs),
      windSpeed: continuousMetrics(windPairs),
    };

    const categorical = {
      precipitation: PRECIP_THRESHOLDS_IN.map(threshold =>
        categoricalMetrics(precipPairs, threshold)
      ),
    };

    const skillInputs = deriveSkillInputs(precipPairs);

    const hashPayload = {
      schemaVersion: '1.0.0',
      forecastRef: input.forecastRef,
      validTimeRange: input.validTimeRange,
      domainBounds: input.domainBounds,
      stationCount: cleaned.observations.length,
      qualityControl: {
        rawObservationCount: rawObservations.length,
        uniqueStationCount: cleaned.observations.length,
        qcRejectedCount: cleaned.rejectedCount,
        observationWindowUsed: input.validTimeRange,
      },
      continuous,
      categorical,
      skillInputs,
    };

    const reportHash = sha256Hex(canonicalJson(hashPayload));

    const report: ForecastVerificationReport = {
      ...hashPayload,
      reportHash,
      reportId: `fvr_${reportHash.slice(0, 16)}`,
      brier_score: skillInputs.brier_score,
      crps_score: skillInputs.crps_score,
      forecast_probability: skillInputs.forecast_probability,
      observed_outcome: skillInputs.observed_outcome,
      forecast_skill: skillInputs.forecast_skill,
      producedAt: new Date().toISOString(),
      producer: 'wrfcoin-backend.forecast-verification',
    };

    return report;
  }
}

function nearestNeighbor(
  field: ForecastField,
  latitude: number,
  longitude: number
): number {
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestValue = 0;

  for (let y = 0; y < field.latitudes.length; y++) {
    for (let x = 0; x < field.longitudes.length; x++) {
      const cellValue = field.values[y][x];
      if (!isFiniteNumber(cellValue)) {
        throw new VerificationValidationError('Grid contains non-finite numeric values');
      }

      const dLat = field.latitudes[y] - latitude;
      const dLon = field.longitudes[x] - longitude;
      const distance = dLat * dLat + dLon * dLon;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestValue = cellValue;
      }
    }
  }

  return bestValue;
}

function continuousMetrics(
  pairs: Array<{ predicted: number; observed: number }>
): ContinuousMetric {
  const count = pairs.length;
  if (count === 0) {
    throw new VerificationValidationError('At least one observation pair is required');
  }

  const errors = pairs.map(pair => pair.predicted - pair.observed);
  const absErrors = errors.map(Math.abs);
  const squaredErrors = errors.map(error => error * error);

  const mae = absErrors.reduce((sum, value) => sum + value, 0) / count;
  const rmse = Math.sqrt(squaredErrors.reduce((sum, value) => sum + value, 0) / count);
  const bias = errors.reduce((sum, value) => sum + value, 0) / count;

  if (!isFiniteNumber(mae) || !isFiniteNumber(rmse) || !isFiniteNumber(bias)) {
    throw new VerificationValidationError('Computed continuous metrics are not finite');
  }

  return {
    mae: round(mae),
    rmse: round(rmse),
    bias: round(bias),
  };
}

function categoricalMetrics(
  pairs: Array<{ predicted: number; observed: number }>,
  thresholdIn: number
): PrecipCategoricalMetric {
  let hits = 0;
  let misses = 0;
  let falseAlarms = 0;

  for (const pair of pairs) {
    const forecastEvent = pair.predicted >= thresholdIn;
    const observedEvent = pair.observed >= thresholdIn;
    if (forecastEvent && observedEvent) {
      hits++;
    } else if (!forecastEvent && observedEvent) {
      misses++;
    } else if (forecastEvent && !observedEvent) {
      falseAlarms++;
    }
  }

  const podDenominator = hits + misses;
  const farDenominator = hits + falseAlarms;
  const csiDenominator = hits + misses + falseAlarms;

  return {
    thresholdIn,
    pod: round(podDenominator > 0 ? hits / podDenominator : 0),
    far: round(farDenominator > 0 ? falseAlarms / farDenominator : 0),
    csi: round(csiDenominator > 0 ? hits / csiDenominator : 0),
  };
}

function deriveSkillInputs(
  precipPairs: Array<{ predicted: number; observed: number }>
): ForecastSkillInputs {
  const threshold = PRECIP_THRESHOLDS_IN[0];
  const binaryPairs = precipPairs.map(pair => ({
    forecast: pair.predicted >= threshold ? 1 : 0,
    observed: pair.observed >= threshold ? 1 : 0,
  }));

  const forecastProbability =
    binaryPairs.reduce((sum, pair) => sum + pair.forecast, 0) / binaryPairs.length;
  const observedOutcome =
    binaryPairs.reduce((sum, pair) => sum + pair.observed, 0) / binaryPairs.length;

  const brier = brierScore(binaryPairs);
  const crps = crpsApprox(precipPairs);
  const forecastSkill = clamp01(((1 - brier) + (1 - crps)) / 2);

  return {
    brier_score: round(clamp01(brier)),
    crps_score: round(crps),
    forecast_probability: round(clamp01(forecastProbability)),
    observed_outcome: round(clamp01(observedOutcome)),
    forecast_skill: round(forecastSkill),
  };
}

function validateRequest(input: ForecastVerificationRequest, maxGridAxisSize: number): void {
  if (!input || typeof input !== 'object') {
    throw new VerificationValidationError('request body must be a JSON object');
  }

  if (!nonEmptyString(input.forecastRef?.cid)) {
    throw new VerificationValidationError('forecastRef.cid is required');
  }
  if (!nonEmptyString(input.forecastRef?.model)) {
    throw new VerificationValidationError('forecastRef.model is required');
  }
  if (!nonEmptyString(input.forecastRef?.runId)) {
    throw new VerificationValidationError('forecastRef.runId is required');
  }

  parseTimeRange(input.validTimeRange);
  validateDomainBounds(input.domainBounds);

  if (!input.grid?.temperature || !input.grid?.windSpeed || !input.grid?.precipitation) {
    throw new VerificationValidationError(
      'grid fields (temperature, windSpeed, precipitation) are required'
    );
  }

  validateForecastField('temperature', input.grid.temperature, maxGridAxisSize);
  validateForecastField('windSpeed', input.grid.windSpeed, maxGridAxisSize);
  validateForecastField('precipitation', input.grid.precipitation, maxGridAxisSize);
}

function parseTimeRange(range: ValidTimeRange): { startMs: number; endMs: number } {
  if (!nonEmptyString(range?.start) || !nonEmptyString(range?.end)) {
    throw new VerificationValidationError(
      'validTimeRange.start and validTimeRange.end are required'
    );
  }

  const startMs = Date.parse(range.start);
  const endMs = Date.parse(range.end);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new VerificationValidationError('validTimeRange timestamps must be valid ISO strings');
  }
  if (startMs >= endMs) {
    throw new VerificationValidationError('validTimeRange.start must be before validTimeRange.end');
  }
  if (endMs - startMs > MAX_VALID_WINDOW_MS) {
    throw new VerificationValidationError('validTimeRange exceeds max supported 72-hour window');
  }

  return { startMs, endMs };
}

function validateDomainBounds(bounds: DomainBounds): void {
  if (!bounds) {
    throw new VerificationValidationError('domainBounds is required');
  }

  const { north, south, east, west } = bounds;
  if (
    !isFiniteNumber(north) ||
    !isFiniteNumber(south) ||
    !isFiniteNumber(east) ||
    !isFiniteNumber(west)
  ) {
    throw new VerificationValidationError('domainBounds values must be finite numbers');
  }
  if (north <= south) {
    throw new VerificationValidationError('domainBounds.north must be greater than south');
  }
  if (east <= west) {
    throw new VerificationValidationError('domainBounds.east must be greater than west');
  }
  if (north > 90 || south < -90 || east > 180 || west < -180) {
    throw new VerificationValidationError('domainBounds are outside valid lat/lon ranges');
  }
}

function validateForecastField(
  name: string,
  field: ForecastField,
  maxGridAxisSize: number
): void {
  if (!Array.isArray(field.latitudes) || field.latitudes.length === 0) {
    throw new VerificationValidationError(`grid.${name}.latitudes must be a non-empty array`);
  }
  if (!Array.isArray(field.longitudes) || field.longitudes.length === 0) {
    throw new VerificationValidationError(`grid.${name}.longitudes must be a non-empty array`);
  }
  if (field.latitudes.length > maxGridAxisSize || field.longitudes.length > maxGridAxisSize) {
    throw new VerificationValidationError(
      `grid.${name} dimensions exceed max axis size ${maxGridAxisSize}`
    );
  }
  if (!Array.isArray(field.values) || field.values.length !== field.latitudes.length) {
    throw new VerificationValidationError(
      `grid.${name}.values row count must match latitudes length`
    );
  }

  field.latitudes.forEach((value, index) => {
    if (!isFiniteNumber(value) || value < -90 || value > 90) {
      throw new VerificationValidationError(
        `grid.${name}.latitudes[${index}] must be a valid latitude`
      );
    }
  });

  field.longitudes.forEach((value, index) => {
    if (!isFiniteNumber(value) || value < -180 || value > 180) {
      throw new VerificationValidationError(
        `grid.${name}.longitudes[${index}] must be a valid longitude`
      );
    }
  });

  field.values.forEach((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== field.longitudes.length) {
      throw new VerificationValidationError(
        `grid.${name}.values[${rowIndex}] column count must match longitudes length`
      );
    }
    row.forEach((value, colIndex) => {
      if (!isFiniteNumber(value)) {
        throw new VerificationValidationError(
          `grid.${name}.values[${rowIndex}][${colIndex}] must be finite`
        );
      }
    });
  });
}

function normalizeObservations(
  observations: StationObservation[],
  domainBounds: DomainBounds,
  validWindow: { startMs: number; endMs: number },
  timeToleranceMs: number
): { observations: StationObservation[]; rejectedCount: number } {
  const deduped = new Map<string, StationObservation>();
  let rejectedCount = 0;

  for (const observation of observations) {
    if (!nonEmptyString(observation?.stationId)) {
      rejectedCount++;
      continue;
    }
    if (
      !isFiniteNumber(observation.latitude) ||
      !isFiniteNumber(observation.longitude) ||
      !isFiniteNumber(observation.temperature) ||
      !isFiniteNumber(observation.windSpeed) ||
      !isFiniteNumber(observation.precipitation) ||
      observation.precipitation < 0
    ) {
      rejectedCount++;
      continue;
    }

    const timestampMs = Date.parse(observation.timestamp);
    if (!Number.isFinite(timestampMs)) {
      rejectedCount++;
      continue;
    }

    const inDomain =
      observation.latitude <= domainBounds.north &&
      observation.latitude >= domainBounds.south &&
      observation.longitude >= domainBounds.west &&
      observation.longitude <= domainBounds.east;
    const inWindow =
      timestampMs >= validWindow.startMs - timeToleranceMs &&
      timestampMs <= validWindow.endMs + timeToleranceMs;

    if (!inDomain || !inWindow) {
      rejectedCount++;
      continue;
    }

    const key = `${observation.stationId}|${new Date(timestampMs).toISOString()}`;
    if (deduped.has(key)) {
      rejectedCount++;
      continue;
    }

    deduped.set(key, {
      ...observation,
      timestamp: new Date(timestampMs).toISOString(),
      precipitation: round(observation.precipitation),
    });
  }

  const cleaned = Array.from(deduped.values()).sort((a, b) => {
    if (a.stationId !== b.stationId) {
      return a.stationId.localeCompare(b.stationId);
    }
    return a.timestamp.localeCompare(b.timestamp);
  });

  return {
    observations: cleaned,
    rejectedCount,
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => canonicalize(item));
  }

  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }

  return value;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function celsiusFromNoaa(value: number | null | undefined): number {
  if (!isFiniteNumber(value)) {
    return 0;
  }
  return value;
}

function mpsFromNoaa(value: number | null | undefined): number {
  if (!isFiniteNumber(value)) {
    return 0;
  }
  return value;
}

function inchesFromNoaa(value: number | null | undefined): number {
  if (!isFiniteNumber(value)) {
    return 0;
  }
  // NOAA precipitation values are often in mm.
  return round(value / 25.4);
}
