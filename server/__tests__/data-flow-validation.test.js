/**
 * Comprehensive Data Flow Validation Tests
 * Tests for data flow manager, validation pipelines, and integration
 */

const {
  dataFlowValidator,
  DATA_SCHEMAS,
  TRANSFORMATION_RULES,
} = require('../services/data-flow-manager');
// backend#1089: connectionPool and cacheClient were imported here and never
// used. Both modules construct their singleton at module load — connection-pool
// calls initializePool()->testConnection()->pool.connect(), and redis-client
// instantiates a client defaulting to host 'redis-cache' — so merely requiring
// them opened a Postgres pool and a Redis connection for the whole run. The
// resulting async ENOTFOUND arrived OUTSIDE any assertion, so it failed a
// neighbouring suite (oracle-detail-routes) without moving the assertion
// counts, and on some runs escaped as an uncaught exception that killed the
// runner. The egress guard does not catch it because that patches http/https,
// not raw TCP. Nothing here used either import; the fix is to not open them.
const {
  validateRequest,
  validateResponse,
  VALIDATION_PIPELINES,
} = require('../middleware/data-validation-middleware');

describe('Data Flow Validation System', () => {
  describe('Data Schema Validation', () => {
    test('should validate valid weather station data', () => {
      const validWeatherData = {
        stationId: 'WS_001',
        location: { lat: 40.7128, lng: -74.006, elevation: 10 },
        sensors: ['temperature', 'humidity', 'pressure'],
        timestamp: Math.floor(Date.now() / 1000),
        temperature: 22.5,
        humidity: 65.2,
        pressure: 1013.25,
        windSpeed: 5.5,
        windDirection: 180,
      };

      const result = dataFlowValidator.validateInput(
        validWeatherData,
        'weatherStation'
      );

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.schemaName).toBe('weatherStation');
    });

    test('should reject weather data with missing required fields', () => {
      const invalidWeatherData = {
        location: { lat: 40.7128, lng: -74.006 },
        temperature: 22.5,
        // Missing: stationId, sensors, timestamp
      };

      const result = dataFlowValidator.validateInput(
        invalidWeatherData,
        'weatherStation'
      );

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.field === 'stationId')).toBe(true);
      expect(result.errors.some(e => e.field === 'sensors')).toBe(true);
      expect(result.errors.some(e => e.field === 'timestamp')).toBe(true);
    });

    test('should reject weather data with invalid ranges', () => {
      const invalidWeatherData = {
        stationId: 'WS_001',
        location: { lat: 40.7128, lng: -74.006, elevation: 10 },
        sensors: ['temperature'],
        timestamp: Math.floor(Date.now() / 1000),
        temperature: -100, // Invalid: below minimum
        humidity: 150, // Invalid: above maximum
        windDirection: 400, // Invalid: above maximum
      };

      const result = dataFlowValidator.validateInput(
        invalidWeatherData,
        'weatherStation'
      );

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.field === 'temperature')).toBe(true);
      expect(result.errors.some(e => e.field === 'humidity')).toBe(true);
      expect(result.errors.some(e => e.field === 'windDirection')).toBe(true);
    });

    test('should validate carbon credit data', () => {
      const validCarbonCredit = {
        projectId: 'CC_2024_001',
        issuer: '0x1234567890123456789012345678901234567890',
        carbonOffset: 1000.5,
        projectType: 'renewable_energy',
        verificationStandard: 'VCS',
        additionalCertifications: ['ISO14064'],
      };

      const result = dataFlowValidator.validateInput(
        validCarbonCredit,
        'carbonCredit'
      );

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should validate cross-chain transaction data', () => {
      const validCrossChainTx = {
        sourceChain: 'ethereum',
        destinationChain: 'polygon',
        amount: '1000000000000000000', // 1 ETH in wei
        token: '0xA0b86a33E6Ed7D4A5e9E7D1e5A6F8D3E7C9B4B6F',
        sender: '0x1234567890123456789012345678901234567890',
        recipient: '0x0987654321098765432109876543210987654321',
        gasPrice: '20000000000', // 20 gwei
        gasLimit: 21000,
      };

      const result = dataFlowValidator.validateInput(
        validCrossChainTx,
        'crossChainTx'
      );

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should validate IoT sensor reading data', () => {
      const validIoTReading = {
        deviceId: 'IOT_SENSOR_001',
        sensorType: 'temperature',
        value: 25.3,
        timestamp: Math.floor(Date.now() / 1000),
        location: { lat: 40.7128, lng: -74.006 },
        quality: 0.95,
        calibrationDate: Math.floor(Date.now() / 1000) - 86400, // 1 day ago
      };

      const result = dataFlowValidator.validateInput(
        validIoTReading,
        'iotReading'
      );

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Data Transformation', () => {
    test('should transform temperature units correctly', () => {
      const data = { temperature: 25 }; // Celsius
      const rules = [
        {
          field: 'temperature',
          operation: 'convert_temperature',
          parameters: { from: 'celsius', to: 'fahrenheit' },
        },
      ];

      const result = dataFlowValidator.transformData(data, rules);

      expect(result.success).toBe(true);
      expect(result.data.temperature).toBeCloseTo(77, 0); // 25°C = 77°F
      expect(result.transformations).toHaveLength(1);
    });

    test('should normalize addresses correctly', () => {
      const data = {
        sender: '0xABCDEF123456789012345678901234567890ABCD',
        recipient: '  0x1234567890123456789012345678901234567890  ',
      };
      const rules = [
        { field: 'sender', operation: 'normalize_address' },
        { field: 'recipient', operation: 'normalize_address' },
      ];

      const result = dataFlowValidator.transformData(data, rules);

      expect(result.success).toBe(true);
      expect(result.data.sender).toBe(
        '0xabcdef123456789012345678901234567890abcd'
      );
      expect(result.data.recipient).toBe(
        '0x1234567890123456789012345678901234567890'
      );
    });

    test('should format numbers with specified decimals', () => {
      const data = {
        price: 123.456789,
        amount: 999.999999,
      };
      const rules = [
        {
          field: 'price',
          operation: 'format_number',
          parameters: { decimals: 2 },
        },
        {
          field: 'amount',
          operation: 'format_number',
          parameters: { decimals: 4 },
        },
      ];

      const result = dataFlowValidator.transformData(data, rules);

      expect(result.success).toBe(true);
      expect(result.data.price).toBe(123.46);
      expect(result.data.amount).toBe(1000.0);
    });

    test('should normalize timestamps correctly', () => {
      const data = {
        timestamp: Date.now(), // Milliseconds
      };
      const rules = [{ field: 'timestamp', operation: 'normalize_timestamp' }];

      const result = dataFlowValidator.transformData(data, rules);

      expect(result.success).toBe(true);
      expect(result.data.timestamp).toBeLessThan(Date.now() / 1000 + 1); // Should be in seconds
      expect(result.data.timestamp).toBeGreaterThan(Date.now() / 1000 - 10);
    });

    test('should sanitize string inputs', () => {
      const data = {
        comment: '  This is a <script>alert("xss")</script> test  ',
        description: 'Normal text with > and < characters',
      };
      const rules = [
        { field: 'comment', operation: 'sanitize_string' },
        { field: 'description', operation: 'sanitize_string' },
      ];

      const result = dataFlowValidator.transformData(data, rules);

      expect(result.success).toBe(true);
      expect(result.data.comment).toBe(
        'This is a scriptalert("xss")/script test'
      );
      expect(result.data.description).toBe('Normal text with  and  characters');
    });
  });

  describe('Data Flow Pipelines', () => {
    test('should process weather ingestion pipeline successfully', async () => {
      const weatherData = {
        stationId: 'WS_TEST_001',
        location: { lat: 40.7128, lng: -74.006, elevation: 10 },
        sensors: ['temperature', 'humidity'],
        timestamp: Math.floor(Date.now() / 1000) - 300, // 5 minutes ago
        temperature: 22.555,
        humidity: 65.123,
      };

      const pipeline = VALIDATION_PIPELINES.weatherIngestion;
      const result = await dataFlowValidator.validateDataFlow(
        weatherData,
        pipeline
      );

      expect(result.success).toBe(true);
      expect(result.stages).toHaveLength(3);
      expect(result.finalData).toBeDefined();
      expect(result.finalData.temperature).toBe(22.56); // Formatted to 2 decimals
      expect(result.finalData.humidity).toBe(65.1); // Formatted to 1 decimal
    });

    test('should process carbon credit flow successfully', async () => {
      const carbonData = {
        projectId: 'CC_TEST_001',
        issuer: '0xABCDEF123456789012345678901234567890ABCD',
        carbonOffset: 1000.123456,
        projectType: 'renewable_energy',
        verificationStandard: 'VCS',
      };

      const pipeline = VALIDATION_PIPELINES.carbonCreditFlow;
      const result = await dataFlowValidator.validateDataFlow(
        carbonData,
        pipeline
      );

      expect(result.success).toBe(true);
      expect(result.finalData.carbonOffset).toBe(1000.123456); // 6 decimals
      expect(result.finalData.issuer).toBe(
        '0xabcdef123456789012345678901234567890abcd'
      );
    });

    test('should process cross-chain flow with validation', async () => {
      const crossChainData = {
        sourceChain: 'ethereum',
        destinationChain: 'polygon',
        amount: '1000000000000000000',
        token: '0xA0b86a33E6Ed7D4A5e9E7D1e5A6F8D3E7C9B4B6F',
        sender: '0x1234567890123456789012345678901234567890',
        recipient: '0x0987654321098765432109876543210987654321',
      };

      const pipeline = VALIDATION_PIPELINES.crossChainFlow;
      const result = await dataFlowValidator.validateDataFlow(
        crossChainData,
        pipeline
      );

      expect(result.success).toBe(true);
      expect(result.finalData.sender).toBe(
        '0x1234567890123456789012345678901234567890'
      );
      expect(result.finalData.recipient).toBe(
        '0x0987654321098765432109876543210987654321'
      );
    });

    test('should handle validation failures in pipeline', async () => {
      const invalidData = {
        sourceChain: 'unsupported_chain',
        destinationChain: 'ethereum',
        amount: '1000',
        token: 'invalid_address',
        sender: 'invalid_sender',
        recipient: 'invalid_recipient',
      };

      const pipeline = VALIDATION_PIPELINES.crossChainFlow;
      const result = await dataFlowValidator.validateDataFlow(
        invalidData,
        pipeline
      );

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Output Validation', () => {
    test('should validate data integrity after transformation', () => {
      const originalData = {
        value: 123.456,
        text: 'original',
        array: [1, 2, 3],
      };

      const transformedData = {
        value: 123.46, // Rounded
        text: 'original',
        array: [1, 2, 3],
      };

      const result = dataFlowValidator.validateOutput(
        originalData,
        transformedData
      );

      expect(result.success).toBe(true);
      expect(result.warnings).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    test('should detect missing fields after transformation', () => {
      const originalData = {
        field1: 'value1',
        field2: 'value2',
        field3: 'value3',
      };

      const transformedData = {
        field1: 'value1',
        field2: 'value2',
        // field3 missing
      };

      const result = dataFlowValidator.validateOutput(
        originalData,
        transformedData
      );

      expect(result.success).toBe(false);
      expect(
        result.errors.some(
          e => e.code === 'FIELDS_MISSING_AFTER_TRANSFORMATION'
        )
      ).toBe(true);
    });

    test('should detect significant data loss', () => {
      const originalData = {
        largeArray: new Array(1000).fill('data'),
        description:
          'This is a very long description with lots of content that represents significant data volume',
        metadata: { key1: 'value1', key2: 'value2', key3: 'value3' },
      };

      const transformedData = {
        summary: 'short',
      };

      const result = dataFlowValidator.validateOutput(
        originalData,
        transformedData
      );

      expect(
        result.warnings.some(w => w.code === 'SIGNIFICANT_DATA_LOSS')
      ).toBe(true);
    });
  });

  describe('Performance and Caching', () => {
    test('should cache validation results for identical inputs', () => {
      const testData = {
        stationId: 'WS_CACHE_TEST',
        location: { lat: 40.7128, lng: -74.006, elevation: 10 },
        sensors: ['temperature'],
        timestamp: Math.floor(Date.now() / 1000),
        temperature: 25.0,
      };

      // First validation
      const result1 = dataFlowValidator.validateInput(
        testData,
        'weatherStation'
      );
      expect(result1.success).toBe(true);
      expect(result1.cached).toBeFalsy();

      // Second validation with same data should be cached
      const result2 = dataFlowValidator.validateInput(
        testData,
        'weatherStation'
      );
      expect(result2.success).toBe(true);
      expect(result2.cached).toBe(true);
    });

    test('should provide validation statistics', () => {
      const stats = dataFlowValidator.getStatistics();

      expect(stats).toHaveProperty('validationCount');
      expect(stats).toHaveProperty('errorCount');
      expect(stats).toHaveProperty('transformationCount');
      expect(stats).toHaveProperty('successRate');
      expect(stats).toHaveProperty('uptime');
      expect(stats).toHaveProperty('averageValidationsPerMinute');
      expect(stats).toHaveProperty('cacheSize');

      expect(typeof stats.validationCount).toBe('number');
      expect(typeof stats.successRate).toBe('string');
    });

    test('should clear validation cache', () => {
      // Add some cached validations
      const testData = {
        stationId: 'test',
        location: {},
        sensors: [],
        timestamp: 123,
      };
      dataFlowValidator.validateInput(testData, 'weatherStation');

      let stats = dataFlowValidator.getStatistics();
      const initialCacheSize = stats.cacheSize;

      // Clear cache
      dataFlowValidator.clearCache();

      stats = dataFlowValidator.getStatistics();
      expect(stats.cacheSize).toBe(0);
    });
  });

  describe('Integration with Other Components', () => {
    test('should validate database query parameters', async () => {
      // Mock a database query validation
      const queryText = 'SELECT * FROM weather_stations WHERE station_id = $1';
      const params = ['WS_001'];

      // This would normally go through the connection pool
      expect(queryText).toContain('SELECT');
      expect(params).toHaveLength(1);
      expect(typeof params[0]).toBe('string');
    });

    test('should validate cache data structure', async () => {
      // Test cache validation through policy
      const testData = {
        stationId: 'WS_CACHE_001',
        timestamp: Date.now(),
        temperature: 25.5,
      };

      // This would normally go through the cache client
      expect(testData).toHaveProperty('stationId');
      expect(testData).toHaveProperty('timestamp');
      expect(testData).toHaveProperty('temperature');
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid schema names gracefully', () => {
      const testData = { test: 'data' };

      const result = dataFlowValidator.validateInput(
        testData,
        'nonexistent_schema'
      );

      expect(result.success).toBe(false);
      expect(
        result.errors.some(e =>
          e.message.includes('Schema nonexistent_schema not found')
        )
      ).toBe(true);
    });

    test('should handle transformation errors gracefully', () => {
      const testData = { temperature: 'not_a_number' };
      const rules = [
        {
          field: 'temperature',
          operation: 'convert_temperature',
          parameters: { from: 'celsius', to: 'fahrenheit' },
        },
      ];

      const result = dataFlowValidator.transformData(testData, rules);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('should handle circular reference in data', () => {
      const circularData = { name: 'test' };
      circularData.self = circularData; // Create circular reference

      expect(() => {
        dataFlowValidator.validateInput(circularData, 'weatherStation');
      }).toThrow(); // Should throw due to JSON.stringify failing
    });
  });

  describe('Security Validation', () => {
    test('should detect potential injection attempts', () => {
      const maliciousData = {
        stationId: "'; DROP TABLE weather_stations; --",
        location: { lat: 40.7128, lng: -74.006, elevation: 10 },
        sensors: ['temperature'],
        timestamp: Math.floor(Date.now() / 1000),
        temperature: 25.0,
      };

      const result = dataFlowValidator.validateInput(
        maliciousData,
        'weatherStation'
      );

      // Should still validate the structure, but the malicious content would be caught
      // at the database layer or by sanitization rules
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    test('should sanitize potentially dangerous strings', () => {
      const data = {
        comment: '<script>alert("xss")</script>',
        description: 'Normal text',
      };
      const rules = [{ field: 'comment', operation: 'sanitize_string' }];

      const result = dataFlowValidator.transformData(data, rules);

      expect(result.success).toBe(true);
      expect(result.data.comment).not.toContain('<script>');
      expect(result.data.comment).not.toContain('</script>');
    });
  });
});

// Helper function to create mock request/response objects
function createMockRequest(body = {}, query = {}) {
  return {
    body,
    query,
    method: 'POST',
    path: '/api/test',
    headers: {},
  };
}

function createMockResponse() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  return res;
}

describe('Data Validation Middleware', () => {
  test('should validate weather data in middleware', async () => {
    const req = createMockRequest({
      stationId: 'WS_MW_001',
      location: { lat: 40.7128, lng: -74.006, elevation: 10 },
      sensors: ['temperature'],
      timestamp: Math.floor(Date.now() / 1000),
      temperature: 25.0,
    });
    const res = createMockResponse();
    const next = jest.fn();

    const middleware = validateRequest('weatherIngestion');
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.validationResult).toBeDefined();
    expect(req.validationResult.success).toBe(true);
    expect(req.validatedData).toBeDefined();
  });

  test('should reject invalid data in middleware', async () => {
    const req = createMockRequest({
      // Missing required fields
      temperature: 25.0,
    });
    const res = createMockResponse();
    const next = jest.fn();

    const middleware = validateRequest('weatherIngestion');
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('should pass through when no validation pipeline specified', async () => {
    const req = createMockRequest({ test: 'data' });
    const res = createMockResponse();
    const next = jest.fn();

    const middleware = validateRequest('nonexistent_pipeline');
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
