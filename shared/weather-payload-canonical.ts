export const WEATHER_SCHEMA_V1 = 'wrf.weather.observation.v1';

import type { WeatherObservation } from './generated-types/index.js';
export type { WeatherObservation } from './generated-types/index.js';

type JsonObject = Record<string, unknown>;
type SensorMap = Record<string, number>;

export type CanonicalWeatherObservation = {
  temperature_c?: WeatherObservation['temperature_c'];
  humidity?: WeatherObservation['humidity_percent'];
  pressure_hpa?: WeatherObservation['pressure_hpa'];
  wind_speed_ms?: WeatherObservation['wind_speed_ms'];
  precipitation?: WeatherObservation['precipitation_mm'];
  dewpoint_c?: WeatherObservation['dewpoint_c'];
};

export interface CanonicalWeatherPayload {
  schema_version: typeof WEATHER_SCHEMA_V1;
  station_id?: string;
  observed_at_unix?: number;
  observation: CanonicalWeatherObservation;
}

export interface LegacyFormatTelemetry {
  event: 'legacy-format-detected';
  schemaVersion: typeof WEATHER_SCHEMA_V1;
  source: 'canonical-v1' | 'legacy-observation' | 'legacy-flat';
  legacyKeys: string[];
}

export interface CanonicalWeatherPayloadResult {
  canonicalPayload: CanonicalWeatherPayload;
  normalizedLegacyRecord: {
    stationId?: string;
    timestamp?: string;
    temperature?: number;
    humidity?: number;
    pressure?: number;
    windSpeed?: number;
    windDirection?: number;
    precipitation?: number;
    dewpoint?: number;
    visibility?: number;
    uvIndex?: number;
    airQuality?: number;
  };
  telemetry?: LegacyFormatTelemetry;
}

export interface CanonicalSensorReading {
  type: string;
  value: number;
  unit: string;
  status: 'active';
}

