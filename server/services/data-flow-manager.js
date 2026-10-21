/**
 * WRFCoin Data Flow Manager
 * Comprehensive data pipeline validation and monitoring system
 */

const { logger } = require('../utils/logger');
const crypto = require('crypto');
const EventEmitter = require('events');

// Data validation schemas
const DATA_SCHEMAS = {
  // Weather station data schema
  weatherStation: {
    required: ['stationId', 'location', 'sensors', 'timestamp'],
    types: {
      stationId: 'string',
      location: { lat: 'number', lng: 'number', elevation: 'number' },
      sensors: 'array',
      timestamp: 'number',
      temperature: 'number',
      humidity: 'number',
      pressure: 'number',
      windSpeed: 'number',
      windDirection: 'number',
    },
    ranges: {
      temperature: { min: -50, max: 60 },
      humidity: { min: 0, max: 100 },
      pressure: { min: 800, max: 1200 },
      windSpeed: { min: 0, max: 200 },
      windDirection: { min: 0, max: 360 },
    },
  },

  // Carbon credit data schema
  carbonCredit: {
    required: [
      'projectId',
      'issuer',
      'carbonOffset',
      'projectType',
      'verificationStandard',
    ],
    types: {
      projectId: 'string',
      issuer: 'string',
      carbonOffset: 'number',
      projectType: 'string',
      verificationStandard: 'string',
      additionalCertifications: 'array',
    },
    ranges: {
      carbonOffset: { min: 0.1, max: 1000000 },
    },
  },

  // Cross-chain transaction data schema
  crossChainTx: {
    required: [
      'sourceChain',
      'destinationChain',
      'amount',
      'token',
      'sender',
      'recipient',
    ],
    types: {
      sourceChain: 'string',
      destinationChain: 'string',
      amount: 'string', // BigNumber as string
      token: 'string',
      sender: 'string',
      recipient: 'string',
      gasPrice: 'string',
      gasLimit: 'number',
    },
  },

  // IoT sensor reading schema
  iotReading: {
    required: ['deviceId', 'sensorType', 'value', 'timestamp', 'location'],
    types: {
      deviceId: 'string',
      sensorType: 'string',
      value: 'number',
      timestamp: 'number',
      location: { lat: 'number', lng: 'number' },
      quality: 'number',
      calibrationDate: 'number',
    },
    ranges: {
      quality: { min: 0, max: 1 },
      value: { min: -1000, max: 10000 }, // Flexible range for different sensor types
    },
  },

  // GraphQL query/mutation input schema
  graphqlInput: {
    required: ['operationName', 'query'],
    types: {
      operationName: 'string',
      query: 'string',
      variables: 'object',
    },
  },
};

// backend#1089: operations whose whole purpose is to produce a number. A
// non-finite result from one of these is a failed transformation, not a value.
const ARITHMETIC_TRANSFORMATIONS = new Set([
  'convert_temperature',
  'format_number',
]);

// Data transformation rules
const TRANSFORMATION_RULES = {
  // Temperature unit conversions
  temperature: {
    celsiusToFahrenheit: celsius => (celsius * 9) / 5 + 32,
    fahrenheitToCelsius: fahrenheit => ((fahrenheit - 32) * 5) / 9,
    kelvinToCelsius: kelvin => kelvin - 273.15,
  },

  // Pressure unit conversions
  pressure: {
    hpaToInHg: hpa => hpa * 0.02953,
    inHgToHpa: inHg => inHg / 0.02953,
    paToHpa: pa => pa / 100,
  },

  // Wind speed unit conversions
  windSpeed: {
    mpsToKmh: mps => mps * 3.6,
    mpsToMph: mps => mps * 2.237,
    kmhToMps: kmh => kmh / 3.6,
  },

  // Address format normalization
  address: {
    normalize: address => address?.toLowerCase?.()?.trim?.() || '',
    validate: address => /^0x[a-fA-F0-9]{40}$/.test(address),
  },

  // Timestamp normalization
  timestamp: {
    toUnix: timestamp => {
      if (typeof timestamp === 'number' && timestamp > 1e12) {
        return Math.floor(timestamp / 1000); // Convert milliseconds to seconds
      }
      return timestamp;
    },
    toMilliseconds: timestamp => {
      if (typeof timestamp === 'number' && timestamp < 1e12) {
        return timestamp * 1000; // Convert seconds to milliseconds
      }
      return timestamp;
    },
  },
};

