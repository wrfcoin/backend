/**
 * Climate Model Integration Framework Tests
 *
 * Comprehensive test suite for the Climate Model Integration Framework.
 * Tests all major components including model adapters, format converters,
 * orchestration engine, and API endpoints.
 *
 * Test Categories:
 * - Unit tests for individual adapters (GFS, WRF, ICON)
 * - Integration tests for framework orchestration
 * - Format conversion tests
 * - API endpoint tests
 * - Error handling and edge cases
 * - Performance and load tests
 */

const {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} = require('@jest/globals');
const fs = require('fs').promises;
const path = require('path');
const request = require('supertest');
const express = require('express');

// Import framework components
const {
  ClimateModelFramework,
  GFSAdapter,
  WRFAdapter,
  ICONAdapter,
} = require('../services/climate-model-integration-framework');

const {
  ClimateDataFormatManager,
  GRIBToNetCDFConverter,
  NetCDFToJSONConverter,
  WRFCoinFormatConverter,
} = require('../services/climate-data-format-converter');

const {
  ClimateModelController,
} = require('../controllers/climate-model-controller');
const climateRoutes = require('../routes/climate-model-routes');

// Mock data and utilities
const createMockGRIBFile = async filePath => {
  // Create a mock GRIB file with GRIB magic number
  const mockGRIBData = Buffer.from(
    'GRIB\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00'
  );
  await fs.writeFile(filePath, mockGRIBData);
  return filePath;
};

const createMockNetCDFFile = async filePath => {
  // Create a mock NetCDF file with basic structure
  const mockData = JSON.stringify({
    dimensions: { time: 1, lat: 10, lon: 10 },
    variables: {
      temperature: {
        dimensions: ['time', 'lat', 'lon'],
        data: Array(100)
          .fill(0)
          .map(() => Math.random() * 30 + 10),
        attributes: { units: 'celsius' },
      },
    },
    coordinates: {
      latitude: {
        data: Array(10)
          .fill(0)
          .map((_, i) => 30 + i),
      },
      longitude: {
        data: Array(10)
          .fill(0)
          .map((_, i) => -120 + i),
      },
    },
  });
  await fs.writeFile(filePath, mockData);
  return filePath;
};

const createMockCSVFile = async filePath => {
  const csvData = `timestamp,station_id,latitude,longitude,temperature,humidity,pressure
2023-10-27T12:00:00Z,STATION001,40.7128,-74.0060,22.5,65.2,1013.2
2023-10-27T12:00:00Z,STATION002,34.0522,-118.2437,25.8,45.1,1015.8
2023-10-27T12:00:00Z,STATION003,41.8781,-87.6298,18.9,72.3,1011.5`;

  await fs.writeFile(filePath, csvData);
  return filePath;
};

// Test data cleanup utility
const cleanupTestFiles = async files => {
  for (const file of files) {
    try {
      await fs.unlink(file);
    } catch (error) {
      // Ignore file not found errors
    }
  }
};

// ============================================================================
// GFS ADAPTER TESTS
// ============================================================================

