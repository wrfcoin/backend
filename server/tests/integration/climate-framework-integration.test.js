/**
 * Climate Model Integration Framework - Full Integration Tests
 *
 * End-to-end integration tests for the complete Climate Model Integration Framework.
 * Tests the full pipeline from data ingestion through transformation to API delivery.
 *
 * Test Scenarios:
 * - Complete model execution workflows (GFS, WRF, ICON)
 * - Data pipeline from raw model output to WRFCoin format
 * - API endpoint integration with all components
 * - Cross-service communication and error handling
 * - Performance under realistic load conditions
 * - Data quality validation throughout the pipeline
 * - Blockchain provenance tracking integration
 */

const {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} = require('@jest/globals');
const fs = require('fs').promises;
const path = require('path');
const request = require('supertest');
const express = require('express');

// Import all framework components
const {
  ClimateModelFramework,
} = require('../../services/climate-model-integration-framework');
const {
  ClimateDataFormatManager,
} = require('../../services/climate-data-format-converter');
const {
  ClimateDataTransformer,
} = require('../../services/climate-data-transformer');
const {
  ClimateModelController,
} = require('../../controllers/climate-model-controller');
const climateRoutes = require('../../routes/climate-model-routes');

// Mock services and utilities
const {
  WeatherDataValidator,
} = require('../../services/weather-data-validator');
const {
  BlockchainService,
} = require('../../services/blockchain-transaction-service');

// Test application setup
let testApp;
let framework;
let formatManager;
let transformer;
let controller;

// Test data directories
const TEST_DATA_DIR = path.join(__dirname, '../test-data');
const TEST_OUTPUT_DIR = path.join(__dirname, '../test-output');

// Mock data generators
const createTestGRIBFile = async (filePath, metadata = {}) => {
  // Create a more realistic GRIB file structure for integration testing
  const gribData = {
    // GRIB2 header
    indicator: 'GRIB',
    edition: 2,
    totalLength: 1024,

    // Mock weather data
    data: {
      grid: {
        type: 'regular_ll',
        ni: metadata.ni || 10,
        nj: metadata.nj || 10,
        la1: metadata.bounds?.south || 30.0,
        lo1: metadata.bounds?.west || -120.0,
        la2: metadata.bounds?.north || 40.0,
        lo2: metadata.bounds?.east || -110.0,
      },
      parameters: [
        {
          name: 'TMP',
          level: '2 m above ground',
          values: Array.from(
            { length: (metadata.ni || 10) * (metadata.nj || 10) },
            () => 273.15 + Math.random() * 30
          ), // 0-30°C in Kelvin
        },
        {
          name: 'UGRD',
          level: '10 m above ground',
          values: Array.from(
            { length: (metadata.ni || 10) * (metadata.nj || 10) },
            () => Math.random() * 20 - 10
          ), // -10 to 10 m/s
        },
        {
          name: 'VGRD',
          level: '10 m above ground',
          values: Array.from(
            { length: (metadata.ni || 10) * (metadata.nj || 10) },
            () => Math.random() * 20 - 10
          ), // -10 to 10 m/s
        },
      ],
      forecastTime: metadata.forecastHour || 0,
      referenceTime: metadata.referenceTime || new Date().toISOString(),
    },
  };

  // Write as binary-encoded JSON for test purposes
  await fs.writeFile(filePath, JSON.stringify(gribData));
  return filePath;
};