class DataFlowValidator extends EventEmitter {
  constructor() {
    super();
    this.validationCount = 0;
    this.errorCount = 0;
    this.transformationCount = 0;
    this.startTime = Date.now();
    this.validationCache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Validate input data against schema
   */
  validateInput(data, schemaName, options = {}) {
    const validation = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      schemaName,
      stage: 'input',
      success: true,
      errors: [],
      warnings: [],
      metrics: {},
    };

    try {
      this.validationCount++;
      const startTime = Date.now();

      // Check cache for repeated validations
      const cacheKey = this.generateCacheKey(data, schemaName);
      if (this.validationCache.has(cacheKey)) {
        const cached = this.validationCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTimeout) {
          validation.cached = true;
          validation.metrics.validationTime = Date.now() - startTime;
          return { ...cached.result, ...validation };
        }
      }

      const schema = DATA_SCHEMAS[schemaName];
      if (!schema) {
        throw new Error(`Schema ${schemaName} not found`);
      }

      // Required field validation
      for (const field of schema.required) {
        if (data[field] === undefined || data[field] === null) {
          validation.errors.push({
            field,
            code: 'REQUIRED_FIELD_MISSING',
            message: `Required field '${field}' is missing`,
          });
        }
      }

      // Type validation
      if (schema.types) {
        for (const [field, expectedType] of Object.entries(schema.types)) {
          if (data[field] !== undefined) {
            const isValid = this.validateFieldType(
              data[field],
              expectedType,
              field
            );
            if (!isValid.valid) {
              validation.errors.push({
                field,
                code: 'TYPE_VALIDATION_FAILED',
                message: isValid.message,
              });
            }
          }
        }
      }

      // Range validation
      if (schema.ranges) {
        for (const [field, range] of Object.entries(schema.ranges)) {
          if (data[field] !== undefined && typeof data[field] === 'number') {
            if (data[field] < range.min || data[field] > range.max) {
              validation.errors.push({
                field,
                code: 'RANGE_VALIDATION_FAILED',
                message: `Field '${field}' value ${data[field]} is outside valid range [${range.min}, ${range.max}]`,
              });
            }
          }
        }
      }

      // Custom validation rules
      if (options.customValidation) {
        const customResult = options.customValidation(data);
        if (customResult.errors) {
          validation.errors.push(...customResult.errors);
        }
        if (customResult.warnings) {
          validation.warnings.push(...customResult.warnings);
        }
      }

      validation.success = validation.errors.length === 0;
      validation.metrics.validationTime = Date.now() - startTime;
      validation.metrics.fieldCount = Object.keys(data).length;

      // Cache successful validations
      if (validation.success) {
        this.validationCache.set(cacheKey, {
          result: validation,
          timestamp: Date.now(),
        });
      }

      if (!validation.success) {
        this.errorCount++;
        this.emit('validationError', validation);
      }

      this.emit('validationComplete', validation);
      return validation;
    } catch (error) {
      validation.success = false;
      validation.errors.push({
        code: 'VALIDATION_SYSTEM_ERROR',
        message: error.message,
      });
      this.errorCount++;
      this.emit('validationError', validation);
      return validation;
    }
  }

  /**
   * Transform data between formats
   */
  transformData(data, transformationRules, options = {}) {
    const transformation = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      stage: 'transformation',
      success: true,
      errors: [],
      warnings: [],
      transformations: [],
      metrics: {},
    };

    try {
      this.transformationCount++;
      const startTime = Date.now();
      const transformedData = JSON.parse(JSON.stringify(data)); // Deep clone

      for (const rule of transformationRules) {
        const { field, operation, parameters = {} } = rule;

        if (transformedData[field] !== undefined) {
          const originalValue = transformedData[field];

          try {
            switch (operation) {
              case 'normalize_address':
                transformedData[field] =
                  TRANSFORMATION_RULES.address.normalize(originalValue);
                break;

              case 'validate_address':
                if (!TRANSFORMATION_RULES.address.validate(originalValue)) {
                  transformation.errors.push({
                    field,
                    code: 'INVALID_ADDRESS_FORMAT',
                    message: `Invalid address format: ${originalValue}`,
                  });
                }
                break;

              case 'convert_temperature':
                const { from, to } = parameters;
                if (from === 'celsius' && to === 'fahrenheit') {
                  transformedData[field] =
                    TRANSFORMATION_RULES.temperature.celsiusToFahrenheit(
                      originalValue
                    );
                } else if (from === 'fahrenheit' && to === 'celsius') {
                  transformedData[field] =
                    TRANSFORMATION_RULES.temperature.fahrenheitToCelsius(
                      originalValue
                    );
                } else if (from === 'kelvin' && to === 'celsius') {
                  transformedData[field] =
                    TRANSFORMATION_RULES.temperature.kelvinToCelsius(
                      originalValue
                    );
                }
                break;

              case 'normalize_timestamp':
                transformedData[field] =
                  TRANSFORMATION_RULES.timestamp.toUnix(originalValue);
                break;

              case 'sanitize_string':
                if (typeof originalValue === 'string') {
                  transformedData[field] = originalValue
                    .trim()
                    .replace(/[<>]/g, '');
                }
                break;

              case 'format_number':
                const { decimals = 2 } = parameters;
                if (typeof originalValue === 'number') {
                  transformedData[field] = Number(
                    originalValue.toFixed(decimals)
                  );
                }
                break;

              default:
                transformation.warnings.push({
                  field,
                  code: 'UNKNOWN_TRANSFORMATION',
                  message: `Unknown transformation operation: ${operation}`,
                });
            }

            // backend#1089: an arithmetic transformation on an unconvertible
            // input yields NaN, and NaN JSON-serialises to null. Nothing
            // recorded an error, so transformData returned
            // {success:true, errors:[], data:{temperature:null}} — a null
            // emitted into the stream under a success flag, which is the
            // worst of the failure modes because nothing downstream can see
            // it. Fail loudly and leave the field at its original value.
            // Scoped to the genuinely arithmetic operations:
            // normalize_timestamp deliberately passes non-numeric values
            // through untouched, so it must not be guarded this way.
            if (
              ARITHMETIC_TRANSFORMATIONS.has(operation) &&
              !Number.isFinite(transformedData[field])
            ) {
              transformedData[field] = originalValue;
              transformation.errors.push({
                field,
                code: 'NON_FINITE_TRANSFORMATION_RESULT',
                message: `Transformation '${operation}' on field '${field}' produced a non-finite result from ${JSON.stringify(
                  originalValue
                )}`,
              });
              continue;
            }

            transformation.transformations.push({
              field,
              operation,
              originalValue,
              newValue: transformedData[field],
            });
          } catch (transformError) {
            transformation.errors.push({
              field,
              code: 'TRANSFORMATION_ERROR',
              message: `Failed to transform field '${field}': ${transformError.message}`,
            });
          }
        }
      }

      transformation.success = transformation.errors.length === 0;
      transformation.metrics.transformationTime = Date.now() - startTime;
      transformation.metrics.transformationCount =
        transformation.transformations.length;
      transformation.data = transformedData;

      this.emit('transformationComplete', transformation);
      return transformation;
    } catch (error) {
      transformation.success = false;
      transformation.errors.push({
        code: 'TRANSFORMATION_SYSTEM_ERROR',
        message: error.message,
      });
      this.emit('transformationError', transformation);
      return transformation;
    }
  }

  /**
   * Validate output data integrity
   */
  validateOutput(originalData, transformedData, options = {}) {
    const validation = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      stage: 'output',
      success: true,
      errors: [],
      warnings: [],
      metrics: {},
    };

    try {
      const startTime = Date.now();

      // Data completeness check
      const originalFields = Object.keys(originalData);
      const transformedFields = Object.keys(transformedData);

      const missingFields = originalFields.filter(
        field => !transformedFields.includes(field)
      );
      const addedFields = transformedFields.filter(
        field => !originalFields.includes(field)
      );

      if (missingFields.length > 0 && !options.allowFieldRemoval) {
        validation.errors.push({
          code: 'FIELDS_MISSING_AFTER_TRANSFORMATION',
          message: `Fields removed during transformation: ${missingFields.join(', ')}`,
        });
      }

      if (addedFields.length > 0) {
        validation.warnings.push({
          code: 'FIELDS_ADDED_DURING_TRANSFORMATION',
          message: `Fields added during transformation: ${addedFields.join(', ')}`,
        });
      }

      // Data integrity check
      for (const field of originalFields) {
        if (transformedData[field] !== undefined) {
          const originalType = typeof originalData[field];
          const transformedType = typeof transformedData[field];

          // Allow number to string conversion for blockchain amounts
          if (
            originalType !== transformedType &&
            !(
              originalType === 'number' &&
              transformedType === 'string' &&
              field.includes('amount')
            )
          ) {
            validation.warnings.push({
              field,
              code: 'TYPE_CHANGED_DURING_TRANSFORMATION',
              message: `Field type changed from ${originalType} to ${transformedType}`,
            });
          }
        }
      }

      // Calculate data loss metrics
      const originalSize = JSON.stringify(originalData).length;
      const transformedSize = JSON.stringify(transformedData).length;
      const sizeChange =
        ((transformedSize - originalSize) / originalSize) * 100;

      validation.metrics.originalSize = originalSize;
      validation.metrics.transformedSize = transformedSize;
      validation.metrics.sizeChangePercent = sizeChange;
      validation.metrics.validationTime = Date.now() - startTime;

      // Flag significant data loss
      if (sizeChange < -20 && !options.allowDataLoss) {
        validation.warnings.push({
          code: 'SIGNIFICANT_DATA_LOSS',
          message: `Data size reduced by ${Math.abs(sizeChange).toFixed(2)}%`,
        });
      }

      validation.success = validation.errors.length === 0;
      this.emit('outputValidationComplete', validation);
      return validation;
    } catch (error) {
      validation.success = false;
      validation.errors.push({
        code: 'OUTPUT_VALIDATION_ERROR',
        message: error.message,
      });
      this.emit('outputValidationError', validation);
      return validation;
    }
  }

  /**
   * Comprehensive data flow validation
   */
  async validateDataFlow(data, pipeline) {
    const flowValidation = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      pipeline: pipeline.name,
      success: true,
      stages: [],
      errors: [],
      warnings: [],
      metrics: {
        totalTime: 0,
        stageCount: pipeline.stages.length,
      },
    };

    try {
      const startTime = Date.now();
      let currentData = data;

      for (const [index, stage] of pipeline.stages.entries()) {
        const stageStart = Date.now();
        let stageResult;

        switch (stage.type) {
          case 'input_validation':
            stageResult = this.validateInput(
              currentData,
              stage.schema,
              stage.options
            );
            break;

          case 'transformation':
            stageResult = this.transformData(
              currentData,
              stage.rules,
              stage.options
            );
            if (stageResult.success && stageResult.data) {
              currentData = stageResult.data;
            }
            break;

          case 'output_validation':
            stageResult = this.validateOutput(data, currentData, stage.options);
            break;

          default:
            throw new Error(`Unknown stage type: ${stage.type}`);
        }

        stageResult.stageIndex = index;
        stageResult.stageName = stage.name || `Stage ${index + 1}`;
        stageResult.stageTime = Date.now() - stageStart;

        flowValidation.stages.push(stageResult);

        if (!stageResult.success) {
          flowValidation.success = false;
          flowValidation.errors.push(...stageResult.errors);
        }

        if (stageResult.warnings) {
          flowValidation.warnings.push(...stageResult.warnings);
        }

        // Stop on critical errors
        if (!stageResult.success && stage.critical !== false) {
          break;
        }
      }

      flowValidation.metrics.totalTime = Date.now() - startTime;
      flowValidation.finalData = currentData;

      this.emit('dataFlowComplete', flowValidation);
      return flowValidation;
    } catch (error) {
      flowValidation.success = false;
      flowValidation.errors.push({
        code: 'DATA_FLOW_ERROR',
        message: error.message,
      });
      this.emit('dataFlowError', flowValidation);
      return flowValidation;
    }
  }

  /**
   * Get validation statistics
   */
  getStatistics() {
    const uptime = Date.now() - this.startTime;
    return {
      validationCount: this.validationCount,
      errorCount: this.errorCount,
      transformationCount: this.transformationCount,
      successRate: (
        ((this.validationCount - this.errorCount) / this.validationCount) *
        100
      ).toFixed(2),
      uptime: uptime,
      averageValidationsPerMinute: (
        this.validationCount /
        (uptime / 60000)
      ).toFixed(2),
      cacheSize: this.validationCache.size,
    };
  }

  /**
   * Clear validation cache
   */
  clearCache() {
    this.validationCache.clear();
    logger.info('Data flow validation cache cleared');
  }

  // Private helper methods
  validateFieldType(value, expectedType, fieldName) {
    if (typeof expectedType === 'string') {
      // backend#1089: bare `typeof` cannot name 'array', which these schemas
      // do declare — `typeof []` is 'object', so an 'array' field could never
      // match and every payload carrying one was rejected. weatherStation
      // declares sensors:'array', so no valid weather-station payload could
      // validate at all. Only the array case is corrected here: `typeof null`
      // is also 'object', but naming that 'null' would newly reject
      // `variables: null` on the graphqlInput schema, which callers legitimately
      // send. That is a separate contract question, not this defect.
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== expectedType) {
        return {
          valid: false,
          message: `Field '${fieldName}' expected type ${expectedType}, got ${actualType}`,
        };
      }
    } else if (typeof expectedType === 'object' && expectedType !== null) {
      // Complex type validation (e.g., objects with nested structure)
      if (typeof value !== 'object' || value === null) {
        return {
          valid: false,
          message: `Field '${fieldName}' expected object, got ${typeof value}`,
        };
      }

      for (const [subField, subType] of Object.entries(expectedType)) {
        const subValidation = this.validateFieldType(
          value[subField],
          subType,
          `${fieldName}.${subField}`
        );
        if (!subValidation.valid) {
          return subValidation;
        }
      }
    }

    return { valid: true };
  }

  generateCacheKey(data, schemaName) {
    const dataStr = JSON.stringify(data, Object.keys(data).sort());
    return crypto
      .createHash('sha256')
      .update(`${schemaName}:${dataStr}`)
      .digest('hex');
  }
}

// Export singleton instance
const dataFlowValidator = new DataFlowValidator();

// Set up monitoring event handlers
dataFlowValidator.on('validationError', validation => {
  logger.error('Data validation failed', {
    validationId: validation.id,
    schemaName: validation.schemaName,
    errors: validation.errors,
    stage: validation.stage,
  });
});

dataFlowValidator.on('transformationError', transformation => {
  logger.error('Data transformation failed', {
    transformationId: transformation.id,
    errors: transformation.errors,
    stage: transformation.stage,
  });
});

dataFlowValidator.on('dataFlowError', flow => {
  logger.error('Data flow validation failed', {
    flowId: flow.id,
    pipeline: flow.pipeline,
    errors: flow.errors,
  });
});

// Log periodic statistics
// #977 ratchet: unref'd — created at import, must not hold the loop open.
const importTimeTimer5 = setInterval(
  () => {
    const stats = dataFlowValidator.getStatistics();
    logger.info('Data flow validation statistics', stats);
  },
  5 * 60 * 1000
);
importTimeTimer5.unref(); // Every 5 minutes

module.exports = {
  dataFlowValidator,
  DATA_SCHEMAS,
  TRANSFORMATION_RULES,
  DataFlowValidator,
};