describe('GFS Adapter', () => {
  let gfsAdapter;
  const testFiles = [];

  beforeEach(() => {
    gfsAdapter = new GFSAdapter({
      useAWS: false, // Use mock data instead of real AWS
      baseUrl: 'http://localhost:3000/mock-gfs',
    });
  });

  afterEach(async () => {
    await cleanupTestFiles(testFiles);
    testFiles.length = 0;
  });

  test('should initialize GFS adapter with correct configuration', () => {
    expect(gfsAdapter.modelName).toBe('GFS');
    expect(gfsAdapter.useAWS).toBe(false);
    expect(gfsAdapter.resolution).toBe('0p25');
    expect(gfsAdapter.maxForecastHours).toBe(384);
  });

  test('should construct correct GFS file names', () => {
    const runTime = new Date('2023-10-27T12:00:00Z');
    const fileName = gfsAdapter.constructGFSFileName(runTime, 6);

    expect(fileName).toBe('gfs.t12z.pgrb2.0p25.f006');
  });

  test('should construct correct GFS URLs', () => {
    const runTime = new Date('2023-10-27T12:00:00Z');
    const fileName = 'gfs.t12z.pgrb2.0p25.f006';
    const url = gfsAdapter.constructGFSUrl(runTime, fileName);

    expect(url).toContain('gfs.20231027/12/atmos/gfs.t12z.pgrb2.0p25.f006');
  });

  test('should get latest run time correctly', () => {
    const latestRunTime = gfsAdapter.getLatestRunTime();

    expect(latestRunTime).toBeInstanceOf(Date);
    expect(latestRunTime.getUTCMinutes()).toBe(0);
    expect(latestRunTime.getUTCSeconds()).toBe(0);
    expect([0, 6, 12, 18]).toContain(latestRunTime.getUTCHours());
  });

  test('should validate GFS configuration correctly', () => {
    const validConfig = {
      forecastHours: [0, 6, 12, 24],
      resolution: '0p25',
      bounds: { north: 50, south: 30, east: -70, west: -120 },
    };

    const validation = gfsAdapter.validateConfig(validConfig);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  test('should reject invalid GFS configuration', () => {
    const invalidConfig = {
      forecastHours: [-1, 500], // Invalid hours
      resolution: 'invalid', // Invalid resolution
      bounds: { north: 30, south: 50, east: -120, west: -70 }, // Invalid bounds
    };

    const validation = gfsAdapter.validateConfig(invalidConfig);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  test('should update metrics correctly', () => {
    const initialMetrics = gfsAdapter.getHealth().metrics;

    gfsAdapter.updateMetrics(true, 5000);

    const updatedMetrics = gfsAdapter.getHealth().metrics;
    expect(updatedMetrics.totalRuns).toBe(initialMetrics.totalRuns + 1);
    expect(updatedMetrics.successfulRuns).toBe(
      initialMetrics.successfulRuns + 1
    );
    expect(updatedMetrics.averageRunTime).toBeGreaterThan(0);
  });
});

// ============================================================================
// WRF ADAPTER TESTS
// ============================================================================

describe('WRF Adapter', () => {
  let wrfAdapter;
  const testFiles = [];

  beforeEach(() => {
    wrfAdapter = new WRFAdapter({
      useDocker: true,
      dockerImage: 'test/wrf:latest',
      workDir: '/tmp/test_wrf_runs',
      maxRuntimeHours: 1,
    });
  });

  afterEach(async () => {
    await cleanupTestFiles(testFiles);
    testFiles.length = 0;
  });

  test('should initialize WRF adapter with correct configuration', () => {
    expect(wrfAdapter.modelName).toBe('WRF');
    expect(wrfAdapter.useDocker).toBe(true);
    expect(wrfAdapter.dockerImage).toBe('test/wrf:latest');
    expect(wrfAdapter.maxRuntimeHours).toBe(1);
  });

  test('should generate unique run IDs', () => {
    const runId1 = wrfAdapter.generateRunId();
    const runId2 = wrfAdapter.generateRunId();

    expect(runId1).toMatch(/^wrf_\d+_[a-z0-9]+$/);
    expect(runId2).toMatch(/^wrf_\d+_[a-z0-9]+$/);
    expect(runId1).not.toBe(runId2);
  });

  test('should validate WRF parameters correctly', () => {
    const validParams = {
      domain: {
        center: [40.0, -105.0],
        size: [50, 50],
        resolution: [10000, 10000],
      },
      timeRange: {
        start: '2023-10-27T00:00:00Z',
        end: '2023-10-27T12:00:00Z',
      },
    };

    const validation = wrfAdapter.validateWRFParams(validParams);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  test('should reject invalid WRF parameters', () => {
    const invalidParams = {
      domain: {
        center: [40.0], // Invalid center (missing longitude)
        size: [5, 5], // Too small grid
        resolution: [-1000, 0], // Invalid resolution
      },
      timeRange: {
        start: '2023-10-27T12:00:00Z',
        end: '2023-10-27T00:00:00Z', // End before start
      },
    };

    const validation = wrfAdapter.validateWRFParams(invalidParams);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  test('should validate WRF configuration', () => {
    const validConfig = {
      useDocker: true,
      dockerImage: 'wrfcoin/wrf:latest',
      maxRuntimeHours: 6,
    };

    const validation = wrfAdapter.validateConfig(validConfig);
    expect(validation.valid).toBe(true);
  });

  test('should reject invalid WRF configuration', () => {
    const invalidConfig = {
      useDocker: true,
      // Missing dockerImage
      maxRuntimeHours: 100, // Too long
    };

    const validation = wrfAdapter.validateConfig(invalidConfig);
    expect(validation.valid).toBe(false);
  });
});

// ============================================================================
// ICON ADAPTER TESTS
// ============================================================================

describe('ICON Adapter', () => {
  let iconAdapter;
  const testFiles = [];

  beforeEach(() => {
    iconAdapter = new ICONAdapter({
      region: 'global',
      baseUrl: 'http://localhost:3000/mock-icon',
    });
  });

  afterEach(async () => {
    await cleanupTestFiles(testFiles);
    testFiles.length = 0;
  });

  test('should initialize ICON adapter with correct configuration', () => {
    expect(iconAdapter.modelName).toBe('ICON');
    expect(iconAdapter.region).toBe('global');
    expect(iconAdapter.maxForecastHours).toBe(120);
  });

  test('should construct correct ICON file names for global model', () => {
    const runTime = new Date('2023-10-27T12:00:00Z');
    const fileName = iconAdapter.constructIconFileName(runTime, 6, 'global');

    expect(fileName).toContain(
      'icon_global_icosahedral_single-level_2023102712_006_2d.grib2.bz2'
    );
  });

  test('should construct correct ICON file names for European model', () => {
    const runTime = new Date('2023-10-27T12:00:00Z');
    const fileName = iconAdapter.constructIconFileName(runTime, 3, 'europe');

    expect(fileName).toContain(
      'icon-d2_germany_regular-lat-lon_single-level_2023102712_003_2d.grib2.bz2'
    );
  });

  test('should get latest ICON run time for global model', () => {
    iconAdapter.region = 'global';
    const latestRunTime = iconAdapter.getLatestIconRunTime();

    expect(latestRunTime).toBeInstanceOf(Date);
    expect([0, 6, 12, 18]).toContain(latestRunTime.getUTCHours());
  });

  test('should get latest ICON run time for European model', () => {
    iconAdapter.region = 'europe';
    const latestRunTime = iconAdapter.getLatestIconRunTime();

    expect(latestRunTime).toBeInstanceOf(Date);
    expect([0, 3, 6, 9, 12, 15, 18, 21]).toContain(latestRunTime.getUTCHours());
  });

  test('should validate ICON configuration correctly', () => {
    const validConfig = {
      region: 'global',
      forecastHours: [0, 6, 12, 24, 48],
    };

    const validation = iconAdapter.validateConfig(validConfig);
    expect(validation.valid).toBe(true);
  });

  test('should reject invalid ICON configuration', () => {
    const invalidConfig = {
      region: 'invalid',
      forecastHours: [200], // Too far for any region
    };

    const validation = iconAdapter.validateConfig(invalidConfig);
    expect(validation.valid).toBe(false);
  });
});

// ============================================================================
// FORMAT CONVERTER TESTS
// ============================================================================

describe('Format Converters', () => {
  let formatManager;
  const testFiles = [];

  beforeAll(() => {
    formatManager = new ClimateDataFormatManager();
  });

  afterEach(async () => {
    await cleanupTestFiles(testFiles);
    testFiles.length = 0;
  });

  describe('GRIB to NetCDF Converter', () => {
    let gribConverter;

    beforeEach(() => {
      gribConverter = new GRIBToNetCDFConverter({
        cdoPath: 'echo', // Mock CDO command
        preserveMetadata: true,
      });
    });

    test('should initialize with correct configuration', () => {
      expect(gribConverter.supportedInputFormats).toContain('grib');
      expect(gribConverter.supportedInputFormats).toContain('grib2');
      expect(gribConverter.supportedOutputFormats).toContain('netcdf');
    });

    test('should build correct CDO command', () => {
      const command = gribConverter.buildCDOCommand(
        '/input/test.grib2',
        '/output/test.nc',
        {
          variables: ['TMP', 'UGRD'],
          region: { north: 50, south: 30, east: -70, west: -120 },
          compression: 'deflate',
          compressionLevel: 6,
        }
      );

      expect(command).toContain('-f nc4c');
      expect(command).toContain('-z zip_6');
      expect(command).toContain('-selvar,TMP,UGRD');
      expect(command).toContain('-sellonlatbox,-120,-70,30,50');
    });
  });

  describe('NetCDF to JSON Converter', () => {
    let netcdfConverter;

    beforeEach(() => {
      netcdfConverter = new NetCDFToJSONConverter({
        maxArraySize: 1000,
      });
    });

    test('should initialize with correct configuration', () => {
      expect(netcdfConverter.supportedInputFormats).toContain('netcdf');
      expect(netcdfConverter.supportedOutputFormats).toContain('json');
    });

    test('should validate NetCDF input correctly', async () => {
      const mockFile = `/tmp/test_netcdf_${Date.now()}.nc`;
      testFiles.push(mockFile);

      await createMockNetCDFFile(mockFile);

      // Mock ncdump command success
      const originalExecAsync = require('util').promisify(
        require('child_process').exec
      );
      const mockExecAsync = jest.fn().mockResolvedValue({
        stdout: 'dimensions:\n  time = 1;\n  lat = 10;\nvariables:',
        stderr: '',
      });

      require('util').promisify = jest.fn().mockReturnValue(mockExecAsync);

      const validation = await netcdfConverter.validateInput(mockFile);
      expect(validation.valid).toBe(true);

      // Restore original
      require('util').promisify = () => originalExecAsync;
    });
  });

  describe('WRFCoin Format Converter', () => {
    let wrfcoinConverter;

    beforeEach(() => {
      wrfcoinConverter = new WRFCoinFormatConverter();
    });

    test('should initialize with correct configuration', () => {
      expect(wrfcoinConverter.supportedInputFormats).toContain('csv');
      expect(wrfcoinConverter.supportedInputFormats).toContain('json');
      expect(wrfcoinConverter.supportedOutputFormats).toContain('wrfcoin-json');
    });

    test('should detect CSV format correctly', async () => {
      const csvFile = `/tmp/test_csv_${Date.now()}.csv`;
      testFiles.push(csvFile);

      await createMockCSVFile(csvFile);

      const format = await wrfcoinConverter.detectFormat(csvFile);
      expect(format).toBe('csv');
    });

    test('should transform CSV data to WRFCoin format', async () => {
      const csvData = {
        originalFormat: 'csv',
        records: [
          {
            timestamp: '2023-10-27T12:00:00Z',
            station_id: 'TEST001',
            latitude: '40.7128',
            longitude: '-74.0060',
            temperature: '22.5',
            humidity: '65.2',
            pressure: '1013.2',
          },
        ],
      };

      const wrfcoinData = wrfcoinConverter.transformCSVToWRFCoin(csvData, {});

      expect(wrfcoinData).toHaveLength(1);
      expect(wrfcoinData[0].metadata.sourceId).toBe('TEST001');
      expect(wrfcoinData[0].location.latitude).toBe(40.7128);
      expect(wrfcoinData[0].measurements.temperature.value).toBe(22.5);
    });

    test('should apply quality control correctly', async () => {
      const records = [
        {
          metadata: { qualityScore: 1.0 },
          measurements: {
            temperature: { value: 25.0, unit: 'celsius' },
            humidity: { value: 65.0, unit: 'percent' },
            pressure: { value: 150000, unit: 'Pa' }, // Invalid - too high
          },
          validation: {},
        },
      ];

      const processedRecords =
        await wrfcoinConverter.applyQualityControl(records);

      expect(processedRecords[0].validation.rangeValidation.passed).toBe(false);
      expect(processedRecords[0].validation.overallScore).toBeLessThan(1.0);
    });
  });

  describe('Format Manager', () => {
    test('should initialize with all converters', () => {
      const converters = formatManager.getAvailableConverters();

      expect(converters).toHaveProperty('grib-to-netcdf');
      expect(converters).toHaveProperty('netcdf-to-json');
      expect(converters).toHaveProperty('wrfcoin-format');
    });

    test('should plan conversion paths correctly', () => {
      const path1 = formatManager.planConversionPath('grib', 'netcdf');
      expect(path1).toHaveLength(1);
      expect(path1[0].converter).toBe('grib-to-netcdf');

      const path2 = formatManager.planConversionPath('grib', 'json');
      expect(path2).toHaveLength(2);
      expect(path2[0].converter).toBe('grib-to-netcdf');
      expect(path2[1].converter).toBe('netcdf-to-json');
    });
  });
});

// ============================================================================
// CLIMATE MODEL FRAMEWORK TESTS
// ============================================================================

describe('Climate Model Framework', () => {
  let framework;
  const testFiles = [];

  beforeEach(async () => {
    framework = new ClimateModelFramework({
      enabledModels: ['GFS', 'WRF', 'ICON'],
      maxConcurrentJobs: 2,
      enableBlockchainProvenance: false, // Disable for testing
      dataRetentionDays: 1,
    });

    // Mock the framework initialization to avoid external dependencies
    framework.isInitialized = true;
    framework.database = { connect: jest.fn(), disconnect: jest.fn() };
    framework.blockchain = { initialize: jest.fn(), shutdown: jest.fn() };
  });

  afterEach(async () => {
    if (framework) {
      await framework.shutdown();
    }
    await cleanupTestFiles(testFiles);
    testFiles.length = 0;
  });

  test('should initialize with correct adapters', () => {
    expect(framework.adapters.has('GFS')).toBe(true);
    expect(framework.adapters.has('WRF')).toBe(true);
    expect(framework.adapters.has('ICON')).toBe(true);
  });

  test('should generate unique job IDs', () => {
    const jobId1 = framework.generateJobId();
    const jobId2 = framework.generateJobId();

    expect(jobId1).toMatch(/^cmf_\d+_[a-z0-9]+$/);
    expect(jobId2).toMatch(/^cmf_\d+_[a-z0-9]+$/);
    expect(jobId1).not.toBe(jobId2);
  });

  test('should get framework status correctly', () => {
    const status = framework.getStatus();

    expect(status.framework.initialized).toBe(true);
    expect(status.framework.enabledModels).toContain('GFS');
    expect(status.framework.enabledModels).toContain('WRF');
    expect(status.framework.enabledModels).toContain('ICON');
    expect(status.adapters).toHaveProperty('GFS');
    expect(status.adapters).toHaveProperty('WRF');
    expect(status.adapters).toHaveProperty('ICON');
  });

  test('should track job history correctly', () => {
    const initialHistory = framework.getJobHistory();
    expect(initialHistory).toHaveLength(0);

    // Simulate completed job
    framework.jobHistory.push({
      jobId: 'test-job-1',
      modelName: 'GFS',
      status: 'completed',
      startTime: new Date(),
      endTime: new Date(),
    });

    const updatedHistory = framework.getJobHistory();
    expect(updatedHistory).toHaveLength(1);
    expect(updatedHistory[0].jobId).toBe('test-job-1');
  });

  test('should update statistics correctly', () => {
    const initialStats = framework.getStatus().framework.stats;

    framework.updateStats(true, 5000);
    framework.updateStats(false, 3000);

    const updatedStats = framework.getStatus().framework.stats;
    expect(updatedStats.totalJobs).toBe(initialStats.totalJobs + 2);
    expect(updatedStats.successfulJobs).toBe(initialStats.successfulJobs + 1);
    expect(updatedStats.failedJobs).toBe(initialStats.failedJobs + 1);
  });

  test('should create provenance records correctly', async () => {
    const job = {
      jobId: 'test-job-1',
      modelName: 'GFS',
      params: { test: 'parameter' },
      options: { test: 'option' },
      startTime: new Date(),
      requestedBy: 'test-user',
    };

    const result = {
      success: true,
      data: { test: 'data' },
      runTime: 5000,
      validation: { qualityScore: 0.95 },
    };

    const provenance = await framework.createProvenanceRecord(job, result);

    expect(provenance.jobId).toBe('test-job-1');
    expect(provenance.modelName).toBe('GFS');
    expect(provenance.inputDataHash).toBeDefined();
    expect(provenance.outputDataHash).toBeDefined();
    expect(provenance.qualityScore).toBe(0.95);
  });

  test('should calculate data hashes correctly', () => {
    const data1 = { test: 'data', value: 123 };
    const data2 = { test: 'data', value: 123 };
    const data3 = { test: 'different', value: 456 };

    const hash1 = framework.calculateHash(JSON.stringify(data1));
    const hash2 = framework.calculateHash(JSON.stringify(data2));
    const hash3 = framework.calculateHash(JSON.stringify(data3));

    expect(hash1).toBe(hash2); // Same data should produce same hash
    expect(hash1).not.toBe(hash3); // Different data should produce different hash
    expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 format
  });
});

// ============================================================================
// API CONTROLLER TESTS
// ============================================================================

describe('Climate Model Controller', () => {
  let controller;
  const testFiles = [];

  beforeEach(async () => {
    controller = new ClimateModelController();

    // Mock the initialization to avoid external dependencies
    controller.isInitialized = true;
    controller.framework = {
      executeModel: jest.fn(),
      getModelData: jest.fn(),
      getStatus: jest.fn(),
      getJobHistory: jest.fn(),
      getActiveJobs: jest.fn(),
      cancelJob: jest.fn(),
    };
    controller.formatManager = {
      convertFormat: jest.fn(),
      autoConvert: jest.fn(),
      getAvailableConverters: jest.fn(),
      getStatistics: jest.fn(),
    };
  });

  afterEach(async () => {
    await cleanupTestFiles(testFiles);
    testFiles.length = 0;
  });

  test('should update metrics correctly', () => {
    const initialMetrics = { ...controller.requestMetrics };

    controller.updateMetrics(true, 1000);
    controller.updateMetrics(false, 2000);

    expect(controller.requestMetrics.totalRequests).toBe(
      initialMetrics.totalRequests + 2
    );
    expect(controller.requestMetrics.successfulRequests).toBe(
      initialMetrics.successfulRequests + 1
    );
    expect(controller.requestMetrics.failedRequests).toBe(
      initialMetrics.failedRequests + 1
    );
    expect(controller.requestMetrics.averageResponseTime).toBeGreaterThan(0);
  });

  test('should handle model execution requests', async () => {
    const mockRequest = {
      body: {
        modelName: 'GFS',
        parameters: { test: 'param' },
        options: { test: 'option' },
      },
      user: { id: 'test-user' },
      headers: { 'x-request-id': 'test-request' },
    };

    const mockResponse = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    const mockResult = {
      success: true,
      jobId: 'test-job-1',
      modelName: 'GFS',
    };

    controller.framework.executeModel.mockResolvedValue(mockResult);

    await controller.executeModel(mockRequest, mockResponse);

    expect(controller.framework.executeModel).toHaveBeenCalledWith(
      'GFS',
      { test: 'param' },
      expect.objectContaining({
        test: 'option',
        userId: 'test-user',
        requestId: 'test-request',
      })
    );

    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: mockResult,
      })
    );
  });

  test('should handle errors gracefully', async () => {
    const mockRequest = {
      body: {
        modelName: 'INVALID',
        parameters: {},
      },
      user: { id: 'test-user' },
      headers: {},
    };

    const mockResponse = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    controller.framework.executeModel.mockRejectedValue(
      new Error('Invalid model')
    );

    await controller.executeModel(mockRequest, mockResponse);

    expect(mockResponse.status).toHaveBeenCalledWith(500);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Invalid model',
      })
    );
  });
});

// ============================================================================
// API ROUTES TESTS
// ============================================================================

describe('Climate Model Routes', () => {
  let app;
  const testFiles = [];

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/climate', climateRoutes);
  });

  afterEach(async () => {
    await cleanupTestFiles(testFiles);
    testFiles.length = 0;
  });

  test('should respond to health check', async () => {
    const response = await request(app)
      .get('/api/climate/system/health')
      .expect(200);

    expect(response.body).toHaveProperty('status');
    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('services');
  });

  test('should return system information', async () => {
    const response = await request(app)
      .get('/api/climate/system/info')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveProperty('name');
    expect(response.body.data).toHaveProperty('version');
    expect(response.body.data).toHaveProperty('capabilities');
  });

  test('should return available models', async () => {
    const response = await request(app)
      .get('/api/climate/models/available')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.models).toHaveProperty('GFS');
    expect(response.body.data.models).toHaveProperty('WRF');
    expect(response.body.data.models).toHaveProperty('ICON');
  });

  test('should return supported formats', async () => {
    const response = await request(app)
      .get('/api/climate/convert/formats')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveProperty('input');
    expect(response.body.data).toHaveProperty('output');
    expect(response.body.data).toHaveProperty('conversionPaths');
  });

  test('should return API documentation', async () => {
    const response = await request(app).get('/api/climate/docs').expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveProperty('title');
    expect(response.body.data).toHaveProperty('endpoints');
  });

  test('should return API examples', async () => {
    const response = await request(app)
      .get('/api/climate/examples')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveProperty('gfsDataRetrieval');
    expect(response.body.data).toHaveProperty('wrfExecution');
    expect(response.body.data).toHaveProperty('formatConversion');
  });

  test('should handle 404 for unknown routes', async () => {
    const response = await request(app)
      .get('/api/climate/unknown/endpoint')
      .expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('endpoint not found');
  });

  test('should validate model execution request', async () => {
    const response = await request(app)
      .post('/api/climate/models/execute')
      .send({
        modelName: 'INVALID_MODEL',
        parameters: {},
      })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Validation failed');
  });

  test('should validate format conversion request', async () => {
    const response = await request(app)
      .post('/api/climate/convert/format')
      .send({
        // Missing required fields
      })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Validation failed');
  });
});