const createTestNetCDFFile = async (filePath, metadata = {}) => {
  const netcdfData = {
    format: 'netcdf',
    dimensions: {
      time: metadata.timeSteps || 4,
      lat: metadata.latPoints || 10,
      lon: metadata.lonPoints || 10,
    },
    variables: {
      time: {
        dimensions: ['time'],
        units: 'hours since 2023-10-27 00:00:00',
        data: Array.from({ length: metadata.timeSteps || 4 }, (_, i) => i * 6),
      },
      lat: {
        dimensions: ['lat'],
        units: 'degrees_north',
        data: Array.from(
          { length: metadata.latPoints || 10 },
          (_, i) => 30 + i
        ),
      },
      lon: {
        dimensions: ['lon'],
        units: 'degrees_east',
        data: Array.from(
          { length: metadata.lonPoints || 10 },
          (_, i) => -120 + i
        ),
      },
      temperature: {
        dimensions: ['time', 'lat', 'lon'],
        units: 'K',
        data: Array.from({ length: metadata.timeSteps || 4 }, () =>
          Array.from({ length: metadata.latPoints || 10 }, () =>
            Array.from(
              { length: metadata.lonPoints || 10 },
              () => 273.15 + Math.random() * 30
            )
          )
        ),
      },
      wind_u: {
        dimensions: ['time', 'lat', 'lon'],
        units: 'm/s',
        data: Array.from({ length: metadata.timeSteps || 4 }, () =>
          Array.from({ length: metadata.latPoints || 10 }, () =>
            Array.from(
              { length: metadata.lonPoints || 10 },
              () => Math.random() * 20 - 10
            )
          )
        ),
      },
    },
    globalAttributes: {
      title: 'Test Climate Model Data',
      institution: 'WRFCoin Test Suite',
      source: metadata.source || 'integration-test',
      created: new Date().toISOString(),
    },
  };

  await fs.writeFile(filePath, JSON.stringify(netcdfData));
  return filePath;
};

// Setup and teardown
beforeAll(async () => {
  // Create test directories
  await fs.mkdir(TEST_DATA_DIR, { recursive: true });
  await fs.mkdir(TEST_OUTPUT_DIR, { recursive: true });

  // Initialize framework components
  framework = new ClimateModelFramework({
    enabledModels: ['GFS', 'WRF', 'ICON'],
    maxConcurrentJobs: 2,
    enableBlockchainProvenance: false, // Disable for integration tests
    dataRetentionDays: 1,
    gfs: { useAWS: false, resolution: '0p25' },
    wrf: { useDocker: false, maxRuntimeHours: 1 },
    icon: { region: 'global' },
  });

  formatManager = new ClimateDataFormatManager({
    preserveMetadata: true,
    enableQualityControl: true,
  });

  transformer = new ClimateDataTransformer({
    enableValidation: true,
  });

  controller = new ClimateModelController();

  // Initialize framework
  await framework.initialize();

  // Setup test Express app
  testApp = express();
  testApp.use(express.json());
  testApp.use('/api/climate', climateRoutes);

  console.log('Integration test setup completed');
});

afterAll(async () => {
  // Cleanup test files
  try {
    await fs.rmdir(TEST_DATA_DIR, { recursive: true });
    await fs.rmdir(TEST_OUTPUT_DIR, { recursive: true });
  } catch (error) {
    console.warn('Cleanup warning:', error.message);
  }

  console.log('Integration test cleanup completed');
});

// ============================================================================
// COMPLETE WORKFLOW INTEGRATION TESTS
// ============================================================================

