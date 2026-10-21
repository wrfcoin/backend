import { createHash } from 'node:crypto';
import { executeQuery } from '../../database/index.js';
import type { WeatherData } from './weather-ingestion-service.js';

type QueryExecutor = (query: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface WeatherSubmissionTransportMeta {
  userId?: number | string | null;
  walletAddress?: string | null;
  deviceId?: string | null;
  source?: string | null;
  qualityScore?: number | null;
  rewardAmount?: number | string | null;
  physicsViolations?: unknown[] | null;
  location?: {
    latitude?: number | null;
    longitude?: number | null;
    altitude?: number | null;
  } | null;
}

export interface WeatherSubmissionPersistenceInput extends WeatherData {
  transportMeta?: WeatherSubmissionTransportMeta;
}

export interface PersistedWeatherSubmission {
  submissionId: number | null;
  submittedAt: string;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asFiniteInteger(value: unknown): number | null {
  const parsed = asFiniteNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function resolveUserId(
  executor: QueryExecutor,
  transportMeta?: WeatherSubmissionTransportMeta
): Promise<number | null> {
  const explicitUserId = asFiniteInteger(transportMeta?.userId);
  if (explicitUserId !== null) {
    return explicitUserId;
  }

  const walletAddress = asStringOrNull(transportMeta?.walletAddress);
  if (!walletAddress) {
    return null;
  }

  try {
    const lookup = await executor('SELECT id FROM users WHERE wallet_address = $1 LIMIT 1', [walletAddress]);
    return asFiniteInteger(lookup.rows[0]?.id);
  } catch {
    return null;
  }
}

function normalizeSubmittedAt(timestamp: string): string {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function normalizeQualityScore(value: unknown): number {
  const parsed = asFiniteNumber(value);
  if (parsed === null) {
    return 100;
  }
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function normalizeRewardAmount(value: unknown): string {
  const parsed = asFiniteNumber(value);
  return parsed === null ? '0' : parsed.toFixed(8);
}

function observationDigest(input: WeatherSubmissionPersistenceInput, submittedAt: string): string {
  const material = JSON.stringify([
    input.stationId,
    submittedAt,
    asFiniteNumber(input.temperature),
    asFiniteNumber(input.humidity),
    asFiniteNumber(input.pressure),
    asFiniteNumber(input.windSpeed),
    asFiniteNumber(input.windDirection),
    asFiniteNumber(input.precipitation),
    asFiniteNumber(input.dewpoint),
    asFiniteNumber(input.visibility),
    asFiniteNumber(input.uvIndex),
    asFiniteNumber(input.airQuality),
  ]);
  return createHash('sha256').update(material).digest('hex');
}

export async function persistWeatherSubmission(
  input: WeatherSubmissionPersistenceInput,
  deps: { execute?: QueryExecutor } = {}
): Promise<PersistedWeatherSubmission> {
  const executor = deps.execute ?? executeQuery;
  const transportMeta = input.transportMeta;
  const userId = await resolveUserId(executor, transportMeta);
  const walletAddress = asStringOrNull(transportMeta?.walletAddress);
  const location = transportMeta?.location ?? null;
  const submittedAt = normalizeSubmittedAt(input.timestamp);

  const insertResult = await executor(
    `WITH inserted_submission AS (
       INSERT INTO weather_submissions (
       user_id,
       wallet_address,
       device_id,
       station_id,
       latitude,
       longitude,
       altitude,
       temperature,
       humidity,
       pressure,
       wind_speed,
       wind_direction,
       rainfall,
       quality_score,
       reward_amount,
       physics_violations,
       source,
       submitted_at
       ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18::timestamptz
     )
       RETURNING id, station_id, submitted_at
     ),
     created_cycle AS (
       INSERT INTO station_reward_cycles (
         cycle_id,
         station_id,
         owner_address,
         observation_id,
         observation_digest,
         observation_observed_at,
         observation_accepted_at,
         lifecycle_state,
         evidence_refreshed_at
       )
       SELECT
         'weather-submission:' || inserted.id::text,
         inserted.station_id,
         station.owner_address,
         inserted.id::text,
         $19,
         inserted.submitted_at,
         inserted.submitted_at,
         'OBSERVATION_RECEIVED',
         now()
       FROM inserted_submission inserted
       JOIN weather_stations station
         ON station.station_id = inserted.station_id
       ON CONFLICT (station_id, observation_id) DO NOTHING
       RETURNING cycle_id
     )
     SELECT
       inserted.id,
       inserted.submitted_at,
       EXISTS (SELECT 1 FROM created_cycle) AS reward_cycle_created
     FROM inserted_submission inserted`,
    [
      userId,
      walletAddress,
      asStringOrNull(transportMeta?.deviceId),
      input.stationId,
      asFiniteNumber(location?.latitude),
      asFiniteNumber(location?.longitude),
      asFiniteNumber(location?.altitude),
      asFiniteNumber(input.temperature),
      asFiniteNumber(input.humidity),
      asFiniteNumber(input.pressure),
      asFiniteNumber(input.windSpeed),
      asFiniteNumber(input.windDirection),
      asFiniteNumber(input.precipitation),
      normalizeQualityScore(transportMeta?.qualityScore),
      normalizeRewardAmount(transportMeta?.rewardAmount),
      JSON.stringify(Array.isArray(transportMeta?.physicsViolations) ? transportMeta?.physicsViolations : []),
      asStringOrNull(transportMeta?.source) || 'api',
      submittedAt,
      observationDigest(input, submittedAt),
    ]
  );

  return {
    submissionId: asFiniteInteger(insertResult.rows[0]?.id),
    submittedAt: asStringOrNull(insertResult.rows[0]?.submitted_at) || submittedAt,
  };
}
