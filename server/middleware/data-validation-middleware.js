/**
 * WRFCoin Data Validation Middleware
 * Comprehensive request/response validation for all API endpoints
 */

const {
  dataFlowValidator,
  DATA_SCHEMAS,
} = require('../services/data-flow-manager');
const { logger } = require('../utils/logger');
const crypto = require('crypto');

// Validation pipelines for different data flows
const VALIDATION_PIPELINES = {
  // Weather station data ingestion pipeline
  weatherIngestion: {
    name: 'Weather Data Ingestion',
    stages: [
      {
        name: 'Input Validation',
        type: 'input_validation',
        schema: 'weatherStation',
        critical: true,
        options: {
          customValidation: data => {
            const errors = [];
            const warnings = [];

            // Check timestamp freshness (within last 24 hours)
            const now = Date.now() / 1000;
            if (data.timestamp && now - data.timestamp > 86400) {
              warnings.push({
                field: 'timestamp',
                code: 'STALE_DATA',
                message: 'Weather data is older than 24 hours',
              });
            }

            // Validate sensor array
            if (data.sensors && Array.isArray(data.sensors)) {
              if (data.sensors.length === 0) {
                errors.push({
                  field: 'sensors',
                  code: 'EMPTY_SENSORS',
                  message: 'Sensors array cannot be empty',
                });
              }
            }

            return { errors, warnings };
          },
        },
      },
      {
        name: 'Data Transformation',
        type: 'transformation',
        rules: [
          { field: 'timestamp', operation: 'normalize_timestamp' },
          {
            field: 'temperature',
            operation: 'format_number',
            parameters: { decimals: 2 },
          },
          {
            field: 'humidity',
            operation: 'format_number',
            parameters: { decimals: 1 },
          },
          {
            field: 'pressure',
            operation: 'format_number',
            parameters: { decimals: 1 },
          },
        ],
        critical: false,
      },
      {
        name: 'Output Validation',
        type: 'output_validation',
        options: {
          allowFieldRemoval: false,
          allowDataLoss: false,
        },
        critical: true,
      },
    ],
  },

  // Carbon credit trading pipeline
  carbonCreditFlow: {
    name: 'Carbon Credit Data Flow',
    stages: [
      {
        name: 'Input Validation',
        type: 'input_validation',
        schema: 'carbonCredit',
        critical: true,
        options: {
          customValidation: data => {
            const errors = [];
            const warnings = [];

            // Validate project type
            const validProjectTypes = [
              'renewable_energy',
              'forest_conservation',
              'methane_capture',
              'energy_efficiency',
              'carbon_sequestration',
              'waste_management',
            ];

            if (
              data.projectType &&
              !validProjectTypes.includes(data.projectType)
            ) {
              errors.push({
                field: 'projectType',
                code: 'INVALID_PROJECT_TYPE',
                message: `Invalid project type. Must be one of: ${validProjectTypes.join(', ')}`,
              });
            }

            // Validate verification standard
            const validStandards = ['VCS', 'CDM', 'GS', 'CAR', 'ACR'];
            if (
              data.verificationStandard &&
              !validStandards.includes(data.verificationStandard)
            ) {
              warnings.push({
                field: 'verificationStandard',
                code: 'UNKNOWN_VERIFICATION_STANDARD',
                message: `Unknown verification standard: ${data.verificationStandard}`,
              });
            }

            return { errors, warnings };
          },
        },
      },
      {
        name: 'Data Transformation',
        type: 'transformation',
        rules: [
          {
            field: 'carbonOffset',
            operation: 'format_number',
            parameters: { decimals: 6 },
          },
          { field: 'projectId', operation: 'sanitize_string' },
          { field: 'issuer', operation: 'normalize_address' },
        ],
        critical: false,
      },
      {
        name: 'Output Validation',
        type: 'output_validation',
        options: {
          allowFieldRemoval: false,
          allowDataLoss: false,
        },
        critical: true,
      },
    ],
  },

  // Cross-chain transaction pipeline
  crossChainFlow: {
    name: 'Cross-Chain Transaction Flow',
    stages: [
      {
        name: 'Input Validation',
        type: 'input_validation',
        schema: 'crossChainTx',
        critical: true,
        options: {
          customValidation: data => {
            const errors = [];
            const warnings = [];

            // Validate chain names
            const supportedChains = [
              'ethereum',
              'polygon',
              'bsc',
              'avalanche',
              'arbitrum',
              'optimism',
              'cosmos',
              'polkadot',
              'near',
              'solana',
            ];

            if (!supportedChains.includes(data.sourceChain)) {
              errors.push({
                field: 'sourceChain',
                code: 'UNSUPPORTED_CHAIN',
                message: `Unsupported source chain: ${data.sourceChain}`,
              });
            }

            if (!supportedChains.includes(data.destinationChain)) {
              errors.push({
                field: 'destinationChain',
                code: 'UNSUPPORTED_CHAIN',
                message: `Unsupported destination chain: ${data.destinationChain}`,
              });
            }

            if (data.sourceChain === data.destinationChain) {
              errors.push({
                field: 'destinationChain',
                code: 'SAME_CHAIN_TRANSFER',
                message: 'Source and destination chains cannot be the same',
              });
            }

            return { errors, warnings };
          },
        },
      },
      {
        name: 'Address Validation',
        type: 'transformation',
        rules: [
          { field: 'sender', operation: 'validate_address' },
          { field: 'recipient', operation: 'validate_address' },
          { field: 'sender', operation: 'normalize_address' },
          { field: 'recipient', operation: 'normalize_address' },
        ],
        critical: true,
      },
      {
        name: 'Output Validation',
        type: 'output_validation',
        options: {
          allowFieldRemoval: false,
          allowDataLoss: false,
        },
        critical: true,
      },
    ],
  },

  // IoT sensor data pipeline
  iotDataFlow: {
    name: 'IoT Sensor Data Flow',
    stages: [
      {
        name: 'Input Validation',
        type: 'input_validation',
        schema: 'iotReading',
        critical: true,
        options: {
          customValidation: data => {
            const errors = [];
            const warnings = [];

            // Validate sensor type
            const validSensorTypes = [
              'temperature',
              'humidity',
              'pressure',
              'air_quality',
              'wind_speed',
              'wind_direction',
              'rainfall',
              'solar_radiation',
              'soil_moisture',
              'co2',
              'pm2.5',
              'pm10',
            ];

            if (!validSensorTypes.includes(data.sensorType)) {
              warnings.push({
                field: 'sensorType',
                code: 'UNKNOWN_SENSOR_TYPE',
                message: `Unknown sensor type: ${data.sensorType}`,
              });
            }

            // Validate quality score
            if (
              data.quality !== undefined &&
              (data.quality < 0 || data.quality > 1)
            ) {
              errors.push({
                field: 'quality',
                code: 'INVALID_QUALITY_SCORE',
                message: 'Quality score must be between 0 and 1',
              });
            }

            // Check data freshness
            const now = Date.now() / 1000;
            if (data.timestamp && now - data.timestamp > 3600) {
              warnings.push({
                field: 'timestamp',
                code: 'STALE_SENSOR_DATA',
                message: 'Sensor data is older than 1 hour',
              });
            }

            return { errors, warnings };
          },
        },
      },
      {
        name: 'Data Normalization',
        type: 'transformation',
        rules: [
          { field: 'timestamp', operation: 'normalize_timestamp' },
          {
            field: 'value',
            operation: 'format_number',
            parameters: { decimals: 4 },
          },
          { field: 'deviceId', operation: 'sanitize_string' },
        ],
        critical: false,
      },
      {
        name: 'Output Validation',
        type: 'output_validation',
        options: {
          allowFieldRemoval: false,
          allowDataLoss: false,
        },
        critical: true,
      },
    ],
  },

  // GraphQL query pipeline
  graphqlFlow: {
    name: 'GraphQL Query Flow',
    stages: [
      {
        name: 'Input Validation',
        type: 'input_validation',
        schema: 'graphqlInput',
        critical: true,
        options: {
          customValidation: data => {
            const errors = [];
            const warnings = [];

            // Query complexity analysis
            if (data.query) {
              const queryDepth = (data.query.match(/\{/g) || []).length;
              if (queryDepth > 10) {
                warnings.push({
                  field: 'query',
                  code: 'COMPLEX_QUERY',
                  message: `Query depth ${queryDepth} may impact performance`,
                });
              }

              // Check for potentially expensive operations
              const expensiveOps = ['nodes', 'edges', 'aggregate', 'search'];
              const hasExpensiveOp = expensiveOps.some(op =>
                data.query.includes(op)
              );
              if (hasExpensiveOp) {
                warnings.push({
                  field: 'query',
                  code: 'EXPENSIVE_OPERATION',
                  message: 'Query contains potentially expensive operations',
                });
              }
            }

            return { errors, warnings };
          },
        },
      },
      {
        name: 'Query Sanitization',
        type: 'transformation',
        rules: [
          { field: 'operationName', operation: 'sanitize_string' },
          { field: 'query', operation: 'sanitize_string' },
        ],
        critical: false,
      },
    ],
  },
};

/**
 * Request validation middleware
 */
function validateRequest(pipelineName) {
  return async (req, res, next) => {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    req.requestId = requestId;

    try {
      const pipeline = VALIDATION_PIPELINES[pipelineName];
      if (!pipeline) {
        logger.warn('Unknown validation pipeline', {
          pipelineName,
          requestId,
        });
        return next();
      }

      const startTime = Date.now();

      // Extract data based on HTTP method
      let dataToValidate;
      if (req.method === 'GET') {
        dataToValidate = req.query;
      } else {
        dataToValidate = req.body;
      }

      if (!dataToValidate || Object.keys(dataToValidate).length === 0) {
        logger.debug('No data to validate', {
          method: req.method,
          path: req.path,
          requestId,
        });
        return next();
      }

      // Run validation pipeline
      const validationResult = await dataFlowValidator.validateDataFlow(
        dataToValidate,
        pipeline
      );

      const validationTime = Date.now() - startTime;

      // Attach validation result to request
      req.validationResult = validationResult;
      req.validatedData = validationResult.finalData || dataToValidate;

      // Log validation results
      logger.info('Request validation completed', {
        requestId,
        pipeline: pipelineName,
        success: validationResult.success,
        errorCount: validationResult.errors.length,
        warningCount: validationResult.warnings.length,
        validationTime,
        path: req.path,
        method: req.method,
      });

      // Handle validation failures
      if (!validationResult.success) {
        const criticalErrors = validationResult.stages
          .filter(stage => !stage.success && stage.critical !== false)
          .map(stage => stage.errors)
          .flat();

        if (criticalErrors.length > 0) {
          logger.error('Critical validation errors', {
            requestId,
            errors: criticalErrors,
            pipeline: pipelineName,
          });

          return res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Request data validation failed',
              details: criticalErrors,
            },
            requestId,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Log warnings but continue
      if (validationResult.warnings.length > 0) {
        logger.warn('Validation warnings', {
          requestId,
          warnings: validationResult.warnings,
          pipeline: pipelineName,
        });
      }

      next();
    } catch (error) {
      logger.error('Request validation middleware error', {
        requestId,
        error: error.message,
        pipeline: pipelineName,
        path: req.path,
      });

      return res.status(500).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Internal validation error',
        },
        requestId,
        timestamp: new Date().toISOString(),
      });
    }
  };
}