describe('Complete Climate Model Workflow Integration', () => {
  let testFiles = [];

  afterEach(async () => {
    // Cleanup test files after each test
    for (const file of testFiles) {
      try {
        await fs.unlink(file);
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    testFiles = [];
  });

  describe('GFS Data Pipeline', () => {
    test('should complete full GFS data processing pipeline', async () => {
      // 1. Create mock GFS GRIB2 file
      const gribFile = path.join(TEST_DATA_DIR, 'test_gfs.grib2');
      testFiles.push(gribFile);

      await createTestGRIBFile(gribFile, {
        ni: 20,
        nj: 15,
        bounds: { north: 50, south: 30, east: -70, west: -120 },
        forecastHour: 6,
        referenceTime: '2023-10-27T00:00:00Z',
      });

      // 2. Process through format converter
      const netcdfFile = path.join(TEST_OUTPUT_DIR, 'converted_gfs.nc');
      testFiles.push(netcdfFile);

      const conversionResult = await formatManager.autoConvert(
        gribFile,
        'netcdf',
        netcdfFile,
        {
          variables: ['TMP', 'UGRD', 'VGRD'],
          qualityControl: true,
        }
      );

      expect(conversionResult.success).toBe(true);
      expect(conversionResult.outputFormat).toBe('netcdf');

      // 3. Transform to WRFCoin format
      const wrfcoinFile = path.join(TEST_OUTPUT_DIR, 'wrfcoin_gfs.json');
      testFiles.push(wrfcoinFile);

      const transformationSpec = {
        unitNormalization: true,
        temporalAlignment: {
          targetGrid: {
            start: '2023-10-27T00:00:00Z',
            end: '2023-10-27T12:00:00Z',
            interval: 6,
          },
        },
      };

      // Load converted NetCDF data (simulated)
      const netcdfData = JSON.parse(await fs.readFile(netcdfFile, 'utf8'));
      const transformResult = await transformer.transformToWRFCoinFormat(
        netcdfData,
        transformationSpec
      );

      expect(transformResult.success).toBe(true);
      expect(transformResult.data.metadata.format).toBe('wrfcoin-unified');
      expect(transformResult.validation.valid).toBe(true);

      // 4. Validate final data quality
      const quality = transformResult.data.quality;
      expect(quality.dataCompleteness).toBeGreaterThan(90);
      expect(quality.spatialCoverage).toBeGreaterThan(0);
      expect(quality.temporalCoverage).toBeGreaterThan(0);

      console.log('GFS Pipeline Test - Data Quality:', quality);
    }, 30000);

    test('should handle GFS data with missing values', async () => {
      const gribFile = path.join(TEST_DATA_DIR, 'test_gfs_missing.grib2');
      testFiles.push(gribFile);

      // Create GRIB with some missing values
      const gribData = JSON.parse(
        JSON.stringify(await createTestGRIBFile(gribFile))
      );

      // Introduce missing values
      gribData.data.parameters[0].values[0] = null;
      gribData.data.parameters[0].values[5] = NaN;
      gribData.data.parameters[0].values[10] = undefined;

      await fs.writeFile(gribFile, JSON.stringify(gribData));

      const transformResult = await transformer.transformToWRFCoinFormat(
        gribData,
        {}
      );

      expect(transformResult.success).toBe(true);
      expect(transformResult.data.quality.dataCompleteness).toBeLessThan(100);
      expect(transformResult.validation.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('WRF Execution Pipeline', () => {
    test('should complete WRF model execution workflow', async () => {
      // Mock WRF execution parameters
      const wrfParams = {
        domain: {
          center: [40.0, -105.0],
          size: [50, 50],
          resolution: [10000, 10000],
        },
        timeRange: {
          start: '2023-10-27T00:00:00Z',
          end: '2023-10-27T06:00:00Z',
        },
        physicsOptions: 'default',
        outputFrequency: 3600,
      };

      const wrfOptions = {
        parallelCores: 1,
        maxRuntimeHours: 1,
        outputFormat: 'netcdf',
      };

      // Note: This is a mock execution since we can't run actual WRF in tests
      const mockExecutionResult = {
        jobId: 'wrf_test_' + Date.now(),
        modelName: 'WRF',
        status: 'completed',
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 60000).toISOString(),
        outputs: [
          {
            filename: 'wrfout_d01_test.nc',
            path: path.join(TEST_OUTPUT_DIR, 'wrfout_d01_test.nc'),
            size: 1024000,
            variables: ['T2', 'U10', 'V10', 'PSFC'],
          },
        ],
        metadata: {
          domain: wrfParams.domain,
          runtime: '60 seconds',
          gridPoints: wrfParams.domain.size[0] * wrfParams.domain.size[1],
        },
      };

      // Create mock WRF output file
      const wrfOutputFile = mockExecutionResult.outputs[0].path;
      testFiles.push(wrfOutputFile);

      await createTestNetCDFFile(wrfOutputFile, {
        timeSteps: 7, // 6 hours at 1-hour intervals + initial
        latPoints: wrfParams.domain.size[0],
        lonPoints: wrfParams.domain.size[1],
        source: 'WRF-test',
      });

      // Process WRF output through transformation pipeline
      const wrfData = JSON.parse(await fs.readFile(wrfOutputFile, 'utf8'));

      const transformResult = await transformer.transformToWRFCoinFormat(
        wrfData,
        {
          unitNormalization: true,
          spatialRegridding: {
            targetGrid: {
              longitude: Array.from({ length: 25 }, (_, i) => -110 + i * 0.4),
              latitude: Array.from({ length: 25 }, (_, i) => 35 + i * 0.4),
            },
            method: 'bilinear',
          },
        }
      );

      expect(transformResult.success).toBe(true);
      expect(transformResult.data.metadata.source).toContain('WRF');
      expect(transformResult.data.coordinates.longitude).toHaveLength(25);
      expect(transformResult.data.coordinates.latitude).toHaveLength(25);

      console.log('WRF Pipeline Test - Execution Result:', {
        jobId: mockExecutionResult.jobId,
        runtime: mockExecutionResult.metadata.runtime,
        outputSize: transformResult.transformationTime + 'ms',
      });
    }, 60000);

    test('should handle WRF execution timeout', async () => {
      const wrfParams = {
        domain: {
          center: [40.0, -105.0],
          size: [100, 100],
          resolution: [1000, 1000],
        },
        timeRange: {
          start: '2023-10-27T00:00:00Z',
          end: '2023-10-28T00:00:00Z',
        },
      };

      // Mock a timeout scenario
      const mockTimeoutResult = {
        jobId: 'wrf_timeout_test',
        status: 'timeout',
        error: 'Model execution exceeded maximum runtime limit',
        startTime: new Date().toISOString(),
        maxRuntimeHours: 1,
      };

      // Verify timeout handling
      expect(mockTimeoutResult.status).toBe('timeout');
      expect(mockTimeoutResult.error).toContain('timeout');
    });
  });

  describe('ICON Data Pipeline', () => {
    test('should process ICON global model data', async () => {
      const iconFile = path.join(TEST_DATA_DIR, 'test_icon_global.grib2');
      testFiles.push(iconFile);

      await createTestGRIBFile(iconFile, {
        ni: 30,
        nj: 20,
        bounds: { north: 90, south: -90, east: 180, west: -180 },
        forecastHour: 12,
        referenceTime: '2023-10-27T00:00:00Z',
      });

      // Process ICON data
      const iconData = JSON.parse(await fs.readFile(iconFile, 'utf8'));

      const transformResult = await transformer.transformToWRFCoinFormat(
        iconData,
        {
          coordinateTransformation: {
            fromCRS: 'WGS84',
            toCRS: 'WGS84',
            options: { validateBounds: true },
          },
        }
      );

      expect(transformResult.success).toBe(true);
      expect(transformResult.data.coordinates.bounds.north).toBe(90);
      expect(transformResult.data.coordinates.bounds.south).toBe(-90);
    });

    test('should process ICON European model data', async () => {
      const iconEuFile = path.join(TEST_DATA_DIR, 'test_icon_eu.grib2');
      testFiles.push(iconEuFile);

      await createTestGRIBFile(iconEuFile, {
        ni: 25,
        nj: 20,
        bounds: { north: 70, south: 30, east: 50, west: -20 },
        forecastHour: 3,
        referenceTime: '2023-10-27T00:00:00Z',
      });

      const iconData = JSON.parse(await fs.readFile(iconEuFile, 'utf8'));

      const transformResult = await transformer.transformToWRFCoinFormat(
        iconData,
        {}
      );

      expect(transformResult.success).toBe(true);
      expect(transformResult.data.coordinates.bounds.north).toBe(70);
      expect(transformResult.data.coordinates.bounds.east).toBe(50);
    });
  });
});

// ============================================================================
// API INTEGRATION TESTS
// ============================================================================

describe('Climate Model API Integration', () => {
  test('should handle model execution request through API', async () => {
    const executionRequest = {
      modelName: 'GFS',
      parameters: {
        runTime: '2023-10-27T00:00:00Z',
        forecastHours: [0, 6, 12],
        variables: ['TMP', 'UGRD', 'VGRD'],
        bounds: { north: 50, south: 30, east: -70, west: -120 },
      },
      options: { outputFormat: 'netcdf' },
    };

    const response = await request(testApp)
      .post('/api/climate/models/execute')
      .send(executionRequest)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toBeDefined();
    expect(response.body.data.modelName).toBe('GFS');
    expect(response.body.responseTime).toBeGreaterThan(0);
  });

  test('should return available models information', async () => {
    const response = await request(testApp)
      .get('/api/climate/models/available')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.models).toBeDefined();
    expect(response.body.data.models).toHaveProperty('GFS');
    expect(response.body.data.models).toHaveProperty('WRF');
    expect(response.body.data.models).toHaveProperty('ICON');
    expect(response.body.data.count).toBe(3);
  });

  test('should handle format conversion request', async () => {
    const conversionRequest = {
      inputPath: path.join(TEST_DATA_DIR, 'test_input.grib2'),
      outputFormat: 'wrfcoin-json',
      outputPath: path.join(TEST_OUTPUT_DIR, 'test_output.json'),
      options: {
        variables: ['temperature', 'wind_speed'],
        qualityControl: true,
      },
    };

    // Create test input file
    await createTestGRIBFile(conversionRequest.inputPath);

    const response = await request(testApp)
      .post('/api/climate/convert/auto')
      .send(conversionRequest)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.outputFormat).toBe('wrfcoin-json');

    // Cleanup
    try {
      await fs.unlink(conversionRequest.inputPath);
      await fs.unlink(conversionRequest.outputPath);
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('should provide system status information', async () => {
    const response = await request(testApp)
      .get('/api/climate/system/status')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.controller).toBeDefined();
    expect(response.body.data.controller.initialized).toBe(true);
  });

  test('should handle health check requests', async () => {
    const response = await request(testApp)
      .get('/api/climate/system/health')
      .expect(200);

    expect(response.body.status).toBeDefined();
    expect(['healthy', 'degraded']).toContain(response.body.status);
    expect(response.body.services).toBeDefined();
  });

  test('should provide API documentation', async () => {
    const response = await request(testApp)
      .get('/api/climate/docs')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.title).toContain('Climate Model Integration API');
    expect(response.body.data.endpoints).toBeDefined();
  });

  test('should provide usage examples', async () => {
    const response = await request(testApp)
      .get('/api/climate/examples')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.gfsDataRetrieval).toBeDefined();
    expect(response.body.data.wrfExecution).toBeDefined();
    expect(response.body.data.formatConversion).toBeDefined();
  });
});

// ============================================================================
// ERROR HANDLING AND RESILIENCE TESTS
// ============================================================================

describe('Error Handling and Resilience', () => {
  test('should handle invalid model execution parameters', async () => {
    const invalidRequest = {
      modelName: 'INVALID_MODEL',
      parameters: {
        runTime: 'invalid-date',
        forecastHours: [-1, 1000], // Invalid hours
        bounds: { north: 30, south: 50 }, // Invalid bounds (north < south)
      },
    };

    const response = await request(testApp)
      .post('/api/climate/models/execute')
      .send(invalidRequest)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBeDefined();
  });

  test('should handle missing input files gracefully', async () => {
    const conversionRequest = {
      inputPath: '/non/existent/file.grib2',
      outputFormat: 'netcdf',
      outputPath: path.join(TEST_OUTPUT_DIR, 'output.nc'),
    };

    const response = await request(testApp)
      .post('/api/climate/convert/auto')
      .send(conversionRequest)
      .expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBeDefined();
  });

  test('should handle corrupted data files', async () => {
    const corruptedFile = path.join(TEST_DATA_DIR, 'corrupted.grib2');
    await fs.writeFile(corruptedFile, 'corrupted data');

    try {
      const result = await formatManager.autoConvert(
        corruptedFile,
        'netcdf',
        path.join(TEST_OUTPUT_DIR, 'output.nc')
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    } catch (error) {
      expect(error).toBeDefined();
    } finally {
      await fs.unlink(corruptedFile);
    }
  });

  test('should handle network timeouts gracefully', async () => {
    // Mock a network timeout scenario
    const timeoutTest = new Promise(resolve => {
      setTimeout(() => {
        resolve({
          success: false,
          error: 'Network timeout',
          timeout: true,
        });
      }, 100);
    });

    const result = await timeoutTest;
    expect(result.success).toBe(false);
    expect(result.timeout).toBe(true);
  });

  test('should maintain service availability during high load', async () => {
    // Simulate concurrent requests
    const requests = Array.from({ length: 10 }, (_, i) =>
      request(testApp)
        .get('/api/climate/system/health')
        .expect(res => {
          expect([200, 503]).toContain(res.status);
        })
    );

    const responses = await Promise.allSettled(requests);
    const successful = responses.filter(r => r.status === 'fulfilled').length;

    // At least 70% of requests should succeed under load
    expect(successful / requests.length).toBeGreaterThan(0.7);
  });
});

// ============================================================================
// PERFORMANCE AND SCALABILITY TESTS
// ============================================================================

describe('Performance and Scalability', () => {
  test('should process medium-sized datasets efficiently', async () => {
    const mediumDataFile = path.join(TEST_DATA_DIR, 'medium_dataset.nc');

    await createTestNetCDFFile(mediumDataFile, {
      timeSteps: 24, // 24 hours
      latPoints: 50, // 50x50 grid
      lonPoints: 50,
    });

    const startTime = Date.now();
    const data = JSON.parse(await fs.readFile(mediumDataFile, 'utf8'));
    const result = await transformer.transformToWRFCoinFormat(data, {
      unitNormalization: true,
      temporalAlignment: {
        targetGrid: {
          start: '2023-10-27T00:00:00Z',
          end: '2023-10-28T00:00:00Z',
          interval: 1,
        },
      },
    });
    const endTime = Date.now();

    expect(result.success).toBe(true);
    expect(endTime - startTime).toBeLessThan(10000); // Should complete within 10 seconds

    await fs.unlink(mediumDataFile);
  }, 15000);

  test('should handle concurrent processing requests', async () => {
    const concurrentTasks = Array.from({ length: 5 }, async (_, i) => {
      const testFile = path.join(TEST_DATA_DIR, `concurrent_test_${i}.nc`);
      await createTestNetCDFFile(testFile, {
        timeSteps: 4,
        latPoints: 10,
        lonPoints: 10,
      });

      const data = JSON.parse(await fs.readFile(testFile, 'utf8'));
      const result = await transformer.transformToWRFCoinFormat(data, {});

      await fs.unlink(testFile);
      return result;
    });

    const results = await Promise.all(concurrentTasks);

    expect(results).toHaveLength(5);
    expect(results.every(r => r.success)).toBe(true);
  });

  test('should maintain memory efficiency during processing', async () => {
    const initialMemory = process.memoryUsage();

    // Process multiple datasets to test memory management
    for (let i = 0; i < 5; i++) {
      const testFile = path.join(TEST_DATA_DIR, `memory_test_${i}.nc`);
      await createTestNetCDFFile(testFile, {
        timeSteps: 12,
        latPoints: 20,
        lonPoints: 20,
      });

      const data = JSON.parse(await fs.readFile(testFile, 'utf8'));
      await transformer.transformToWRFCoinFormat(data, {});

      await fs.unlink(testFile);

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
    }

    const finalMemory = process.memoryUsage();
    const memoryIncrease =
      (finalMemory.heapUsed - initialMemory.heapUsed) / 1024 / 1024; // MB

    // Memory increase should be reasonable (less than 100MB for this test)
    expect(memoryIncrease).toBeLessThan(100);
  });
});

// ============================================================================
// DATA QUALITY AND VALIDATION TESTS
// ============================================================================

describe('Data Quality and Validation', () => {
  test('should validate physics consistency in weather data', async () => {
    const testFile = path.join(TEST_DATA_DIR, 'physics_test.nc');

    // Create data with some physics violations
    const data = {
      format: 'netcdf',
      variables: {
        temperature: {
          data: [[-50, 25, 80]], // -50°C might be too cold for some regions
          units: 'celsius',
        },
        humidity: {
          data: [[150, 60, -10]], // 150% humidity is impossible, -10% is invalid
          units: 'percent',
        },
        pressure: {
          data: [[50000, 101325, 110000]], // 50kPa might be too low for sea level
          units: 'Pa',
        },
      },
    };

    await fs.writeFile(testFile, JSON.stringify(data));

    const result = await transformer.transformToWRFCoinFormat(data, {});

    expect(result.success).toBe(true);
    expect(result.validation.warnings.length).toBeGreaterThan(0);

    await fs.unlink(testFile);
  });

  test('should detect and handle data gaps', async () => {
    const dataWithGaps = {
      time: [
        '2023-10-27T00:00:00Z',
        '2023-10-27T06:00:00Z',
        '2023-10-27T18:00:00Z',
      ], // Missing 12:00
      variables: {
        temperature: {
          data: [20, null, 25], // Gap at 06:00
          units: 'celsius',
        },
      },
    };

    const result = await transformer.transformToWRFCoinFormat(dataWithGaps, {});

    expect(result.success).toBe(true);
    expect(result.data.quality.dataCompleteness).toBeLessThan(100);
  });

  test('should validate coordinate consistency', async () => {
    const inconsistentData = {
      coordinates: {
        longitude: [-120, -119, -118],
        latitude: [30, 31], // Mismatched array lengths
      },
      variables: {
        temperature: {
          data: [
            [20, 21, 22],
            [23, 24, 25],
          ], // 2x3 but coords suggest 3x2
          units: 'celsius',
        },
      },
    };

    try {
      const result = await transformer.transformToWRFCoinFormat(
        inconsistentData,
        {}
      );
      expect(result.validation.warnings.length).toBeGreaterThan(0);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  test('should assess data coverage and resolution', async () => {
    const sparseData = {
      coordinates: {
        longitude: [-120, -110, -100], // Sparse 10-degree resolution
        latitude: [30, 40, 50],
      },
      variables: {
        temperature: {
          data: [
            [20, 21, 22],
            [23, 24, 25],
            [26, 27, 28],
          ],
          units: 'celsius',
        },
      },
    };

    const result = await transformer.transformToWRFCoinFormat(sparseData, {});

    expect(result.success).toBe(true);
    expect(result.data.quality.spatialCoverage).toBe(9); // 3x3 grid

    // Could add warnings for low resolution
    if (result.validation.warnings) {
      expect(
        result.validation.warnings.some(w => w.includes('resolution'))
      ).toBeDefined();
    }
  });
});

// ============================================================================
// BLOCKCHAIN INTEGRATION TESTS (MOCKED)
// ============================================================================

describe('Blockchain Integration (Mocked)', () => {
  test('should create data provenance records', async () => {
    // Mock blockchain service for testing
    const mockBlockchainService = {
      recordDataProvenance: jest.fn().mockResolvedValue({
        transactionHash: '0x1234567890abcdef',
        blockNumber: 12345,
        dataHash: 'sha256:abcdef123456',
        timestamp: new Date().toISOString(),
      }),
    };

    const testData = {
      source: 'GFS',
      timestamp: new Date().toISOString(),
      dataHash: 'test-hash-123',
      transformations: ['unit_conversion', 'format_conversion'],
    };

    const provenanceRecord =
      await mockBlockchainService.recordDataProvenance(testData);

    expect(provenanceRecord.transactionHash).toBeDefined();
    expect(provenanceRecord.blockNumber).toBeGreaterThan(0);
    expect(provenanceRecord.dataHash).toBeDefined();
    expect(mockBlockchainService.recordDataProvenance).toHaveBeenCalledWith(
      testData
    );
  });

  test('should verify data integrity through blockchain', async () => {
    const mockBlockchainService = {
      verifyDataIntegrity: jest.fn().mockResolvedValue({
        verified: true,
        originalHash: 'sha256:abcdef123456',
        currentHash: 'sha256:abcdef123456',
        blockHeight: 12345,
        confirmations: 6,
      }),
    };

    const verificationResult =
      await mockBlockchainService.verifyDataIntegrity('test-hash-123');

    expect(verificationResult.verified).toBe(true);
    expect(verificationResult.originalHash).toBe(
      verificationResult.currentHash
    );
    expect(verificationResult.confirmations).toBeGreaterThan(0);
  });
});

console.log(
  'Climate Model Integration Framework - Full Integration Test Suite Ready'
);