// ============================================================================
// PERFORMANCE AND LOAD TESTS
// ============================================================================

describe('Performance Tests', () => {
  let framework;

  beforeEach(async () => {
    framework = new ClimateModelFramework({
      enabledModels: ['GFS'],
      maxConcurrentJobs: 5,
      enableBlockchainProvenance: false,
    });

    framework.isInitialized = true;
    framework.database = { connect: jest.fn(), disconnect: jest.fn() };
  });

  afterEach(async () => {
    if (framework) {
      await framework.shutdown();
    }
  });

  test('should handle multiple concurrent job status requests', async () => {
    const startTime = Date.now();
    const numRequests = 100;

    const promises = Array(numRequests)
      .fill()
      .map(() => {
        return Promise.resolve(framework.getStatus());
      });

    const results = await Promise.all(promises);
    const endTime = Date.now();

    expect(results).toHaveLength(numRequests);
    expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second

    // All results should be valid
    results.forEach(result => {
      expect(result.framework).toBeDefined();
      expect(result.adapters).toBeDefined();
    });
  });

  test('should handle job ID generation performance', () => {
    const startTime = Date.now();
    const numJobs = 10000;

    const jobIds = new Set();
    for (let i = 0; i < numJobs; i++) {
      jobIds.add(framework.generateJobId());
    }

    const endTime = Date.now();

    expect(jobIds.size).toBe(numJobs); // All IDs should be unique
    expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
  });

  test('should handle hash calculation performance', () => {
    const startTime = Date.now();
    const numCalculations = 1000;

    const data = {
      test: 'data',
      values: Array(1000)
        .fill(0)
        .map((_, i) => i),
    };
    const dataString = JSON.stringify(data);

    const hashes = [];
    for (let i = 0; i < numCalculations; i++) {
      hashes.push(framework.calculateHash(dataString));
    }

    const endTime = Date.now();

    expect(hashes).toHaveLength(numCalculations);
    expect(endTime - startTime).toBeLessThan(2000); // Should complete within 2 seconds

    // All hashes should be identical for same data
    const uniqueHashes = new Set(hashes);
    expect(uniqueHashes.size).toBe(1);
  });
});

