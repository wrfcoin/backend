/**
 * Comprehensive IoT Data Validation and Error Handling System
 *
 * This module provides comprehensive validation and error handling for IoT device data
 * transmission, integrating with the existing error handling framework and extending
 * weather data validation for IoT-specific scenarios.
 */

const {
  errorHandler,
  ValidationError,
  DatabaseError,
  WrfcoinError,
} = require('../error-handler');
const { WeatherDataValidator } = require('./weather-data-validation');
const {
  EnhancedWeatherDataValidator,
} = require('./enhanced-weather-validation');
const crypto = require('crypto');

/**
 * IoT-specific error classes
 */
class IoTDeviceError extends WrfcoinError {
  constructor(message, deviceId = null) {
    super(message, 'IOT_DEVICE_ERROR', 500);
    this.deviceId = deviceId;
  }
}

class DataTransmissionError extends WrfcoinError {
  constructor(message, transmissionId = null) {
    super(message, 'DATA_TRANSMISSION_ERROR', 502);
    this.transmissionId = transmissionId;
  }
}

class DeviceCommunicationError extends WrfcoinError {
  constructor(message, deviceId = null, protocol = null) {
    super(message, 'DEVICE_COMMUNICATION_ERROR', 503);
    this.deviceId = deviceId;
    this.protocol = protocol;
  }
}

/**
 * Comprehensive IoT Data Validation and Error Handler
 */
