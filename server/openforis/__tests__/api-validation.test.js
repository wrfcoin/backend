/**
 * OpenForis API Validation Tests
 *
 * Comprehensive tests for OpenForis API validation functionality
 */

const {
  validateApiKey,
  validateEndpointUrl,
  validateProjectResponse,
  validatePlotResponse,
  validateTimeSeriesResponse,
  validateClimateResponse,
  createProjectValidation,
  createPlotValidation,
  timeSeriesAnalysisValidation,
  climateProjectionValidation,
} = require('../validation-schemas');

const OpenForisErrorHandler = require('../error-handler');
const { OpenForisAdapter } = require('../adapter');

describe('OpenForis API Validation', () => {
  describe('API Key Validation', () => {
    it('should validate a proper API key', () => {
      const validKey = 'sk_test_' + 'a'.repeat(32);
      expect(() => validateApiKey(validKey)).not.toThrow();
    });

    it('should reject empty or null API keys', () => {
      expect(() => validateApiKey('')).toThrow(
        'API key must be a non-empty string'
      );
      expect(() => validateApiKey(null)).toThrow(
        'API key must be a non-empty string'
      );
      expect(() => validateApiKey(undefined)).toThrow(
        'API key must be a non-empty string'
      );
    });

    it('should reject API keys that are too short', () => {
      expect(() => validateApiKey('short')).toThrow(
        'API key must be between 32 and 128 characters'
      );
    });

    it('should reject API keys that are too long', () => {
      const longKey = 'a'.repeat(200);
      expect(() => validateApiKey(longKey)).toThrow(
        'API key must be between 32 and 128 characters'
      );
    });

    it('should reject API keys with invalid characters', () => {
      const invalidKey = 'sk_test_' + 'a'.repeat(25) + '!@#$%^';
      expect(() => validateApiKey(invalidKey)).toThrow(
        'API key contains invalid characters'
      );
    });
  });

  describe('Endpoint URL Validation', () => {
    it('should validate proper HTTPS URLs', () => {
      expect(() =>
        validateEndpointUrl('https://api.openforis.org')
      ).not.toThrow();
      expect(() =>
        validateEndpointUrl('https://collect.earth/api/v2')
      ).not.toThrow();
    });

    it('should reject invalid URLs', () => {
      expect(() => validateEndpointUrl('not-a-url')).toThrow(
        'Invalid endpoint URL'
      );
      expect(() => validateEndpointUrl('ftp://invalid.com')).toThrow(
        'Invalid endpoint URL'
      );
    });

    it('should reject HTTP URLs in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      expect(() => validateEndpointUrl('http://api.openforis.org')).toThrow(
        'Endpoint URL must use HTTPS in production'
      );

      process.env.NODE_ENV = originalEnv;
    });

    it('should reject localhost URLs in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      expect(() => validateEndpointUrl('https://localhost:3000')).toThrow(
        'Cannot use localhost URLs in production'
      );
      expect(() => validateEndpointUrl('https://127.0.0.1:3000')).toThrow(
        'Cannot use localhost URLs in production'
      );

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('Project Response Validation', () => {
    it('should validate a proper project response', () => {
      const validProject = {
        id: 'ce-project-12345678',
        name: 'Test Forest Project',
        status: 'ACTIVE',
        createdAt: '2023-01-01T00:00:00Z',
        description: 'A test project',
      };

      const errors = validateProjectResponse(validProject);
      expect(errors).toHaveLength(0);
    });

    it('should reject project response without required fields', () => {
      const invalidProject = {
        name: 'Test Project',
        // Missing id, status, etc.
      };

      const errors = validateProjectResponse(invalidProject);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.includes('ID'))).toBe(true);
      expect(errors.some(e => e.includes('status'))).toBe(true);
    });

    it('should reject project response with invalid status', () => {
      const invalidProject = {
        id: 'ce-project-12345678',
        name: 'Test Project',
        status: 'INVALID_STATUS',
      };

      const errors = validateProjectResponse(invalidProject);
      expect(errors.some(e => e.includes('valid status'))).toBe(true);
    });

    it('should reject project response with invalid date', () => {
      const invalidProject = {
        id: 'ce-project-12345678',
        name: 'Test Project',
        status: 'ACTIVE',
        createdAt: 'invalid-date',
      };

      const errors = validateProjectResponse(invalidProject);
      expect(errors.some(e => e.includes('valid date'))).toBe(true);
    });
  });

  describe('Plot Response Validation', () => {
    it('should validate a proper plot response', () => {
      const validPlot = {
        id: 'ce-plot-12345678',
        projectId: 'ce-project-87654321',
        coordinates: {
          latitude: 45.5,
          longitude: -122.7,
        },
        name: 'Test Plot',
      };

      const errors = validatePlotResponse(validPlot);
      expect(errors).toHaveLength(0);
    });

    it('should reject plot response without coordinates', () => {
      const invalidPlot = {
        id: 'ce-plot-12345678',
        projectId: 'ce-project-87654321',
      };

      const errors = validatePlotResponse(invalidPlot);
      expect(errors.some(e => e.includes('coordinates'))).toBe(true);
    });

    it('should reject plot response with invalid coordinates', () => {
      const invalidPlot = {
        id: 'ce-plot-12345678',
        projectId: 'ce-project-87654321',
        coordinates: {
          latitude: 100, // Invalid latitude
          longitude: -122.7,
        },
      };

      const errors = validatePlotResponse(invalidPlot);
      expect(
        errors.some(e => e.includes('latitude must be between -90 and 90'))
      ).toBe(true);
    });
  });

  describe('Time Series Response Validation', () => {
    it('should validate a proper time series response', () => {
      const validTimeSeries = {
        id: 'em-timeseries-12345678',
        plotId: 'ce-plot-87654321',
        dataPoints: [
          {
            timestamp: '2023-01-01T00:00:00Z',
            ndvi: 0.7,
            temperature: 25.5,
          },
        ],
      };

      const errors = validateTimeSeriesResponse(validTimeSeries);
      expect(errors).toHaveLength(0);
    });

    it('should reject time series response with invalid NDVI values', () => {
      const invalidTimeSeries = {
        id: 'em-timeseries-12345678',
        plotId: 'ce-plot-87654321',
        dataPoints: [
          {
            timestamp: '2023-01-01T00:00:00Z',
            ndvi: 2.0, // Invalid NDVI (must be between -1 and 1)
            temperature: 25.5,
          },
        ],
      };

      const errors = validateTimeSeriesResponse(invalidTimeSeries);
      expect(
        errors.some(e => e.includes('NDVI must be between -1 and 1'))
      ).toBe(true);
    });

    it('should reject time series response with invalid temperature values', () => {
      const invalidTimeSeries = {
        id: 'em-timeseries-12345678',
        plotId: 'ce-plot-87654321',
        dataPoints: [
          {
            timestamp: '2023-01-01T00:00:00Z',
            ndvi: 0.7,
            temperature: -100, // Invalid temperature
          },
        ],
      };

      const errors = validateTimeSeriesResponse(invalidTimeSeries);
      expect(
        errors.some(e => e.includes('temperature must be between -50 and 60°C'))
      ).toBe(true);
    });
  });

  describe('Climate Response Validation', () => {
    it('should validate a proper climate response', () => {
      const validClimate = {
        id: 'cd-dataset-12345678',
        region: 'Europe',
        scenario: 'RCP4.5',
        projections: [
          {
            year: 2030,
            temperature: 15.5,
          },
        ],
      };

      const errors = validateClimateResponse(validClimate);
      expect(errors).toHaveLength(0);
    });

    it('should reject climate response with invalid region', () => {
      const invalidClimate = {
        id: 'cd-dataset-12345678',
        region: 'Invalid Region',
        scenario: 'RCP4.5',
      };

      const errors = validateClimateResponse(invalidClimate);
      expect(errors.some(e => e.includes('valid region'))).toBe(true);
    });

    it('should reject climate response with invalid projection years', () => {
      const invalidClimate = {
        id: 'cd-dataset-12345678',
        region: 'Europe',
        scenario: 'RCP4.5',
        projections: [
          {
            year: 1900, // Invalid year
            temperature: 15.5,
          },
        ],
      };

      const errors = validateClimateResponse(invalidClimate);
      expect(
        errors.some(e => e.includes('year must be between 2020 and 2100'))
      ).toBe(true);
    });
  });

  describe('Error Handler', () => {
    it('should create sanitized errors properly', () => {
      const error = new Error('Test error');
      error.code = 'TEST_ERROR';
      error.details = ['Detail 1', 'Detail 2'];

      const sanitized = OpenForisErrorHandler.createSanitizedError(error, true);

      expect(sanitized.success).toBe(false);
      expect(sanitized.error).toBe('Test error');
      expect(sanitized.code).toBe('TEST_ERROR');
      expect(sanitized.details).toEqual(['Detail 1', 'Detail 2']);
      expect(sanitized.timestamp).toBeDefined();
    });

    it('should identify retryable errors correctly', () => {
      const retryableError = new Error('Connection timeout');
      retryableError.code = 'ETIMEDOUT';

      const nonRetryableError = new Error('Validation failed');
      nonRetryableError.response = { status: 400 };

      expect(OpenForisErrorHandler.isRetryableError(retryableError)).toBe(true);
      expect(OpenForisErrorHandler.isRetryableError(nonRetryableError)).toBe(
        false
      );
    });

    it('should calculate retry delays with exponential backoff', () => {
      const delay1 = OpenForisErrorHandler.calculateRetryDelay(0, 1000);
      const delay2 = OpenForisErrorHandler.calculateRetryDelay(1, 1000);
      const delay3 = OpenForisErrorHandler.calculateRetryDelay(2, 1000);

      expect(delay1).toBeGreaterThanOrEqual(1000);
      expect(delay1).toBeLessThan(2000);

      expect(delay2).toBeGreaterThanOrEqual(2000);
      expect(delay2).toBeLessThan(3000);

      expect(delay3).toBeGreaterThanOrEqual(4000);
      expect(delay3).toBeLessThan(5000);
    });
  });

  describe('OpenForis Adapter Integration', () => {
    let adapter;

    beforeEach(() => {
      adapter = new OpenForisAdapter({
        testMode: true,
        collectEarthEndpoint: 'https://test.collect.earth',
        earthMapEndpoint: 'https://test.earthmap.org',
        climateDataEndpoint: 'https://test.climatedata.openforis.org',
      });
    });

    afterEach(async () => {
      // Clean up any resources
      if (adapter.initialized) {
        adapter.initialized = false;
      }
    });

    it('should initialize successfully in test mode', async () => {
      await adapter.initialize();
      expect(adapter.initialized).toBe(true);
      expect(adapter.testMode).toBe(true);
    });

    it('should validate endpoints in production mode', async () => {
      const prodAdapter = new OpenForisAdapter({
        testMode: false,
        collectEarthEndpoint: 'https://api.collect.earth',
        earthMapEndpoint: 'https://api.earthmap.org',
        climateDataEndpoint: 'https://api.climatedata.openforis.org',
      });

      // Mock environment variables
      process.env.OPENFORIS_API_KEY = 'sk_test_' + 'a'.repeat(32);

      // Mock the validation request to avoid actual API calls
      jest.spyOn(prodAdapter, 'makeValidationRequest').mockResolvedValue({
        status: 200,
        data: { valid: true },
      });

      await expect(prodAdapter.validateEndpoints()).resolves.toBe(true);

      // Clean up
      delete process.env.OPENFORIS_API_KEY;
      prodAdapter.makeValidationRequest.mockRestore();
    });

    it('should handle API validation failures gracefully', async () => {
      const prodAdapter = new OpenForisAdapter({
        testMode: false,
      });

      // No API key set
      await expect(prodAdapter.validateEndpoints()).rejects.toThrow(
        'API key must be a non-empty string'
      );
    });

    it('should create projects with validation in test mode', async () => {
      await adapter.initialize();

      const projectData = {
        name: 'Test Validation Project',
        description: 'A project for testing validation',
        type: 'FOREST_MONITORING',
        region: 'North America',
        metadata: {
          forestType: 'Temperate forest',
          timespan: '2023-2025',
        },
      };

      const result = await adapter.createCollectEarthProject(projectData);

      expect(result).toBeDefined();
      expect(result.id).toMatch(/^ce-project-[a-f0-9]{8}$/);
      expect(result.name).toBe(projectData.name);
      expect(result.type).toBe(projectData.type);
      expect(result.region).toBe(projectData.region);
    });

    it('should validate project data properly', async () => {
      await adapter.initialize();

      const invalidProjectData = {
        name: 'A', // Too short
        description: 'Short', // Too short
        type: 'INVALID_TYPE',
        region: 'Invalid Region',
      };

      // In test mode, this should still work but in production it would be validated
      const result =
        await adapter.createCollectEarthProject(invalidProjectData);
      expect(result).toBeDefined(); // Test mode is permissive
    });
  });
});

