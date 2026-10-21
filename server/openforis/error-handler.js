/**
 * OpenForis API Error Handler
 *
 * Comprehensive error handling for OpenForis API validation failures
 * and external API communication errors.
 */

const { validationResult } = require('express-validator');
const createLogger = require('../utils/logger');

const LOG_PREFIX = 'openforis:error-handler';
const logger = createLogger(LOG_PREFIX);

/**
 * OpenForis validation error handler
 */
class OpenForisErrorHandler {
  /**
   * Handle express-validator validation errors
   */
  static handleValidationErrors(req, res, next) {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      const errorDetails = errors.array().map(error => ({
        field: error.param || error.path,
        message: error.msg,
        value: error.value,
        location: error.location,
      }));

      // Log validation failure for monitoring
      logger.warn(`${LOG_PREFIX} Validation failed`, {
        endpoint: req.path,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        errors: errorDetails,
        timestamp: new Date().toISOString(),
      });

      return res.status(400).json({
        success: false,
        error: 'OpenForis API validation failed',
        code: 'VALIDATION_ERROR',
        details: errorDetails,
        timestamp: new Date().toISOString(),
        requestId: req.id || 'unknown',
      });
    }

    next();
  }

  /**
   * Handle OpenForis API communication errors
   */
  static handleApiErrors(error, req, res, next) {
    logger.error(`${LOG_PREFIX} OpenForis API error`, {
      error: error.message,
      stack: error.stack,
      endpoint: req?.path,
      method: req?.method,
      timestamp: new Date().toISOString(),
    });

    // Handle different types of API errors
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({
        success: false,
        error: 'OpenForis API service unavailable',
        code: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to OpenForis API. Please try again later.',
        timestamp: new Date().toISOString(),
      });
    }

    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      return res.status(504).json({
        success: false,
        error: 'OpenForis API request timeout',
        code: 'REQUEST_TIMEOUT',
        message: 'OpenForis API request took too long to respond.',
        timestamp: new Date().toISOString(),
      });
    }

    // Handle HTTP response errors
    if (error.response) {
      const status = error.response.status;
      const statusText = error.response.statusText;
      const responseData = error.response.data;

      switch (status) {
        case 400:
          return res.status(400).json({
            success: false,
            error: 'Invalid request to OpenForis API',
            code: 'BAD_REQUEST',
            message:
              responseData?.message || 'The request was malformed or invalid.',
            details: responseData?.errors || [],
            timestamp: new Date().toISOString(),
          });

        case 401:
          return res.status(401).json({
            success: false,
            error: 'OpenForis API authentication failed',
            code: 'AUTHENTICATION_FAILED',
            message: 'API key is invalid or has expired.',
            timestamp: new Date().toISOString(),
          });

        case 403:
          return res.status(403).json({
            success: false,
            error: 'OpenForis API access forbidden',
            code: 'ACCESS_FORBIDDEN',
            message: 'API key does not have permission for this operation.',
            timestamp: new Date().toISOString(),
          });

        case 404:
          return res.status(404).json({
            success: false,
            error: 'OpenForis API resource not found',
            code: 'RESOURCE_NOT_FOUND',
            message: 'The requested resource was not found.',
            timestamp: new Date().toISOString(),
          });

        case 422:
          return res.status(422).json({
            success: false,
            error: 'OpenForis API data validation failed',
            code: 'DATA_VALIDATION_ERROR',
            message: 'The provided data failed OpenForis API validation.',
            details: responseData?.errors || [],
            timestamp: new Date().toISOString(),
          });

        case 429:
          return res.status(429).json({
            success: false,
            error: 'OpenForis API rate limit exceeded',
            code: 'RATE_LIMIT_EXCEEDED',
            message:
              'Too many requests to OpenForis API. Please try again later.',
            retryAfter: error.response.headers['retry-after'] || 60,
            timestamp: new Date().toISOString(),
          });

        case 500:
          return res.status(502).json({
            success: false,
            error: 'OpenForis API internal error',
            code: 'UPSTREAM_ERROR',
            message: 'OpenForis API encountered an internal error.',
            timestamp: new Date().toISOString(),
          });

        case 502:
        case 503:
        case 504:
          return res.status(503).json({
            success: false,
            error: 'OpenForis API service unavailable',
            code: 'SERVICE_UNAVAILABLE',
            message: `OpenForis API is temporarily unavailable (${status} ${statusText}).`,
            timestamp: new Date().toISOString(),
          });

        default:
          return res.status(502).json({
            success: false,
            error: 'OpenForis API error',
            code: 'UPSTREAM_ERROR',
            message: `OpenForis API returned an error (${status} ${statusText}).`,
            timestamp: new Date().toISOString(),
          });
      }
    }

    // Handle generic errors
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      message:
        'An unexpected error occurred while processing the OpenForis API request.',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle data validation errors for responses
   */
  static handleResponseValidationError(data, dataType, errors) {
    const error = new Error(
      `OpenForis API response validation failed for ${dataType}`
    );
    error.code = 'RESPONSE_VALIDATION_ERROR';
    error.details = errors;
    error.data = data;
    return error;
  }

  /**
   * Validate and handle API response data
   */
  static validateApiResponse(data, validationFn, dataType) {
    try {
      const errors = validationFn(data);

      if (errors.length > 0) {
        logger.error(`${LOG_PREFIX} Response validation failed`, {
          dataType,
          errors,
          data: JSON.stringify(data, null, 2),
          timestamp: new Date().toISOString(),
        });

        throw this.handleResponseValidationError(data, dataType, errors);
      }

      return data;
    } catch (error) {
      if (error.code === 'RESPONSE_VALIDATION_ERROR') {
        throw error;
      }

      // Handle unexpected validation errors
      logger.error(`${LOG_PREFIX} Unexpected validation error`, {
        error: error.message,
        stack: error.stack,
        dataType,
        timestamp: new Date().toISOString(),
      });

      const validationError = new Error(
        `Unexpected error during ${dataType} validation`
      );
      validationError.code = 'VALIDATION_ERROR';
      validationError.originalError = error;
      throw validationError;
    }
  }

  /**
   * Create a sanitized error response for client
   */
  static createSanitizedError(error, includeDetails = false) {
    const sanitized = {
      success: false,
      error: error.message || 'An error occurred',
      code: error.code || 'UNKNOWN_ERROR',
      timestamp: new Date().toISOString(),
    };

    // Include additional details in development or if explicitly requested
    if (includeDetails || process.env.NODE_ENV === 'development') {
      if (error.details) {
        sanitized.details = error.details;
      }

      if (error.originalError) {
        sanitized.originalError = error.originalError.message;
      }
    }

    return sanitized;
  }

  /**
   * Wrap async functions to handle errors consistently
   */
  static asyncErrorHandler(fn) {
    return (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  /**
   * Log successful operations for monitoring
   */
  static logSuccess(operation, details = {}) {
    logger.info(`${LOG_PREFIX} ${operation} successful`, {
      ...details,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Check if error is retryable
   */
  static isRetryableError(error) {
    const retryableCodes = [
      'ETIMEDOUT',
      'ECONNABORTED',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
    ];

    const retryableHttpStatuses = [408, 429, 502, 503, 504];

    return (
      retryableCodes.includes(error.code) ||
      (error.response && retryableHttpStatuses.includes(error.response.status))
    );
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  static calculateRetryDelay(attempt, baseDelay = 1000) {
    const maxDelay = 30000; // 30 seconds
    const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    // Add jitter to prevent thundering herd
    return delay + Math.random() * 1000;
  }
}

module.exports = OpenForisErrorHandler;
