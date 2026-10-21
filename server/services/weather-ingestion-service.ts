import { z } from 'zod';
import { weatherLogger } from '../utils/logger.js';
import {
  newDurableId,
  resolveIdempotencyKey,
  routeDurableStore,
} from '../../shared/route-durable-store.js';
import {
  canonicalizeWeatherPayloadForApi,
  type CanonicalWeatherPayloadResult,
} from '../../shared/weather-payload-canonical.js';
import { recordWeatherPayloadFormatMetric } from '../utils/metrics.js';
import {
  persistWeatherSubmission,
  type WeatherSubmissionTransportMeta,
} from './weather-submission-persistence.js';

export const weatherDataSchema = z
  .object({
    stationId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'stationId must be alphanumeric with hyphens/underscores'),
    timestamp: z.string(),
    temperature: z.number().optional(),
    humidity: z.number().optional(),
    pressure: z.number().optional(),
    windSpeed: z.number().optional(),
    windDirection: z.number().optional().default(0),
    precipitation: z.number().optional(),
    dewpoint: z.number().optional(),
    visibility: z.number().optional(),
    uvIndex: z.number().optional(),
    airQuality: z.number().optional(),
  })
  .refine(
    data =>
      [
        data.temperature,
        data.humidity,
        data.pressure,
        data.windSpeed,
        data.precipitation,
        data.dewpoint,
      ].some(value => typeof value === 'number'),
    'At least one weather measurement is required'
  );

export type WeatherData = z.infer<typeof weatherDataSchema>;

export interface WeatherIngestionOptions {
  route: string;
  payload: unknown;
  idempotencyKey?: unknown;
  transportMeta?: WeatherSubmissionTransportMeta;
}

export interface WeatherIngestionResult {
  status: number;
  body: Record<string, unknown>;
  canonicalized: CanonicalWeatherPayloadResult;
}

function sameWeatherPayload(duplicate: Record<string, unknown>, validatedData: Record<string, unknown>) {
  return (
    JSON.stringify({
      stationId: duplicate.stationId,
      timestamp: duplicate.timestamp,
      temperature: duplicate.temperature,
      humidity: duplicate.humidity,
      pressure: duplicate.pressure,
      windSpeed: duplicate.windSpeed,
      windDirection: duplicate.windDirection,
      precipitation: duplicate.precipitation,
      visibility: duplicate.visibility,
      uvIndex: duplicate.uvIndex,
      airQuality: duplicate.airQuality,
    }) === JSON.stringify(validatedData)
  );
}

export async function ingestWeatherPayload(
  options: WeatherIngestionOptions
): Promise<WeatherIngestionResult> {
  const canonicalized = canonicalizeWeatherPayloadForApi(options.payload);
  recordWeatherPayloadFormatMetric(options.route, canonicalized.telemetry);
  if (canonicalized.telemetry) {
    weatherLogger.warn('Legacy weather payload aliases ingested', {
      ...canonicalized.telemetry,
      route: options.route,
    });
    weatherLogger.info(canonicalized.telemetry.event, {
      ...canonicalized.telemetry,
      route: options.route,
    });
  }

  const validatedData = weatherDataSchema.parse(canonicalized.normalizedLegacyRecord);
  const idempotencyKey = resolveIdempotencyKey(options.idempotencyKey);
  if (idempotencyKey) {
    const prior = await routeDurableStore.getIdempotency('weather:data:create', idempotencyKey);
    if (prior) {
      return {
        status: prior.status,
        body: {
          ...(prior.responseBody as Record<string, unknown>),
          replayed: true,
        },
        canonicalized,
      };
    }
  }

  const writeResult = await routeDurableStore.write(state => {
    const duplicate = Object.values(state.weather.records).find(
      record =>
        record.stationId === validatedData.stationId &&
        record.timestamp === validatedData.timestamp
    );

    if (duplicate) {
      if (!sameWeatherPayload(duplicate as unknown as Record<string, unknown>, validatedData as unknown as Record<string, unknown>)) {
        return {
          status: 409,
          body: {
            error: 'Conflicting weather sample already exists for stationId and timestamp',
            existingDataId: duplicate.id,
          },
        };
      }

      return {
        status: 200,
        body: {
          success: true,
          weatherData: duplicate,
          id: duplicate.id,
          duplicate: true,
        },
      };
    }

    const id = newDurableId('weather');
    const record = {
      id,
      ...validatedData,
      canonicalPayload: canonicalized.canonicalPayload,
      submittedAt: new Date().toISOString(),
      ...(options.transportMeta ? { transportMeta: options.transportMeta } : {}),
    };
    state.weather.records[id] = record;
    return {
      status: 201,
      body: {
        success: true,
        weatherData: record,
        id,
      },
    };
  });

  if (writeResult.status === 201) {
    const createdId = String(writeResult.body.id);

    try {
      const persistedSubmission = await persistWeatherSubmission({
        ...(writeResult.body.weatherData as WeatherData),
        transportMeta: options.transportMeta,
      });

      const persistedRecord = {
        ...(writeResult.body.weatherData as Record<string, unknown>),
        persistence: persistedSubmission,
      } as Record<string, unknown>;

      await routeDurableStore.write(state => {
        const existingRecord = state.weather.records[createdId];
        if (existingRecord) {
          state.weather.records[createdId] = {
            ...existingRecord,
            persistence: persistedSubmission,
          };
        }
        return {
          status: 200,
          body: null,
        };
      });

      writeResult.body = {
        ...writeResult.body,
        weatherData: persistedRecord,
      } as any;
    } catch (error) {
      await routeDurableStore.write(state => {
        delete state.weather.records[createdId];
        return {
          status: 200,
          body: null,
        };
      });
      throw error;
    }
  }

  if (idempotencyKey) {
    await routeDurableStore.putIdempotency(
      'weather:data:create',
      idempotencyKey,
      writeResult.status,
      writeResult.body
    );
  }

  return {
    status: writeResult.status,
    body: writeResult.body,
    canonicalized,
  };
}