class IoTValidationErrorHandler {
  constructor() {
    this.weatherValidator = new WeatherDataValidator();
    this.enhancedValidator = new EnhancedWeatherDataValidator();
    this.errorHandler = errorHandler;

    // Validation statistics
    this.validationStats = {
      totalValidations: 0,
      successfulValidations: 0,
      failedValidations: 0,
      errorsByType: new Map(),
      deviceErrorCounts: new Map(),
      recoveryAttempts: 0,
      successfulRecoveries: 0,
    };

    // Device communication circuits
    this.setupDeviceCircuitBreakers();

    // Validation cache for performance
    this.validationCache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Setup circuit breakers for different device types
   */
  setupDeviceCircuitBreakers() {
    const deviceTypes = ['acurite', 'luftdaten', 'ttn', 'foam', 'streamr'];

    deviceTypes.forEach(deviceType => {
      this.errorHandler.createCircuitBreaker(`iot_device_${deviceType}`, {
        failureThreshold: 3,
        resetTimeout: 30000, // 30 seconds
        monitoringPeriod: 300000, // 5 minutes
      });
    });

    // General IoT data transmission circuit breaker
    this.errorHandler.createCircuitBreaker('iot_data_transmission', {
      failureThreshold: 5,
      resetTimeout: 60000, // 1 minute
      monitoringPeriod: 600000, // 10 minutes
    });
  }

  /**
   * Comprehensive IoT data validation with error handling
   */
  async validateIoTData(data, options = {}) {
    const validationId = this.generateValidationId();
    this.validationStats.totalValidations++;

    try {
      // Check circuit breaker for device type
      const deviceCircuit = this.errorHandler.checkCircuitBreaker(
        `iot_device_${data.deviceType}`
      );
      if (!deviceCircuit.allowed) {
        throw new IoTDeviceError(
          `Device type ${data.deviceType} circuit breaker is open`,
          data.deviceId
        );
      }

      // Check cache first
      const cacheKey = this.generateCacheKey(data);
      const cachedResult = this.getFromCache(cacheKey);
      if (cachedResult && options.useCache !== false) {
        this.validationStats.successfulValidations++;
        return cachedResult;
      }

      const validationResult = {
        validationId,
        isValid: true,
        errors: [],
        warnings: [],
        deviceId: data.deviceId,
        deviceType: data.deviceType,
        timestamp: new Date().toISOString(),
        validationSteps: [],
      };

      // Step 1: Basic structure validation
      await this.validateBasicStructure(data, validationResult);

      // Step 2: Device-specific validation
      await this.validateDeviceSpecific(data, validationResult);

      // Step 3: Data integrity validation
      await this.validateDataIntegrity(data, validationResult);

      // Step 4: Environmental data validation
      await this.validateEnvironmentalData(data, validationResult);

      // Step 5: Temporal validation
      await this.validateTemporalConsistency(data, validationResult);

      // Step 6: Security validation
      await this.validateSecurity(data, validationResult);

      // Determine final validation status
      validationResult.isValid = validationResult.errors.length === 0;

      if (validationResult.isValid) {
        this.validationStats.successfulValidations++;
        this.errorHandler.recordSuccess(`iot_device_${data.deviceType}`);

        // Cache successful validation
        this.addToCache(cacheKey, validationResult);
      } else {
        this.validationStats.failedValidations++;
        this.errorHandler.recordFailure(`iot_device_${data.deviceType}`);

        // Track errors by type
        validationResult.errors.forEach(error => {
          const errorType = error.type || 'UNKNOWN';
          this.validationStats.errorsByType.set(
            errorType,
            (this.validationStats.errorsByType.get(errorType) || 0) + 1
          );
        });
      }

      return validationResult;
    } catch (error) {
      this.validationStats.failedValidations++;

      // Log the validation error
      this.errorHandler.logError(error, {
        validationId,
        deviceId: data.deviceId,
        deviceType: data.deviceType,
        validationStep: 'comprehensive_validation',
      });

      throw error;
    }
  }

  /**
   * Validate basic data structure
   */
  async validateBasicStructure(data, result) {
    result.validationSteps.push('basic_structure');

    // Required fields validation
    const requiredFields = [
      'deviceId',
      'deviceType',
      'timestamp',
      'measurements',
    ];
    const missingFields = requiredFields.filter(field => !data[field]);

    if (missingFields.length > 0) {
      result.errors.push({
        type: 'MISSING_REQUIRED_FIELDS',
        message: `Missing required fields: ${missingFields.join(', ')}`,
        fields: missingFields,
      });
    }

    // Device ID format validation
    if (data.deviceId && typeof data.deviceId !== 'string') {
      result.errors.push({
        type: 'INVALID_DEVICE_ID_FORMAT',
        message: 'Device ID must be a string',
        field: 'deviceId',
      });
    }

    // Device type validation
    const supportedDeviceTypes = [
      'acurite',
      'luftdaten',
      'ttn',
      'foam',
      'streamr',
    ];
    if (data.deviceType && !supportedDeviceTypes.includes(data.deviceType)) {
      result.errors.push({
        type: 'UNSUPPORTED_DEVICE_TYPE',
        message: `Unsupported device type: ${data.deviceType}`,
        supportedTypes: supportedDeviceTypes,
      });
    }

    // Measurements structure validation
    if (data.measurements && typeof data.measurements !== 'object') {
      result.errors.push({
        type: 'INVALID_MEASUREMENTS_FORMAT',
        message: 'Measurements must be an object',
        field: 'measurements',
      });
    }
  }

  /**
   * Device-specific validation
   */
  async validateDeviceSpecific(data, result) {
    result.validationSteps.push('device_specific');

    try {
      switch (data.deviceType) {
        case 'acurite':
          await this.validateAcuriteDevice(data, result);
          break;
        case 'luftdaten':
          await this.validateLuftdatenDevice(data, result);
          break;
        case 'ttn':
          await this.validateTTNDevice(data, result);
          break;
        case 'foam':
          await this.validateFOAMDevice(data, result);
          break;
        case 'streamr':
          await this.validateStreamrDevice(data, result);
          break;
        default:
          result.warnings.push({
            type: 'UNKNOWN_DEVICE_TYPE',
            message: `No specific validation available for device type: ${data.deviceType}`,
          });
      }
    } catch (error) {
      result.errors.push({
        type: 'DEVICE_SPECIFIC_VALIDATION_ERROR',
        message: `Device-specific validation failed: ${error.message}`,
        deviceType: data.deviceType,
      });
    }
  }

  /**
   * Validate data integrity
   */
  async validateDataIntegrity(data, result) {
    result.validationSteps.push('data_integrity');

    try {
      // Check for data corruption signs
      const measurementValues = Object.values(data.measurements || {});

      // Check for null/undefined values
      const nullValues = measurementValues.filter(
        value => value === null || value === undefined
      );
      if (nullValues.length > 0) {
        result.warnings.push({
          type: 'NULL_MEASUREMENT_VALUES',
          message: `Found ${nullValues.length} null/undefined measurement values`,
        });
      }

      // Check for extreme outliers (Z-score > 4)
      await this.detectOutliers(data.measurements, result);

      // Validate data consistency
      await this.validateDataConsistency(data.measurements, result);
    } catch (error) {
      result.errors.push({
        type: 'DATA_INTEGRITY_CHECK_FAILED',
        message: `Data integrity validation failed: ${error.message}`,
      });
    }
  }

  /**
   * Validate environmental data using existing validators
   */
  async validateEnvironmentalData(data, result) {
    result.validationSteps.push('environmental_data');

    try {
      // Use existing weather data validator
      const weatherValidation = this.weatherValidator.validateDataPoint({
        timestamp: data.timestamp,
        temperature: data.measurements?.temperature,
        humidity: data.measurements?.humidity,
        pressure: data.measurements?.pressure,
        windSpeed: data.measurements?.windSpeed,
        precipitation: data.measurements?.precipitation,
      });

      if (!weatherValidation.isValid) {
        weatherValidation.errors.forEach(error => {
          result.errors.push({
            type: 'ENVIRONMENTAL_DATA_VALIDATION_ERROR',
            message: error,
            validator: 'weather_data_validator',
          });
        });
      }

      // Use enhanced validator for timestamp validation
      const enhancedValidation = this.enhancedValidator.validateTimestamp(
        data.timestamp
      );
      if (!enhancedValidation.isValid) {
        enhancedValidation.errors.forEach(error => {
          result.errors.push({
            type: 'TIMESTAMP_VALIDATION_ERROR',
            message: error,
            validator: 'enhanced_weather_validator',
          });
        });
      }
    } catch (error) {
      result.errors.push({
        type: 'ENVIRONMENTAL_VALIDATION_FAILED',
        message: `Environmental data validation failed: ${error.message}`,
      });
    }
  }

  /**
   * Validate temporal consistency
   */
  async validateTemporalConsistency(data, result) {
    result.validationSteps.push('temporal_consistency');

    try {
      const timestamp = new Date(data.timestamp);
      const now = new Date();

      // Check for future timestamps (with some tolerance)
      if (timestamp.getTime() > now.getTime() + 5 * 60 * 1000) {
        // 5 minutes tolerance
        result.errors.push({
          type: 'FUTURE_TIMESTAMP',
          message: 'Data timestamp is too far in the future',
          timestamp: data.timestamp,
          currentTime: now.toISOString(),
        });
      }

      // Check for very old timestamps
      const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      if (timestamp.getTime() < oneMonthAgo.getTime()) {
        result.warnings.push({
          type: 'OLD_TIMESTAMP',
          message: 'Data timestamp is older than 30 days',
          timestamp: data.timestamp,
        });
      }
    } catch (error) {
      result.errors.push({
        type: 'TEMPORAL_VALIDATION_ERROR',
        message: `Temporal validation failed: ${error.message}`,
      });
    }
  }

  /**
   * Validate security aspects
   */
  async validateSecurity(data, result) {
    result.validationSteps.push('security_validation');

    try {
      // Check for injection attempts in string fields
      const stringFields = ['deviceId'];
      stringFields.forEach(field => {
        if (data[field] && typeof data[field] === 'string') {
          if (this.containsSQLInjection(data[field])) {
            result.errors.push({
              type: 'SECURITY_SQL_INJECTION_DETECTED',
              message: `Potential SQL injection detected in ${field}`,
              field,
              value: data[field],
            });
          }

          if (this.containsXSS(data[field])) {
            result.errors.push({
              type: 'SECURITY_XSS_DETECTED',
              message: `Potential XSS attack detected in ${field}`,
              field,
              value: data[field],
            });
          }
        }
      });

      // Validate location data for reasonable bounds
      if (data.location) {
        const { latitude, longitude } = data.location;
        if (latitude < -90 || latitude > 90) {
          result.errors.push({
            type: 'INVALID_LATITUDE',
            message: 'Latitude must be between -90 and 90',
            value: latitude,
          });
        }

        if (longitude < -180 || longitude > 180) {
          result.errors.push({
            type: 'INVALID_LONGITUDE',
            message: 'Longitude must be between -180 and 180',
            value: longitude,
          });
        }
      }
    } catch (error) {
      result.errors.push({
        type: 'SECURITY_VALIDATION_ERROR',
        message: `Security validation failed: ${error.message}`,
      });
    }
  }

  /**
   * Handle data transmission errors with recovery mechanisms
   */
  async handleDataTransmissionError(error, data, options = {}) {
    const transmissionId = this.generateTransmissionId();
    this.validationStats.recoveryAttempts++;

    try {
      // Log the transmission error
      this.errorHandler.logError(error, {
        transmissionId,
        deviceId: data?.deviceId,
        deviceType: data?.deviceType,
        errorType: 'data_transmission',
      });

      // Check circuit breaker
      const circuitStatus = this.errorHandler.checkCircuitBreaker(
        'iot_data_transmission'
      );
      if (!circuitStatus.allowed) {
        throw new DataTransmissionError(
          'Data transmission circuit breaker is open - service temporarily unavailable',
          transmissionId
        );
      }

      // Attempt recovery based on error type
      let recoveryResult = null;

      if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
        recoveryResult = await this.handleNetworkError(
          error,
          data,
          transmissionId
        );
      } else if (error.statusCode >= 400 && error.statusCode < 500) {
        recoveryResult = await this.handleClientError(
          error,
          data,
          transmissionId
        );
      } else if (error.statusCode >= 500) {
        recoveryResult = await this.handleServerError(
          error,
          data,
          transmissionId
        );
      } else {
        recoveryResult = await this.handleGenericError(
          error,
          data,
          transmissionId
        );
      }

      if (recoveryResult.success) {
        this.validationStats.successfulRecoveries++;
        this.errorHandler.recordSuccess('iot_data_transmission');
      } else {
        this.errorHandler.recordFailure('iot_data_transmission', error);
      }

      return recoveryResult;
    } catch (recoveryError) {
      this.errorHandler.logError(recoveryError, {
        originalError: error.message,
        transmissionId,
        recoveryStep: 'transmission_error_handling',
      });

      throw new DataTransmissionError(
        `Failed to recover from transmission error: ${recoveryError.message}`,
        transmissionId
      );
    }
  }

