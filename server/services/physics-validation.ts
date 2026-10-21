/**
 * Physics validation for weather readings.
 * Types generated from meteo-types Rust crate; logic stays in TypeScript.
 */

import type {
  PhysicsRangePolicy,
  PhysicsViolation,
  ValidationReading,
} from '../../shared/generated-types/index.js';

export type { PhysicsRangePolicy, PhysicsViolation, ValidationReading };

export const DEFAULT_PHYSICS_POLICY: PhysicsRangePolicy = {
  tempMinC: -89.2,
  tempMaxC: 70.7,
  pressureMinHpa: 870.0,
  pressureMaxHpa: 1085.0,
  humidityMinPct: 0.0,
  humidityMaxPct: 100.0,
  windSpeedMaxMs: 113.3,
  tempRateMaxCPerMin: 5.0,
};

/**
 * Validate a weather reading against physical bounds.
 * Mirrors the Rust validate_physics() in shared-protocol/src/weather/validation.rs.
 * All violations are collected (not short-circuited).
 */
export function validatePhysics(
  current: ValidationReading,
  prev: Pick<ValidationReading, 'temperatureC' | 'timestampUnix'> | null,
  policy: PhysicsRangePolicy = DEFAULT_PHYSICS_POLICY,
): PhysicsViolation[] {
  const violations: PhysicsViolation[] = [];

  // Temperature range
  if (current.temperatureC != null) {
    if (current.temperatureC < policy.tempMinC || current.temperatureC > policy.tempMaxC) {
      violations.push({
        type: 'TemperatureOutOfRange',
        valueC: current.temperatureC,
        min: policy.tempMinC,
        max: policy.tempMaxC,
      });
    }
  }

  // Pressure range
  if (current.pressureHpa != null) {
    if (current.pressureHpa < policy.pressureMinHpa || current.pressureHpa > policy.pressureMaxHpa) {
      violations.push({
        type: 'PressureOutOfRange',
        valueHpa: current.pressureHpa,
        min: policy.pressureMinHpa,
        max: policy.pressureMaxHpa,
      });
    }
  }

  // Humidity range
  if (current.humidityPct != null) {
    if (current.humidityPct < policy.humidityMinPct || current.humidityPct > policy.humidityMaxPct) {
      violations.push({
        type: 'HumidityOutOfRange',
        valuePct: current.humidityPct,
        min: policy.humidityMinPct,
        max: policy.humidityMaxPct,
      });
    }
  }

  // Wind speed maximum
  if (current.windSpeedMs != null && current.windSpeedMs > policy.windSpeedMaxMs) {
    violations.push({
      type: 'WindSpeedExceedsMaximum',
      valueMs: current.windSpeedMs,
      max: policy.windSpeedMaxMs,
    });
  }

  // Temperature rate-of-change (needs a previous reading with known timestamp)
  if (
    prev != null &&
    current.temperatureC != null &&
    prev.temperatureC != null
  ) {
    const dtMin = (current.timestampUnix - prev.timestampUnix) / 60;
    if (dtMin > 0) {
      const deltaC = Math.abs(current.temperatureC - prev.temperatureC);
      const limitC = policy.tempRateMaxCPerMin * dtMin;
      if (deltaC > limitC) {
        violations.push({ type: 'TemperatureRateExceeded', deltaC, limit: limitC });
      }
    }
  }

  // Cross-parameter: dew point must not exceed temperature + 2.0 °C
  // Uses the August-Roche-Magnus approximation (same as Rust port).
  if (
    current.temperatureC != null &&
    current.humidityPct != null &&
    current.humidityPct > 0
  ) {
    const T = current.temperatureC;
    const RH = current.humidityPct;
    const gamma = Math.log(RH / 100) + (17.625 * T) / (243.04 + T);
    const denom = 17.625 - gamma;
    if (denom !== 0) {
      const dewPoint = (243.04 * gamma) / denom;
      if (dewPoint > T + 2.0) {
        violations.push({
          type: 'CrossParameterInconsistency',
          detail: `Dew point ${dewPoint.toFixed(1)}°C exceeds temperature ${T.toFixed(1)}°C + 2.0°C tolerance`,
        });
      }
    }
  }

  return violations;
}

/** Quality score: 100 − 20 per violation, floored at 0. */
export function qualityScore(violations: PhysicsViolation[]): number {
  return Math.max(0, 100 - violations.length * 20);
}

/**
 * Convert a CommitRevealReading (snake_case, from wire format) to a
 * ValidationReading (camelCase, for physics validation).
 */
export function toValidationReading(
  reading: import('../../shared/types/weather-types.js').CommitRevealReading,
  timestampUnix?: number,
): ValidationReading {
  return {
    temperatureC: (reading.temperature_c as number) ?? null,
    pressureHpa: (reading.pressure_hpa as number) ?? null,
    humidityPct: (reading.humidity_percent as number) ?? null,
    windSpeedMs: (reading.wind_speed_ms as number) ?? null,
    timestampUnix: timestampUnix ?? (reading.timestamp
      ? Math.trunc(new Date(reading.timestamp).getTime() / 1000)
      : Math.trunc(Date.now() / 1000)),
  };
}