// ============================================================================
// ERROR HANDLING AND EDGE CASES
// ============================================================================

describe('Error Handling and Edge Cases', () => {
  let framework;

  beforeEach(async () => {
    framework = new ClimateModelFramework({
      enabledModels: ['GFS'],
      maxConcurrentJobs: 1,
      enableBlockchainProvenance: false,
    });

    framework.isInitialized = true;
    framework.database = { connect: jest.fn(), disconnect: jest.fn() };
  });

  afterEach(async () => {
    if (framework) {
      await framework.shutdown();
    }
  });

  test('should handle unsupported model names', async () => {
    const result = await framework.executeModel('UNSUPPORTED_MODEL', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported model');
  });

  test('should handle concurrent job limit', async () => {
    // Mock adapter that never completes
    const neverCompletingAdapter = {
      execute: () => new Promise(() => {}), // Never resolves
    };

    framework.adapters.set('TEST_MODEL', neverCompletingAdapter);

    // Start first job (will hang)
    const job1Promise = framework.executeModel('TEST_MODEL', {});

    // Wait a bit to ensure job1 is active
    await new Promise(resolve => setTimeout(resolve, 100));

    // Try to start second job (should fail due to limit)
    const job2Result = await framework.executeModel('TEST_MODEL', {});

    expect(job2Result.success).toBe(false);
    expect(job2Result.error).toContain('Maximum concurrent jobs limit reached');
  });

  test('should handle invalid provenance data', async () => {
    const job = {
      jobId: 'test-job',
      modelName: 'GFS',
      params: null, // Invalid
      options: undefined, // Invalid
      startTime: new Date(),
      requestedBy: 'test-user',
    };

    const result = {
      success: true,
      data: null,
    };

    const provenance = await framework.createProvenanceRecord(job, result);

    expect(provenance.inputDataHash).toBeDefined();
    expect(provenance.outputDataHash).toBeNull();
  });

  test('should handle job cancellation of non-existent job', async () => {
    try {
      await framework.cancelJob('non-existent-job');
      fail('Should have thrown an error');
    } catch (error) {
      expect(error.message).toContain('Job non-existent-job not found');
    }
  });

  test('should handle empty job history', () => {
    const history = framework.getJobHistory();
    expect(history).toHaveLength(0);

    const limitedHistory = framework.getJobHistory(10);
    expect(limitedHistory).toHaveLength(0);
  });

  test('should handle statistics calculation with no data', () => {
    const stats = framework.getStatus().framework.stats;

    expect(stats.totalJobs).toBe(0);
    expect(stats.successfulJobs).toBe(0);
    expect(stats.failedJobs).toBe(0);
    expect(stats.averageJobTime).toBe(0);
    expect(stats.lastJobAt).toBeNull();
  });
});

// ============================================================================
// CLEANUP
// ============================================================================

afterAll(async () => {
  // Ensure all test files are cleaned up
  const tmpFiles = await fs.readdir('/tmp').catch(() => []);
  const testFiles = tmpFiles.filter(
    file =>
      file.includes('test_') ||
      file.includes('gfs_') ||
      file.includes('wrf_') ||
      file.includes('icon_') ||
      file.includes('climate_')
  );

  for (const file of testFiles) {
    try {
      await fs.unlink(`/tmp/${file}`);
    } catch (error) {
      // Ignore errors - file might not exist
    }
  }
});

// Export test utilities for use in other test files
module.exports = {
  createMockGRIBFile,
  createMockNetCDFFile,
  createMockCSVFile,
  cleanupTestFiles,
};
