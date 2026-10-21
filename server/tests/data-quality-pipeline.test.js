/**
 * Comprehensive Test Suite for WRFCoin Data Quality Assurance Pipeline
 *
 * Tests all components of the data quality pipeline including profiling,
 * anomaly detection, reporting, and API endpoints.
 *
 * @author WRFCoin Development Team
 * @version 1.0.0
 * @since 2025-07-12
 */

const request = require('supertest');
const express = require('express');
const DataProfilingEngine = require('../services/data-profiling-engine');
const AnomalyDetectionEngine = require('../services/anomaly-detection-engine');
const QualityReportingService = require('../services/quality-reporting-service');
const DataQualityController = require('../controllers/data-quality-controller');
const dataQualityRoutes = require('../routes/data-quality-routes');
const {
  getSharedAntiFraudQualityPipeline,
} = require('../services/anti-fraud-quality-pipeline');

// Test data generators
const generateSampleWeatherData = (count = 100, anomalyRate = 0.05) => {
  const data = [];
  const anomalyCount = Math.floor(count * anomalyRate);

  for (let i = 0; i < count; i++) {
    const isAnomaly = i < anomalyCount;

    const record = {
      timestamp: new Date(Date.now() - (count - i) * 60000).toISOString(),
      temperature: isAnomaly
        ? Math.random() * 100 + 50
        : Math.random() * 30 + 10, // Normal: 10-40°C, Anomaly: 50-150°C
      humidity: isAnomaly ? Math.random() * 200 : Math.random() * 100, // Normal: 0-100%, Anomaly: 0-200%
      pressure: isAnomaly
        ? Math.random() * 200 + 1200
        : Math.random() * 200 + 950, // Normal: 950-1150 hPa, Anomaly: 1200-1400 hPa
      windSpeed: isAnomaly ? Math.random() * 200 : Math.random() * 20, // Normal: 0-20 m/s, Anomaly: 0-200 m/s
      windDirection: Math.random() * 360,
      precipitation: Math.random() * 10,
      visibility: Math.random() * 20000 + 1000,
      dewPoint: isAnomaly ? Math.random() * 60 + 20 : Math.random() * 25 + 5,
      location: 'test_station_001',
      stationId: 'WRFC_TEST_001',
    };

    data.push(record);
  }

  return data;
};

const generateIncompleteWeatherData = (count = 100, missingRate = 0.3) => {
  const data = generateSampleWeatherData(count);

  return data.map(record => {
    const newRecord = { ...record };
    const params = Object.keys(newRecord).filter(
      key => key !== 'timestamp' && key !== 'location'
    );

    // Randomly remove parameters based on missing rate
    params.forEach(param => {
      if (Math.random() < missingRate) {
        delete newRecord[param];
      }
    });

    return newRecord;
  });
};

const generatePhysicsViolationData = (count = 50) => {
  const data = [];

  for (let i = 0; i < count; i++) {
    const record = {
      timestamp: new Date(Date.now() - (count - i) * 60000).toISOString(),
      temperature: 20,
      humidity: 80,
      pressure: 1013.25,
      windSpeed: 10,
      dewPoint: 25, // Violates physics: dew point > temperature
      location: 'test_station_002',
    };

    data.push(record);
  }

  return data;
};