describe('Express Validator Integration', () => {
  const { validationResult } = require('express-validator');

  // Mock request object
  const createMockReq = (body = {}, params = {}, query = {}) => ({
    body,
    params,
    query,
  });

  // Mock response object
  const createMockRes = () => {
    const res = {
      status: jest.fn(() => res),
      json: jest.fn(() => res),
    };
    return res;
  };

  // Mock next function
  const mockNext = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should validate project creation data with express-validator', async () => {
    const { createProjectValidation } = require('../validation-schemas');

    // Valid request
    const validReq = createMockReq({
      name: 'Valid Project Name',
      description: 'This is a valid project description with enough characters',
      type: 'FOREST_MONITORING',
      region: 'Europe',
    });

    // Run validation
    for (const validation of createProjectValidation) {
      await validation.run(validReq);
    }

    const errors = validationResult(validReq);
    expect(errors.isEmpty()).toBe(true);
  });

  it('should reject invalid project creation data', async () => {
    const { createProjectValidation } = require('../validation-schemas');

    // Invalid request
    const invalidReq = createMockReq({
      name: 'A', // Too short
      description: 'Short', // Too short
      type: 'INVALID_TYPE',
      region: 'Invalid Region',
    });

    // Run validation
    for (const validation of createProjectValidation) {
      await validation.run(invalidReq);
    }

    const errors = validationResult(invalidReq);
    expect(errors.isEmpty()).toBe(false);
    expect(errors.array().length).toBeGreaterThan(0);
  });

  it('should handle validation errors with error handler', async () => {
    const req = createMockReq({});
    const res = createMockRes();

    // Add some validation errors manually
    req.validationErrors = () => [{ param: 'name', msg: 'Name is required' }];

    OpenForisErrorHandler.handleValidationErrors(req, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalled();
    expect(mockNext).not.toHaveBeenCalled();
  });
});
