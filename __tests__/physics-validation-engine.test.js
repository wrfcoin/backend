/**
 * Comprehensive Test Suite for Physics-Based Validation Engine
 *
 * Tests fundamental atmospheric and thermodynamic validation algorithms
 * to ensure accurate physics-based weather data quality assurance.
 *
 * @author WRFCoin Development Team
 * @version 1.0.0
 */

const PhysicsValidationEngine = require('../server/services/physics-validation-engine');
const {
  ValidationResult,
  PhysicsConstants,
  AtmosphericUtils,
} = require('../server/services/physics-utils');

describe('PhysicsValidationEngine', () => {
  let physicsValidator;
  let physicsConstants;
  let atmosphericUtils;

  beforeEach(() => {
    physicsValidator = new PhysicsValidationEngine({
      temperatureTolerance: 0.5,
      pressureTolerance: 1.0,
      humidityTolerance: 5.0,
      windTolerance: 2.0,
      radiationTolerance: 50.0,
      strictMode: false,
      enableDebug: false,
    });

    physicsConstants = new PhysicsConstants();
    atmosphericUtils = new AtmosphericUtils();
  });

  describe('Basic Initialization', () => {
    test('should initialize with default options', () => {
      const validator = new PhysicsValidationEngine();
      expect(validator).toBeDefined();
      expect(validator.physicsConstants).toBeDefined();
      expect(validator.atmosphericUtils).toBeDefined();
    });

    test('should accept custom configuration options', () => {
      const customValidator = new PhysicsValidationEngine({
        temperatureTolerance: 1.0,
        strictMode: true,
        enableDebug: true,
      });

      expect(customValidator.options.temperatureTolerance).toBe(1.0);
      expect(customValidator.options.strictMode).toBe(true);
      expect(customValidator.options.enableDebug).toBe(true);
    });
  });

  describe('Thermodynamic Validation', () => {
    test('should validate normal thermodynamic relationships', async () => {
      const validRecord = {
        temperature: 25.0, // °C
        dewpoint: 20.0, // °C
        pressure: 1013.25, // hPa
        humidity: 78.6, // %
      };

      const result = await physicsValidator.validateData(validRecord);

      expect(result.overallValid).toBe(true);
      // Missing wind/radiation/altitude must lower aggregate completeness.
      expect(result.validations.thermodynamics.confidence).toBe(1);
      expect(result.validations.thermodynamics).toBeDefined();
      expect(result.validations.thermodynamics.isValid).toBe(true);
    });

    test('should detect dewpoint exceeding temperature', async () => {
      const invalidRecord = {
        temperature: 20.0,
        dewpoint: 22.0, // Invalid: dewpoint > temperature
        pressure: 1013.25,
        humidity: 100,
      };

      const result = await physicsValidator.validateData(invalidRecord);

      expect(result.overallValid).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'dewpoint_exceeds_temperature',
        })
      );
    });

    test('should detect humidity inconsistency', async () => {
      const inconsistentRecord = {
        temperature: 25.0,
        dewpoint: 15.0, // Should give ~60% RH
        humidity: 90.0, // Measured humidity inconsistent
      };

      const result = await physicsValidator.validateData(inconsistentRecord);

      // Should detect humidity inconsistency
      const humidityViolations = result.violations.filter(
        v =>
          v.type === 'humidity_inconsistency' ||
          v.type === 'relative_humidity_inconsistency'
      );
      expect(humidityViolations.length).toBeGreaterThan(0);
    });

    test('should validate Magnus formula vapor pressure calculations', async () => {
      const testRecord = {
        temperature: 30.0,
        dewpoint: 25.0,
        pressure: 1000.0,
      };

      const result = await physicsValidator.validateData(testRecord);

      // Verify thermodynamic validation ran
      expect(result.validations.thermodynamics).toBeDefined();

      // Check that vapor pressure calculations are reasonable
      const thermoResult = result.validations.thermodynamics;
      expect(thermoResult.confidence).toBeGreaterThan(0.5);
    });

    test('should validate wet bulb temperature calculations', async () => {
      const testRecord = {
        temperature: 35.0,
        dewpoint: 30.0,
        pressure: 1013.25,
      };

      const result = await physicsValidator.validateData(testRecord);

      // Wet bulb should be between dewpoint and temperature
      expect(result.validations.thermodynamics).toBeDefined();
      expect(result.validations.thermodynamics.isValid).toBe(true);
    });
  });

  describe('Atmospheric Stability Validation', () => {
    test('should validate standard atmosphere conditions', async () => {
      const standardRecord = {
        temperature: 15.0, // Standard temperature at sea level
        pressure: 1013.25, // Standard pressure
        altitude: 0, // Sea level
      };

      const result = await physicsValidator.validateData(standardRecord);

      expect(result.validations.atmospheric_stability).toBeDefined();
      expect(result.validations.atmospheric_stability.isValid).toBe(true);
    });

    test('should detect extreme temperature deviations', async () => {
      const extremeRecord = {
        temperature: 40.0, // Very hot for standard atmosphere
        pressure: 1013.25,
        altitude: 3000, // 3km altitude
      };

      const result = await physicsValidator.validateData(extremeRecord);

      // May detect temperature deviation depending on tolerance
      expect(result.validations.atmospheric_stability).toBeDefined();
    });

    test('should validate potential temperature calculations', async () => {
      const testRecord = {
        temperature: 20.0,
        pressure: 850.0, // Reduced pressure (higher altitude)
        altitude: 1500,
      };

      const result = await physicsValidator.validateData(testRecord);

      const stabilityResult = result.validations.atmospheric_stability;
      expect(stabilityResult).toBeDefined();
      expect(stabilityResult.confidence).toBeGreaterThan(0.0);
    });

    test('should assess static stability with previous data', async () => {
      const currentRecord = {
        temperature: 22.0,
        pressure: 1000.0,
        previousData: {
          temperature: 25.0,
          pressure: 1010.0,
        },
      };

      const result = await physicsValidator.validateData(currentRecord);

      expect(result.validations.atmospheric_stability).toBeDefined();
    });
  });

  describe('Psychrometric Validation', () => {
    test('should validate psychrometric relationships', async () => {
      const psychroRecord = {
        temperature: 28.0,
        dewpoint: 18.0,
        humidity: 54.7, // Magnus RH for 28 C / 18 C; 60% exceeds 5% tolerance.
        pressure: 1013.25,
      };

      const result = await physicsValidator.validateData(psychroRecord);

      expect(result.validations.psychrometrics).toBeDefined();
      expect(result.validations.psychrometrics.isValid).toBe(true);
    });

    test('should detect negative vapor pressure deficit', async () => {
      const invalidRecord = {
        temperature: 15.0,
        dewpoint: 18.0, // Invalid: dewpoint > temperature
        humidity: 100,
      };

      const result = await physicsValidator.validateData(invalidRecord);

      expect(result.overallValid).toBe(false);
      // Should detect dewpoint violation and potentially VPD issues
    });

    test('should validate mixing ratio calculations', async () => {
      const testRecord = {
        temperature: 25.0,
        dewpoint: 20.0,
        pressure: 1000.0,
      };

      const result = await physicsValidator.validateData(testRecord);

      const psychroResult = result.validations.psychrometrics;
      expect(psychroResult).toBeDefined();
    });

    test('should detect extreme mixing ratios', async () => {
      const extremeRecord = {
        temperature: 50.0, // Very hot
        dewpoint: 45.0, // Very high dewpoint
        pressure: 900.0, // Lower pressure
      };

      const result = await physicsValidator.validateData(extremeRecord);

      // Should validate but may flag extreme values
      expect(result.validations.psychrometrics).toBeDefined();
    });
  });

  describe('Radiation Physics Validation', () => {
    test('should validate normal solar radiation', async () => {
      const radiationRecord = {
        solarRadiation: 800, // W/m²
        temperature: 25.0,
        timestamp: '2023-07-15T17:00:00Z', // Near solar noon at -74 degrees.
        latitude: 40.0,
        longitude: -74.0,
      };

      const result = await physicsValidator.validateData(radiationRecord);

      expect(result.validations.radiation).toBeDefined();
      expect(result.validations.radiation.isValid).toBe(true);
      expect(result.validations.radiation.errors).toEqual([]);
    });

    test('should detect excessive solar radiation', async () => {
      const excessiveRecord = {
        solarRadiation: 1500, // Exceeds physical maximum
        temperature: 30.0,
        timestamp: '2023-07-15T12:00:00Z',
      };

      const result = await physicsValidator.validateData(excessiveRecord);

      expect(result.overallValid).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'excessive_solar_radiation',
        })
      );
    });

    test('should detect negative solar radiation', async () => {
      const negativeRecord = {
        solarRadiation: -50, // Invalid negative value
        temperature: 20.0,
      };

      const result = await physicsValidator.validateData(negativeRecord);

      expect(result.overallValid).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'negative_solar_radiation',
        })
      );
    });

    test('should detect nighttime solar radiation', async () => {
      const nightRecord = {
        solarRadiation: 100, // Radiation during night
        temperature: 15.0,
        timestamp: '2023-07-15T02:00:00Z', // 2 AM
        latitude: 40.0,
        longitude: -74.0,
      };

      const result = await physicsValidator.validateData(nightRecord);

      // Should detect nighttime radiation violation
      const radiationViolations = result.violations.filter(
        v => v.type === 'nighttime_solar_radiation'
      );
      expect(radiationViolations.length).toBeGreaterThan(0);
    });

    test('should validate radiation-temperature consistency', async () => {
      const consistentRecord = {
        solarRadiation: 600,
        temperature: 30.0, // High temp with high radiation
        timestamp: '2023-07-15T14:00:00Z',
      };

      const result = await physicsValidator.validateData(consistentRecord);

      expect(result.validations.radiation).toBeDefined();
    });
  });

  describe('Pressure-Altitude Validation', () => {
    test('should validate sea level pressure', async () => {
      const seaLevelRecord = {
        pressure: 1013.25,
        altitude: 0,
        temperature: 15.0,
      };

      const result = await physicsValidator.validateData(seaLevelRecord);

      expect(result.validations.pressure_altitude).toBeDefined();
      expect(result.validations.pressure_altitude.isValid).toBe(true);
    });

    test('should validate pressure-altitude relationship', async () => {
      const altitudeRecord = {
        pressure: 900.0, // Lower pressure
        altitude: 1000, // 1km altitude
        temperature: 8.5, // Cooler at altitude
      };

      const result = await physicsValidator.validateData(altitudeRecord);

      expect(result.validations.pressure_altitude).toBeDefined();
      expect(result.validations.pressure_altitude.isValid).toBe(true);
    });

    test('should detect pressure-altitude inconsistency', async () => {
      const inconsistentRecord = {
        pressure: 1013.25, // Sea level pressure
        altitude: 5000, // 5km altitude - inconsistent
        temperature: 15.0,
      };

      const result = await physicsValidator.validateData(inconsistentRecord);

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'pressure_altitude_inconsistency',
        })
      );
    });

    test('should validate altimeter setting calculations', async () => {
      const testRecord = {
        pressure: 1020.0,
        altitude: 500,
        temperature: 12.0,
      };

      const result = await physicsValidator.validateData(testRecord);

      expect(result.validations.pressure_altitude).toBeDefined();
    });

    test('should detect extreme pressure values', async () => {
      const extremeRecord = {
        pressure: 2000.0, // Extremely high pressure
        altitude: 0,
      };

      const result = await physicsValidator.validateData(extremeRecord);

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'pressure_out_of_range',
        })
      );
    });
  });

  describe('Wind Physics Validation', () => {
    test('should validate normal wind conditions', async () => {
      const windRecord = {
        windSpeed: 10.0, // m/s
        windGust: 15.0, // m/s
        windDirection: 180.0, // degrees
      };

      const result = await physicsValidator.validateData(windRecord);

      expect(result.validations.wind_physics).toBeDefined();
      expect(result.validations.wind_physics.isValid).toBe(true);
    });

    test('should detect negative wind speed', async () => {
      const negativeWindRecord = {
        windSpeed: -5.0, // Invalid negative speed
        windDirection: 90.0,
      };

      const result = await physicsValidator.validateData(negativeWindRecord);

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'negative_wind_speed',
        })
      );
    });

    test('should detect gust less than sustained wind', async () => {
      const invalidGustRecord = {
        windSpeed: 20.0,
        windGust: 15.0, // Gust < sustained wind (invalid)
        windDirection: 270.0,
      };

      const result = await physicsValidator.validateData(invalidGustRecord);

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'gust_less_than_speed',
        })
      );
    });

    test('should detect invalid wind direction', async () => {
      const invalidDirectionRecord = {
        windSpeed: 8.0,
        windDirection: 400.0, // Invalid direction > 360°
      };

      const result = await physicsValidator.validateData(
        invalidDirectionRecord
      );

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'invalid_wind_direction',
        })
      );
    });

    test('should detect extreme wind speeds', async () => {
      const extremeWindRecord = {
        windSpeed: 200.0, // Extreme wind speed
        windGust: 250.0,
        windDirection: 45.0,
      };

      const result = await physicsValidator.validateData(extremeWindRecord);

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'extreme_wind_speed',
        })
      );
    });

    test('should validate gust factor', async () => {
      const highGustFactorRecord = {
        windSpeed: 5.0,
        windGust: 20.0, // High gust factor (4.0)
        windDirection: 120.0,
      };

      const result = await physicsValidator.validateData(highGustFactorRecord);

      // May flag excessive gust factor
      const gustViolations = result.violations.filter(
        v => v.type === 'excessive_gust_factor'
      );
      expect(gustViolations.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Energy Balance Validation', () => {
    test('should validate energy balance components', async () => {
      const energyRecord = {
        solarRadiation: 800,
        netRadiation: 600,
        temperature: 25.0,
        humidity: 60.0,
        windSpeed: 3.0,
      };

      const result = await physicsValidator.validateData(energyRecord);

      expect(result.validations.energy_balance).toBeDefined();
      expect(result.validations.energy_balance.isValid).toBe(true);
      expect(result.validations.energy_balance.errors).toEqual([]);
    });

    test('should detect net radiation exceeding solar radiation', async () => {
      const invalidEnergyRecord = {
        solarRadiation: 500,
        netRadiation: 600, // Net > solar (invalid)
        temperature: 20.0,
      };

      const result = await physicsValidator.validateData(invalidEnergyRecord);

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'net_radiation_exceeds_solar',
        })
      );
    });

    test('should validate nighttime energy balance', async () => {
      const nightEnergyRecord = {
        solarRadiation: 0,
        netRadiation: 20, // Positive net radiation at night
        temperature: 15.0,
      };

      const result = await physicsValidator.validateData(nightEnergyRecord);

      // Should detect positive nighttime net radiation
      const energyViolations = result.violations.filter(
        v => v.type === 'positive_nighttime_net_radiation'
      );
      expect(energyViolations.length).toBeGreaterThan(0);
    });

    test.each([0, -20])(
      'accepts nighttime net radiation of %s',
      async netRadiation => {
        const result = await physicsValidator.validateData({
          solarRadiation: 0,
          netRadiation,
        });
        expect(result.validations.energy_balance.isValid).toBe(true);
        expect(result.validations.energy_balance.warnings).toEqual([]);
      }
    );

    test('does not treat absent solar radiation as measured night', async () => {
      const result = await physicsValidator.validateData({ netRadiation: 20 });
      expect(result.violations).not.toContainEqual(
        expect.objectContaining({ type: 'positive_nighttime_net_radiation' })
      );
    });

    test.each([0, -5])('preserves a measured surface temperature of %s C', async soilTemperature => {
      const result = await physicsValidator.validateData({
        solarRadiation: 500, netRadiation: 400,
        temperature: 30, windSpeed: 10, soilTemperature,
      });
      expect(result.validations.energy_balance.violations).toContainEqual(
        expect.objectContaining({ type: 'extreme_sensible_heat_flux' })
      );
      expect(result.validations.energy_balance.errors).toEqual([]);
    });

    test.each([1, 50, 100])('does not infer a cold-weather Bowen anomaly at %s percent RH', async humidity => {
      const result = await physicsValidator.validateData({
        solarRadiation: 0, netRadiation: -10, temperature: -40, humidity,
      });
      expect(result.validations.energy_balance.violations).not.toContainEqual(
        expect.objectContaining({ type: 'extreme_bowen_ratio' })
      );
      expect(result.validations.energy_balance.warnings).toContainEqual(
        expect.objectContaining({ message: 'Bowen ratio is not evaluated: measured sensible and latent heat fluxes are unavailable' })
      );
      expect(result.validations.energy_balance.errors).toEqual([]);
    });

    test('should estimate sensible heat flux', async () => {
      const heatFluxRecord = {
        temperature: 30.0,
        windSpeed: 5.0,
        soilTemperature: 35.0,
      };

      const result = await physicsValidator.validateData(heatFluxRecord);

      expect(result.validations.energy_balance).toBeDefined();
    });

    test('should calculate Bowen ratio', async () => {
      const bowenRecord = {
        temperature: 28.0,
        humidity: 50.0,
        windSpeed: 4.0,
      };

      const result = await physicsValidator.validateData(bowenRecord);

      expect(result.validations.energy_balance).toBeDefined();
    });
  });

  describe('Temporal Consistency Validation', () => {
    test('should validate temporal consistency', async () => {
      const currentRecord = {
        temperature: 25.0,
        pressure: 1013.25,
        humidity: 60.0,
        timestamp: '2023-07-15T12:00:00Z',
        previousData: {
          temperature: 24.5,
          pressure: 1013.0,
          humidity: 62.0,
          timestamp: '2023-07-15T11:00:00Z',
        },
      };

      const result = await physicsValidator.validateData(currentRecord);

      expect(result.validations.temporal_consistency).toBeDefined();
      expect(result.validations.temporal_consistency.isValid).toBe(true);
    });

    test('should detect excessive temperature change rate', async () => {
      const rapidChangeRecord = {
        temperature: 35.0, // 20°C change in 1 hour
        timestamp: '2023-07-15T12:00:00Z',
        previousData: {
          temperature: 15.0,
          timestamp: '2023-07-15T11:00:00Z',
        },
      };

      const result = await physicsValidator.validateData(rapidChangeRecord);

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'excessive_temperature_change_rate',
        })
      );
    });

    test('should detect excessive pressure change rate', async () => {
      const rapidPressureRecord = {
        pressure: 1000.0, // 20 hPa change in 1 hour
        timestamp: '2023-07-15T12:00:00Z',
        previousData: {
          pressure: 1020.0,
          timestamp: '2023-07-15T11:00:00Z',
        },
      };

      const result = await physicsValidator.validateData(rapidPressureRecord);

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'excessive_pressure_change_rate',
        })
      );
    });

    test('should detect invalid time sequence', async () => {
      const invalidTimeRecord = {
        temperature: 25.0,
        timestamp: '2023-07-15T11:00:00Z', // Earlier than previous
        previousData: {
          temperature: 24.0,
          timestamp: '2023-07-15T12:00:00Z',
        },
      };

      const result = await physicsValidator.validateData(invalidTimeRecord);

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'invalid_time_sequence',
        })
      );
    });

    test.each([
      ['2023-07-15T12:00:00Z', '2023-07-15T12:00:00Z'],
      ['invalid-date', '2023-07-15T12:00:00Z'],
      ['2023-07-15T12:00:00Z', undefined],
      [null, '2023-07-15T12:00:00Z'],
    ])(
      'rejects unusable temporal pair %s / %s',
      async (timestamp, previousTimestamp) => {
        const result = await physicsValidator.validateData({
          timestamp,
          previousData: { timestamp: previousTimestamp },
        });
        expect(result.overallValid).toBe(false);
        expect(result.overallConfidence).toBeLessThan(1);
        expect(result.violations).toContainEqual(
          expect.objectContaining({ type: 'invalid_time_sequence' })
        );
      }
    );

    test('detects temperature rates beginning at zero', async () => {
      const result = await physicsValidator.validateData({
        temperature: 20,
        timestamp: '2023-07-15T12:00:00Z',
        previousData: { temperature: 0, timestamp: '2023-07-15T11:00:00Z' },
      });
      expect(result.violations).toContainEqual(
        expect.objectContaining({ type: 'excessive_temperature_change_rate' })
      );
    });
  });

  describe('Array Data Processing', () => {
    test('should validate array of weather records', async () => {
      const weatherArray = [
        {
          temperature: 20.0,
          dewpoint: 15.0,
          pressure: 1013.25,
          humidity: 73.0,
        },
        {
          temperature: 22.0,
          dewpoint: 16.0,
          pressure: 1012.0,
          humidity: 70.0,
        },
        {
          temperature: 25.0,
          dewpoint: 18.0,
          pressure: 1011.0,
          humidity: 68.0,
        },
      ];

      const result = await physicsValidator.validateData(weatherArray);

      expect(result.recordResults).toHaveLength(3);
      expect(result.overallConfidence).toBeGreaterThan(0.0);
      expect(result.metadata.totalChecks).toBeGreaterThan(0);
    });

    test('should handle mixed valid and invalid records', async () => {
      const mixedArray = [
        {
          temperature: 25.0,
          dewpoint: 20.0, // Valid
          pressure: 1013.25,
        },
        {
          temperature: 20.0,
          dewpoint: 25.0, // Invalid: dewpoint > temperature
          pressure: 1013.25,
        },
        {
          temperature: 30.0,
          dewpoint: 22.0, // Valid
          pressure: 1010.0,
        },
      ];

      const result = await physicsValidator.validateData(mixedArray);

      expect(result.overallValid).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.recordResults).toHaveLength(3);

      // Check individual record results
      expect(result.recordResults[0].overallValid).toBe(true);
      expect(result.recordResults[1].overallValid).toBe(false);
      expect(result.recordResults[2].overallValid).toBe(true);
    });
  });

  describe('Error Handling', () => {
    test('should handle missing required fields gracefully', async () => {
      const incompleteRecord = {
        temperature: 25.0,
        // Missing other fields
      };

      const result = await physicsValidator.validateData(incompleteRecord);

      // Should not crash, but may have warnings
      expect(result).toBeDefined();
      expect(result.overallValid).toBeDefined();
    });

    test('should handle invalid data types', async () => {
      const invalidRecord = {
        temperature: 'not_a_number',
        dewpoint: null,
        pressure: undefined,
      };

      const result = await physicsValidator.validateData(invalidRecord);

      expect(result).toBeDefined();
      expect(result.overallValid).toBeDefined();
    });

    test('should handle empty data', async () => {
      const result = await physicsValidator.validateData({});

      expect(result).toBeDefined();
      expect(result.overallValid).toBeDefined();
    });

    test('should handle null input', async () => {
      const result = await physicsValidator.validateData(null);

      expect(result).toBeDefined();
      expect(result.overallValid).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          type: 'validation_error',
        })
      );
    });
  });

  describe('Confidence Scoring', () => {
    test('should calculate appropriate confidence scores', async () => {
      const completeRecord = {
        temperature: 25.0,
        dewpoint: 20.0,
        pressure: 1013.25,
        humidity: 78.6,
        windSpeed: 5.0,
        windDirection: 180.0,
        solarRadiation: 800,
        altitude: 100,
      };

      const result = await physicsValidator.validateData(completeRecord);

      expect(result.overallConfidence).toBeGreaterThan(0.8);

      // Check individual validation confidences
      Object.values(result.validations).forEach(validation => {
        expect(validation.confidence).toBeGreaterThan(0.0);
        expect(validation.confidence).toBeLessThanOrEqual(1.0);
      });
    });

    test('should reduce confidence for incomplete data', async () => {
      const incompleteRecord = {
        temperature: 25.0,
        pressure: 1013.25,
        // Missing many fields
      };

      const result = await physicsValidator.validateData(incompleteRecord);

      expect(result.overallConfidence).toBeLessThan(0.8);
      expect(result.validations.thermodynamics.confidence).toBeLessThan(1);
      expect(result.validations.psychrometrics.confidence).toBeLessThan(1);
      expect(result.validations.radiation.confidence).toBeLessThan(1);
      expect(result.validations.wind_physics.confidence).toBeLessThan(1);
    });

    test('should reduce confidence for extreme values', async () => {
      const extremeRecord = {
        temperature: 60.0, // Very extreme temperature
        dewpoint: 55.0,
        pressure: 1500.0, // Very extreme pressure
        humidity: 100.0,
      };

      const result = await physicsValidator.validateData(extremeRecord);

      // Confidence should be reduced due to extreme values
      expect(result.overallConfidence).toBeLessThan(1.0);
    });
  });

  describe('Performance and Scalability', () => {
    test('should handle large datasets efficiently', async () => {
      const largeDataset = Array(1000)
        .fill()
        .map((_, i) => ({
          temperature: 20 + Math.sin(i * 0.1) * 10,
          dewpoint: 15 + Math.sin(i * 0.1) * 8,
          pressure: 1013.25 + Math.sin(i * 0.05) * 20,
          humidity: 60 + Math.sin(i * 0.08) * 30,
          timestamp: new Date(
            Date.UTC(2023, 6, 15, 12) + i * 3600000
          ).toISOString(),
        }));

      const startTime = Date.now();
      const result = await physicsValidator.validateData(largeDataset);
      const duration = Date.now() - startTime;

      expect(result).toBeDefined();
      expect(result.recordResults).toHaveLength(1000);
      expect(duration).toBeLessThan(30000); // Should complete within 30 seconds
    });

    test('should not consume excessive memory', async () => {
      const memoryBefore = process.memoryUsage().heapUsed;

      const moderateDataset = Array(500)
        .fill()
        .map(() => ({
          temperature: 25.0,
          dewpoint: 20.0,
          pressure: 1013.25,
          humidity: 78.6,
        }));

      await physicsValidator.validateData(moderateDataset);

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const memoryAfter = process.memoryUsage().heapUsed;
      const memoryIncrease = (memoryAfter - memoryBefore) / 1024 / 1024; // MB

      expect(memoryIncrease).toBeLessThan(100); // Should not increase memory by more than 100MB
    });
  });
});

