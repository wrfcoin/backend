/**
 * Comprehensive Test Suite for Weather Data Ingestion Pipeline
 *
 * Tests all components of the weather data ingestion pipeline including:
 * - Data transformation from various sources
 * - Data cleaning and preprocessing
 * - Data validation and quality checks
 * - Pipeline orchestration and error handling
 */

const { expect } = require('chai');
const sinon = require('sinon');
const WeatherDataTransformer = require('../services/weather-data-transformer');
const WeatherDataCleaner = require('../services/weather-data-cleaner');
const WeatherIngestionValidator = require('../services/weather-ingestion-validator');
const WeatherDataIngestionOrchestrator = require('../services/weather-data-ingestion-orchestrator');
const {
  AntiFraudReasonCodes,
  PENALTY_POINTS,
  getSharedAntiFraudQualityPipeline,
} = require('../services/anti-fraud-quality-pipeline');

const buildValidIngestionPayload = (overrides = {}) => {
  const basePayload = {
    metadata: {
      sourceId: 'KORD',
      sourceType: 'api',
      provider: 'NOAA-NWS',
      dataType: 'current',
      timestamp: new Date().toISOString(),
    },
    location: {
      latitude: 41.98,
      longitude: -87.9,
    },
    measurements: {
      temperature: { value: 20, unit: 'celsius', qualityFlag: 'A' },
      humidity: { value: 60, unit: 'percent', qualityFlag: 'A' },
      pressure: { value: 1013, unit: 'hPa', qualityFlag: 'A' },
    },
  };

  return {
    ...basePayload,
    ...overrides,
    metadata: {
      ...basePayload.metadata,
      ...(overrides.metadata || {}),
    },
    location: {
      ...basePayload.location,
      ...(overrides.location || {}),
    },
    measurements: {
      ...basePayload.measurements,
      ...(overrides.measurements || {}),
    },
  };
};

