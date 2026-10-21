/**
 * Boundary validation for incoming weather observation data.
 *
 * Combines canonical type normalization with physics-plausibility checks.
 * All external weather data (API submissions, IoT payloads, legacy formats)
 * should pass through validateWeatherObservation before being stored or forwarded.
 */

import type { WeatherObservation } from '../generated-types/index.js';
import {
  validatePhysics,
  DEFAULT_PHYSICS_POLICY,
  type PhysicsRangePolicy,
} from '../../server/services/physics-validation.js';

export interface WeatherValidationResult {
  valid: boolean;
  errors: string[];
  normalized: WeatherObservation;
}

/**
 * Validate a partial weather observation against physics-plausibility bounds.
 *
 * Returns a normalized `WeatherObservation` with nulls for missing fields,
 * plus a list of physics errors (empty when valid).
 *
 * Range bounds default to WMO earth-record extremes (see DEFAULT_PHYSICS_POLICY).
 */
export function validateWeatherObservation(
  data: Partial<WeatherObservation>,
  policy: PhysicsRangePolicy = DEFAULT_PHYSICS_POLICY,
): WeatherValidationResult {
  const normalized: WeatherObservation = {
    temperature_c: data.temperature_c ?? null,
    humidity_percent: data.humidity_percent ?? null,
    pressure_hpa: data.pressure_hpa ?? null,
    wind_speed_ms: data.wind_speed_ms ?? null,
    wind_direction_deg: data.wind_direction_deg ?? null,
    precipitation_mm: data.precipitation_mm ?? null,
    dewpoint_c: data.dewpoint_c ?? null,
    visibility_m: data.visibility_m ?? null,
  };

  const validationReading = {
    temperatureC: normalized.temperature_c,
    pressureHpa: normalized.pressure_hpa,
    humidityPct: normalized.humidity_percent,
    windSpeedMs: normalized.wind_speed_ms,
    timestampUnix: Math.trunc(Date.now() / 1000),
  };

  const violations = validatePhysics(validationReading, null, policy);
  const errors = violations.map(v => {
    switch (v.type) {
      case 'TemperatureOutOfRange':
        return `temperature_c ${v.valueC} out of range [${v.min}, ${v.max}]`;
      case 'PressureOutOfRange':
        return `pressure_hpa ${v.valueHpa} out of range [${v.min}, ${v.max}]`;
      case 'HumidityOutOfRange':
        return `humidity_percent ${v.valuePct} out of range [${v.min}, ${v.max}]`;
      case 'WindSpeedExceedsMaximum':
        return `wind_speed_ms ${v.valueMs} exceeds maximum ${v.max}`;
      case 'TemperatureRateExceeded':
        return `temperature change ${v.deltaC.toFixed(1)}°C exceeds limit ${v.limit.toFixed(1)}°C`;
      case 'CrossParameterInconsistency':
        return v.detail;
      default:
        return `physics violation: ${JSON.stringify(v)}`;
    }
  });

  return { valid: errors.length === 0, errors, normalized };
}