// Test suite setup
describe('Data Quality Assurance Pipeline', () => {
  let app;
  let profilingEngine;
  let anomalyDetectionEngine;
  let reportingService;
  let controller;
  let antiFraudPipeline;

  beforeAll(async () => {
    // Setup Express app for API testing
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/data-quality', dataQualityRoutes);

    // Initialize services
    profilingEngine = new DataProfilingEngine();
    anomalyDetectionEngine = new AnomalyDetectionEngine();
    reportingService = new QualityReportingService();
    controller = new DataQualityController();
    antiFraudPipeline = getSharedAntiFraudQualityPipeline();
    antiFraudPipeline.resetStateForTests();
  });

  afterAll(async () => {
    // Cleanup
    if (profilingEngine) profilingEngine.clearCache();
    if (reportingService) await reportingService.cleanup();
    if (antiFraudPipeline) antiFraudPipeline.resetStateForTests();
  });

  // =======================
  // DATA PROFILING TESTS
  // =======================

  describe('Data Profiling Engine', () => {
    test('should generate comprehensive profile for normal weather data', async () => {
      const data = generateSampleWeatherData(200, 0.02);
      const profile = await profilingEngine.generateProfile(data, {
        location: 'test_location',
        source: 'unit_test',
      });

      expect(profile).toBeDefined();
      expect(profile.metadata.recordCount).toBe(200);
      expect(profile.statistical).toBeDefined();
      expect(profile.temporal).toBeDefined();
      expect(profile.completeness).toBeDefined();
      expect(profile.quality).toBeDefined();
      expect(profile.quality.overallScore).toBeGreaterThan(0);
    });

    test('should handle incomplete data correctly', async () => {
      const data = generateIncompleteWeatherData(100, 0.4);
      const profile = await profilingEngine.generateProfile(data);

      expect(profile.completeness.overall.completenessPercentage).toBeLessThan(
        80
      );
      expect(profile.quality.scores.completeness.score).toBeLessThan(80);
      expect(profile.quality.scores.completeness.category).toMatch(/fair|poor/);
    });

    test('should calculate statistical measures correctly', async () => {
      const data = generateSampleWeatherData(1000, 0);
      const profile = await profilingEngine.generateProfile(data);

      const tempStats = profile.statistical.temperature;
      expect(tempStats).toBeDefined();
      expect(tempStats.mean).toBeGreaterThan(10);
      expect(tempStats.mean).toBeLessThan(40);
      expect(tempStats.standardDeviation).toBeGreaterThan(0);
      expect(tempStats.min).toBeGreaterThanOrEqual(10);
      expect(tempStats.max).toBeLessThanOrEqual(40);
      expect(tempStats.percentiles).toBeDefined();
      expect(tempStats.percentiles.p50).toBeDefined(); // Median
    });

    test('should detect outliers correctly', async () => {
      const data = generateSampleWeatherData(100, 0.1);
      const profile = await profilingEngine.generateProfile(data);

      const tempStats = profile.statistical.temperature;
      expect(tempStats.outliers.zScore.count).toBeGreaterThan(0);
      expect(tempStats.outliers.iqr.count).toBeGreaterThan(0);
    });

    test('should analyze temporal patterns', async () => {
      const data = generateSampleWeatherData(100, 0);
      const profile = await profilingEngine.generateProfile(data);

      expect(profile.temporal.timeRange).toBeDefined();
      expect(profile.temporal.timeRange.start).toBeDefined();
      expect(profile.temporal.timeRange.end).toBeDefined();
      expect(profile.temporal.frequency).toBeDefined();
      expect(profile.temporal.gaps).toBeDefined();
    });

    test('should handle empty data gracefully', async () => {
      await expect(profilingEngine.generateProfile([])).rejects.toThrow(
        'Invalid or empty dataset provided'
      );
    });

    test('should handle malformed data gracefully', async () => {
      const malformedData = [
        { temperature: 'invalid', humidity: null },
        { temperature: NaN, humidity: undefined },
        { timestamp: 'invalid_date' },
      ];

      const profile = await profilingEngine.generateProfile(malformedData);
      expect(profile.completeness.overall.completenessPercentage).toBeLessThan(
        50
      );
    });
  });

  // =======================
  // ANOMALY DETECTION TESTS
  // =======================

  describe('Anomaly Detection Engine', () => {
    test('should detect statistical anomalies', async () => {
      const data = generateSampleWeatherData(200, 0.1);
      const results = await anomalyDetectionEngine.detectAnomalies(data);

      expect(results.anomalies.byMethod.zscore).toBeDefined();
      expect(results.anomalies.byMethod.iqr).toBeDefined();
      expect(
        results.anomalies.byMethod.zscore.anomalies.length
      ).toBeGreaterThan(0);
      expect(results.anomalies.ensemble.anomalies.length).toBeGreaterThan(0);
    });

    test('should detect physics-based violations', async () => {
      const data = generatePhysicsViolationData(50);
      const results = await anomalyDetectionEngine.detectAnomalies(data);

      expect(results.anomalies.byMethod.physics_based).toBeDefined();
      expect(results.anomalies.byMethod.physics_based.anomalies.length).toBe(
        50
      );

      const violation = results.anomalies.byMethod.physics_based.anomalies[0];
      expect(violation.violations).toContain('dewpoint_exceeds_temperature');
    });

    test('should perform ensemble analysis', async () => {
      const data = generateSampleWeatherData(100, 0.15);
      const results = await anomalyDetectionEngine.detectAnomalies(data);

      expect(results.anomalies.ensemble).toBeDefined();
      expect(results.anomalies.ensemble.anomalies).toBeDefined();
      expect(results.anomalies.ensemble.confidenceScore).toBeGreaterThan(0);
      expect(results.anomalies.ensemble.totalMethods).toBeGreaterThan(1);
    });

    test('should detect temporal anomalies', async () => {
      // Create data with sudden spike
      const data = generateSampleWeatherData(50, 0);
      data[25].temperature = 100; // Sudden spike

      const results = await anomalyDetectionEngine.detectAnomalies(data);
      expect(results.anomalies.byMethod.temporal_anomaly).toBeDefined();
    });

    test('should handle different detection options', async () => {
      const data = generateSampleWeatherData(100, 0.05);
      const options = {
        zScoreThreshold: 2.5,
        iqrMultiplier: 2.0,
        ensembleThreshold: 0.7,
      };

      const results = await anomalyDetectionEngine.detectAnomalies(
        data,
        options
      );
      expect(results.metadata.detectionMethods).toContain('zscore');
      expect(results.metadata.detectionMethods).toContain('iqr');
    });

    test('should generate recommendations', async () => {
      const data = generatePhysicsViolationData(20);
      const results = await anomalyDetectionEngine.detectAnomalies(data);

      expect(results.recommendations).toBeDefined();
      expect(results.recommendations.length).toBeGreaterThan(0);

      const physicsRec = results.recommendations.find(
        r => r.type === 'physics'
      );
      expect(physicsRec).toBeDefined();
    });

    test('should handle clean data (no anomalies)', async () => {
      const data = generateSampleWeatherData(50, 0);
      const results = await anomalyDetectionEngine.detectAnomalies(data);

      expect(results.anomalies.ensemble.summary.total).toBe(0);
      expect(results.recommendations.length).toBeGreaterThan(0);
      const normalRec = results.recommendations.find(r => r.type === 'normal');
      expect(normalRec).toBeDefined();
    });
  });

  // =======================
  // REPORTING SERVICE TESTS
  // =======================

  describe('Quality Reporting Service', () => {
    test('should generate comprehensive quality report', async () => {
      const data = generateSampleWeatherData(100, 0.1);
      const profile = await profilingEngine.generateProfile(data);
      const anomalies = await anomalyDetectionEngine.detectAnomalies(data);

      const qualityData = {
        ...profile,
        anomalies: anomalies.anomalies,
        recommendations: anomalies.recommendations,
      };

      const result = await reportingService.generateQualityReport(qualityData, {
        source: 'unit_test',
      });

      expect(result.report).toBeDefined();
      expect(result.reportId).toBeDefined();
      expect(result.report.executiveSummary).toBeDefined();
      expect(result.report.qualityScores).toBeDefined();
      expect(result.report.anomalies).toBeDefined();
      expect(result.report.recommendations).toBeDefined();
    });

    test('should format reports in different formats', async () => {
      const qualityData = {
        metadata: { recordCount: 100 },
        quality: { overallScore: 85, scores: {} },
        anomalies: { ensemble: { summary: { total: 5 } } },
      };

      const jsonReport = await reportingService.generateQualityReport(
        qualityData,
        {},
        'json'
      );
      const htmlReport = await reportingService.generateQualityReport(
        qualityData,
        {},
        'html'
      );
      const csvReport = await reportingService.generateQualityReport(
        qualityData,
        {},
        'csv'
      );

      expect(jsonReport.formatted).toContain('"success"');
      expect(htmlReport.formatted).toContain('<html>');
      expect(csvReport.formatted).toContain('Quality Scores');
    });

    test('should generate alerts for poor quality data', async () => {
      const poorQualityData = {
        metadata: { recordCount: 100 },
        quality: {
          overallScore: 50,
          scores: {
            completeness: { score: 60 },
            accuracy: { score: 70 },
            consistency: { score: 40 },
            timeliness: { score: 90 },
          },
        },
        anomalies: { ensemble: { summary: { total: 15 } } },
      };

      const result =
        await reportingService.generateQualityReport(poorQualityData);
      expect(result.report.alerts.length).toBeGreaterThan(0);

      const consistencyAlert = result.report.alerts.find(
        a => a.metric === 'consistency'
      );
      expect(consistencyAlert).toBeDefined();
      expect(consistencyAlert.severity).toBe('high');
    });

    test('should maintain dashboard data', async () => {
      const qualityData = {
        metadata: { recordCount: 100 },
        quality: { overallScore: 85 },
        anomalies: { ensemble: { summary: { total: 2 } } },
      };

      await reportingService.generateQualityReport(qualityData);
      const dashboard = reportingService.getDashboardData();

      expect(dashboard.latest).toBeDefined();
      expect(dashboard.latest.overallScore).toBe(85);
      expect(dashboard.history).toBeDefined();
    });

    test('should cache and retrieve reports', async () => {
      const qualityData = {
        metadata: { recordCount: 50 },
        quality: { overallScore: 90 },
      };

      const result = await reportingService.generateQualityReport(qualityData);
      const cached = reportingService.getReport(result.reportId);

      expect(cached).toBeDefined();
      expect(cached.id).toBe(result.reportId);
    });

    test('should list recent reports', async () => {
      // Generate multiple reports
      for (let i = 0; i < 3; i++) {
        const qualityData = {
          metadata: { recordCount: 50 + i },
          quality: { overallScore: 80 + i },
        };
        await reportingService.generateQualityReport(qualityData);
      }

      const reports = reportingService.listReports(5);
      expect(reports.length).toBeGreaterThanOrEqual(3);
      expect(reports[0].generatedAt).toBeDefined();
    });
  });

  // =======================
  // API ENDPOINT TESTS
  // =======================

  describe('Data Quality API Endpoints', () => {
    test('POST /api/data-quality/profile should generate profile', async () => {
      const data = generateSampleWeatherData(50);

      const response = await request(app)
        .post('/api/data-quality/profile')
        .send({ data, metadata: { source: 'api_test' } })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.profile).toBeDefined();
      expect(response.body.profile.metadata.recordCount).toBe(50);
    });

    test('POST /api/data-quality/anomalies should detect anomalies', async () => {
      const data = generateSampleWeatherData(50, 0.1);

      const response = await request(app)
        .post('/api/data-quality/anomalies')
        .send({ data })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.results.anomalies).toBeDefined();
    });

    test('POST /api/data-quality/analyze should run comprehensive analysis', async () => {
      const data = generateSampleWeatherData(30, 0.05);

      const response = await request(app)
        .post('/api/data-quality/analyze')
        .send({ data, metadata: { source: 'api_test' } })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.analysis.profile).toBeDefined();
      expect(response.body.analysis.anomalies).toBeDefined();
      expect(response.body.analysis.report).toBeDefined();
      expect(response.body.analysis.reportId).toBeDefined();
    });

    test('POST /api/data-quality/validate should validate data quality', async () => {
      const data = generateIncompleteWeatherData(50, 0.5); // High missing rate

      const response = await request(app)
        .post('/api/data-quality/validate')
        .send({
          data,
          thresholds: { completeness: 80, accuracy: 85 },
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.validation.passed).toBe(false);
      expect(response.body.validation.violations.length).toBeGreaterThan(0);
    });

    test('GET /api/data-quality/dashboard should return dashboard data', async () => {
      const response = await request(app)
        .get('/api/data-quality/dashboard')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.dashboard).toBeDefined();
    });

    test('GET /api/data-quality/health should return health status', async () => {
      const response = await request(app)
        .get('/api/data-quality/health')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.health.status).toBe('healthy');
      expect(response.body.health.services).toBeDefined();
    });

    test('GET /api/data-quality/risk-status should expose sanitized risk summary', async () => {
      const response = await request(app)
        .get('/api/data-quality/risk-status')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.riskStatus).toBeDefined();
      expect(response.body.riskStatus.totalEvaluated).toBeGreaterThanOrEqual(0);
      expect(response.body.riskStatus.riskLevels).toBeDefined();
      expect(response.body.riskStatus).not.toHaveProperty('fingerprintSeenAt');
    });

    test('GET /api/data-quality/risk-events should not leak sensitive internals', async () => {
      antiFraudPipeline.evaluateSubmission({
        metadata: {
          sourceId: 'station-001',
          sourceType: 'api',
          provider: 'NOAA-NWS',
          timestamp: new Date().toISOString(),
        },
        location: {
          latitude: 41.98,
          longitude: -87.9,
        },
        measurements: {
          temperature: { value: 20, unit: 'celsius' },
          humidity: { value: 60, unit: 'percent' },
          pressure: { value: 1013, unit: 'hPa' },
        },
      });

      const response = await request(app)
        .get('/api/data-quality/risk-events?limit=1')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.events)).toBe(true);
      expect(response.body.events.length).toBeGreaterThan(0);
      expect(response.body.events[0].source.sourceIdHash).toBeDefined();
      expect(response.body.events[0].source.sourceId).toBeUndefined();
      expect(response.body.events[0]).not.toHaveProperty('stack');
    });

    test('should handle empty data with proper error', async () => {
      const response = await request(app)
        .post('/api/data-quality/profile')
        .send({ data: [] })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('empty');
    });

    test('should handle invalid data format', async () => {
      const response = await request(app)
        .post('/api/data-quality/profile')
        .send({ data: 'invalid' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('array');
    });

    test('should handle large datasets appropriately', async () => {
      const response = await request(app)
        .post('/api/data-quality/profile')
        .send({ data: new Array(15000).fill({}) })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('too large');
    });
  });

  // =======================
  // INTEGRATION TESTS
  // =======================

  describe('Pipeline Integration', () => {
    test('should process data through complete pipeline', async () => {
      const data = generateSampleWeatherData(100, 0.08);

      // Step 1: Profile the data
      const profile = await profilingEngine.generateProfile(data, {
        source: 'integration_test',
      });

      // Step 2: Detect anomalies
      const anomalies = await anomalyDetectionEngine.detectAnomalies(data);

      // Step 3: Generate report
      const qualityData = {
        ...profile,
        anomalies: anomalies.anomalies,
        recommendations: anomalies.recommendations,
      };

      const report = await reportingService.generateQualityReport(qualityData);

      // Verify complete pipeline execution
      expect(profile.quality.overallScore).toBeGreaterThan(0);
      expect(
        anomalies.anomalies.ensemble.anomalies.length
      ).toBeGreaterThanOrEqual(0);
      expect(report.report.executiveSummary.qualityStatus).toMatch(
        /excellent|good|fair|poor/
      );

      // Verify data consistency across pipeline
      expect(report.report.anomalies.total).toBe(
        anomalies.anomalies.ensemble.summary.total
      );
    });

    test('should handle pipeline errors gracefully', async () => {
      const malformedData = [
        { invalid: 'data' },
        { temperature: 'not_a_number' },
      ];

      // Profile should handle malformed data
      const profile = await profilingEngine.generateProfile(malformedData);
      expect(profile.quality.overallScore).toBeLessThan(50);

      // Anomaly detection should also handle it
      const anomalies =
        await anomalyDetectionEngine.detectAnomalies(malformedData);
      expect(anomalies.metadata.recordCount).toBe(2);
    });

    test('should maintain performance with large datasets', async () => {
      const largeData = generateSampleWeatherData(1000, 0.05);
      const startTime = Date.now();

      const profile = await profilingEngine.generateProfile(largeData);
      const profileTime = Date.now() - startTime;

      const anomalyStart = Date.now();
      const anomalies = await anomalyDetectionEngine.detectAnomalies(largeData);
      const anomalyTime = Date.now() - anomalyStart;

      // Performance expectations (adjust based on requirements)
      expect(profileTime).toBeLessThan(5000); // 5 seconds
      expect(anomalyTime).toBeLessThan(10000); // 10 seconds

      expect(profile.metadata.recordCount).toBe(1000);
      expect(anomalies.metadata.recordCount).toBe(1000);
    });
  });

  // =======================
  // CONFIGURATION TESTS
  // =======================

  describe('Configuration and Customization', () => {
    test('should respect custom profiling options', async () => {
      const customEngine = new DataProfilingEngine({
        outlierThreshold: 2.0,
        temporalAnalysisWindow: 12,
      });

      const data = generateSampleWeatherData(50);
      const profile = await customEngine.generateProfile(data);

      expect(profile).toBeDefined();
      // Custom threshold should detect more outliers
    });

    test('should respect custom anomaly detection options', async () => {
      const customEngine = new AnomalyDetectionEngine({
        zScoreThreshold: 2.5,
        ensembleThreshold: 0.8,
      });

      const data = generateSampleWeatherData(50, 0.1);
      const results = await customEngine.detectAnomalies(data);

      expect(results.anomalies.ensemble.ensembleThreshold).toBe(0.8);
    });

    test('should respect custom reporting thresholds', async () => {
      const customService = new QualityReportingService({
        alertThresholds: {
          completeness: 90,
          accuracy: 95,
        },
      });

      const qualityData = {
        metadata: { recordCount: 100 },
        quality: {
          overallScore: 85,
          scores: {
            completeness: { score: 85 },
            accuracy: { score: 90 },
          },
        },
      };

      const result = await customService.generateQualityReport(qualityData);

      // Should generate alerts due to higher thresholds
      expect(result.report.alerts.length).toBeGreaterThan(0);
    });
  });
});