/**
 * Response validation middleware
 */
function validateResponse(pipelineName, responseSchema = null) {
  return async (req, res, next) => {
    const originalSend = res.send;
    const requestId = req.requestId || crypto.randomUUID();

    res.send = async function (data) {
      try {
        if (!data) {
          return originalSend.call(this, data);
        }

        let responseData;
        try {
          responseData = typeof data === 'string' ? JSON.parse(data) : data;
        } catch (parseError) {
          // Not JSON data, skip validation
          return originalSend.call(this, data);
        }

        // Basic response structure validation
        const responseValidation = {
          valid: true,
          errors: [],
          warnings: [],
        };

        // Check for required response fields
        if (responseData.success === undefined) {
          responseValidation.warnings.push({
            field: 'success',
            code: 'MISSING_SUCCESS_FIELD',
            message: 'Response should include success field',
          });
        }

        // Validate error structure
        if (responseData.success === false && !responseData.error) {
          responseValidation.errors.push({
            field: 'error',
            code: 'MISSING_ERROR_DETAILS',
            message: 'Failed responses should include error details',
          });
        }

        // Validate timestamp
        if (!responseData.timestamp) {
          responseValidation.warnings.push({
            field: 'timestamp',
            code: 'MISSING_TIMESTAMP',
            message: 'Response should include timestamp',
          });
        }

        // Custom schema validation if provided
        if (responseSchema && responseData.data) {
          const schemaValidation = dataFlowValidator.validateInput(
            responseData.data,
            responseSchema
          );

          if (!schemaValidation.success) {
            responseValidation.errors.push(...schemaValidation.errors);
            responseValidation.valid = false;
          }
        }

        // Log response validation
        logger.debug('Response validation completed', {
          requestId,
          pipeline: pipelineName,
          valid: responseValidation.valid,
          errorCount: responseValidation.errors.length,
          warningCount: responseValidation.warnings.length,
          statusCode: res.statusCode,
        });

        if (!responseValidation.valid) {
          logger.error('Response validation failed', {
            requestId,
            errors: responseValidation.errors,
            path: req.path,
          });
        }

        // Add validation metadata to response
        if (responseData && typeof responseData === 'object') {
          responseData.metadata = {
            ...responseData.metadata,
            requestId,
            validationPassed: responseValidation.valid,
            timestamp: responseData.timestamp || new Date().toISOString(),
          };

          return originalSend.call(this, JSON.stringify(responseData));
        }

        return originalSend.call(this, data);
      } catch (error) {
        logger.error('Response validation middleware error', {
          requestId,
          error: error.message,
          pipeline: pipelineName,
        });

        return originalSend.call(this, data);
      }
    };

    next();
  };
}

/**
 * Data transformation middleware
 */
function transformData(transformationRules) {
  return async (req, res, next) => {
    const requestId = req.requestId || crypto.randomUUID();

    try {
      if (!req.body || Object.keys(req.body).length === 0) {
        return next();
      }

      const transformationResult = dataFlowValidator.transformData(
        req.body,
        transformationRules
      );

      if (transformationResult.success) {
        req.body = transformationResult.data;
        req.transformationResult = transformationResult;

        logger.debug('Data transformation completed', {
          requestId,
          transformationCount: transformationResult.transformations.length,
          path: req.path,
        });
      } else {
        logger.error('Data transformation failed', {
          requestId,
          errors: transformationResult.errors,
          path: req.path,
        });
      }

      next();
    } catch (error) {
      logger.error('Data transformation middleware error', {
        requestId,
        error: error.message,
        path: req.path,
      });
      next();
    }
  };
}

/**
 * Validation statistics middleware
 */
function validationStats() {
  return (req, res, next) => {
    // Add validation statistics to request context
    req.validationStats = dataFlowValidator.getStatistics();
    next();
  };
}

module.exports = {
  validateRequest,
  validateResponse,
  transformData,
  validationStats,
  VALIDATION_PIPELINES,
  dataFlowValidator,
};
