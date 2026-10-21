/**
 * Canonical weather data types for the backend.
 *
 * WeatherObservation is generated from the meteo-types Rust crate and serves as the
 * single source of truth for observation field names and units (SI/WMO).
 *
 * Layer-specific types (API, controller, DTO) extend or compose WeatherObservation
 * with metadata relevant to their layer.
 */

import type { WeatherObservation } from '../generated-types/index.js';

export type { WeatherObservation } from '../generated-types/index.js';

/**
 * A weather data record combining a canonical observation with station and location metadata.
 *
 * Observation fields are snake_case with explicit SI units (from Rust WeatherObservation):
 * temperature_c, humidity_percent, pressure_hpa, wind_speed_ms, wind_direction_deg,
 * precipitation_mm, dewpoint_c, visibility_m.
 */
export interface WeatherData extends WeatherObservation {
  stationId: string;
  timestamp: Date;
  location?: {
    lat: number;
    lon: number;
    name?: string;
  };
  validated?: boolean;
}

/**
 * Extended weather reading for controller input — adds optional extended sensor fields.
 */
export interface ControllerWeatherReading extends WeatherData {
  solarRadiation?: number;
  uvIndex?: number;
  airQuality?: number;
}

/**
 * Weather reading in the commit-reveal pipeline wire format.
 * Field names align with WeatherObservation (snake_case + SI units).
 * The index signature accommodates legacy/extra fields from older clients.
 */
export interface CommitRevealReading extends Partial<WeatherObservation> {
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * Normalize a raw commit-reveal reading, mapping legacy field names
 * (e.g., humidity_pct) to canonical names (humidity_percent).
 */
export function normalizeCommitRevealReading(raw: Record<string, unknown>): CommitRevealReading {
  const result: CommitRevealReading = { ...raw };
  if (result.humidity_pct !== undefined && result.humidity_percent === undefined) {
    result.humidity_percent = result.humidity_pct as number | null;
    delete result.humidity_pct;
  }
  return result;
}

/**
 * Inter-service weather data transfer object with nested location and data structure.
 */
export interface WeatherDataDTO {
  stationId: string;
  location: {
    lat: number;
    lng: number;
    city: string;
    country: string;
  };
  data: Pick<WeatherObservation, 'temperature_c' | 'humidity_percent' | 'pressure_hpa' | 'wind_speed_ms' | 'wind_direction_deg'>;
  timestamp: string;
  validated: boolean;
}
