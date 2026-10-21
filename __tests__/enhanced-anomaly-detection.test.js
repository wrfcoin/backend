/**
 * Enhanced Anomaly Detection Engine Tests with Physics Validation
 *
 * Tests the integration between the anomaly detection engine and the
 * comprehensive physics validation system for weather data quality assurance.
 *
 * backend#1414: this suite was written against a result shape the engine never
 * returned (`result.results[]`, `result.success`, `result.timestamp`, a
 * `methods` filter and a nested `options.options.batchSize`). The engine
 * actually returns
 *   { metadata, anomalies: { byMethod: { <name>: {...} }, ensemble, summary },
 *     statistics, recommendations }
 * runs every registered method (there is no method filter) and reads
 * `options.batchSize`. Expectations were moved to that contract only where the
 * engine code proves it (see the comments naming the code behind each one).
 * Negative controls (invalid physics must be flagged) are kept.
 *
 * Findings that are NOT stale expectations are kept as `test.failing` and named
 * in the "Known gaps" block at the bottom.
 *
 * Lives in __tests__/ (the discovered root), not server/tests/ (never run by
 * `npm test`) and not server/__tests__/ (where
 * __tests__/server-js-suites-combined.test.ts pins an exact count of eight
 * suites).
 */

const AnomalyDetectionEngine = require('../server/services/anomaly-detection-engine');
const PhysicsValidationEngine = require('../server/services/physics-validation-engine');

// Physics results live under byMethod.physics_based (the method's own `method`
// label is 'physics_based_enhanced').
const physicsOf = result => result.anomalies.byMethod.physics_based;

// 2023-07-15 17:00Z is about solar noon at longitude -74 (13:00 EDT); 12:00Z is
// 08:00 EDT, when the sun is about 25 degrees up and 800 W/m2 is not physical.
const SOLAR_NOON = '2023-07-15T17:00:00Z';
const EARLY_MORNING = '2023-07-15T12:00:00Z';

// Shared by the Ensemble Methods tests and the #1468 Known gap below.
const mixedQualityData = [
  // Normal data points
  { temperature: 20.0, dewpoint: 15.0, pressure: 1013.0, humidity: 73.0 },
  { temperature: 21.0, dewpoint: 16.0, pressure: 1012.0, humidity: 75.0 },
  { temperature: 22.0, dewpoint: 17.0, pressure: 1011.0, humidity: 77.0 },

  // Statistical outlier but physically valid
  { temperature: 35.0, dewpoint: 25.0, pressure: 1010.0, humidity: 65.0 },

  // Physics violation
  {
    temperature: 15.0,
    dewpoint: 20.0,
    pressure: 1013.0,
    humidity: 100.0,
  },

  // Both statistical outlier and physics violation
  {
    temperature: -50.0,
    dewpoint: -45.0,
    pressure: 500.0,
    humidity: 200.0,
  },
];