const ALIAS_KEYS: Record<keyof CanonicalWeatherObservation, string[]> = {
  temperature_c: ['temperature', 'temp_c', 'temperature_celsius'],
  humidity: ['relative_humidity', 'humidity_percent'],
  pressure_hpa: ['pressure'],
  wind_speed_ms: ['windSpeed', 'wind_speed'],
  precipitation: ['rainfall', 'precip_mm', 'precipitation_mm'],
  dewpoint_c: ['dewpoint', 'dew_point'],
};

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function pickString(object: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function pickNumber(object: JsonObject, keys: string[]): number | undefined {
  for (const key of keys) {
    const parsed = finiteNumber(object[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function pickObservedAtUnix(object: JsonObject): number | undefined {
  const direct = pickNumber(object, ['observed_at_unix', 'observedAtUnix']);
  if (direct !== undefined) {
    return Math.trunc(direct);
  }

  const timestamp = object.timestamp;
  if (typeof timestamp === 'string' && timestamp.trim().length > 0) {
    const millis = Date.parse(timestamp);
    if (Number.isFinite(millis)) {
      return Math.trunc(millis / 1000);
    }
  }
  return undefined;
}

function sensorDataMap(payload: JsonObject): SensorMap {
  const sensorData = payload.sensorData;
  if (!Array.isArray(sensorData)) {
    return {};
  }

  const out: SensorMap = {};
  for (const sensor of sensorData) {
    const sensorObject = asObject(sensor);
    if (!sensorObject) {
      continue;
    }
    const rawType = sensorObject.type;
    const value = finiteNumber(sensorObject.value);
    if (typeof rawType !== 'string' || value === undefined) {
      continue;
    }
    out[rawType.trim().toLowerCase()] = value;
  }
  return out;
}

function collectLegacyKeys(payload: JsonObject, observation: JsonObject): string[] {
  const keys = new Set<string>();

  for (const [canonicalKey, aliases] of Object.entries(ALIAS_KEYS)) {
    if (observation[canonicalKey] !== undefined) {
      continue;
    }
    for (const alias of aliases) {
      if (observation[alias] !== undefined) {
        keys.add(alias);
      }
    }
  }

  if (payload.schema !== undefined) {
    keys.add('schema');
  }
  if (payload.weather_schema_version !== undefined) {
    keys.add('weather_schema_version');
  }
  if (payload.stationId !== undefined && payload.station_id === undefined) {
    keys.add('stationId');
  }
  if (
    payload.observedAtUnix !== undefined &&
    payload.observed_at_unix === undefined
  ) {
    keys.add('observedAtUnix');
  }

  return [...keys].sort();
}

export function canonicalizeWeatherPayloadForApi(
  input: unknown,
  options?: { stationIdFallback?: string }
): CanonicalWeatherPayloadResult {
  const rootObject = asObject(input) || {};
  const payload = asObject(rootObject.data) || rootObject;
  const observationObject = asObject(payload.observation) || payload;
  const sensors = sensorDataMap(payload);

  const observation: CanonicalWeatherObservation = {
    temperature_c:
      pickNumber(observationObject, ['temperature_c', ...ALIAS_KEYS.temperature_c]) ??
      sensors.temperature,
    humidity:
      pickNumber(observationObject, ['humidity', ...ALIAS_KEYS.humidity]) ??
      sensors.humidity,
    pressure_hpa:
      pickNumber(observationObject, ['pressure_hpa', ...ALIAS_KEYS.pressure_hpa]) ??
      sensors.pressure,
    wind_speed_ms:
      pickNumber(observationObject, ['wind_speed_ms', ...ALIAS_KEYS.wind_speed_ms]) ??
      sensors.windspeed ??
      sensors.wind_speed,
    precipitation:
      pickNumber(observationObject, ['precipitation', ...ALIAS_KEYS.precipitation]) ??
      sensors.precipitation ??
      sensors.rainfall,
    dewpoint_c:
      pickNumber(observationObject, ['dewpoint_c', ...ALIAS_KEYS.dewpoint_c]) ??
      sensors.dewpoint,
  };

  const stationId =
    pickString(payload, ['station_id', 'stationId']) ?? options?.stationIdFallback;
  const observedAtUnix = pickObservedAtUnix(payload);

  const normalizedLegacyRecord = {
    stationId,
    timestamp:
      (typeof payload.timestamp === 'string' ? payload.timestamp : undefined) ??
      (observedAtUnix !== undefined
        ? new Date(observedAtUnix * 1000).toISOString()
        : undefined),
    temperature: observation.temperature_c,
    humidity: observation.humidity,
    pressure: observation.pressure_hpa,
    windSpeed: observation.wind_speed_ms,
    windDirection: pickNumber(payload, [
      'windDirection',
      'wind_direction',
      'wind_direction_deg',
    ]),
    precipitation: observation.precipitation,
    dewpoint: observation.dewpoint_c,
    visibility: pickNumber(payload, ['visibility']),
    uvIndex: pickNumber(payload, ['uvIndex', 'uv_index']),
    airQuality: pickNumber(payload, ['airQuality', 'air_quality']),
  };

  const canonicalPayload: CanonicalWeatherPayload = {
    schema_version: WEATHER_SCHEMA_V1,
    station_id: stationId,
    observed_at_unix: observedAtUnix,
    observation,
  };

  const schemaVersion = pickString(payload, [
    'schema_version',
    'schema',
    'weather_schema_version',
  ]);
  const source = schemaVersion === WEATHER_SCHEMA_V1
    ? 'canonical-v1'
    : payload.observation
      ? 'legacy-observation'
      : 'legacy-flat';
  const legacyKeys = collectLegacyKeys(payload, observationObject);

  return {
    canonicalPayload,
    normalizedLegacyRecord,
    telemetry:
      legacyKeys.length > 0
        ? {
            event: 'legacy-format-detected',
            schemaVersion: WEATHER_SCHEMA_V1,
            source,
            legacyKeys,
          }
        : undefined,
  };
}

const CANONICAL_SENSOR_MAP: Array<{
  key: keyof CanonicalWeatherObservation;
  type: string;
  unit: string;
}> = [
  { key: 'temperature_c', type: 'temperature', unit: 'celsius' },
  { key: 'humidity', type: 'humidity', unit: 'percent' },
  { key: 'pressure_hpa', type: 'pressure', unit: 'hpa' },
  { key: 'wind_speed_ms', type: 'windSpeed', unit: 'm/s' },
  { key: 'precipitation', type: 'precipitation', unit: 'mm' },
  { key: 'dewpoint_c', type: 'dewpoint', unit: 'celsius' },
];

export function canonicalObservationToSensorData(
  observation: CanonicalWeatherObservation
): CanonicalSensorReading[] {
  const readings: CanonicalSensorReading[] = [];
  for (const field of CANONICAL_SENSOR_MAP) {
    const value = observation[field.key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      readings.push({
        type: field.type,
        value,
        unit: field.unit,
        status: 'active',
      });
    }
  }
  return readings;
}