  /**
   * Handle device communication errors with retry logic
   */
  async handleDeviceCommunicationError(
    error,
    deviceId,
    protocol,
    options = {}
  ) {
    const communicationId = this.generateCommunicationId();

    try {
      // Track device-specific errors
      const deviceErrorCount =
        this.validationStats.deviceErrorCounts.get(deviceId) || 0;
      this.validationStats.deviceErrorCounts.set(
        deviceId,
        deviceErrorCount + 1
      );

      this.errorHandler.logError(error, {
        communicationId,
        deviceId,
        protocol,
        errorCount: deviceErrorCount + 1,
        errorType: 'device_communication',
      });

      // Check if device has too many consecutive errors
      if (deviceErrorCount >= 5) {
        throw new DeviceCommunicationError(
          `Device ${deviceId} has exceeded maximum error threshold`,
          deviceId,
          protocol
        );
      }

      // Implement exponential backoff retry
      const maxRetries = options.maxRetries || 3;
      const baseDelay = options.baseDelay || 1000;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          await this.sleep(delay);

          // Attempt to re-establish communication
          const communicationResult = await this.testDeviceCommunication(
            deviceId,
            protocol
          );

          if (communicationResult.success) {
            // Reset error count on successful communication
            this.validationStats.deviceErrorCounts.set(deviceId, 0);

            return {
              success: true,
              communicationId,
              attempt,
              message: `Device communication restored after ${attempt} attempts`,
            };
          }
        } catch (retryError) {
          if (attempt === maxRetries) {
            throw new DeviceCommunicationError(
              `Failed to restore communication after ${maxRetries} attempts: ${retryError.message}`,
              deviceId,
              protocol
            );
          }
        }
      }
    } catch (handlingError) {
      this.errorHandler.logError(handlingError, {
        originalError: error.message,
        communicationId,
        deviceId,
        protocol,
      });

      throw handlingError;
    }
  }

  /**
   * Create comprehensive error simulation scenarios
   */
  async createErrorSimulationScenarios() {
    return {
      // Network-related errors
      networkErrors: [
        { type: 'ECONNRESET', description: 'Connection reset by peer' },
        { type: 'ENOTFOUND', description: 'DNS resolution failed' },
        { type: 'ETIMEDOUT', description: 'Request timeout' },
        { type: 'ECONNREFUSED', description: 'Connection refused' },
      ],

      // Data validation errors
      validationErrors: [
        { type: 'MISSING_REQUIRED_FIELDS', data: { deviceType: 'acurite' } },
        { type: 'INVALID_TIMESTAMP', data: { timestamp: 'invalid-date' } },
        {
          type: 'OUT_OF_RANGE_VALUES',
          data: { measurements: { temperature: 200 } },
        },
        { type: 'MALFORMED_DATA', data: { measurements: 'not-an-object' } },
      ],

      // Device-specific errors
      deviceErrors: [
        { deviceType: 'acurite', error: 'SENSOR_CALIBRATION_ERROR' },
        { deviceType: 'luftdaten', error: 'PM_SENSOR_FAILURE' },
        { deviceType: 'ttn', error: 'LORAWAN_GATEWAY_OFFLINE' },
        { deviceType: 'foam', error: 'BLOCKCHAIN_SYNC_ERROR' },
        { deviceType: 'streamr', error: 'STREAM_SUBSCRIPTION_FAILED' },
      ],

      // Security-related errors
      securityErrors: [
        {
          type: 'SQL_INJECTION_ATTEMPT',
          data: { deviceId: "'; DROP TABLE devices; --" },
        },
        {
          type: 'XSS_ATTEMPT',
          data: { deviceId: '<script>alert("xss")</script>' },
        },
        {
          type: 'INVALID_COORDINATES',
          data: { location: { latitude: 999, longitude: 999 } },
        },
      ],
    };
  }

  // Helper methods for validation
  containsSQLInjection(input) {
    const sqlPatterns = [
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION)\b)/i,
      /(--|\/\*|\*\/|;)/,
      /(\b(OR|AND)\b.*=.*)/i,
    ];
    return sqlPatterns.some(pattern => pattern.test(input));
  }

  containsXSS(input) {
    const xssPatterns = [
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
      /javascript:/i,
      /on\w+\s*=/i,
    ];
    return xssPatterns.some(pattern => pattern.test(input));
  }

  async detectOutliers(measurements, result) {
    if (!measurements || typeof measurements !== 'object') return;

    // Simple Z-score based outlier detection
    const numericFields = ['temperature', 'humidity', 'pressure', 'windSpeed'];

    numericFields.forEach(field => {
      if (typeof measurements[field] === 'number') {
        const zScore = this.calculateZScore(measurements[field], field);
        if (Math.abs(zScore) > 4) {
          result.warnings.push({
            type: 'STATISTICAL_OUTLIER',
            message: `${field} value appears to be a statistical outlier (Z-score: ${zScore.toFixed(2)})`,
            field,
            value: measurements[field],
            zScore,
          });
        }
      }
    });
  }

  calculateZScore(value, field) {
    // Simplified Z-score calculation with typical weather data means/stddevs
    const stats = {
      temperature: { mean: 15, stddev: 15 },
      humidity: { mean: 60, stddev: 25 },
      pressure: { mean: 1013, stddev: 20 },
      windSpeed: { mean: 3, stddev: 5 },
    };

    const fieldStats = stats[field] || { mean: 0, stddev: 1 };
    return (value - fieldStats.mean) / fieldStats.stddev;
  }

  async validateDataConsistency(measurements, result) {
    if (!measurements) return;

    // Check temperature-humidity relationship
    if (
      typeof measurements.temperature === 'number' &&
      typeof measurements.humidity === 'number'
    ) {
      // Very hot temperatures with very high humidity might be suspicious
      if (measurements.temperature > 40 && measurements.humidity > 90) {
        result.warnings.push({
          type: 'SUSPICIOUS_TEMP_HUMIDITY_COMBINATION',
          message: 'High temperature with very high humidity is unusual',
          temperature: measurements.temperature,
          humidity: measurements.humidity,
        });
      }
    }
  }

  // Device-specific validation methods
  async validateAcuriteDevice(data, result) {
    // AcuRite devices typically provide temperature, humidity, wind data
    const expectedFields = ['temperature', 'humidity'];
    const providedFields = Object.keys(data.measurements || {});

    const missingExpected = expectedFields.filter(
      field => !providedFields.includes(field)
    );
    if (missingExpected.length > 0) {
      result.warnings.push({
        type: 'ACURITE_MISSING_TYPICAL_FIELDS',
        message: `AcuRite device missing typical fields: ${missingExpected.join(', ')}`,
      });
    }
  }

  async validateLuftdatenDevice(data, result) {
    // Luftdaten focuses on air quality
    const expectedFields = ['pm25', 'pm10', 'temperature', 'humidity'];
    const providedFields = Object.keys(data.measurements || {});

    if (!providedFields.some(field => field.startsWith('pm'))) {
      result.warnings.push({
        type: 'LUFTDATEN_MISSING_PM_DATA',
        message: 'Luftdaten device should provide particulate matter data',
      });
    }
  }

  async validateTTNDevice(data, result) {
    // TTN devices use LoRaWAN protocol
    if (!data.metadata?.lora) {
      result.warnings.push({
        type: 'TTN_MISSING_LORA_METADATA',
        message: 'TTN device should include LoRaWAN metadata',
      });
    }
  }

  async validateFOAMDevice(data, result) {
    // FOAM devices focus on location proofs
    if (!data.location) {
      result.errors.push({
        type: 'FOAM_MISSING_LOCATION',
        message: 'FOAM device must provide location data',
      });
    }
  }

  async validateStreamrDevice(data, result) {
    // Streamr devices should have stream metadata
    if (!data.metadata?.streamId) {
      result.warnings.push({
        type: 'STREAMR_MISSING_STREAM_METADATA',
        message: 'Streamr device should include stream metadata',
      });
    }
  }

  // Error handling helper methods
  async handleNetworkError(error, data, transmissionId) {
    // Implement network error recovery
    return {
      success: false,
      error: 'Network error recovery not yet implemented',
      transmissionId,
    };
  }

  async handleClientError(error, data, transmissionId) {
    // Handle 4xx errors
    return {
      success: false,
      error: 'Client error handling not yet implemented',
      transmissionId,
    };
  }

  async handleServerError(error, data, transmissionId) {
    // Handle 5xx errors
    return {
      success: false,
      error: 'Server error handling not yet implemented',
      transmissionId,
    };
  }

  async handleGenericError(error, data, transmissionId) {
    // Handle other errors
    return {
      success: false,
      error: 'Generic error handling not yet implemented',
      transmissionId,
    };
  }

  async testDeviceCommunication(deviceId, protocol) {
    // Simulate device communication test
    return {
      success: Math.random() > 0.3, // 70% success rate for simulation
      deviceId,
      protocol,
      timestamp: new Date().toISOString(),
    };
  }

  // Utility methods
  generateValidationId() {
    return `val_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  generateTransmissionId() {
    return `trans_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  generateCommunicationId() {
    return `comm_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  generateCacheKey(data) {
    const keyData = {
      deviceId: data.deviceId,
      deviceType: data.deviceType,
      timestamp: data.timestamp,
      measurementKeys: Object.keys(data.measurements || {}).sort(),
    };
    return crypto
      .createHash('md5')
      .update(JSON.stringify(keyData))
      .digest('hex');
  }

  addToCache(key, result) {
    this.validationCache.set(key, {
      result,
      timestamp: Date.now(),
    });
  }

  getFromCache(key) {
    const cached = this.validationCache.get(key);
    if (!cached) return null;

    if (Date.now() - cached.timestamp > this.cacheTimeout) {
      this.validationCache.delete(key);
      return null;
    }

    return cached.result;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get validation and error handling statistics
   */
  getStatistics() {
    return {
      ...this.validationStats,
      errorsByType: Object.fromEntries(this.validationStats.errorsByType),
      deviceErrorCounts: Object.fromEntries(
        this.validationStats.deviceErrorCounts
      ),
      successRate:
        this.validationStats.totalValidations > 0
          ? (
              (this.validationStats.successfulValidations /
                this.validationStats.totalValidations) *
              100
            ).toFixed(2)
          : 0,
      recoveryRate:
        this.validationStats.recoveryAttempts > 0
          ? (
              (this.validationStats.successfulRecoveries /
                this.validationStats.recoveryAttempts) *
              100
            ).toFixed(2)
          : 0,
    };
  }
}

module.exports = {
  IoTValidationErrorHandler,
  IoTDeviceError,
  DataTransmissionError,
  DeviceCommunicationError,
};