describe('Enhanced Anomaly Detection with Physics Validation', () => {
  let anomalyEngine;

  beforeEach(() => {
    anomalyEngine = new AnomalyDetectionEngine({
      // Statistical detection parameters
      zScoreThreshold: 3.0,
      iqrMultiplier: 1.5,
      modifiedZScoreThreshold: 3.5,

      // Physics validation parameters
      temperatureTolerance: 0.5,
      pressureTolerance: 1.0,
      humidityTolerance: 5.0,
      windTolerance: 2.0,
      radiationTolerance: 50.0,
      strictMode: false,
      enableDebug: false,

      // Ensemble parameters
      ensembleThreshold: 0.6,
    });
  });

  describe('Result contract', () => {
    test('returns the byMethod / ensemble shape and runs the physics method', async () => {
      const result = await anomalyEngine.detectAnomalies([
        {
          temperature: 25.0,
          dewpoint: 20.0,
          pressure: 1013.25,
          humidity: 78.6,
          timestamp: SOLAR_NOON,
        },
      ]);

      expect(result.results).toBeUndefined();
      expect(result.metadata.recordCount).toBe(1);
      expect(typeof result.metadata.detectedAt).toBe('string');
      expect(result.metadata.detectionMethods).toEqual(
        expect.arrayContaining(['zscore', 'iqr', 'physics_based'])
      );
      expect(result.anomalies.byMethod.physics_based.method).toBe(
        'physics_based_enhanced'
      );
      expect(result.anomalies.ensemble.anomalies).toBeInstanceOf(Array);
      expect(result.statistics.methodsExecuted).toBe(
        result.metadata.detectionMethods.length
      );
    });

    test('rejects an empty dataset (negative control)', async () => {
      await expect(anomalyEngine.detectAnomalies([])).rejects.toThrow(
        'Invalid or empty dataset provided'
      );
    });
  });

  describe('Physics Validation Integration', () => {
    test('should initialize physics validator within anomaly engine', () => {
      expect(anomalyEngine.physicsValidator).toBeDefined();
      expect(anomalyEngine.physicsValidator).toBeInstanceOf(
        PhysicsValidationEngine
      );
    });

    test('should detect physics-based anomalies in single records', async () => {
      const invalidData = [
        {
          temperature: 20.0,
          dewpoint: 25.0, // Invalid: dewpoint > temperature
          pressure: 1013.25,
          humidity: 100.0,
          timestamp: EARLY_MORNING,
        },
      ];

      const result = await anomalyEngine.detectAnomalies(invalidData, {
        batchSize: 1,
      });

      const physicsResult = physicsOf(result);
      expect(physicsResult).toBeDefined();
      expect(physicsResult.anomalies.length).toBeGreaterThan(0);

      // Check for dewpoint violation
      const dewpointViolation = physicsResult.anomalies.find(a =>
        a.violations.includes('dewpoint_exceeds_temperature')
      );
      expect(dewpointViolation).toBeDefined();
    });

    test('should process multiple physics violations correctly', async () => {
      const multiViolationData = [
        {
          temperature: 15.0,
          dewpoint: 20.0, // Violation 1: dewpoint > temperature
          pressure: 2000.0, // Violation 2: extreme pressure
          humidity: 150.0, // Violation 3: humidity > 100%
          windSpeed: -5.0, // Violation 4: negative wind speed
          solarRadiation: 1500, // Violation 5: excessive solar radiation
          timestamp: EARLY_MORNING,
        },
      ];

      const result = await anomalyEngine.detectAnomalies(multiViolationData, {
        batchSize: 1,
      });

      const physicsResult = physicsOf(result);
      expect(physicsResult.anomalies.length).toBeGreaterThan(0);

      const anomaly = physicsResult.anomalies[0];
      expect(anomaly.violations).toEqual(
        expect.arrayContaining([
          'dewpoint_exceeds_temperature',
          'pressure_out_of_range',
          'negative_wind_speed',
          'excessive_solar_radiation',
        ])
      );
      expect(anomaly.severity).toBe('critical'); // Multiple violations should be critical
    });

    test('should handle valid physics data without false positives', async () => {
      // Solar noon: the original fixture used 12:00Z (08:00 local), where 800
      // W/m2 correctly trips radiation_exceeds_solar_angle_limit (see the
      // negative control below), so it was not a valid record.
      const validData = [
        {
          temperature: 25.0,
          dewpoint: 20.0,
          pressure: 1013.25,
          humidity: 78.6,
          windSpeed: 5.0,
          windGust: 8.0,
          windDirection: 180.0,
          solarRadiation: 800,
          altitude: 100,
          timestamp: SOLAR_NOON,
          latitude: 40.0,
          longitude: -74.0,
        },
      ];

      const result = await anomalyEngine.detectAnomalies(validData, {
        batchSize: 1,
      });

      const physicsResult = physicsOf(result);
      expect(physicsResult.anomalies.length).toBe(0); // No anomalies for valid data
      expect(physicsResult.metrics.averageConfidence).toBeGreaterThan(0.8);
    });

    test('flags 800 W/m2 at 08:00 local time as exceeding the solar-angle limit (negative control)', async () => {
      const result = await anomalyEngine.detectAnomalies(
        [
          {
            temperature: 25.0,
            dewpoint: 20.0,
            pressure: 1013.25,
            humidity: 78.6,
            windSpeed: 5.0,
            solarRadiation: 800,
            timestamp: EARLY_MORNING,
            latitude: 40.0,
            longitude: -74.0,
          },
        ],
        { batchSize: 1 }
      );

      const physicsResult = physicsOf(result);
      expect(physicsResult.anomalies).toHaveLength(1);
      expect(physicsResult.anomalies[0].violations).toContain(
        'radiation_exceeds_solar_angle_limit'
      );
    });

    test('should provide detailed physics validation metadata', async () => {
      const testData = [
        {
          temperature: 22.0,
          dewpoint: 18.0,
          pressure: 1010.0,
          humidity: 75.0,
          timestamp: '2023-07-15T14:00:00Z',
        },
      ];

      const result = await anomalyEngine.detectAnomalies(testData, {
        batchSize: 1,
      });

      const physicsResult = physicsOf(result);
      expect(physicsResult.metrics).toBeDefined();
      expect(physicsResult.metrics.averageConfidence).toBeDefined();
      expect(physicsResult.metrics.validationCoverage).toBeDefined();
      expect(physicsResult.validationResults).toBeDefined();
      expect(physicsResult.validationResults.length).toBe(1);
    });
  });

  describe('Ensemble Detection with Physics Validation', () => {
    test('should combine physics validation with statistical methods', async () => {
      const result = await anomalyEngine.detectAnomalies(mixedQualityData, {
        batchSize: 10,
      });

      const { byMethod, ensemble } = result.anomalies;

      // Physics should detect the physics violations (records 4 and 5).
      const physicsIndexes = byMethod.physics_based.anomalies.map(
        a => a.recordIndex
      );
      expect(physicsIndexes).toEqual(expect.arrayContaining([4, 5]));

      // The statistical outliers are found by IQR. `zscore` cannot fire on six
      // records: the engine uses the population SD, so the largest possible
      // |z| for n = 6 is sqrt(n-1) = sqrt(5) = 2.236, below the threshold of 3, so the original "z-score > 0" expectation
      // was unsatisfiable on this fixture.
      expect(byMethod.iqr.anomalies.length).toBeGreaterThan(0);
      expect(byMethod.zscore.anomalies).toHaveLength(0);

      // Ensemble keeps only the record whose anomaly-entry count reaches the
      // threshold: the one that is both a statistical outlier and a physics
      // violation. (Entry count, not distinct methods: see Known gaps, #1468.)
      expect(ensemble.anomalies.map(a => a.recordIndex)).toEqual([5]);
      expect(ensemble.anomalies[0].methodsAgreeing).toContain('physics_based');
      expect(ensemble.anomalies[0].methodsAgreeing).toContain('iqr');
    });

    test('ensemble anomalies meet the anomaly-entry threshold (not a distinct-method quorum, see #1468)', async () => {
      const result = await anomalyEngine.detectAnomalies(mixedQualityData, {
        batchSize: 10,
      });

      const { ensemble } = result.anomalies;
      // agreementCount is incremented once per anomaly ENTRY (engine
      // :897-905), several per method, so this is an entry count.
      const minAgreement = Math.ceil(
        ensemble.totalMethods * ensemble.ensembleThreshold
      );
      expect(ensemble.anomalies.length).toBeGreaterThan(0);
      for (const anomaly of ensemble.anomalies) {
        expect(anomaly.agreementCount).toBeGreaterThanOrEqual(minAgreement);
        expect(anomaly.confidence).toBeCloseTo(
          anomaly.agreementCount / anomaly.totalMethods,
          10
        );
      }
    });
  });

  describe('Batch Processing and Performance', () => {
    test('should handle large datasets with physics validation', async () => {
      // Generate realistic weather data with some physics violations
      const largeDataset = Array(500)
        .fill()
        .map((_, i) => {
          const baseTemp = 20 + Math.sin(i * 0.01) * 10;
          const baseDewpoint = baseTemp - 5 + Math.sin(i * 0.015) * 3;

          // Introduce occasional physics violations
          const hasProblem = i % 50 === 0;

          return {
            temperature: baseTemp,
            dewpoint: hasProblem ? baseTemp + 5 : baseDewpoint, // Physics violation
            pressure: 1013.25 + Math.sin(i * 0.005) * 20,
            humidity: hasProblem ? 150 : 60 + Math.sin(i * 0.02) * 20,
            windSpeed: Math.abs(Math.sin(i * 0.03) * 15),
            timestamp: new Date(
              Date.parse('2023-07-15T00:00:00Z') + i * 3600000
            ).toISOString(),
          };
        });

      const startTime = Date.now();
      const result = await anomalyEngine.detectAnomalies(largeDataset, {
        batchSize: 50,
      });
      const duration = Date.now() - startTime;

      const physicsResult = physicsOf(result);
      expect(physicsResult.validationResults).toHaveLength(500);

      // Every injected dewpoint > temperature record (i % 50 === 0 -> 10
      // records) must be reported.
      const dewpointIndexes = physicsResult.anomalies
        .filter(a => a.violations.includes('dewpoint_exceeds_temperature'))
        .map(a => a.recordIndex);
      expect(dewpointIndexes).toEqual(
        Array.from({ length: 10 }, (_, k) => k * 50)
      );

      // Performance check
      expect(duration).toBeLessThan(60000); // Should complete within 60 seconds
    });

    test('should process different batch sizes efficiently', async () => {
      const testData = Array(100)
        .fill()
        .map((_, i) => ({
          temperature: 20 + i * 0.1,
          dewpoint: 15 + i * 0.08,
          pressure: 1013.25 - i * 0.1,
          humidity: 60 + Math.sin(i * 0.1) * 20,
          timestamp: new Date(
            Date.parse('2023-07-15T00:00:00Z') + i * 3600000
          ).toISOString(),
        }));

      // Test different batch sizes
      const batchSizes = [10, 25, 50, 100];
      const anomalyIndexesBySize = [];

      for (const batchSize of batchSizes) {
        const result = await anomalyEngine.detectAnomalies(testData, {
          batchSize,
        });

        const physicsResult = physicsOf(result);
        expect(physicsResult.validationResults).toHaveLength(100);

        // Results should be consistent regardless of batch size
        expect(physicsResult.metrics.averageConfidence).toBeGreaterThan(0.5);
        anomalyIndexesBySize.push(
          physicsResult.anomalies.map(a => a.recordIndex)
        );
      }

      // recordIndex is the global index (batchIndex * batchSize + i), so the
      // flagged records must not depend on how the data was batched.
      for (const indexes of anomalyIndexesBySize.slice(1)) {
        expect(indexes).toEqual(anomalyIndexesBySize[0]);
      }
    });
  });

  describe('Error Handling and Resilience', () => {
    test('should handle records with missing physics data gracefully', async () => {
      const incompleteData = [
        { temperature: 25.0 }, // Missing most fields
        { dewpoint: 20.0, pressure: 1013.25 }, // Missing temperature
        { temperature: 22.0, dewpoint: 18.0, pressure: 1010.0, humidity: 75.0 }, // Complete
        { windSpeed: 5.0, windDirection: 180.0 }, // Missing core atmospheric data
      ];

      const result = await anomalyEngine.detectAnomalies(incompleteData, {
        batchSize: 4,
      });

      const physicsResult = physicsOf(result);
      expect(physicsResult.error).toBeUndefined();
      expect(physicsResult.validationResults).toHaveLength(4);
      expect(result.metadata.recordCount).toBe(4);
    });

    test('should handle invalid data types in physics validation', async () => {
      const invalidTypeData = [
        {
          temperature: 'not_a_number',
          dewpoint: null,
          pressure: undefined,
          humidity: 'invalid',
          windSpeed: {},
          timestamp: EARLY_MORNING,
        },
      ];

      const result = await anomalyEngine.detectAnomalies(invalidTypeData, {
        batchSize: 1,
      });

      // Should not crash and should still produce a physics result.
      expect(result).toBeDefined();
      const physicsResult = physicsOf(result);
      expect(physicsResult.error).toBeUndefined();
      expect(physicsResult.validationResults).toHaveLength(1);
    });

    test('should continue processing when individual physics validations fail', async () => {
      const mixedData = [
        { temperature: 25.0, dewpoint: 20.0, pressure: 1013.25 }, // Valid
        { temperature: null, dewpoint: undefined }, // Invalid types
        { temperature: 30.0, dewpoint: 22.0, pressure: 1010.0 }, // Valid
        { invalid_field: 'error' }, // Completely invalid structure
        { temperature: 18.0, dewpoint: 15.0, pressure: 1015.0 }, // Valid
      ];

      const result = await anomalyEngine.detectAnomalies(mixedData, {
        batchSize: 5,
      });

      const physicsResult = physicsOf(result);
      expect(physicsResult.error).toBeUndefined();
      // Should have processed all records despite some failures
      expect(physicsResult.validationResults).toHaveLength(5);
    });

    test('records a failing physics validation as a validation_error anomaly and keeps going', async () => {
      const originalValidate = anomalyEngine.physicsValidator.validateData;
      let calls = 0;
      anomalyEngine.physicsValidator.validateData = async (...args) => {
        calls += 1;
        if (calls === 2) throw new Error('simulated validator failure');
        return originalValidate.apply(anomalyEngine.physicsValidator, args);
      };

      const result = await anomalyEngine.detectAnomalies(
        [
          { temperature: 25.0, dewpoint: 20.0, pressure: 1013.25 },
          { temperature: 24.0, dewpoint: 19.0, pressure: 1013.25 },
          { temperature: 23.0, dewpoint: 18.0, pressure: 1013.25 },
        ],
        { batchSize: 3 }
      );

      const physicsResult = physicsOf(result);
      expect(calls).toBe(3);
      expect(physicsResult.anomalies).toHaveLength(1);
      expect(physicsResult.anomalies[0]).toMatchObject({
        recordIndex: 1,
        type: 'validation_error',
        violations: ['physics_validation_error'],
      });
      expect(physicsResult.anomalies[0].message).toContain(
        'simulated validator failure'
      );
    });
  });

  describe('Configuration and Customization', () => {
    test('should respect custom physics validation tolerances', async () => {
      const borderlineData = [
        {
          temperature: 25.0,
          dewpoint: 24.8, // Very close to temperature
          pressure: 1013.25,
          humidity: 97.0, // Very high humidity
        },
      ];

      // Strict tolerances
      const strictEngine = new AnomalyDetectionEngine({
        temperatureTolerance: 0.1,
        humidityTolerance: 1.0,
        strictMode: true,
      });
      const strictResult = await strictEngine.detectAnomalies(borderlineData, {
        batchSize: 1,
      });

      // Loose tolerances
      const looseEngine = new AnomalyDetectionEngine({
        temperatureTolerance: 2.0,
        humidityTolerance: 10.0,
        strictMode: false,
      });
      const looseResult = await looseEngine.detectAnomalies(borderlineData, {
        batchSize: 1,
      });

      const strictPhysics = physicsOf(strictResult);
      const loosePhysics = physicsOf(looseResult);

      // Strict mode is more sensitive: it flags the borderline record and the
      // loose engine does not.
      expect(strictPhysics.anomalies.length).toBeGreaterThan(
        loosePhysics.anomalies.length
      );
      expect(loosePhysics.anomalies).toHaveLength(0);
      expect(strictPhysics.anomalies[0].violations).toContain(
        'relative_humidity_inconsistency'
      );
    });

    test('should support debug mode for physics validation', async () => {
      const debugEngine = new AnomalyDetectionEngine({
        enableDebug: true,
      });
      expect(debugEngine.config.enableDebug).toBe(true);

      const result = await debugEngine.detectAnomalies(
        [
          {
            temperature: 20.0,
            dewpoint: 25.0, // Physics violation
            pressure: 1013.25,
          },
        ],
        { batchSize: 1 }
      );

      // Debug mode must not change what is detected.
      expect(physicsOf(result).anomalies).toHaveLength(1);
    });
  });

  describe('Validation Coverage and Metrics', () => {
    test('should provide comprehensive validation coverage metrics', async () => {
      const completeData = [
        {
          temperature: 25.0,
          dewpoint: 20.0,
          pressure: 1013.25,
          humidity: 78.6,
          windSpeed: 5.0,
          windGust: 8.0,
          windDirection: 180.0,
          solarRadiation: 800,
          netRadiation: 600,
          altitude: 100,
          latitude: 40.0,
          longitude: -74.0,
          soilTemperature: 22.0,
          timestamp: SOLAR_NOON,
        },
      ];

      const result = await anomalyEngine.detectAnomalies(completeData, {
        batchSize: 1,
      });

      const physicsResult = physicsOf(result);
      expect(physicsResult.metrics).toBeDefined();

      // Should have high validation coverage for complete data
      expect(physicsResult.metrics.validationCoverage).toBeGreaterThan(0.8);
      expect(physicsResult.metrics.totalValidations).toBeGreaterThan(5);
      expect(physicsResult.metrics.averageConfidence).toBeGreaterThan(0.8);
    });

    test('should track most common violation types', async () => {
      const violationData = [
        { temperature: 20.0, dewpoint: 25.0 }, // dewpoint violation
        { temperature: 15.0, dewpoint: 20.0 }, // dewpoint violation
        { windSpeed: -5.0 }, // negative wind violation
        { temperature: 10.0, dewpoint: 15.0 }, // dewpoint violation
        { pressure: 2000.0 }, // extreme pressure violation
        { solarRadiation: -100 }, // negative radiation violation
      ];

      const result = await anomalyEngine.detectAnomalies(violationData, {
        batchSize: 6,
      });

      const physicsResult = physicsOf(result);
      const common = physicsResult.summary.mostCommonViolations;
      expect(common.length).toBeGreaterThan(0);

      // dewpoint violations are among the most common: three records have
      // them, and they tie with the two derived checks that fire with them
      // (vapor pressure, wet bulb), so assert the count, not the tie order.
      const dewpoint = common.find(
        v => v.violation === 'dewpoint_exceeds_temperature'
      );
      expect(dewpoint).toBeDefined();
      expect(dewpoint.count).toBe(3);
      expect(common[0].count).toBe(3);
    });

    test('should categorize anomalies by severity correctly', async () => {
      const severityTestData = [
        { temperature: 20.0, dewpoint: 20.1 }, // Minor violation
        { temperature: 15.0, dewpoint: 25.0, humidity: 200.0 }, // Major violations
        { pressure: 5000.0, windSpeed: -50.0, solarRadiation: -500 }, // Several violations
        { temperature: 22.0, dewpoint: 21.8 }, // Borderline: not flagged
      ];

      const result = await anomalyEngine.detectAnomalies(severityTestData, {
        batchSize: 4,
      });

      const physicsResult = physicsOf(result);
      expect(physicsResult.summary).toBeDefined();

      // Severity buckets add up to the total, with both critical and high
      // present (record 1 is critical, records 0 and 2 are high).
      const { summary } = physicsResult;
      expect(summary.total).toBe(3);
      expect(summary.criticalSeverity).toBe(1);
      expect(summary.highSeverity).toBe(2);
      expect(
        summary.criticalSeverity +
          summary.highSeverity +
          summary.mediumSeverity +
          summary.lowSeverity
      ).toBe(summary.total);
    });
  });
});

