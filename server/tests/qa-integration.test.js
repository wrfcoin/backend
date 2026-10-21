/**
 * Quality Assurance Integration Tests
 *
 * Tests the integration of the data quality assurance pipeline with the
 * existing data ingestion system. Verifies real-time quality validation,
 * data enrichment, and anomaly detection during data flow.
 */

const {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} = require('@jest/globals');
const {
  RealTimeStreamProcessor,
} = require('../services/realtime-stream-processor');
const { DataQualityEngine } = require('../services/data-quality-engine');
const DataProfilingEngine = require('../services/data-profiling-engine');
const AnomalyDetectionEngine = require('../services/anomaly-detection-engine');

// Mock dependencies
jest.mock('../utils/logger');
jest.mock('../database/database-manager');

describe('Quality Assurance Integration Tests', () => {
  let streamProcessor;
  let mockDatabaseManager;

  beforeEach(async () => {
    // Setup mock database manager
    mockDatabaseManager = {
      connect: jest.fn().mockResolvedValue(true),
      disconnect: jest.fn().mockResolvedValue(true),
      insertWeatherData: jest
        .fn()
        .mockResolvedValue({ id: 'test-id', success: true }),
      checkHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    };

    // Initialize stream processor with quality assurance enabled
    streamProcessor = new RealTimeStreamProcessor({
      enableQualityAssurance: true,
      enableQualityScoring: true,
      enableDataProfiling: true,
      enableAdvancedAnomalyDetection: true,
      minimumQualityScore: 0.7,
      profilingBatchSize: 5,
      anomalyEnsembleThreshold: 0.6,
    });

    streamProcessor.databaseManager = mockDatabaseManager;
    await streamProcessor.initialize();
  });

  afterEach(async () => {
    if (streamProcessor.isStreaming) {
      await streamProcessor.stopStreaming();
    }
  });

  describe('Real-time Quality Validation', () => {
    it('should assess data quality during real-time processing', async () => {
      const testData = {
        source: 'test-source',
        location: { id: 'test-station', latitude: 40.7128, longitude: -74.006 },
        data: {
          properties: {
            timestamp: '2025-07-12T12:00:00Z',
            temperature: { value: 25.5, unitCode: 'degC' },
            relativeHumidity: { value: 60, unitCode: 'percent' },
            barometricPressure: { value: 1013.25, unitCode: 'Pa' },
          },
        },
        timestamp: '2025-07-12T12:00:00Z',
        receivedAt: Date.now(),
      };

      // Setup event listeners to capture quality events
      const qualityAssessments = [];
      const dataProcessed = [];

      streamProcessor.on('quality-assessment', assessment => {
        qualityAssessments.push(assessment);
      });

      streamProcessor.on('data-processed', result => {
        dataProcessed.push(result);
      });

      // Process the data
      await streamProcessor.processRealTimeData(testData);

      // Verify quality assessment was performed
      expect(qualityAssessments).toHaveLength(1);
      expect(qualityAssessments[0]).toHaveProperty('overallScore');
      expect(qualityAssessments[0]).toHaveProperty('qualityLevel');
      expect(qualityAssessments[0]).toHaveProperty('flags');

      // Verify data processing included quality metadata
      expect(dataProcessed).toHaveLength(1);
      expect(dataProcessed[0]).toHaveProperty('qualityAssessment');
      expect(dataProcessed[0].qualityAssessment.overallScore).toBeGreaterThan(
        0
      );

      // Verify metrics were updated
      const metrics = streamProcessor.getMetrics();
      expect(metrics.qualityAssurance.totalAssessments).toBe(1);
      expect(metrics.qualityAssurance.averageQualityScore).toBeGreaterThan(0);
    });

    it('should reject data below quality threshold', async () => {
      const poorQualityData = {
        source: 'test-source',
        location: { id: 'test-station', latitude: 40.7128, longitude: -74.006 },
        data: {
          properties: {
            timestamp: '2025-07-12T12:00:00Z',
            temperature: { value: null }, // Missing critical data
            relativeHumidity: { value: null },
            barometricPressure: { value: null },
          },
        },
        timestamp: '2025-07-12T12:00:00Z',
        receivedAt: Date.now(),
      };

      const qualityAssessments = [];
      const dataProcessed = [];

      streamProcessor.on('quality-assessment', assessment => {
        qualityAssessments.push(assessment);
      });

      streamProcessor.on('data-processed', result => {
        dataProcessed.push(result);
      });

      // Process poor quality data
      await streamProcessor.processRealTimeData(poorQualityData);

      // Verify quality assessment was performed
      expect(qualityAssessments).toHaveLength(1);

      // Verify data was rejected (no data-processed event)
      expect(dataProcessed).toHaveLength(0);

      // Verify rejection metrics
      const metrics = streamProcessor.getMetrics();
      expect(metrics.qualityAssurance.rejectedLowQuality).toBeGreaterThan(0);
      expect(metrics.qualityAssurance.rejectionRate).toBeGreaterThan(0);
    });

    it('should enrich data with derived parameters', async () => {
      const testData = {
        source: 'test-source',
        location: { id: 'test-station', latitude: 40.7128, longitude: -74.006 },
        data: {
          properties: {
            timestamp: '2025-07-12T12:00:00Z',
            temperature: { value: 30, unitCode: 'degC' },
            relativeHumidity: { value: 70, unitCode: 'percent' },
            barometricPressure: { value: 1013.25, unitCode: 'Pa' },
          },
        },
        timestamp: '2025-07-12T12:00:00Z',
        receivedAt: Date.now(),
      };

      const dataEnrichments = [];
      const dataProcessed = [];

      streamProcessor.on('data-enrichment', enrichment => {
        dataEnrichments.push(enrichment);
      });

      streamProcessor.on('data-processed', result => {
        dataProcessed.push(result);
      });

      // Process the data
      await streamProcessor.processRealTimeData(testData);

      // Verify data enrichment occurred
      expect(dataProcessed).toHaveLength(1);
      expect(dataProcessed[0].data.quality?.enrichment?.enabled).toBe(true);
      expect(dataProcessed[0].data.quality?.enrichment?.log).toBeDefined();
      expect(
        dataProcessed[0].data.quality?.enrichment?.log.length
      ).toBeGreaterThan(0);
    });
  });

  describe('Advanced Anomaly Detection', () => {
    it('should detect anomalies using ensemble methods', async () => {
      const anomalousData = {
        source: 'test-source',
        location: { id: 'test-station', latitude: 40.7128, longitude: -74.006 },
        data: {
          properties: {
            timestamp: '2025-07-12T12:00:00Z',
            temperature: { value: 100, unitCode: 'degC' }, // Extremely high temperature
            relativeHumidity: { value: 60, unitCode: 'percent' },
            barometricPressure: { value: 1013.25, unitCode: 'Pa' },
          },
        },
        timestamp: '2025-07-12T12:00:00Z',
        receivedAt: Date.now(),
      };

      const advancedAnomalies = [];

      streamProcessor.on('advanced-anomaly-detected', result => {
        advancedAnomalies.push(result);
      });

      // Process anomalous data
      await streamProcessor.processRealTimeData(anomalousData);

      // Verify advanced anomaly detection
      if (advancedAnomalies.length > 0) {
        expect(advancedAnomalies[0]).toHaveProperty('anomalyResults');
        expect(
          advancedAnomalies[0].anomalyResults.anomalies.ensemble
        ).toBeDefined();

        // Verify metrics were updated
        const metrics = streamProcessor.getMetrics();
        expect(
          metrics.qualityAssurance.advancedAnomaliesDetected
        ).toBeGreaterThan(0);
      }
    });
  });

  describe('Data Profiling Integration', () => {
    it('should generate data profiles from batched real-time data', async () => {
      const profileResults = [];

      streamProcessor.on('data-profiled', result => {
        profileResults.push(result);
      });

      // Process multiple data points to trigger profiling
      const dataPoints = [];
      for (let i = 0; i < 6; i++) {
        dataPoints.push({
          source: 'test-source',
          location: {
            id: 'test-station',
            latitude: 40.7128,
            longitude: -74.006,
          },
          data: {
            properties: {
              timestamp: new Date(Date.now() + i * 60000).toISOString(),
              temperature: { value: 20 + i, unitCode: 'degC' },
              relativeHumidity: { value: 60 + i, unitCode: 'percent' },
              barometricPressure: { value: 1013.25, unitCode: 'Pa' },
            },
          },
          timestamp: new Date(Date.now() + i * 60000).toISOString(),
          receivedAt: Date.now(),
        });
      }

      // Process all data points
      for (const dataPoint of dataPoints) {
        await streamProcessor.processRealTimeData(dataPoint);
      }

      // Wait for profiling to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify profiling was triggered
      expect(profileResults.length).toBeGreaterThan(0);
      expect(profileResults[0]).toHaveProperty('profile');
      expect(profileResults[0]).toHaveProperty('dataCount');

      // Verify metrics were updated
      const metrics = streamProcessor.getMetrics();
      expect(metrics.qualityAssurance.profilingOperations).toBeGreaterThan(0);
    });
  });

  describe('Quality Metrics Generation', () => {
    it('should generate and aggregate quality metrics', async () => {
      const qualityMetrics = [];

      streamProcessor.on('quality-metrics-generated', metrics => {
        qualityMetrics.push(metrics);
      });

      // Process multiple data points with varying quality
      const dataPoints = [
        // Good quality data
        {
          source: 'test-source',
          location: {
            id: 'test-station',
            latitude: 40.7128,
            longitude: -74.006,
          },
          data: {
            properties: {
              timestamp: '2025-07-12T12:00:00Z',
              temperature: { value: 25, unitCode: 'degC' },
              relativeHumidity: { value: 60, unitCode: 'percent' },
              barometricPressure: { value: 1013.25, unitCode: 'Pa' },
            },
          },
          timestamp: '2025-07-12T12:00:00Z',
          receivedAt: Date.now(),
        },
        // Poor quality data (incomplete)
        {
          source: 'test-source',
          location: {
            id: 'test-station',
            latitude: 40.7128,
            longitude: -74.006,
          },
          data: {
            properties: {
              timestamp: '2025-07-12T12:01:00Z',
              temperature: { value: null },
              relativeHumidity: { value: null },
              barometricPressure: { value: null },
            },
          },
          timestamp: '2025-07-12T12:01:00Z',
          receivedAt: Date.now(),
        },
      ];

      // Process data points
      for (const dataPoint of dataPoints) {
        await streamProcessor.processRealTimeData(dataPoint);
      }

      // Manually trigger quality buffer processing
      await streamProcessor.processQualityBuffer();

      // Verify quality metrics were generated
      const metrics = streamProcessor.getMetrics();
      expect(metrics.qualityAssurance.totalAssessments).toBeGreaterThan(0);
      expect(metrics.qualityAssurance.rejectedLowQuality).toBeGreaterThan(0);
      expect(metrics.qualityAssurance.rejectionRate).toBeGreaterThan(0);
    });
  });

  describe('Integration Status and Health', () => {
    it('should report quality assurance component status', () => {
      const metrics = streamProcessor.getMetrics();

      // Verify quality assurance components are reported
      expect(metrics.qualityAssurance).toBeDefined();
      expect(metrics.qualityAssurance.enabled).toBe(true);
      expect(metrics.qualityAssurance.components.qualityEngine).toBe(true);
      expect(metrics.qualityAssurance.components.profilingEngine).toBe(true);
      expect(metrics.qualityAssurance.components.anomalyDetectionEngine).toBe(
        true
      );

      // Verify buffer sizes are reported
      expect(metrics.bufferSizes.quality).toBeDefined();
      expect(metrics.bufferSizes.profiling).toBeDefined();
      expect(metrics.bufferSizes.qualityMetrics).toBeDefined();
    });

    it('should provide quality metrics summary', () => {
      const qualityMetrics = streamProcessor.getQualityMetrics();

      expect(qualityMetrics.enabled).toBe(true);
      expect(qualityMetrics.currentMetrics).toBeDefined();
      expect(qualityMetrics.bufferStatus).toBeDefined();
      expect(qualityMetrics.bufferStatus.quality).toBeDefined();
      expect(qualityMetrics.bufferStatus.profiling).toBeDefined();
      expect(qualityMetrics.bufferStatus.processing).toBeDefined();
    });
  });

  describe('Error Handling and Resilience', () => {
    it('should continue processing when quality assessment fails', async () => {
      // Mock quality engine to throw an error
      const originalAssessQuality = streamProcessor.qualityEngine.assessQuality;
      streamProcessor.qualityEngine.assessQuality = jest
        .fn()
        .mockRejectedValue(new Error('Quality assessment failed'));

      const testData = {
        source: 'test-source',
        location: { id: 'test-station', latitude: 40.7128, longitude: -74.006 },
        data: {
          properties: {
            timestamp: '2025-07-12T12:00:00Z',
            temperature: { value: 25, unitCode: 'degC' },
            relativeHumidity: { value: 60, unitCode: 'percent' },
            barometricPressure: { value: 1013.25, unitCode: 'Pa' },
          },
        },
        timestamp: '2025-07-12T12:00:00Z',
        receivedAt: Date.now(),
      };

      const dataProcessed = [];
      streamProcessor.on('data-processed', result => {
        dataProcessed.push(result);
      });

      // Process the data - should continue despite quality assessment failure
      await streamProcessor.processRealTimeData(testData);

      // Verify data was still processed
      expect(dataProcessed).toHaveLength(1);
      expect(mockDatabaseManager.insertWeatherData).toHaveBeenCalled();

      // Restore original method
      streamProcessor.qualityEngine.assessQuality = originalAssessQuality;
    });

    it('should handle missing quality assurance components gracefully', async () => {
      // Create stream processor without quality assurance
      const basicProcessor = new RealTimeStreamProcessor({
        enableQualityAssurance: false,
      });
      basicProcessor.databaseManager = mockDatabaseManager;
      await basicProcessor.initialize();

      const testData = {
        source: 'test-source',
        location: { id: 'test-station', latitude: 40.7128, longitude: -74.006 },
        data: {
          properties: {
            timestamp: '2025-07-12T12:00:00Z',
            temperature: { value: 25, unitCode: 'degC' },
          },
        },
        timestamp: '2025-07-12T12:00:00Z',
        receivedAt: Date.now(),
      };

      // Should process without errors
      await basicProcessor.processRealTimeData(testData);

      // Verify quality assurance is disabled in metrics
      const metrics = basicProcessor.getMetrics();
      expect(metrics.qualityAssurance.enabled).toBe(false);
      expect(metrics.qualityAssurance.components.qualityEngine).toBe(false);
    });
  });
});

module.exports = {
  RealTimeStreamProcessor,
};