// =======================
// PERFORMANCE BENCHMARKS
// =======================

describe('Performance Benchmarks', () => {
  test('profile generation performance', async () => {
    const engine = new DataProfilingEngine();
    const data = generateSampleWeatherData(500);

    const iterations = 5;
    const times = [];

    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      await engine.generateProfile(data);
      times.push(Date.now() - start);
    }

    const avgTime = times.reduce((sum, t) => sum + t, 0) / times.length;
    console.log(
      `Average profile generation time for 500 records: ${avgTime}ms`
    );

    expect(avgTime).toBeLessThan(3000); // 3 seconds max
  });

  test('anomaly detection performance', async () => {
    const engine = new AnomalyDetectionEngine();
    const data = generateSampleWeatherData(300, 0.1);

    const start = Date.now();
    await engine.detectAnomalies(data);
    const time = Date.now() - start;

    console.log(`Anomaly detection time for 300 records: ${time}ms`);
    expect(time).toBeLessThan(5000); // 5 seconds max
  });
});

// =======================
// EDGE CASE TESTS
// =======================

describe('Edge Cases and Error Handling', () => {
  test('should handle data with all null values', async () => {
    const nullData = Array(10).fill({
      timestamp: new Date().toISOString(),
      temperature: null,
      humidity: null,
      pressure: null,
    });

    const engine = new DataProfilingEngine();
    const profile = await engine.generateProfile(nullData);

    expect(profile.completeness.overall.completenessPercentage).toBeLessThan(
      50
    );
  });

  test('should handle single record dataset', async () => {
    const singleRecord = [
      {
        timestamp: new Date().toISOString(),
        temperature: 25.5,
        humidity: 60,
        pressure: 1013.25,
      },
    ];

    const engine = new DataProfilingEngine();
    const profile = await engine.generateProfile(singleRecord);

    expect(profile.metadata.recordCount).toBe(1);
    expect(profile.statistical.temperature.count).toBe(1);
  });

  test('should handle extreme weather values', async () => {
    const extremeData = [
      {
        timestamp: new Date().toISOString(),
        temperature: -89, // Record low temperature
        humidity: 0,
        pressure: 870, // Very low pressure
      },
    ];

    const engine = new AnomalyDetectionEngine();
    const results = await engine.detectAnomalies(extremeData);

    // Should handle extreme but potentially valid values
    expect(results.metadata.recordCount).toBe(1);
  });
});

module.exports = {
  generateSampleWeatherData,
  generateIncompleteWeatherData,
  generatePhysicsViolationData,
};