describe('Integration with Data Quality Pipeline', () => {
  test('should expose a result format compatible with quality reporting', async () => {
    const testData = [
      {
        temperature: 25.0,
        dewpoint: 30.0, // Physics violation
        pressure: 1013.25,
        timestamp: EARLY_MORNING,
      },
    ];

    const anomalyEngine = new AnomalyDetectionEngine();
    const result = await anomalyEngine.detectAnomalies(testData, {
      batchSize: 1,
    });

    expect(result.metadata.detectedAt).toBeDefined();
    expect(result.statistics.totalAnomaliesByMethod.physics_based).toBe(1);
    expect(result.recommendations).toBeInstanceOf(Array);

    const physicsResult = physicsOf(result);
    expect(physicsResult.anomalies).toBeDefined();
    expect(physicsResult.summary).toBeDefined();
  });

  test('should support real-time streaming integration', async () => {
    // Test that physics validation can work in real-time scenarios
    const anomalyEngine = new AnomalyDetectionEngine();

    // Simulate streaming data with small batches
    const streamingBatches = [
      [{ temperature: 25.0, dewpoint: 20.0, pressure: 1013.25 }],
      [{ temperature: 20.0, dewpoint: 25.0, pressure: 1010.0 }], // Violation
      [{ temperature: 22.0, dewpoint: 18.0, pressure: 1012.0 }],
    ];

    const results = [];
    for (const batch of streamingBatches) {
      results.push(await anomalyEngine.detectAnomalies(batch, { batchSize: 1 }));
    }

    expect(results).toHaveLength(3);

    // Only the second batch carries the physics violation.
    expect(physicsOf(results[0]).anomalies).toHaveLength(0);
    expect(physicsOf(results[1]).anomalies.length).toBeGreaterThan(0);
    expect(physicsOf(results[2]).anomalies).toHaveLength(0);
  });
});

