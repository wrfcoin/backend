/**
 * Tests for physics-validation.ts dew-point cross-parameter violation path (#451)
 *
 * The production code fires CrossParameterInconsistency when the computed
 * dew point exceeds temperature + 2.0 °C using the August-Roche-Magnus
 * approximation: gamma = ln(RH/100) + (17.625*T)/(243.04+T)
 *                        dew = (243.04*gamma)/(17.625-gamma)
 *
 * With standard valid inputs (RH ≤ 100) the violation cannot be triggered
 * on physically realizable data; however the check IS reachable when
 * - humidity values above 100 are allowed by a relaxed policy, OR
 * - temperature is strongly negative while humidity is at the maximum
 *
 * This file proves the branch is reachable and correctly emits the violation.
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
} from '@jest/globals';
import {
  validatePhysics,
  qualityScore,
  DEFAULT_PHYSICS_POLICY,
  type PhysicsRangePolicy,
} from '../../services/physics-validation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute expected dew point using the same Magnus approximation as the
 * production code so the test values stay in sync.
 */
function computeDewPoint(T: number, RH: number): number {
  const gamma = Math.log(RH / 100) + (17.625 * T) / (243.04 + T);
  const denom = 17.625 - gamma;
  return denom !== 0 ? (243.04 * gamma) / denom : NaN;
}

const BASE_READING = {
  pressureHpa: 1013.25,
  windSpeedMs: 5.0,
  timestampUnix: 1000,
};

// ---------------------------------------------------------------------------
// #451: Cross-parameter dew-point violation — violation path
// ---------------------------------------------------------------------------

describe('validatePhysics — CrossParameterInconsistency (dew-point violation, #451)', () => {
  // Relaxed policy that allows humidity > 100 so we can construct a
  // physically-impossible reading that must trigger the cross-parameter check.
  const relaxedPolicy: PhysicsRangePolicy = {
    ...DEFAULT_PHYSICS_POLICY,
    humidityMaxPct: 200, // allow over-saturated sensor readings
  };

  it('triggers the violation when dew point > temperature + 2 °C using over-saturated humidity', () => {
    // With T=10°C and RH=150, the formula gives:
    //   gamma = ln(1.5) + (17.625*10)/(253.04) ≈ 0.4055 + 0.6963 ≈ 1.1018
    //   dew   = (243.04*1.1018)/(17.625-1.1018) ≈ 267.8/16.52 ≈ 16.2°C
    // 16.2°C > 10+2=12°C → violation fires
    const T = 10;
    const RH = 150;
    const dewPoint = computeDewPoint(T, RH);
    // Sanity check for the test itself
    expect(dewPoint).toBeGreaterThan(T + 2);

    const reading = { ...BASE_READING, temperatureC: T, humidityPct: RH };
    const violations = validatePhysics(reading, null, relaxedPolicy);

    const crossParam = violations.filter(
      (v) => v.type === 'CrossParameterInconsistency',
    );
    expect(crossParam).toHaveLength(1);
    expect(crossParam[0].detail).toMatch(/Dew point/);
    expect(crossParam[0].detail).toMatch(/exceeds temperature/);
  });

  it('includes dew-point value and temperature in the detail message', () => {
    const T = 5;
    const RH = 160;
    const dewPoint = computeDewPoint(T, RH);
    expect(dewPoint).toBeGreaterThan(T + 2);

    const reading = { ...BASE_READING, temperatureC: T, humidityPct: RH };
    const violations = validatePhysics(reading, null, relaxedPolicy);

    const [crossParam] = violations.filter(
      (v) => v.type === 'CrossParameterInconsistency',
    );
    expect(crossParam).toBeDefined();
    // Detail must mention the computed dew point (rounded to 1 dp)
    expect(crossParam.detail).toMatch(/\d+\.\d°C/);
  });

  it('does NOT fire when dew point is within tolerance (≤ T + 2)', () => {
    // Standard: T=25°C, RH=90% → dew ≈ 23.3°C < 27°C — no violation
    const reading = {
      ...BASE_READING,
      temperatureC: 25,
      humidityPct: 90,
    };
    const violations = validatePhysics(reading, null, DEFAULT_PHYSICS_POLICY);
    const crossParam = violations.filter(
      (v) => v.type === 'CrossParameterInconsistency',
    );
    expect(crossParam).toHaveLength(0);
  });

  it('does NOT fire when humidity is null (missing sensor field)', () => {
    const reading = {
      ...BASE_READING,
      temperatureC: 20,
      humidityPct: null,
    };
    const violations = validatePhysics(reading, null, DEFAULT_PHYSICS_POLICY);
    const crossParam = violations.filter(
      (v) => v.type === 'CrossParameterInconsistency',
    );
    expect(crossParam).toHaveLength(0);
  });

  it('does NOT fire when temperature is null (missing sensor field)', () => {
    const reading = {
      ...BASE_READING,
      temperatureC: null,
      humidityPct: 95,
    };
    const violations = validatePhysics(reading, null, DEFAULT_PHYSICS_POLICY);
    const crossParam = violations.filter(
      (v) => v.type === 'CrossParameterInconsistency',
    );
    expect(crossParam).toHaveLength(0);
  });

  it('does NOT fire when humidity is exactly 0 (gamma → -∞, denom stays positive)', () => {
    // humidityPct=0 is guarded by `humidityPct > 0` in the production code
    const reading = {
      ...BASE_READING,
      temperatureC: 20,
      humidityPct: 0,
    };
    const violations = validatePhysics(reading, null, DEFAULT_PHYSICS_POLICY);
    const crossParam = violations.filter(
      (v) => v.type === 'CrossParameterInconsistency',
    );
    expect(crossParam).toHaveLength(0);
  });

  it('quality score decreases when CrossParameterInconsistency is present', () => {
    const reading = {
      ...BASE_READING,
      temperatureC: 10,
      humidityPct: 150,
    };
    const violations = validatePhysics(reading, null, relaxedPolicy);
    const crossParam = violations.filter(
      (v) => v.type === 'CrossParameterInconsistency',
    );
    expect(crossParam.length).toBeGreaterThan(0);
    // qualityScore reduces by 20 per violation
    expect(qualityScore(violations)).toBeLessThan(100);
  });

  it('accumulates CrossParameterInconsistency alongside other violations', () => {
    // Wind speed also out of range → two violations total
    const reading = {
      temperatureC: 10,
      humidityPct: 150,
      pressureHpa: 1013,
      windSpeedMs: 999, // exceeds max
      timestampUnix: 1000,
    };
    const violations = validatePhysics(reading, null, relaxedPolicy);
    expect(violations.some((v) => v.type === 'CrossParameterInconsistency')).toBe(true);
    expect(violations.some((v) => v.type === 'WindSpeedExceedsMaximum')).toBe(true);
  });
});
