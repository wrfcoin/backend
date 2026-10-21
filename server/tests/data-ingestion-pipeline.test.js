/**
 * WRFCoin Data Ingestion Pipeline Tests
 *
 * Comprehensive test suite for the data ingestion and preprocessing pipeline.
 * Tests all components including data preprocessing, batch processing, real-time streaming,
 * quality assessment, and temporal/spatial processing.
 */

const {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  jest,
} = require('@jest/globals');
const {
  DataIngestionPipeline,
} = require('../services/data-ingestion-pipeline');
const { DataPreprocessor } = require('../services/data-preprocessor');
const { BatchProcessor } = require('../services/batch-processor');
const {
  RealTimeStreamProcessor,
} = require('../services/realtime-stream-processor');
const { DataQualityEngine } = require('../services/data-quality-engine');
const {
  TemporalSpatialProcessor,
} = require('../services/temporal-spatial-processor');
const {
  DataIngestionController,
} = require('../controllers/data-ingestion-controller');
const { DatabaseManager } = require('../database/database-manager');

// Mock dependencies
jest.mock('../utils/logger');
jest.mock('../database/database-manager');
jest.mock('bull');
jest.mock('redis');

describe('Data Ingestion Pipeline Tests', () => {
  let mockDatabaseManager;
  let mockRedisClient;

  beforeAll(() => {
    // Setup global mocks
    mockDatabaseManager = {
      connect: jest.fn().mockResolvedValue(true),
      disconnect: jest.fn().mockResolvedValue(true),
      insertWeatherData: jest
        .fn()
        .mockResolvedValue({ id: 'test-id', success: true }),
      checkHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    };

    mockRedisClient = {
      connect: jest.fn().mockResolvedValue(true),
      setEx: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      quit: jest.fn().mockResolvedValue('OK'),
    };

    // Mock Redis constructor
    jest.mock('redis', () => ({
      createClient: jest.fn(() => mockRedisClient),
    }));

    // Mock Bull queue
    jest.mock('bull', () => {
      return jest.fn().mockImplementation(() => ({
        add: jest.fn().mockResolvedValue({ id: 'job-id' }),
        process: jest.fn(),
        on: jest.fn(),
        close: jest.fn().mockResolvedValue(true),
      }));
    });
  });

  describe('DataPreprocessor', () => {
    let preprocessor;

    beforeEach(() => {
      preprocessor = new DataPreprocessor();
    });

    describe('Data Processing', () => {
      it('should process valid weather data', async () => {
        const inputData = {
          properties: {
            timestamp: '2023-10-15T12:00:00Z',
            temperature: { value: 25.5, unitCode: 'degC' },
            relativeHumidity: { value: 60, unitCode: 'percent' },
            barometricPressure: { value: 1013.25, unitCode: 'Pa' },
          },
          geometry: {
            coordinates: [-74.006, 40.7128],
          },
        };

        const result = await preprocessor.process(inputData, {
          source: 'noaa-nws',
        });

        expect(result).toBeDefined();
        expect(result.source).toBe('noaa-nws');
        expect(result.location.latitude).toBe(40.7128);
        expect(result.location.longitude).toBe(-74.006);
        expect(result.data.temperature.value).toBe(25.5);
        expect(result.data.temperature.unit).toBe('celsius');
        expect(result.data.humidity.value).toBe(60);
        expect(result.data.pressure.value).toBe(10.1325); // Pa to hPa conversion
      });

      it('should handle temperature unit conversion', async () => {
        const fahrenheitData = {
          temperature: { value: 77, unitCode: 'degF' },
          timestamp: '2023-10-15T12:00:00Z',
          location: { latitude: 40.7128, longitude: -74.006 },
        };

        const result = await preprocessor.process(fahrenheitData, {
          source: 'generic',
        });

        expect(result.data.temperature.value).toBeCloseTo(25, 1); // 77°F ≈ 25°C
        expect(result.data.temperature.unit).toBe('celsius');
      });

      it('should handle missing data gracefully', async () => {
        const incompleteData = {
          temperature: { value: 25 },
          timestamp: '2023-10-15T12:00:00Z',
          location: { latitude: 40.7128, longitude: -74.006 },
        };

        const result = await preprocessor.process(incompleteData, {
          source: 'generic',
        });

        expect(result).toBeDefined();
        expect(result.data.temperature.value).toBe(25);
        expect(result.data.humidity.value).toBeNull();
        expect(result.data.pressure.value).toBeNull();
      });

      it('should validate data ranges', () => {
        const invalidData = {
          temperature: { value: 150 }, // Invalid temperature
          timestamp: '2023-10-15T12:00:00Z',
          location: { latitude: 40.7128, longitude: -74.006 },
        };

        expect(() => preprocessor.validateTemperature(150)).toThrow();
      });
    });

    describe('Unit Conversion', () => {
      it('should convert pressure units correctly', () => {
        expect(preprocessor.convertPressure(29.92, 'inhg')).toBeCloseTo(
          1013.25,
          2
        );
        expect(preprocessor.convertPressure(760, 'mmhg')).toBeCloseTo(
          1013.25,
          2
        );
        expect(preprocessor.convertPressure(1013.25, 'hpa')).toBe(1013.25);
      });

      it('should convert wind speed units correctly', () => {
        expect(preprocessor.convertWindSpeed(10, 'mph')).toBeCloseTo(4.47, 2);
        expect(preprocessor.convertWindSpeed(36, 'kmh')).toBeCloseTo(10, 2);
        expect(preprocessor.convertWindSpeed(10, 'ms')).toBe(10);
      });

      it('should convert precipitation units correctly', () => {
        expect(preprocessor.convertPrecipitation(1, 'inches')).toBeCloseTo(
          25.4,
          1
        );
        expect(preprocessor.convertPrecipitation(2.54, 'cm')).toBeCloseTo(
          25.4,
          1
        );
        expect(preprocessor.convertPrecipitation(25.4, 'mm')).toBe(25.4);
      });
    });

    describe('Data Enrichment', () => {
      it('should calculate derived parameters', async () => {
        const data = {
          timestamp: '2023-10-15T12:00:00Z',
          location: { latitude: 40.7128, longitude: -74.006 },
          data: {
            temperature: { value: 30, unit: 'celsius' },
            humidity: { value: 70, unit: 'percent' },
          },
        };

        await preprocessor.enrichData(data);

        expect(data.data.dewPoint).toBeDefined();
        expect(data.data.dewPoint.value).toBeGreaterThan(20);
        expect(data.data.dewPoint.value).toBeLessThan(30);
      });

      it('should add temporal information', () => {
        const data = {
          timestamp: '2023-07-15T12:00:00Z',
          location: { latitude: 40.7128, longitude: -74.006 },
        };

        preprocessor.addTemporalData(data);

        expect(data.metadata.temporal).toBeDefined();
        expect(data.metadata.temporal.hour).toBe(12);
        expect(data.metadata.temporal.month).toBe(7);
        expect(data.metadata.temporal.season).toBe('summer');
      });
    });
  });

  describe('DataQualityEngine', () => {
    let qualityEngine;

    beforeEach(() => {
      qualityEngine = new DataQualityEngine();
    });

    describe('Quality Assessment', () => {
      it('should assess data completeness', async () => {
        const completeData = {
          timestamp: '2023-10-15T12:00:00Z',
          location: { latitude: 40.7128, longitude: -74.006 },
          data: {
            temperature: { value: 25 },
            humidity: { value: 60 },
            pressure: { value: 1013.25 },
            windSpeed: { value: 10 },
            windDirection: { value: 180 },
          },
        };

        const assessment = await qualityEngine.assessQuality(completeData);

        expect(assessment.scores.completeness.overall).toBeGreaterThan(0.8);
        expect(assessment.overallScore).toBeGreaterThan(0.7);
        expect(assessment.qualityLevel).toBe('good');
      });

      it('should detect incomplete data', async () => {
        const incompleteData = {
          timestamp: '2023-10-15T12:00:00Z',
          location: { latitude: 40.7128, longitude: -74.006 },
          data: {
            temperature: { value: 25 },
            // Missing other required parameters
          },
        };

        const assessment = await qualityEngine.assessQuality(incompleteData);

        expect(assessment.scores.completeness.overall).toBeLessThan(0.5);
        expect(assessment.flags).toContainEqual(
          expect.objectContaining({ type: 'completeness' })
        );
      });

      it('should detect accuracy issues', async () => {
        const inaccurateData = {
          timestamp: '2023-10-15T12:00:00Z',
          location: { latitude: 40.7128, longitude: -74.006 },
          data: {
            temperature: { value: 200 }, // Impossible temperature
            humidity: { value: 60 },
            pressure: { value: 1013.25 },
          },
        };

        const assessment = await qualityEngine.assessQuality(inaccurateData);

        expect(assessment.scores.accuracy.overall).toBeLessThan(0.5);
        expect(assessment.flags).toContainEqual(
          expect.objectContaining({ type: 'accuracy' })
        );
      });
    });

    describe('Data Enrichment', () => {
      it('should enrich data with derived parameters', async () => {
        const data = {
          timestamp: '2023-10-15T12:00:00Z',
          location: { latitude: 40.7128, longitude: -74.006 },
          data: {
            temperature: { value: 25 },
            humidity: { value: 60 },
            pressure: { value: 1013.25 },
          },
        };

        const enriched = await qualityEngine.enrichData(data);

        expect(enriched.quality.enrichment).toBeDefined();
        expect(enriched.quality.enrichment.enabled).toBe(true);
        expect(enriched.quality.enrichment.log).toContain(
          'Calculated dew point from temperature and humidity'
        );
      });
    });
  });

  describe('TemporalSpatialProcessor', () => {
    let processor;

    beforeEach(() => {
      processor = new TemporalSpatialProcessor();
    });

    describe('Temporal Aggregation', () => {
      it('should aggregate hourly data', async () => {
        const data = [
          {
            timestamp: '2023-10-15T12:00:00Z',
            location: { latitude: 40.7128, longitude: -74.006 },
            data: { temperature: { value: 25 } },
          },
          {
            timestamp: '2023-10-15T12:30:00Z',
            location: { latitude: 40.7128, longitude: -74.006 },
            data: { temperature: { value: 26 } },
          },
        ];

        const result = await processor.aggregateTemporalData(data, {
          interval: 'hour',
          parameters: ['temperature'],
        });

        expect(result.aggregatedData).toHaveLength(1);
        expect(result.aggregatedData[0].data.temperature.value).toBeCloseTo(
          25.5,
          1
        );
        expect(result.aggregatedData[0].dataPointCount).toBe(2);
      });

      it('should handle different aggregation methods', async () => {
        const data = [
          {
            timestamp: '2023-10-15T12:00:00Z',
            location: { latitude: 40.7128, longitude: -74.006 },
            data: { precipitation: { value: 5 } },
          },
          {
            timestamp: '2023-10-15T12:30:00Z',
            location: { latitude: 40.7128, longitude: -74.006 },
            data: { precipitation: { value: 3 } },
          },
        ];

        const result = await processor.aggregateTemporalData(data, {
          interval: 'hour',
          parameters: ['precipitation'],
          aggregationMethods: { precipitation: 'sum' },
        });

        expect(result.aggregatedData[0].data.precipitation.value).toBe(8);
      });
    });

    describe('Spatial Interpolation', () => {
      it('should perform inverse distance weighting', async () => {
        const data = [
          {
            location: { latitude: 40.7128, longitude: -74.006 },
            timestamp: '2023-10-15T12:00:00Z',
            value: 25,
            quality: 0.9,
          },
          {
            location: { latitude: 40.72, longitude: -74.0 },
            timestamp: '2023-10-15T12:00:00Z',
            value: 26,
            quality: 0.8,
          },
        ];

        const targetLocations = [
          { latitude: 40.7164, longitude: -74.003 }, // Point between the two
        ];

        const result = await processor.interpolateSpatialData(
          data,
          targetLocations,
          {
            method: 'idw',
            parameter: 'temperature',
          }
        );

        expect(result.interpolatedValues).toHaveLength(1);
        expect(result.interpolatedValues[0].value).toBeGreaterThan(25);
        expect(result.interpolatedValues[0].value).toBeLessThan(26);
        expect(result.interpolatedValues[0].method).toBe('idw');
      });

      it('should generate grid data', async () => {
        const data = [
          { location: { latitude: 40.0, longitude: -74.0 }, value: 25 },
          { location: { latitude: 40.1, longitude: -74.0 }, value: 26 },
          { location: { latitude: 40.0, longitude: -73.9 }, value: 24 },
          { location: { latitude: 40.1, longitude: -73.9 }, value: 27 },
        ];

        const result = await processor.generateGrid(data, {
          bounds: { north: 40.1, south: 40.0, east: -73.9, west: -74.0 },
          resolution: 0.05,
          parameter: 'temperature',
        });

        expect(result.grid).toBeDefined();
        expect(result.grid.length).toBeGreaterThan(0);
        expect(result.metadata.gridDimensions.width).toBeGreaterThan(0);
        expect(result.metadata.gridDimensions.height).toBeGreaterThan(0);
      });
    });

    describe('Gap Filling', () => {
      it('should fill temporal gaps', async () => {
        const data = [
          {
            timestamp: '2023-10-15T12:00:00Z',
            location: { latitude: 40.7128, longitude: -74.006 },
            data: { temperature: { value: 25 } },
          },
          {
            timestamp: '2023-10-15T13:00:00Z',
            location: { latitude: 40.7128, longitude: -74.006 },
            data: { temperature: { value: null } }, // Missing data
          },
          {
            timestamp: '2023-10-15T14:00:00Z',
            location: { latitude: 40.7128, longitude: -74.006 },
            data: { temperature: { value: 27 } },
          },
        ];

        const result = await processor.fillMissingData(data, {
          method: 'temporal',
          parameters: ['temperature'],
        });

        expect(result.filledData[1].data.temperature.filled).toBe(true);
        expect(result.filledData[1].data.temperature.value).toBeCloseTo(26, 1);
        expect(result.fillLog).toHaveLength(1);
      });
    });

    describe('Trend Analysis', () => {
      it('should analyze linear trends', async () => {
        const data = Array.from({ length: 10 }, (_, i) => ({
          timestamp: new Date(2023, 9, 15, 12 + i).toISOString(),
          location: { latitude: 40.7128, longitude: -74.006 },
          data: { temperature: { value: 20 + i * 0.5 } }, // Increasing trend
        }));

        const result = await processor.analyzeTrends(data, {
          parameter: 'temperature',
          interval: 'hour',
          trendMethods: ['linear'],
        });

        expect(result.trends.linear.slope).toBeGreaterThan(0);
        expect(result.trends.linear.trend).toBe('increasing');
        expect(result.trends.linear.correlation).toBeCloseTo(1, 1);
      });
    });
  });

  describe('BatchProcessor', () => {
    let batchProcessor;

    beforeEach(() => {
      batchProcessor = new BatchProcessor();
      batchProcessor.databaseManager = mockDatabaseManager;
    });

    describe('Batch Processing', () => {
      it('should process historical data in batches', async () => {
        const request = {
          locations: [
            {
              id: 'station1',
              stationId: 'NOAA001',
              latitude: 40.7128,
              longitude: -74.006,
            },
          ],
          startDate: '2023-10-01',
          endDate: '2023-10-02',
          dataTypes: ['TMAX', 'TMIN'],
          resumeFromProgress: false,
        };

        // Mock NOAA data service
        batchProcessor.noaaDataService = {
          getHistoricalData: jest.fn().mockResolvedValue([
            {
              date: '2023-10-01',
              station: 'NOAA001',
              datatype: 'TMAX',
              value: 25.5,
            },
          ]),
        };

        const result = await batchProcessor.processHistoricalData(request);

        expect(result.totalProcessed).toBeGreaterThan(0);
        expect(result.isComplete).toBe(true);
        expect(result.successRate).toBeGreaterThan(0);
      });

      it('should handle batch errors gracefully', async () => {
        const request = {
          locations: [{ id: 'invalid-station' }],
          startDate: '2023-10-01',
          endDate: '2023-10-02',
        };

        batchProcessor.noaaDataService = {
          getHistoricalData: jest
            .fn()
            .mockRejectedValue(new Error('Station not found')),
        };

        await expect(
          batchProcessor.processHistoricalData(request)
        ).rejects.toThrow('Station not found');
      });
    });

    describe('Progress Tracking', () => {
      it('should save and load progress', async () => {
        const mockFs = jest.requireMock('fs').promises;
        mockFs.writeFile = jest.fn().mockResolvedValue();
        mockFs.readFile = jest.fn().mockResolvedValue(
          JSON.stringify({
            totalRecords: 100,
            processedRecords: 50,
          })
        );

        await batchProcessor.saveProgress();
        await batchProcessor.loadProgress();

        expect(batchProcessor.progress.totalRecords).toBe(100);
        expect(batchProcessor.progress.processedRecords).toBe(50);
      });
    });
  });

  describe('RealTimeStreamProcessor', () => {
    let streamProcessor;

    beforeEach(() => {
      streamProcessor = new RealTimeStreamProcessor();
      streamProcessor.databaseManager = mockDatabaseManager;
    });

    describe('Real-time Processing', () => {
      it('should process real-time data', async () => {
        const data = {
          source: 'noaa-nws-realtime',
          location: { id: 'station1', latitude: 40.7128, longitude: -74.006 },
          data: {
            properties: {
              temperature: { value: 25.5 },
              timestamp: '2023-10-15T12:00:00Z',
            },
          },
          timestamp: '2023-10-15T12:00:00Z',
        };

        await streamProcessor.processRealTimeData(data);

        expect(mockDatabaseManager.insertWeatherData).toHaveBeenCalled();
      });

      it('should detect anomalies', () => {
        const data = {
          timestamp: '2023-10-15T12:00:00Z',
          location: { latitude: 40.7128, longitude: -74.006 },
          data: { temperature: { value: 150 } }, // Extreme temperature
        };

        // Mock baseline data
        streamProcessor.historicalData.set('40.7128_-74.006', {
          temperature: { mean: 25, stdDev: 5 },
        });
        streamProcessor.baselineCalculated = true;

        const anomaly = streamProcessor.detectAnomaly(data);

        expect(anomaly).toBeDefined();
        expect(anomaly.anomalies).toContainEqual(
          expect.objectContaining({ parameter: 'temperature' })
        );
      });
    });

    describe('Alert Generation', () => {
      it('should generate temperature alerts', () => {
        const data = {
          timestamp: '2023-10-15T12:00:00Z',
          location: { latitude: 40.7128, longitude: -74.006 },
          data: { temperature: { value: 50 } }, // Extreme heat
        };

        const alerts = [];
        streamProcessor.on('alert-generated', alert => alerts.push(alert));

        streamProcessor.checkForAlerts(data);

        expect(alerts).toHaveLength(1);
        expect(alerts[0].type).toBe('extreme_heat');
      });
    });
  });

  describe('DataIngestionController', () => {
    let controller;

    beforeEach(async () => {
      controller = new DataIngestionController();

      // Mock all services
      controller.databaseManager = mockDatabaseManager;
      controller.pipeline = {
        initialize: jest.fn().mockResolvedValue(),
        ingestData: jest.fn().mockResolvedValue({ processed: 1 }),
        getStats: jest.fn().mockReturnValue({}),
        getHealth: jest.fn().mockReturnValue({ status: 'healthy' }),
        stop: jest.fn().mockResolvedValue(),
      };
      controller.batchProcessor = {
        initialize: jest.fn().mockResolvedValue(),
        processHistoricalData: jest.fn().mockResolvedValue({}),
        getStatus: jest.fn().mockReturnValue({ isRunning: false }),
        stop: jest.fn().mockResolvedValue(),
      };
      controller.streamProcessor = {
        initialize: jest.fn().mockResolvedValue(),
        startStreaming: jest.fn().mockResolvedValue(),
        stopStreaming: jest.fn().mockResolvedValue(),
        getStatus: jest.fn().mockReturnValue({ isStreaming: false }),
        getMetrics: jest.fn().mockReturnValue({}),
      };
      controller.qualityEngine = {
        assessQuality: jest.fn().mockResolvedValue({}),
        enrichData: jest.fn().mockResolvedValue({}),
        getMetrics: jest.fn().mockReturnValue({}),
      };
      controller.spatialProcessor = {
        aggregateTemporalData: jest.fn().mockResolvedValue({}),
        interpolateSpatialData: jest.fn().mockResolvedValue({}),
        generateGrid: jest.fn().mockResolvedValue({}),
        fillMissingData: jest.fn().mockResolvedValue({}),
        getMetrics: jest.fn().mockReturnValue({}),
      };

      await controller.initialize();
    });

    afterEach(async () => {
      if (controller.isInitialized) {
        await controller.shutdown();
      }
    });

    describe('Initialization', () => {
      it('should initialize successfully', () => {
        expect(controller.isInitialized).toBe(true);
        expect(controller.services.size).toBeGreaterThan(0);
      });
    });

    describe('API Endpoints', () => {
      it('should handle data ingestion requests', async () => {
        const req = {
          body: {
            sources: [
              {
                type: 'noaa-nws',
                location: { latitude: 40.7128, longitude: -74.006 },
              },
            ],
          },
        };
        const res = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        };

        await controller.ingestData(req, res);

        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ success: true })
        );
      });

      it('should handle quality assessment requests', async () => {
        const req = {
          body: {
            data: {
              timestamp: '2023-10-15T12:00:00Z',
              location: { latitude: 40.7128, longitude: -74.006 },
              data: { temperature: { value: 25 } },
            },
          },
        };
        const res = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        };

        await controller.assessDataQuality(req, res);

        expect(controller.qualityEngine.assessQuality).toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ success: true })
        );
      });

      it('should provide health check information', async () => {
        const req = {};
        const res = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        };

        await controller.healthCheck(req, res);

        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            data: expect.objectContaining({ status: 'healthy' }),
          })
        );
      });
    });

    describe('Error Handling', () => {
      it('should handle validation errors', async () => {
        const req = {
          body: { sources: 'invalid' }, // Should be array
        };
        const res = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        };

        await controller.ingestData(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ success: false })
        );
      });

      it('should handle service errors', async () => {
        controller.pipeline.ingestData = jest
          .fn()
          .mockRejectedValue(new Error('Service error'));

        const req = {
          body: {
            sources: [
              {
                type: 'noaa-nws',
                location: { latitude: 40.7128, longitude: -74.006 },
              },
            ],
          },
        };
        const res = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        };

        await controller.ingestData(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: 'Service error',
          })
        );
      });
    });
  });

  describe('Integration Tests', () => {
    let controller;

    beforeEach(async () => {
      // Use real components for integration testing
      controller = new DataIngestionController();

      // Mock only external dependencies
      controller.databaseManager = mockDatabaseManager;

      await controller.initialize();
    });

    afterEach(async () => {
      if (controller.isInitialized) {
        await controller.shutdown();
      }
    });

    it('should process data end-to-end', async () => {
      const inputData = {
        properties: {
          timestamp: '2023-10-15T12:00:00Z',
          temperature: { value: 25.5, unitCode: 'degC' },
          relativeHumidity: { value: 60, unitCode: 'percent' },
        },
        geometry: {
          coordinates: [-74.006, 40.7128],
        },
      };

      // Process through preprocessor
      const preprocessor = new DataPreprocessor();
      const processed = await preprocessor.process(inputData, {
        source: 'noaa-nws',
      });

      // Assess quality
      const qualityEngine = new DataQualityEngine();
      const assessment = await qualityEngine.assessQuality(processed);

      // Enrich data
      const enriched = await qualityEngine.enrichData(processed, assessment);

      expect(enriched).toBeDefined();
      expect(enriched.source).toBe('noaa-nws');
      expect(enriched.data.temperature.value).toBe(25.5);
      expect(enriched.quality.enrichment).toBeDefined();
      expect(assessment.overallScore).toBeGreaterThan(0);
    });

    it('should handle batch to real-time transition', async () => {
      // Start with batch processing
      const batchProcessor = new BatchProcessor();
      batchProcessor.databaseManager = mockDatabaseManager;

      // Mock batch data
      const batchData = [
        {
          timestamp: '2023-10-15T10:00:00Z',
          location: { latitude: 40.7128, longitude: -74.006 },
          data: { temperature: { value: 24 } },
        },
      ];

      // Process batch
      const preprocessor = new DataPreprocessor();
      const processedBatch = await Promise.all(
        batchData.map(data => preprocessor.process(data, { source: 'batch' }))
      );

      // Transition to real-time
      const streamProcessor = new RealTimeStreamProcessor();
      streamProcessor.databaseManager = mockDatabaseManager;

      const realtimeData = {
        timestamp: '2023-10-15T12:00:00Z',
        location: { latitude: 40.7128, longitude: -74.006 },
        data: { temperature: { value: 26 } },
      };

      const processedRealtime = await preprocessor.process(realtimeData, {
        source: 'realtime',
      });

      expect(processedBatch).toHaveLength(1);
      expect(processedRealtime).toBeDefined();
      expect(processedRealtime.data.temperature.value).toBe(26);
    });
  });

  describe('Performance Tests', () => {
    it('should handle large data volumes efficiently', async () => {
      const preprocessor = new DataPreprocessor();
      const largeDataset = Array.from({ length: 1000 }, (_, i) => ({
        timestamp: new Date(2023, 9, 15, 12, i % 60).toISOString(),
        location: {
          latitude: 40.7128 + (i % 10) * 0.001,
          longitude: -74.006 + (i % 10) * 0.001,
        },
        data: { temperature: { value: 20 + Math.random() * 20 } },
      }));

      const startTime = Date.now();
      const results = await Promise.all(
        largeDataset.map(data =>
          preprocessor.process(data, { source: 'performance-test' })
        )
      );
      const processingTime = Date.now() - startTime;

      expect(results).toHaveLength(1000);
      expect(processingTime).toBeLessThan(10000); // Should process 1000 items in less than 10 seconds

      // Check that all results are valid
      results.forEach(result => {
        expect(result).toBeDefined();
        expect(result.source).toBe('performance-test');
        expect(result.data.temperature.value).toBeGreaterThan(0);
      });
    });

    it('should handle concurrent processing', async () => {
      const qualityEngine = new DataQualityEngine();
      const concurrentRequests = Array.from({ length: 10 }, (_, i) => ({
        timestamp: '2023-10-15T12:00:00Z',
        location: { latitude: 40.7128, longitude: -74.006 },
        data: { temperature: { value: 20 + i } },
      }));

      const startTime = Date.now();
      const results = await Promise.all(
        concurrentRequests.map(data => qualityEngine.assessQuality(data))
      );
      const processingTime = Date.now() - startTime;

      expect(results).toHaveLength(10);
      expect(processingTime).toBeLessThan(5000); // Should handle 10 concurrent requests in less than 5 seconds

      results.forEach(result => {
        expect(result.overallScore).toBeGreaterThan(0);
        expect(result.qualityLevel).toBeDefined();
      });
    });
  });
});

module.exports = {
  DataIngestionPipeline,
  DataPreprocessor,
  BatchProcessor,
  RealTimeStreamProcessor,
  DataQualityEngine,
  TemporalSpatialProcessor,
  DataIngestionController,
};