// Known gaps (backend#1414). These are expectations from the original suite
// that the engine does NOT meet and that are not stale shape drift: they ask
// for behaviour the engine has no code for. `test.failing` keeps them visible
// and fails the suite the day the behaviour lands, so the marker gets removed
// deliberately instead of rotting.
describe('Known gaps (backend#1414)', () => {
  // The ensemble is an equal-weight vote (agreementCount >= ceil(totalMethods
  // * ensembleThreshold)). There is no physics weighting, so a single record
  // with a critical physics violation (dewpoint 5 C above temperature) never
  // reaches the ensemble list: only physics_based reports it. The original
  // test asked for "physics violations should be given high weight in
  // ensemble". Whether that weighting is wanted is a product decision.
  test.failing('a critical physics violation on its own reaches the ensemble list', async () => {
    const engine = new AnomalyDetectionEngine({ ensembleThreshold: 0.6 });
    const result = await engine.detectAnomalies(
      [
        {
          temperature: 20.0,
          dewpoint: 25.0,
          pressure: 1013.25,
          humidity: 100.0,
          windSpeed: 5.0,
          timestamp: EARLY_MORNING,
        },
      ],
      { batchSize: 1 }
    );

    expect(physicsOf(result).anomalies).toHaveLength(1); // holds today
    expect(result.anomalies.ensemble.anomalies.map(a => a.recordIndex)).toContain(0);
  });

  // Quorum counts anomaly entries, not distinct methods (backend#1468). On
  // mixedQualityData record 5 has agreementCount 10 but only 4 distinct
  // methods (iqr, modified_zscore, grubbs, physics_based) against the
  // ceil(13 * 0.6) = 8 that `ensembleThreshold` ("fraction of methods that
  // must agree", engine:36) implies.
  test.failing('ensemble quorum requires distinct methods, not anomaly entries (#1468)', async () => {
    const engine = new AnomalyDetectionEngine({ ensembleThreshold: 0.6 });
    const result = await engine.detectAnomalies(mixedQualityData, {
      batchSize: 10,
    });
    const { byMethod, ensemble } = result.anomalies;
    const needed = Math.ceil(ensemble.totalMethods * ensemble.ensembleThreshold);

    // Fixture facts (these hold today and after a fix): record 5 is flagged by
    // fewer distinct methods than the quorum requires.
    const flaggingMethods = Object.entries(byMethod)
      .filter(([, r]) => r.anomalies.some(a => a.recordIndex === 5))
      .map(([m]) => m);
    expect(flaggingMethods.length).toBeGreaterThan(0);
    expect(flaggingMethods.length).toBeLessThan(needed);

    // The gap: with a distinct-method quorum, record 5 is not an ensemble
    // anomaly. Today it is (agreementCount counts entries).
    expect(ensemble.anomalies.map(a => a.recordIndex)).not.toContain(5);
  });

  // The engine runs all registered methods; the original suite passed
  // `{ methods: ['physics_based'] }` to restrict that. The option is ignored.
  test.failing('detectAnomalies honours a methods filter', async () => {
    const engine = new AnomalyDetectionEngine();
    const result = await engine.detectAnomalies(
      [{ temperature: 20.0, dewpoint: 15.0, pressure: 1013.25 }],
      { methods: ['physics_based'] }
    );

    expect(Object.keys(result.anomalies.byMethod)).toEqual(['physics_based']);
  });
});