describe('Weather Data Ingestion Pipeline', () => {
  let transformer;
  let cleaner;
  let validator;
  let orchestrator;
  let antiFraudPipeline;

  beforeEach(() => {
    antiFraudPipeline = getSharedAntiFraudQualityPipeline();
    antiFraudPipeline.resetStateForTests();
    transformer = new WeatherDataTransformer();
    cleaner = new WeatherDataCleaner();
    validator = new WeatherIngestionValidator();
    orchestrator = new WeatherDataIngestionOrchestrator();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('WeatherDataTransformer', () => {
    describe('NOAA-NWS Transformation', () => {
      it('should transform NOAA NWS observation data correctly', async () => {
        const noaaData = {
          properties: {
            station: 'KORD',
            timestamp: '2024-01-15T12:00:00Z',
            temperature: { value: 10, unitCode: 'wmo:degC' },
            dewpoint: { value: 5, unitCode: 'wmo:degC' },
            relativeHumidity: { value: 60, unitCode: 'wmo:percent' },
            barometricPressure: { value: 101325, unitCode: 'wmo:Pa' },
            windSpeed: { value: 18, unitCode: 'wmo:km_h-1' },
            windDirection: { value: 270, unitCode: 'wmo:degree_(angle)' },
          },
          geometry: {
            coordinates: [-87.9, 41.98],
          },
        };

        const result = await transformer.transformWeatherData(
          noaaData,
          'NOAA-NWS'
        );

        expect(result.success).to.be.true;
        expect(result.transformedData).to.exist;
        expect(result.transformedData.metadata.provider).to.equal('NOAA-NWS');
        expect(result.transformedData.metadata.sourceId).to.equal('KORD');
        expect(result.transformedData.location.latitude).to.equal(41.98);
        expect(result.transformedData.location.longitude).to.equal(-87.9);
        expect(result.transformedData.measurements.temperature.value).to.equal(
          10
        );
        expect(result.transformedData.measurements.temperature.unit).to.equal(
          'celsius'
        );
        expect(result.transformedData.measurements.pressure.value).to.equal(
          1013.25
        ); // Converted from Pa to hPa
        expect(result.transformedData.measurements.windSpeed.value).to.equal(5); // Converted from km/h to m/s
      });

      it('should handle missing measurements gracefully', async () => {
        const incompleteData = {
          properties: {
            station: 'KORD',
            timestamp: '2024-01-15T12:00:00Z',
            temperature: { value: 10, unitCode: 'wmo:degC' },
            // Missing other measurements
          },
          geometry: {
            coordinates: [-87.9, 41.98],
          },
        };

        const result = await transformer.transformWeatherData(
          incompleteData,
          'NOAA-NWS'
        );

        expect(result.success).to.be.true;
        expect(result.transformedData.measurements.temperature).to.exist;
        expect(result.transformedData.measurements.pressure).to.not.exist;
      });
    });

    describe('NOAA-NCEI Transformation', () => {
      it('should transform NOAA NCEI historical data correctly', async () => {
        const nceiData = {
          station: 'USC00111577',
          date: '2024-01-15',
          latitude: 41.98,
          longitude: -87.9,
          elevation: 205,
          name: 'CHICAGO OHARE INTL AP',
          TMAX: 100, // 10.0°C in tenths
          TMIN: -50, // -5.0°C in tenths
          PRCP: 25, // 2.5mm in tenths
        };

        const result = await transformer.transformWeatherData(
          nceiData,
          'NOAA-NCEI'
        );

        expect(result.success).to.be.true;
        expect(result.transformedData.metadata.provider).to.equal('NOAA-NCEI');
        expect(result.transformedData.metadata.dataType).to.equal('historical');
        expect(
          result.transformedData.measurements.temperatureMax.value
        ).to.equal(10.0);
        expect(
          result.transformedData.measurements.temperatureMin.value
        ).to.equal(-5.0);
        expect(
          result.transformedData.measurements.precipitation.value
        ).to.equal(2.5);
      });
    });

    describe('OpenWeatherMap Transformation', () => {
      it('should transform OpenWeatherMap data correctly', async () => {
        const owmData = {
          coord: { lat: 41.98, lon: -87.9 },
          name: 'Chicago',
          dt: 1642248000, // Unix timestamp
          main: {
            temp: 283.15, // 10°C in Kelvin
            humidity: 60,
            pressure: 1013,
          },
          wind: {
            speed: 5,
            deg: 270,
          },
          visibility: 10000,
          clouds: { all: 25 },
          sys: { country: 'US' },
        };

        const result = await transformer.transformWeatherData(
          owmData,
          'OpenWeatherMap'
        );

        expect(result.success).to.be.true;
        expect(result.transformedData.metadata.provider).to.equal(
          'OpenWeatherMap'
        );
        expect(result.transformedData.measurements.temperature.value).to.equal(
          10
        ); // Converted from Kelvin
        expect(result.transformedData.measurements.visibility.value).to.equal(
          10
        ); // Converted from m to km
      });
    });

    describe('Error Handling', () => {
      it('should handle malformed data gracefully', async () => {
        const malformedData = { invalid: 'data' };

        const result = await transformer.transformWeatherData(
          malformedData,
          'NOAA-NWS'
        );

        expect(result.success).to.be.false;
        expect(result.errors).to.have.length.greaterThan(0);
      });

      it('should handle unsupported source types', async () => {
        const data = { test: 'data' };

        const result = await transformer.transformWeatherData(
          data,
          'UNSUPPORTED'
        );

        expect(result.success).to.be.false;
        expect(result.errors).to.include.something.that.includes(
          'Unsupported source type'
        );
      });
    });
  });

  describe('WeatherDataCleaner', () => {
    describe('Unit Conversion', () => {
      it('should convert temperature units correctly', async () => {
        const data = {
          metadata: {
            sourceId: 'test',
            sourceType: 'test',
            provider: 'test',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            temperature: { value: 32, unit: 'fahrenheit', qualityFlag: 'A' },
          },
        };

        const result = await cleaner.cleanWeatherRecord(data);

        expect(result.cleanedData.measurements.temperature.value).to.be.closeTo(
          0,
          0.1
        ); // 32°F = 0°C
        expect(result.cleanedData.measurements.temperature.unit).to.equal(
          'celsius'
        );
        expect(result.cleaningActions).to.have.length.greaterThan(0);
        expect(result.cleaningActions[0].type).to.equal('unit_conversion');
      });

      it('should convert pressure units correctly', async () => {
        const data = {
          metadata: {
            sourceId: 'test',
            sourceType: 'test',
            provider: 'test',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            pressure: { value: 101325, unit: 'pa', qualityFlag: 'A' },
          },
        };

        const result = await cleaner.cleanWeatherRecord(data);

        expect(result.cleanedData.measurements.pressure.value).to.equal(
          1013.25
        ); // Pa to hPa
        expect(result.cleanedData.measurements.pressure.unit).to.equal('hpa');
      });

      it('should convert wind speed units correctly', async () => {
        const data = {
          metadata: {
            sourceId: 'test',
            sourceType: 'test',
            provider: 'test',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            windSpeed: { value: 36, unit: 'kmh', qualityFlag: 'A' },
          },
        };

        const result = await cleaner.cleanWeatherRecord(data);

        expect(result.cleanedData.measurements.windSpeed.value).to.equal(10); // 36 km/h = 10 m/s
        expect(result.cleanedData.measurements.windSpeed.unit).to.equal('m/s');
      });
    });

    describe('Missing Value Handling', () => {
      it('should handle missing temperature with interpolation strategy', async () => {
        const data = {
          metadata: {
            sourceId: 'test',
            sourceType: 'test',
            provider: 'test',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            temperature: { value: null, unit: 'celsius', qualityFlag: 'M' },
          },
        };

        const result = await cleaner.cleanWeatherRecord(data);

        expect(result.cleanedData.measurements.temperature.value).to.not.be
          .null;
        expect(
          result.cleanedData.measurements.temperature.qualityFlag
        ).to.equal('I'); // Interpolated
        expect(
          result.cleaningActions.some(
            action => action.type === 'missing_value_handling'
          )
        ).to.be.true;
      });

      it('should handle missing wind speed with default value', async () => {
        const data = {
          metadata: {
            sourceId: 'test',
            sourceType: 'test',
            provider: 'test',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            windSpeed: { value: null, unit: 'm/s', qualityFlag: 'M' },
          },
        };

        const result = await cleaner.cleanWeatherRecord(data);

        expect(result.cleanedData.measurements.windSpeed.value).to.equal(0); // Default to calm
        expect(result.cleanedData.measurements.windSpeed.qualityFlag).to.equal(
          'I'
        );
      });
    });

    describe('Outlier Detection', () => {
      it('should detect temperature outliers', async () => {
        const data = {
          metadata: {
            sourceId: 'test',
            sourceType: 'test',
            provider: 'test',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            temperature: { value: 100, unit: 'celsius', qualityFlag: 'A' }, // Impossible temperature
          },
        };

        const result = await cleaner.cleanWeatherRecord(data);

        expect(result.warnings).to.have.length.greaterThan(0);
        expect(
          result.warnings.some(warning => warning.includes('Outlier detected'))
        ).to.be.true;
        expect(
          result.cleanedData.measurements.temperature.qualityFlag
        ).to.equal('S'); // Suspected
      });

      it('should detect pressure outliers', async () => {
        const data = {
          metadata: {
            sourceId: 'test',
            sourceType: 'test',
            provider: 'test',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            pressure: { value: 2000, unit: 'hPa', qualityFlag: 'A' }, // Impossible pressure
          },
        };

        const result = await cleaner.cleanWeatherRecord(data);

        expect(result.warnings).to.have.length.greaterThan(0);
        expect(result.cleanedData.measurements.pressure.qualityFlag).to.equal(
          'S'
        );
      });
    });

    describe('Quality Assessment', () => {
      it('should assign excellent quality to clean data', async () => {
        const data = {
          metadata: {
            sourceId: 'test',
            sourceType: 'test',
            provider: 'test',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            temperature: { value: 20, unit: 'celsius', qualityFlag: 'A' },
            humidity: { value: 60, unit: 'percent', qualityFlag: 'A' },
            pressure: { value: 1013, unit: 'hPa', qualityFlag: 'A' },
          },
        };

        const result = await cleaner.cleanWeatherRecord(data);

        expect(result.overallQuality).to.equal('excellent');
        expect(result.qualityScore).to.be.above(0.9);
      });

      it('should assign poor quality to problematic data', async () => {
        const data = {
          metadata: {
            sourceId: 'test',
            sourceType: 'test',
            provider: 'test',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            temperature: { value: 100, unit: 'celsius', qualityFlag: 'A' }, // Outlier
            humidity: { value: null, unit: 'percent', qualityFlag: 'M' }, // Missing
            pressure: { value: 2000, unit: 'hPa', qualityFlag: 'A' }, // Outlier
          },
        };

        const result = await cleaner.cleanWeatherRecord(data);

        expect(result.overallQuality).to.be.oneOf(['poor', 'fair']);
        expect(result.qualityScore).to.be.below(0.7);
      });
    });
  });

  describe('WeatherIngestionValidator', () => {
    describe('Structure Validation', () => {
      it('should validate complete data structure', async () => {
        const completeData = {
          metadata: {
            sourceId: 'KORD',
            sourceType: 'api',
            provider: 'NOAA-NWS',
            timestamp: '2024-01-15T12:00:00Z',
          },
          location: {
            latitude: 41.98,
            longitude: -87.9,
          },
          measurements: {
            temperature: { value: 20, unit: 'celsius', qualityFlag: 'A' },
          },
        };

        const result = await validator.validateIngestionData(completeData);

        expect(result.isValid).to.be.true;
        expect(result.canIngest).to.be.true;
        expect(result.validationChecks.structureValidation.passed).to.be.true;
      });

      it('should reject data with missing required fields', async () => {
        const incompleteData = {
          metadata: {
            sourceId: 'KORD',
            // Missing required fields
          },
          location: {
            latitude: 41.98,
            // Missing longitude
          },
          measurements: {},
        };

        const result = await validator.validateIngestionData(incompleteData, {
          strictMode: true,
        });

        expect(result.isValid).to.be.false;
        expect(result.canIngest).to.be.false;
        expect(result.validationChecks.structureValidation.passed).to.be.false;
      });
    });

    describe('Source Validation', () => {
      it('should validate trusted sources', async () => {
        const trustedData = {
          metadata: {
            sourceId: 'KORD',
            sourceType: 'api',
            provider: 'NOAA-NWS',
            timestamp: '2024-01-15T12:00:00Z',
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            temperature: { value: 20, unit: 'celsius', qualityFlag: 'A' },
          },
        };

        const result = await validator.validateIngestionData(trustedData);

        expect(result.validationChecks.sourceValidation.passed).to.be.true;
        expect(result.validationChecks.sourceValidation.score).to.equal(1.0);
      });

      it('should flag untrusted sources', async () => {
        const untrustedData = {
          metadata: {
            sourceId: 'unknown',
            sourceType: 'unknown',
            provider: 'Unknown',
            timestamp: '2024-01-15T12:00:00Z',
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            temperature: { value: 20, unit: 'celsius', qualityFlag: 'A' },
          },
        };

        const result = await validator.validateIngestionData(untrustedData);

        expect(result.validationChecks.sourceValidation.passed).to.be.false;
        expect(result.validationChecks.sourceValidation.score).to.equal(0.3);
      });
    });

    describe('Freshness Validation', () => {
      it('should accept fresh current data', async () => {
        const freshData = {
          metadata: {
            sourceId: 'KORD',
            sourceType: 'api',
            provider: 'NOAA-NWS',
            dataType: 'current',
            timestamp: new Date().toISOString(), // Current time
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            temperature: { value: 20, unit: 'celsius', qualityFlag: 'A' },
          },
        };

        const result = await validator.validateIngestionData(freshData);

        expect(result.validationChecks.freshnessValidation.passed).to.be.true;
      });

      it('should reject stale current data', async () => {
        const staleData = {
          metadata: {
            sourceId: 'KORD',
            sourceType: 'api',
            provider: 'NOAA-NWS',
            dataType: 'current',
            timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5 hours ago
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            temperature: { value: 20, unit: 'celsius', qualityFlag: 'A' },
          },
        };

        const result = await validator.validateIngestionData(staleData);

        expect(result.validationChecks.freshnessValidation.passed).to.be.false;
      });
    });

    describe('Completeness Validation', () => {
      it('should accept data with essential measurements', async () => {
        const completeData = {
          metadata: {
            sourceId: 'KORD',
            sourceType: 'api',
            provider: 'NOAA-NWS',
            dataType: 'current',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            temperature: { value: 20, unit: 'celsius', qualityFlag: 'A' },
            humidity: { value: 60, unit: 'percent', qualityFlag: 'A' },
            pressure: { value: 1013, unit: 'hPa', qualityFlag: 'A' },
          },
        };

        const result = await validator.validateIngestionData(completeData);

        expect(result.validationChecks.completenessValidation.passed).to.be
          .true;
        expect(
          result.validationChecks.completenessValidation.completenessRatio
        ).to.be.above(0.3);
      });

      it('should flag incomplete data', async () => {
        const incompleteData = {
          metadata: {
            sourceId: 'KORD',
            sourceType: 'api',
            provider: 'NOAA-NWS',
            dataType: 'current',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            // Missing essential measurements
            windSpeed: { value: 5, unit: 'm/s', qualityFlag: 'A' },
          },
        };

        const result = await validator.validateIngestionData(incompleteData);

        expect(result.validationChecks.completenessValidation.passed).to.be
          .false;
      });
    });

    describe('Physics Validation', () => {
      it('should pass physics validation for consistent data', async () => {
        const physicallyConsistentData = {
          metadata: {
            sourceId: 'KORD',
            sourceType: 'api',
            provider: 'NOAA-NWS',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            temperature: { value: 20, unit: 'celsius', qualityFlag: 'A' },
            dewpoint: { value: 15, unit: 'celsius', qualityFlag: 'A' }, // Dewpoint < temperature
            humidity: { value: 60, unit: 'percent', qualityFlag: 'A' },
          },
        };

        const result = await validator.validateIngestionData(
          physicallyConsistentData
        );

        expect(result.validationChecks.physicsValidation.passed).to.be.true;
      });

      it('should fail physics validation for inconsistent data', async () => {
        const physicallyInconsistentData = {
          metadata: {
            sourceId: 'KORD',
            sourceType: 'api',
            provider: 'NOAA-NWS',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: {
            temperature: { value: 20, unit: 'celsius', qualityFlag: 'A' },
            dewpoint: { value: 25, unit: 'celsius', qualityFlag: 'A' }, // Dewpoint > temperature (impossible)
            humidity: { value: 60, unit: 'percent', qualityFlag: 'A' },
          },
        };

        const result = await validator.validateIngestionData(
          physicallyInconsistentData
        );

        expect(result.validationChecks.physicsValidation.passed).to.be.false;
      });
    });

    describe('Anti-Fraud Pipeline', () => {
      it('should reject duplicate/replay submissions deterministically', async () => {
        const payload = buildValidIngestionPayload({
          metadata: {
            timestamp: new Date().toISOString(),
          },
        });

        const first = await validator.validateIngestionData(payload);
        const second = await validator.validateIngestionData(payload);

        expect(first.canIngest).to.be.true;
        expect(second.canIngest).to.be.false;
        expect(second.riskAssessment.decision).to.equal('rejected');
        expect(second.riskAssessment.reasonCodes).to.include(
          AntiFraudReasonCodes.DUPLICATE_REPLAY
        );
      });

      it('should reject adversarial malformed payload patterns', async () => {
        const payload = buildValidIngestionPayload({
          metadata: {
            sourceId: '<script>alert(1)</script>',
          },
        });

        const result = await validator.validateIngestionData(payload);

        expect(result.canIngest).to.be.false;
        expect(result.riskAssessment.reasonCodes).to.include(
          AntiFraudReasonCodes.MALFORMED_PAYLOAD_PATTERN
        );
      });

      it('should apply deterministic penalty totals from explicit reason codes', async () => {
        const payload = buildValidIngestionPayload({
          metadata: {
            provider: 'Unknown',
            sourceId: 'unknown',
          },
          measurements: {
            temperature: {
              value: Number.POSITIVE_INFINITY,
              unit: 'celsius',
              qualityFlag: 'A',
            },
          },
        });

        const result = await validator.validateIngestionData(payload);
        const expectedPenalty = result.riskAssessment.reasonCodes.reduce(
          (sum, reasonCode) => sum + (PENALTY_POINTS[reasonCode] || 0),
          0
        );

        expect(result.riskAssessment.reasonCodes).to.deep.equal(
          [...result.riskAssessment.reasonCodes].sort()
        );
        expect(result.riskAssessment.penaltyPoints).to.equal(expectedPenalty);
        expect(result.riskAssessment.decision).to.equal('rejected');
      });

      it('should avoid false positives at temporal consistency boundary', async () => {
        const baselineTime = Date.now();
        const previousData = buildValidIngestionPayload({
          metadata: {
            timestamp: new Date(baselineTime - 60 * 60 * 1000).toISOString(),
          },
          measurements: {
            temperature: { value: 10, unit: 'celsius', qualityFlag: 'A' },
          },
        });

        const boundaryData = buildValidIngestionPayload({
          metadata: {
            timestamp: new Date(baselineTime).toISOString(),
          },
          measurements: {
            temperature: { value: 30, unit: 'celsius', qualityFlag: 'A' },
          },
        });

        const result = await validator.validateIngestionData(boundaryData, {
          previousData,
        });

        expect(result.validationChecks.consistencyValidation.passed).to.be.true;
      });

      it('should detect false negatives beyond temporal consistency boundary', async () => {
        const baselineTime = Date.now();
        const previousData = buildValidIngestionPayload({
          metadata: {
            timestamp: new Date(baselineTime - 60 * 60 * 1000).toISOString(),
          },
          measurements: {
            temperature: { value: 10, unit: 'celsius', qualityFlag: 'A' },
          },
        });

        const outOfBoundaryData = buildValidIngestionPayload({
          metadata: {
            timestamp: new Date(baselineTime).toISOString(),
          },
          measurements: {
            temperature: { value: 31, unit: 'celsius', qualityFlag: 'A' },
          },
        });

        const result = await validator.validateIngestionData(
          outOfBoundaryData,
          {
            previousData,
          }
        );

        expect(result.validationChecks.consistencyValidation.passed).to.be
          .false;
      });
    });
  });

  describe('WeatherDataIngestionOrchestrator', () => {
    let mockTransformer, mockCleaner, mockValidator;

    beforeEach(() => {
      mockTransformer = sinon.createStubInstance(WeatherDataTransformer);
      mockCleaner = sinon.createStubInstance(WeatherDataCleaner);
      mockValidator = sinon.createStubInstance(WeatherIngestionValidator);

      orchestrator.transformer = mockTransformer;
      orchestrator.cleaner = mockCleaner;
      orchestrator.validator = mockValidator;
    });

    describe('Complete Pipeline', () => {
      it('should execute complete ingestion pipeline successfully', async () => {
        const rawData = { test: 'data' };
        const transformedData = {
          metadata: {
            sourceId: 'test',
            provider: 'test',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: { temperature: { value: 20, unit: 'celsius' } },
        };

        // Mock transformation
        mockTransformer.transformWeatherData.resolves({
          success: true,
          transformedData,
          errors: [],
          warnings: [],
        });

        // Mock cleaning
        mockCleaner.cleanWeatherRecord.resolves({
          cleanedData: transformedData,
          cleaningActions: [],
          errors: [],
          warnings: [],
          overallQuality: 'excellent',
        });

        // Mock validation
        mockValidator.validateIngestionData.resolves({
          canIngest: true,
          isValid: true,
          qualityLevel: 'excellent',
          warnings: [],
          errors: [],
        });

        const result = await orchestrator.ingestWeatherData(
          'NOAA-NWS',
          rawData
        );

        expect(result.success).to.be.true;
        expect(result.pipeline.transformation.completed).to.be.true;
        expect(result.pipeline.cleaning.completed).to.be.true;
        expect(result.pipeline.validation.completed).to.be.true;
        expect(result.pipeline.storage.completed).to.be.true;
      });

      it('should handle transformation failures gracefully', async () => {
        const rawData = { invalid: 'data' };

        mockTransformer.transformWeatherData.resolves({
          success: false,
          transformedData: null,
          errors: ['Transformation failed'],
          warnings: [],
        });

        const result = await orchestrator.ingestWeatherData(
          'NOAA-NWS',
          rawData
        );

        expect(result.success).to.be.false;
        expect(result.errors).to.have.length.greaterThan(0);
        expect(result.pipeline.transformation.completed).to.be.false;
      });

      it('should handle validation failures in strict mode', async () => {
        const rawData = { test: 'data' };
        const transformedData = {
          metadata: {
            sourceId: 'test',
            provider: 'test',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: { temperature: { value: 20, unit: 'celsius' } },
        };

        mockTransformer.transformWeatherData.resolves({
          success: true,
          transformedData,
          errors: [],
          warnings: [],
        });

        mockCleaner.cleanWeatherRecord.resolves({
          cleanedData: transformedData,
          cleaningActions: [],
          errors: [],
          warnings: [],
          overallQuality: 'excellent',
        });

        mockValidator.validateIngestionData.resolves({
          canIngest: false,
          isValid: false,
          qualityLevel: 'invalid',
          warnings: [],
          errors: ['Validation failed'],
        });

        const result = await orchestrator.ingestWeatherData(
          'NOAA-NWS',
          rawData,
          { strictMode: true }
        );

        expect(result.success).to.be.false;
        expect(result.errors).to.include.something.that.includes(
          'Validation failed'
        );
      });

      it('should fail closed on anti-fraud high-risk decisions in non-strict mode', async () => {
        const rawData = { test: 'data' };
        const transformedData = buildValidIngestionPayload();

        mockTransformer.transformWeatherData.resolves({
          success: true,
          transformedData,
          errors: [],
          warnings: [],
        });

        mockCleaner.cleanWeatherRecord.resolves({
          cleanedData: transformedData,
          cleaningActions: [],
          errors: [],
          warnings: [],
          overallQuality: 'excellent',
        });

        mockValidator.validateIngestionData.resolves({
          canIngest: false,
          isValid: false,
          qualityLevel: 'invalid',
          warnings: [],
          errors: ['Validation failed'],
          riskAssessment: {
            shouldReject: true,
            decision: 'rejected',
            reasonCodes: [AntiFraudReasonCodes.DUPLICATE_REPLAY],
          },
        });

        const result = await orchestrator.ingestWeatherData(
          'NOAA-NWS',
          rawData
        );

        expect(result.success).to.be.false;
        expect(
          result.errors.some(error =>
            error.includes(AntiFraudReasonCodes.DUPLICATE_REPLAY)
          )
        ).to.be.true;
      });
    });

    describe('Batch Processing', () => {
      it('should process multiple data items in batch', async () => {
        const dataArray = [
          { source: 'NOAA-NWS', rawData: { test: 'data1' } },
          { source: 'NOAA-NWS', rawData: { test: 'data2' } },
        ];

        const transformedData = {
          metadata: {
            sourceId: 'test',
            provider: 'test',
            timestamp: new Date().toISOString(),
          },
          location: { latitude: 41.98, longitude: -87.9 },
          measurements: { temperature: { value: 20, unit: 'celsius' } },
        };

        mockTransformer.transformWeatherData.resolves({
          success: true,
          transformedData,
          errors: [],
          warnings: [],
        });

        mockCleaner.cleanWeatherRecord.resolves({
          cleanedData: transformedData,
          cleaningActions: [],
          errors: [],
          warnings: [],
          overallQuality: 'excellent',
        });

        mockValidator.validateIngestionData.resolves({
          canIngest: true,
          isValid: true,
          qualityLevel: 'excellent',
          warnings: [],
          errors: [],
        });

        const results = await orchestrator.ingestWeatherBatch(dataArray);

        expect(results).to.have.length(2);
        expect(results[0].success).to.be.true;
        expect(results[1].success).to.be.true;
      });
    });

    describe('Metrics and Monitoring', () => {
      it('should track processing metrics', async () => {
        const rawData = { test: 'data' };

        const initialStatus = orchestrator.getStatus();
        expect(initialStatus.metrics.totalProcessed).to.equal(0);

        // Mock successful processing
        mockTransformer.transformWeatherData.resolves({
          success: true,
          transformedData: {
            metadata: {
              sourceId: 'test',
              provider: 'test',
              timestamp: new Date().toISOString(),
            },
            location: { latitude: 41.98, longitude: -87.9 },
            measurements: { temperature: { value: 20, unit: 'celsius' } },
          },
          errors: [],
          warnings: [],
        });

        mockCleaner.cleanWeatherRecord.resolves({
          cleanedData: {},
          cleaningActions: [],
          errors: [],
          warnings: [],
          overallQuality: 'excellent',
        });

        mockValidator.validateIngestionData.resolves({
          canIngest: true,
          isValid: true,
          qualityLevel: 'excellent',
          warnings: [],
          errors: [],
        });

        await orchestrator.ingestWeatherData('NOAA-NWS', rawData);

        const finalStatus = orchestrator.getStatus();
        expect(finalStatus.metrics.totalProcessed).to.equal(1);
        expect(finalStatus.metrics.totalIngested).to.equal(1);
        expect(finalStatus.metrics.processingTime).to.have.length(1);
      });

      it('should provide detailed statistics', () => {
        const stats = orchestrator.getDetailedStatistics();

        expect(stats).to.have.property('metrics');
        expect(stats).to.have.property('pipeline');
        expect(stats).to.have.property('performance');
        expect(stats.pipeline).to.have.property('supportedSources');
        expect(stats.performance).to.have.property(
          'processingTimeDistribution'
        );
      });
    });
  });

  describe('Integration Tests', () => {
    describe('End-to-End Pipeline', () => {
      it('should process real NOAA data through complete pipeline', async () => {
        // Real NOAA NWS observation structure (simplified)
        const realNoaaData = {
          properties: {
            station: 'KORD',
            timestamp: '2024-01-15T12:00:00Z',
            temperature: { value: 10, unitCode: 'wmo:degC' },
            relativeHumidity: { value: 60, unitCode: 'wmo:percent' },
            barometricPressure: { value: 101325, unitCode: 'wmo:Pa' },
          },
          geometry: { coordinates: [-87.9, 41.98] },
        };

        const result = await orchestrator.ingestWeatherData(
          'NOAA-NWS',
          realNoaaData
        );

        expect(result.success).to.be.true;
        expect(result.data).to.exist;
        expect(result.data.metadata.provider).to.equal('NOAA-NWS');
        expect(result.data.measurements.temperature.unit).to.equal('celsius');
        expect(result.data.measurements.pressure.unit).to.equal('hPa');
        expect(result.pipeline.transformation.completed).to.be.true;
        expect(result.pipeline.validation.completed).to.be.true;
      });

      it('should handle data quality degradation gracefully', async () => {
        // Poor quality data with outliers and missing values
        const poorQualityData = {
          properties: {
            station: 'KORD',
            timestamp: '2024-01-15T12:00:00Z',
            temperature: { value: 150, unitCode: 'wmo:degC' }, // Outlier
            relativeHumidity: { value: null, unitCode: 'wmo:percent' }, // Missing
            barometricPressure: { value: 50000, unitCode: 'wmo:Pa' }, // Outlier
          },
          geometry: { coordinates: [-87.9, 41.98] },
        };

        const result = await orchestrator.ingestWeatherData(
          'NOAA-NWS',
          poorQualityData
        );

        // Should still succeed in non-strict mode but with warnings
        expect(result.success).to.be.true;
        expect(result.warnings).to.have.length.greaterThan(0);
        expect(result.pipeline.validation.result?.qualityLevel).to.be.oneOf([
          'poor',
          'fair',
        ]);
      });
    });

    describe('Performance Tests', () => {
      it('should process batch data efficiently', async function () {
        this.timeout(10000); // Allow more time for batch processing

        const batchData = Array.from({ length: 20 }, (_, i) => ({
          source: 'NOAA-NWS',
          rawData: {
            properties: {
              station: `KORD${i}`,
              timestamp: new Date().toISOString(),
              temperature: { value: 20 + i, unitCode: 'wmo:degC' },
              relativeHumidity: { value: 60, unitCode: 'wmo:percent' },
            },
            geometry: { coordinates: [-87.9, 41.98] },
          },
        }));

        const startTime = Date.now();
        const results = await orchestrator.ingestWeatherBatch(batchData);
        const processingTime = Date.now() - startTime;

        expect(results).to.have.length(20);
        expect(processingTime).to.be.below(30000); // Should complete within 30 seconds

        const successfulResults = results.filter(r => r.success);
        expect(successfulResults.length).to.be.above(15); // At least 75% success rate
      });
    });
  });
});