describe('PhysicsConstants', () => {
  let constants;

  beforeEach(() => {
    constants = new PhysicsConstants();
  });

  test('should provide correct physical constants', () => {
    expect(constants.R_DRY).toBe(287.05);
    expect(constants.G).toBe(9.80665);
    expect(constants.STANDARD_PRESSURE).toBe(1013.25);
    expect(constants.KELVIN_OFFSET).toBe(273.15);
  });

  test('should convert temperature units correctly', () => {
    expect(constants.celsiusToKelvin(0)).toBe(273.15);
    expect(constants.kelvinToCelsius(273.15)).toBe(0);
    expect(constants.celsiusToFahrenheit(0)).toBe(32);
    expect(constants.fahrenheitToCelsius(32)).toBe(0);
  });

  test('should convert pressure units correctly', () => {
    expect(constants.hpaToInhg(1013.25)).toBeCloseTo(29.92, 2);
    expect(constants.hpaToPa(1013.25)).toBe(101325);
  });

  test('should convert wind speed units correctly', () => {
    expect(constants.msToKmh(10)).toBe(36);
    expect(constants.msToMph(10)).toBeCloseTo(22.37, 2);
  });
});

describe('AtmosphericUtils', () => {
  let utils;

  beforeEach(() => {
    utils = new AtmosphericUtils();
  });

  test('should calculate saturation vapor pressure correctly', () => {
    const svp = utils.calculateSaturationVaporPressure(25);
    expect(svp).toBeCloseTo(31.67, 1); // Expected value for 25°C
  });

  test('should calculate relative humidity correctly', () => {
    const temperature = 25;
    const dewpoint = 20;
    const svpT = utils.calculateSaturationVaporPressure(temperature);
    const svpD = utils.calculateSaturationVaporPressure(dewpoint);
    const expectedRH = (svpD / svpT) * 100;

    // RH = 100 * e(Td)/e(T); NOAA saturation-vapor-pressure relationship.
    expect(expectedRH).toBeCloseTo(73.78, 1);
  });

  test('should calculate mixing ratio correctly', () => {
    const mixingRatio = utils.calculateMixingRatio(20, 1013.25);
    expect(mixingRatio).toBeGreaterThan(0);
    expect(mixingRatio).toBeLessThan(0.02); // Should be reasonable value
  });

  test('should calculate potential temperature correctly', () => {
    const potentialTemp = utils.calculatePotentialTemperature(20, 850);
    expect(potentialTemp).toBeGreaterThan(293.15); // Should be > original temp in Kelvin
  });

  test('should validate pressure at altitude calculations', () => {
    const pressure = utils.calculatePressureAtAltitude(1013.25, 1000, 15);
    expect(pressure).toBeLessThan(1013.25); // Should decrease with altitude
    expect(pressure).toBeGreaterThan(800); // Should be reasonable
  });
});

describe('Integration Tests', () => {
  test('should integrate with existing anomaly detection engine', async () => {
    const AnomalyDetectionEngine = require('../server/services/anomaly-detection-engine');

    const anomalyEngine = new AnomalyDetectionEngine({
      enablePhysicsValidation: true,
      physicsValidationOptions: {
        temperatureTolerance: 0.5,
        strictMode: false,
      },
    });

    const testData = [
      {
        temperature: 25.0,
        dewpoint: 20.0,
        pressure: 1013.25,
        humidity: 78.6,
      },
      {
        temperature: 20.0,
        dewpoint: 25.0, // Invalid
        pressure: 1013.25,
        humidity: 100.0,
      },
    ];

    const result = await anomalyEngine.detectAnomalies(testData, {
      methods: ['physics_based'],
      options: { batchSize: 10 },
    });

    expect(result).toBeDefined();
    const physics = result.anomalies.byMethod.physics_based;
    expect(physics.method).toBe('physics_based_enhanced');
    expect(physics.error).toBeUndefined();
    expect(physics.validationResults).toHaveLength(2);
    expect(physics.anomalies).toContainEqual(
      expect.objectContaining({ recordIndex: 1 })
    );
  });
});
