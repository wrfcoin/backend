/**
 * OpenForis Integration Adapter for Wrfcoin
 *
 * This adapter provides an interface to interact with OpenForis ecosystem tools:
 * - Collect Earth: For land use monitoring and data collection
 * - Earth Map: For time-series analysis of satellite imagery
 * - Climate Data: For enhanced climate simulations and projections
 */

const crypto = require('crypto');
const axios = require('axios');
const createLogger = require('../utils/logger');
const { OpenForisTransformer } = require('../utils/openforis-transformer');
const { openForisCacheManager } = require('../utils/openforis-cache');

// Constants
const LOG_PREFIX = 'openforis:adapter';

// Create a logger instance
const logger = createLogger(LOG_PREFIX);

/**
 * OpenForis Adapter for Wrfcoin integration
 */
class OpenForisAdapter {
  constructor(options = {}) {
    this.initialized = false;

    // Use test mode if specified in options or environment
    this.testMode =
      options.testMode || process.env.OPENFORIS_TEST_MODE === 'true';

    // OpenForis API endpoints
    this.endpoints = {
      collectEarth:
        options.collectEarthEndpoint ||
        process.env.OPENFORIS_COLLECT_EARTH_ENDPOINT ||
        'https://api.collect.earth',
      earthMap:
        options.earthMapEndpoint ||
        process.env.OPENFORIS_EARTH_MAP_ENDPOINT ||
        'https://api.earthmap.org',
      climateData:
        options.climateDataEndpoint ||
        process.env.OPENFORIS_CLIMATE_DATA_ENDPOINT ||
        'https://api.climatedata.openforis.org',
    };

    // API authentication
    this.apiKey = process.env.OPENFORIS_API_KEY;
    this.apiTimeout = parseInt(process.env.OPENFORIS_API_TIMEOUT, 10) || 30000;

    // Initialize data transformer
    this.transformer = new OpenForisTransformer();

    // Initialize cache manager
    this.cacheManager = openForisCacheManager;

    // In-memory cache for test mode and fallback
    this.cache = {
      projects: new Map(),
      plots: new Map(),
      timeSeries: new Map(),
      climateData: new Map(),
    };

    logger.info(`${LOG_PREFIX} Creating OpenForis adapter`, {
      testMode: this.testMode,
      endpoints: this.endpoints,
      cacheEnabled: true,
    });
  }

  /**
   * Initialize the adapter
   */
  async initialize() {
    if (this.initialized) {
      logger.info(`${LOG_PREFIX} OpenForis adapter already initialized`);
      return;
    }

    try {
      logger.info(`${LOG_PREFIX} Initializing OpenForis adapter`);

      if (this.testMode) {
        await this.initializeTestMode();
      } else {
        await this.connect();
      }

      this.initialized = true;
      logger.info(`${LOG_PREFIX} OpenForis adapter initialized successfully`);
      return true;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to initialize OpenForis adapter`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Initialize adapter in test mode
   */
  async initializeTestMode() {
    logger.info(
      `${LOG_PREFIX} Operating in test mode, using mock implementation`
    );

    // Create mock projects
    await this.createMockProjects();

    // Create mock plots
    await this.createMockPlots();

    // Create mock time series data
    await this.createMockTimeSeries();

    // Create mock climate data
    await this.createMockClimateData();

    logger.info(`${LOG_PREFIX} Test mode initialization complete`, {
      projectCount: this.cache.projects.size,
      plotCount: this.cache.plots.size,
      timeSeriesCount: this.cache.timeSeries.size,
      climateDataCount: this.cache.climateData.size,
    });
  }

  /**
   * Connect to OpenForis APIs
   */
  async connect() {
    logger.info(`${LOG_PREFIX} Connecting to OpenForis APIs`);

    try {
      // Validate API endpoints
      await this.validateEndpoints();

      logger.info(`${LOG_PREFIX} Connected to OpenForis APIs successfully`);
      return true;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to connect to OpenForis APIs`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Validate API endpoints
   */
  async validateEndpoints() {
    if (this.testMode) {
      logger.info(`${LOG_PREFIX} Skipping endpoint validation in test mode`);
      return true;
    }

    // Import validation utilities
    const {
      validateApiKey,
      validateEndpointUrl,
    } = require('./validation-schemas');
    const OpenForisErrorHandler = require('./error-handler');
    const axios = require('axios');

    try {
      // Enhanced production validation implementation
      logger.info(
        `${LOG_PREFIX} Starting comprehensive production API validation`
      );

      // Step 1: Validate API key from environment with enhanced security checks
      const apiKey = process.env.OPENFORIS_API_KEY;

      if (!apiKey) {
        throw new Error('OpenForis API key not configured in environment');
      }

      // Validate API key format and security requirements
      validateApiKey(apiKey);

      // Additional security validation for production
      if (process.env.NODE_ENV === 'production') {
        // Check for test keys in production
        if (
          apiKey.includes('test') ||
          apiKey.includes('dev') ||
          apiKey.includes('staging')
        ) {
          throw new Error(
            'Test or development API keys cannot be used in production'
          );
        }

        // Validate API key entropy (basic check for randomness)
        const uniqueChars = new Set(apiKey.replace(/[^a-zA-Z0-9]/g, '')).size;
        if (uniqueChars < 16) {
          logger.warn(
            `${LOG_PREFIX} API key appears to have low entropy (${uniqueChars} unique characters)`
          );
        }
      }

      logger.info(`${LOG_PREFIX} API key validation passed`);

      // Step 2: Validate all endpoint URLs with enhanced security checks
      const endpointValidationResults = [];

      for (const [name, url] of Object.entries(this.endpoints)) {
        try {
          // Basic URL format validation
          validateEndpointUrl(url);

          // Additional production-specific URL validation
          if (process.env.NODE_ENV === 'production') {
            const parsedUrl = new URL(url);

            // Ensure HTTPS is used
            if (parsedUrl.protocol !== 'https:') {
              throw new Error('All endpoints must use HTTPS in production');
            }

            // Validate domain allowlist if configured
            const allowedDomains =
              process.env.OPENFORIS_ALLOWED_DOMAINS?.split(',') || [];
            if (allowedDomains.length > 0) {
              const isAllowed = allowedDomains.some(domain =>
                parsedUrl.hostname.endsWith(domain.trim())
              );
              if (!isAllowed) {
                throw new Error(
                  `Domain ${parsedUrl.hostname} is not in allowed domains list`
                );
              }
            }

            // Check for suspicious ports
            const suspiciousPorts = [
              '22',
              '23',
              '25',
              '53',
              '110',
              '143',
              '993',
              '995',
            ];
            if (parsedUrl.port && suspiciousPorts.includes(parsedUrl.port)) {
              logger.warn(
                `${LOG_PREFIX} Endpoint ${name} using suspicious port ${parsedUrl.port}`
              );
            }
          }

          logger.info(`${LOG_PREFIX} Endpoint ${name} URL validation passed`, {
            url: url,
            hostname: new URL(url).hostname,
          });

          endpointValidationResults.push({
            name,
            url,
            status: 'url_valid',
          });
        } catch (error) {
          logger.error(`${LOG_PREFIX} Endpoint ${name} URL validation failed`, {
            url: url,
            error: error.message,
          });
          throw new Error(`Invalid ${name} endpoint URL: ${error.message}`);
        }
      }

      // Step 3: Test API connectivity and authentication for each endpoint
      logger.info(
        `${LOG_PREFIX} Testing API connectivity and authentication for ${endpointValidationResults.length} endpoints`
      );

      const connectivityPromises = endpointValidationResults.map(
        async ({ name, url }) => {
          try {
            logger.info(
              `${LOG_PREFIX} Testing connectivity for ${name} endpoint`
            );

            // Enhanced validation request with comprehensive error handling
            const validationResponse = await this.makeValidationRequest(
              url,
              apiKey
            );

            // Validate response structure and content
            if (!validationResponse || typeof validationResponse !== 'object') {
              throw new Error(
                `Invalid response structure from ${name} endpoint`
              );
            }

            const { status, data, headers } = validationResponse;

            // Check HTTP status
            if (status < 200 || status >= 300) {
              throw new Error(`HTTP ${status} response from ${name} endpoint`);
            }

            // Validate response data structure
            if (!data || typeof data !== 'object') {
              throw new Error(`Invalid response data from ${name} endpoint`);
            }

            // Check for valid authentication response
            if (
              data.valid !== true &&
              data.authenticated !== true &&
              !data.success
            ) {
              const errorMsg =
                data.message ||
                data.error ||
                'Authentication validation failed';
              throw new Error(
                `Authentication validation failed for ${name} endpoint: ${errorMsg}`
              );
            }

            // Additional production security checks
            if (process.env.NODE_ENV === 'production') {
              // Check for security headers
              const securityHeaders = [
                'strict-transport-security',
                'x-content-type-options',
                'x-frame-options',
              ];

              const missingHeaders = securityHeaders.filter(
                header => !headers || !headers[header]
              );

              if (missingHeaders.length > 0) {
                logger.warn(
                  `${LOG_PREFIX} ${name} endpoint missing security headers`,
                  {
                    missingHeaders,
                  }
                );
              }

              // Validate API version compatibility if provided
              if (data.version || data.api_version) {
                const apiVersion = data.version || data.api_version;
                logger.info(
                  `${LOG_PREFIX} ${name} endpoint API version: ${apiVersion}`
                );

                // Check for deprecated API versions
                const deprecatedVersions = ['v1.0', '1.0', 'beta', 'alpha'];
                if (
                  deprecatedVersions.some(v =>
                    apiVersion.toLowerCase().includes(v)
                  )
                ) {
                  logger.warn(
                    `${LOG_PREFIX} ${name} endpoint using potentially deprecated API version: ${apiVersion}`
                  );
                }
              }

              // Check rate limiting information
              if (headers && headers['x-ratelimit-limit']) {
                const rateLimit = parseInt(headers['x-ratelimit-limit']);
                const remaining = parseInt(
                  headers['x-ratelimit-remaining'] || rateLimit
                );

                logger.info(`${LOG_PREFIX} ${name} endpoint rate limit info`, {
                  limit: rateLimit,
                  remaining: remaining,
                  percentage: Math.round((remaining / rateLimit) * 100),
                });

                if (remaining < rateLimit * 0.1) {
                  logger.warn(
                    `${LOG_PREFIX} ${name} endpoint rate limit nearly exhausted`,
                    {
                      remaining,
                      limit: rateLimit,
                    }
                  );
                }
              }
            }

            logger.info(
              `${LOG_PREFIX} ${name} endpoint validation successful`,
              {
                responseTime: validationResponse.responseTime || 'unknown',
                apiVersion: data.version || data.api_version || 'unknown',
              }
            );

            return {
              endpoint: name,
              status: 'valid',
              url: url,
              responseTime: validationResponse.responseTime,
              apiVersion: data.version || data.api_version,
            };
          } catch (error) {
            logger.error(`${LOG_PREFIX} ${name} endpoint validation failed`, {
              error: error.message,
              url: url,
              stack: error.stack,
            });

            // Enhanced retry logic for production
            if (OpenForisErrorHandler.isRetryableError(error)) {
              logger.warn(
                `${LOG_PREFIX} Retryable error for ${name} endpoint, will schedule retry`
              );
              return {
                endpoint: name,
                status: 'retry',
                error: error.message,
                url: url,
                retryable: true,
              };
            }

            // Log specific error types for monitoring
            if (error.code === 'ENOTFOUND') {
              logger.error(
                `${LOG_PREFIX} DNS resolution failed for ${name} endpoint`
              );
            } else if (error.code === 'ECONNREFUSED') {
              logger.error(
                `${LOG_PREFIX} Connection refused by ${name} endpoint`
              );
            } else if (error.code === 'ETIMEDOUT') {
              logger.error(
                `${LOG_PREFIX} Connection timeout to ${name} endpoint`
              );
            }

            throw new Error(
              `${name} endpoint validation failed: ${error.message}`
            );
          }
        }
      );

      // Step 4: Wait for all endpoint validations with comprehensive error handling
      logger.info(`${LOG_PREFIX} Waiting for all endpoint validation results`);
      const results = await Promise.allSettled(connectivityPromises);

      // Analyze results
      const successful = results
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);

      const failed = results
        .filter(result => result.status === 'rejected')
        .map(result => ({
          error: result.reason.message,
          reason: result.reason,
        }));

      // Handle complete failures
      if (failed.length > 0) {
        const errorMessages = failed.map(f => f.error);
        logger.error(`${LOG_PREFIX} Endpoint validation failures`, {
          failedCount: failed.length,
          totalCount: results.length,
          errors: errorMessages,
        });
        throw new Error(
          `Endpoint validation failed for ${failed.length} endpoints: ${errorMessages.join('; ')}`
        );
      }

      // Handle retry-needed endpoints
      const retryNeeded = successful.filter(
        result => result.status === 'retry'
      );
      const validEndpoints = successful.filter(
        result => result.status === 'valid'
      );

      if (retryNeeded.length > 0) {
        logger.warn(`${LOG_PREFIX} Some endpoints need retry`, {
          retryCount: retryNeeded.length,
          validCount: validEndpoints.length,
          retryEndpoints: retryNeeded.map(r => ({
            endpoint: r.endpoint,
            error: r.error,
          })),
        });

        // Schedule intelligent retry with exponential backoff
        setTimeout(() => this.retryEndpointValidation(retryNeeded), 5000);
      }

      // Step 5: Final validation summary
      const validationSummary = {
        totalEndpoints: Object.keys(this.endpoints).length,
        validatedEndpoints: validEndpoints.length,
        retryPendingEndpoints: retryNeeded.length,
        failedEndpoints: failed.length,
        validationTime: Date.now(),
      };

      logger.info(
        `${LOG_PREFIX} OpenForis API validation completed successfully`,
        validationSummary
      );

      // Store validation results for monitoring
      this.lastValidationResult = {
        ...validationSummary,
        endpoints: validEndpoints,
        timestamp: new Date().toISOString(),
      };

      return true;
    } catch (error) {
      logger.error(`${LOG_PREFIX} OpenForis endpoint validation failed`, {
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      });

      // Store failed validation for monitoring
      this.lastValidationResult = {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };

      throw error;
    }
  }

  /**
   * Make validation request to OpenForis API
   */
  async makeValidationRequest(baseUrl, apiKey, retryCount = 0) {
    const axios = require('axios');
    const OpenForisErrorHandler = require('./error-handler');
    const maxRetries = 3;
    const startTime = Date.now();

    try {
      logger.debug(`${LOG_PREFIX} Making validation request to ${baseUrl}`, {
        attempt: retryCount + 1,
        maxRetries: maxRetries + 1,
      });

      // Enhanced request configuration for production validation
      const requestConfig = {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'WRFCoin-Platform/1.0',
          'X-Request-ID': `wrfc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          'X-Client-Version': '1.0.0',
        },
        timeout: process.env.NODE_ENV === 'production' ? 15000 : 10000, // Longer timeout in production
        validateStatus: status => status < 500, // Don't throw on 4xx errors
        maxRedirects: 3, // Limit redirects for security
        // Enhanced security options
        httpsAgent:
          process.env.NODE_ENV === 'production'
            ? new (require('https').Agent)({
                rejectUnauthorized: true, // Enforce SSL certificate validation
                checkServerIdentity: (hostname, cert) => {
                  // Additional hostname verification in production
                  if (
                    cert.subject.CN !== hostname &&
                    !cert.subjectaltname?.includes(`DNS:${hostname}`)
                  ) {
                    logger.warn(
                      `${LOG_PREFIX} SSL certificate hostname mismatch`,
                      {
                        expected: hostname,
                        actual: cert.subject.CN,
                        altNames: cert.subjectaltname,
                      }
                    );
                  }
                  return undefined; // Continue with default validation
                },
              })
            : undefined,
      };

      // Add request interceptor for detailed logging in production
      if (process.env.NODE_ENV === 'production') {
        const requestStartTime = Date.now();

        // Log outbound request details
        logger.info(`${LOG_PREFIX} Outbound validation request`, {
          url: `${baseUrl}/auth/validate`,
          requestId: requestConfig.headers['X-Request-ID'],
          timeout: requestConfig.timeout,
          attempt: retryCount + 1,
        });
      }

      const response = await axios.get(
        `${baseUrl}/auth/validate`,
        requestConfig
      );
      const responseTime = Date.now() - startTime;

      // Enhanced response validation and logging
      if (response) {
        // Add response time to response object
        response.responseTime = responseTime;

        // Log successful response details
        logger.debug(`${LOG_PREFIX} Validation request successful`, {
          url: baseUrl,
          status: response.status,
          responseTime: responseTime,
          requestId: requestConfig.headers['X-Request-ID'],
          hasData: !!response.data,
          dataKeys: response.data ? Object.keys(response.data) : [],
        });

        // Enhanced response validation for production
        if (process.env.NODE_ENV === 'production') {
          // Check response headers for security indicators
          const securityHeaders = response.headers || {};
          const securityChecks = {
            hasSecurityHeaders: !!(
              securityHeaders['strict-transport-security'] ||
              securityHeaders['x-content-type-options'] ||
              securityHeaders['x-frame-options']
            ),
            hasRateLimitHeaders: !!(
              securityHeaders['x-ratelimit-limit'] ||
              securityHeaders['x-ratelimit-remaining']
            ),
            contentType: securityHeaders['content-type'],
            serverHeader: securityHeaders['server'],
          };

          logger.debug(`${LOG_PREFIX} Response security analysis`, {
            url: baseUrl,
            securityChecks,
            responseTime,
          });

          // Validate content type
          if (
            securityChecks.contentType &&
            !securityChecks.contentType.includes('application/json')
          ) {
            logger.warn(
              `${LOG_PREFIX} Unexpected content type in validation response`,
              {
                expected: 'application/json',
                actual: securityChecks.contentType,
                url: baseUrl,
              }
            );
          }

          // Check for information disclosure in server header
          if (securityChecks.serverHeader) {
            const sensitivePatterns = [
              /apache\/[\d.]+/i,
              /nginx\/[\d.]+/i,
              /iis\/[\d.]+/i,
              /php\/[\d.]+/i,
            ];

            if (
              sensitivePatterns.some(pattern =>
                pattern.test(securityChecks.serverHeader)
              )
            ) {
              logger.warn(
                `${LOG_PREFIX} Server header may contain version information`,
                {
                  serverHeader: securityChecks.serverHeader,
                  url: baseUrl,
                }
              );
            }
          }
        }

        // Additional data structure validation
        if (response.data && typeof response.data === 'object') {
          const requiredResponseFields = ['valid', 'authenticated', 'success'];
          const hasValidationField = requiredResponseFields.some(field =>
            response.data.hasOwnProperty(field)
          );

          if (!hasValidationField) {
            logger.warn(
              `${LOG_PREFIX} Validation response missing expected fields`,
              {
                url: baseUrl,
                responseData: JSON.stringify(response.data),
                expectedFields: requiredResponseFields,
              }
            );
          }
        }
      }

      return response;
    } catch (error) {
      const responseTime = Date.now() - startTime;

      // Enhanced error logging and handling
      logger.error(`${LOG_PREFIX} Validation request failed`, {
        url: baseUrl,
        attempt: retryCount + 1,
        maxRetries: maxRetries + 1,
        responseTime,
        errorCode: error.code,
        errorMessage: error.message,
        httpStatus: error.response?.status,
        httpStatusText: error.response?.statusText,
      });

      // Check if error is retryable
      if (
        retryCount < maxRetries &&
        OpenForisErrorHandler.isRetryableError(error)
      ) {
        const delay = OpenForisErrorHandler.calculateRetryDelay(retryCount);

        logger.warn(`${LOG_PREFIX} Retrying validation request`, {
          url: baseUrl,
          attempt: retryCount + 1,
          maxRetries: maxRetries + 1,
          delay,
          error: error.message,
          isRetryable: true,
        });

        // Add exponential backoff with jitter
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.makeValidationRequest(baseUrl, apiKey, retryCount + 1);
      }

      // Add response time to error for monitoring
      error.responseTime = responseTime;
      error.attempt = retryCount + 1;
      error.url = baseUrl;

      // Enhanced error classification
      if (error.code === 'ENOTFOUND') {
        error.errorType = 'DNS_RESOLUTION_FAILED';
        error.userMessage = 'Unable to resolve OpenForis API hostname';
      } else if (error.code === 'ECONNREFUSED') {
        error.errorType = 'CONNECTION_REFUSED';
        error.userMessage = 'OpenForis API server refused connection';
      } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        error.errorType = 'REQUEST_TIMEOUT';
        error.userMessage = 'OpenForis API request timed out';
      } else if (error.response?.status === 401) {
        error.errorType = 'AUTHENTICATION_FAILED';
        error.userMessage = 'API key authentication failed';
      } else if (error.response?.status === 403) {
        error.errorType = 'AUTHORIZATION_FAILED';
        error.userMessage = 'API key lacks required permissions';
      } else if (error.response?.status >= 500) {
        error.errorType = 'SERVER_ERROR';
        error.userMessage = 'OpenForis API server error';
      } else {
        error.errorType = 'UNKNOWN_ERROR';
        error.userMessage = 'Unknown error occurred during validation';
      }

      logger.error(`${LOG_PREFIX} Final validation request failure`, {
        url: baseUrl,
        errorType: error.errorType,
        userMessage: error.userMessage,
        totalAttempts: retryCount + 1,
        totalResponseTime: responseTime,
      });

      throw error;
    }
  }

  /**
   * Retry endpoint validation for failed endpoints
   */
  async retryEndpointValidation(retryEndpoints) {
    const apiKey = process.env.OPENFORIS_API_KEY;

    for (const { endpoint } of retryEndpoints) {
      try {
        const url = this.endpoints[endpoint];
        const response = await this.makeValidationRequest(url, apiKey);

        if (response.status === 200 && response.data.valid) {
          logger.info(
            `${LOG_PREFIX} Retry successful for ${endpoint} endpoint`
          );
        } else {
          logger.error(`${LOG_PREFIX} Retry failed for ${endpoint} endpoint`);
        }
      } catch (error) {
        logger.error(`${LOG_PREFIX} Retry error for ${endpoint} endpoint`, {
          error: error.message,
        });
      }
    }
  }

  /**
   * Make authenticated API request with validation and error handling
   */
  async makeApiRequest(method, url, data = null, options = {}) {
    const axios = require('axios');
    const OpenForisErrorHandler = require('./error-handler');
    const { validateApiKey } = require('./validation-schemas');
    const crypto = require('crypto');

    const startTime = Date.now();

    // Enhanced API key validation
    const apiKey = process.env.OPENFORIS_API_KEY;
    if (!apiKey) {
      throw new Error('OpenForis API key not configured in environment');
    }

    try {
      validateApiKey(apiKey);
    } catch (error) {
      logger.error(`${LOG_PREFIX} API key validation failed`, {
        error: error.message,
      });
      throw new Error(`Invalid API key configuration: ${error.message}`);
    }

    // Generate unique request ID for tracking
    const requestId = `wrfc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    // Enhanced request configuration with security features
    const config = {
      method: method.toLowerCase(),
      url,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'WRFCoin-Platform/1.0',
        'X-Request-ID': requestId,
        'X-Client-Version': '1.0.0',
        'X-Platform': 'WRFCoin-Weather-Blockchain',
        ...options.headers,
      },
      timeout:
        options.timeout ||
        (process.env.NODE_ENV === 'production' ? 45000 : 30000),
      validateStatus: status => status < 500, // Don't throw on 4xx errors
      maxRedirects: options.maxRedirects || 3,
      // Enhanced security configuration
      httpsAgent:
        process.env.NODE_ENV === 'production'
          ? new (require('https').Agent)({
              rejectUnauthorized: true,
              minVersion: 'TLSv1.2', // Minimum TLS version
              ciphers:
                'ECDHE+AESGCM:ECDHE+CHACHA20:DHE+AESGCM:DHE+CHACHA20:!aNULL:!MD5:!DSS',
            })
          : undefined,
      ...options,
    };

    // Input validation and sanitization
    if (data) {
      try {
        // Validate data is serializable JSON
        const serializedData = JSON.stringify(data);

        // Check for suspicious content in production
        if (process.env.NODE_ENV === 'production') {
          const suspiciousPatterns = [
            /<script[^>]*>/i,
            /javascript:/i,
            /vbscript:/i,
            /on\w+\s*=/i,
            /eval\s*\(/i,
            /function\s*\(/i,
          ];

          if (
            suspiciousPatterns.some(pattern => pattern.test(serializedData))
          ) {
            logger.warn(
              `${LOG_PREFIX} Potentially suspicious content detected in request data`,
              {
                requestId,
                method: method.toUpperCase(),
                url,
                dataSize: serializedData.length,
              }
            );
          }
        }

        config.data = data;

        // Add content length and hash for integrity checking
        config.headers['Content-Length'] = Buffer.byteLength(
          serializedData,
          'utf8'
        );
        config.headers['X-Content-Hash'] = crypto
          .createHash('sha256')
          .update(serializedData)
          .digest('hex');
      } catch (error) {
        logger.error(`${LOG_PREFIX} Request data serialization failed`, {
          requestId,
          error: error.message,
          dataType: typeof data,
        });
        throw new Error('Invalid request data: cannot serialize to JSON');
      }
    }

    const maxRetries = options.maxRetries || 3;
    let retryCount = 0;

    // Request attempt loop with enhanced error handling
    while (retryCount <= maxRetries) {
      const attemptStartTime = Date.now();

      try {
        logger.info(`${LOG_PREFIX} Making API request`, {
          requestId,
          method: method.toUpperCase(),
          url,
          attempt: retryCount + 1,
          maxRetries: maxRetries + 1,
          hasData: !!data,
          dataSize: data ? JSON.stringify(data).length : 0,
          timeout: config.timeout,
        });

        const response = await axios(config);
        const attemptResponseTime = Date.now() - attemptStartTime;
        const totalResponseTime = Date.now() - startTime;

        // Enhanced response validation
        if (!response) {
          throw new Error('No response received from OpenForis API');
        }

        // Add timing information to response
        response.timings = {
          attemptTime: attemptResponseTime,
          totalTime: totalResponseTime,
          attempts: retryCount + 1,
        };

        // Comprehensive response validation
        const { status, data: responseData, headers } = response;

        // Check for successful status codes
        if (status >= 200 && status < 300) {
          // Additional validation in production
          if (process.env.NODE_ENV === 'production') {
            // Validate response content type
            const contentType = headers['content-type'] || '';
            if (!contentType.includes('application/json') && responseData) {
              logger.warn(
                `${LOG_PREFIX} Unexpected content type in API response`,
                {
                  requestId,
                  expectedType: 'application/json',
                  actualType: contentType,
                  url,
                }
              );
            }

            // Check response size for potential issues
            const responseSize = JSON.stringify(responseData || {}).length;
            if (responseSize > 10 * 1024 * 1024) {
              // 10MB
              logger.warn(`${LOG_PREFIX} Large API response received`, {
                requestId,
                responseSize,
                url,
                method: method.toUpperCase(),
              });
            }

            // Validate response structure if expected schema is provided
            if (
              options.validateResponse &&
              typeof options.validateResponse === 'function'
            ) {
              try {
                const validationErrors = options.validateResponse(responseData);
                if (validationErrors && validationErrors.length > 0) {
                  logger.error(`${LOG_PREFIX} API response validation failed`, {
                    requestId,
                    url,
                    validationErrors,
                    method: method.toUpperCase(),
                  });

                  const validationError = new Error(
                    'API response validation failed'
                  );
                  validationError.code = 'RESPONSE_VALIDATION_ERROR';
                  validationError.validationErrors = validationErrors;
                  throw validationError;
                }
              } catch (validationError) {
                if (validationError.code === 'RESPONSE_VALIDATION_ERROR') {
                  throw validationError;
                }
                logger.warn(`${LOG_PREFIX} Response validation check failed`, {
                  requestId,
                  error: validationError.message,
                });
              }
            }
          }

          logger.info(`${LOG_PREFIX} API request successful`, {
            requestId,
            method: method.toUpperCase(),
            url,
            status,
            attemptResponseTime,
            totalResponseTime,
            attempts: retryCount + 1,
            responseSize: responseData
              ? JSON.stringify(responseData).length
              : 0,
          });

          return response;
        }

        // Handle non-2xx responses with detailed error information
        const errorDetails = {
          status,
          statusText: response.statusText,
          data: responseData,
          headers: Object.fromEntries(
            Object.entries(headers).filter(
              ([key]) =>
                !key.toLowerCase().includes('authorization') &&
                !key.toLowerCase().includes('cookie')
            )
          ),
        };

        logger.error(`${LOG_PREFIX} API request returned non-success status`, {
          requestId,
          method: method.toUpperCase(),
          url,
          errorDetails,
          attemptResponseTime,
          attempt: retryCount + 1,
        });

        const error = new Error(
          `OpenForis API returned status ${status}: ${response.statusText}`
        );
        error.response = response;
        error.requestId = requestId;
        error.statusCode = status;
        throw error;
      } catch (error) {
        const attemptResponseTime = Date.now() - attemptStartTime;

        // Enhanced error classification and logging
        const errorInfo = {
          requestId,
          method: method.toUpperCase(),
          url,
          attempt: retryCount + 1,
          maxRetries: maxRetries + 1,
          attemptResponseTime,
          errorCode: error.code,
          errorMessage: error.message,
          httpStatus: error.response?.status,
          httpStatusText: error.response?.statusText,
          isRetryable: OpenForisErrorHandler.isRetryableError(error),
        };

        // Determine if we should retry
        if (
          retryCount < maxRetries &&
          OpenForisErrorHandler.isRetryableError(error)
        ) {
          const delay = OpenForisErrorHandler.calculateRetryDelay(retryCount);

          logger.warn(`${LOG_PREFIX} API request failed, will retry`, {
            ...errorInfo,
            delay,
            nextAttempt: retryCount + 2,
          });

          retryCount++;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // Final failure - add comprehensive error context
        error.requestId = requestId;
        error.totalAttempts = retryCount + 1;
        error.totalResponseTime = Date.now() - startTime;
        error.url = url;
        error.method = method.toUpperCase();

        // Add user-friendly error messages
        if (error.code === 'ENOTFOUND') {
          error.userMessage = 'Unable to reach OpenForis API service';
        } else if (error.code === 'ETIMEDOUT') {
          error.userMessage = 'OpenForis API request timed out';
        } else if (error.response?.status === 401) {
          error.userMessage = 'OpenForis API authentication failed';
        } else if (error.response?.status === 403) {
          error.userMessage = 'OpenForis API access forbidden';
        } else if (error.response?.status === 429) {
          error.userMessage = 'OpenForis API rate limit exceeded';
        } else if (error.response?.status >= 500) {
          error.userMessage = 'OpenForis API server error';
        } else {
          error.userMessage = 'OpenForis API request failed';
        }

        logger.error(
          `${LOG_PREFIX} API request failed after all retry attempts`,
          {
            ...errorInfo,
            totalResponseTime: error.totalResponseTime,
            userMessage: error.userMessage,
            finalError: true,
          }
        );

        throw error;
      }
    }
  }

  /**
   * Create mock projects for testing
   */
  async createMockProjects() {
    const mockProjects = [
      {
        id: 'ce-project-' + crypto.randomUUID().slice(0, 8),
        name: 'Amazon Rainforest Monitoring',
        description:
          'Monitoring deforestation patterns in the Amazon rainforest',
        type: 'FOREST_MONITORING',
        region: 'South America',
        createdAt: new Date().toISOString(),
        status: 'ACTIVE',
        plotCount: 120,
        metadata: {
          forestType: 'Tropical rainforest',
          timespan: '2020-2025',
          collaborators: ['Research Institute A', 'NGO B', 'University C'],
        },
      },
      {
        id: 'ce-project-' + crypto.randomUUID().slice(0, 8),
        name: 'European Forest Carbon Assessment',
        description: 'Assessing carbon sequestration in European forests',
        type: 'CARBON_ASSESSMENT',
        region: 'Europe',
        createdAt: new Date().toISOString(),
        status: 'ACTIVE',
        plotCount: 85,
        metadata: {
          forestType: 'Mixed temperate',
          timespan: '2022-2025',
          collaborators: [
            'European Forest Institute',
            'University of Helsinki',
          ],
        },
      },
      {
        id: 'ce-project-' + crypto.randomUUID().slice(0, 8),
        name: 'African Savanna Land Use Change',
        description: 'Tracking land use changes in African savannas',
        type: 'LAND_USE_CHANGE',
        region: 'Africa',
        createdAt: new Date().toISOString(),
        status: 'ACTIVE',
        plotCount: 95,
        metadata: {
          forestType: 'Savanna woodland',
          timespan: '2021-2024',
          collaborators: [
            'African Conservation Trust',
            'University of Nairobi',
          ],
        },
      },
    ];

    for (const project of mockProjects) {
      this.cache.projects.set(project.id, project);
    }

    logger.info(`${LOG_PREFIX} Created ${mockProjects.length} mock projects`);
    return mockProjects;
  }

  /**
   * Create mock plots for testing
   */
  async createMockPlots() {
    const projects = Array.from(this.cache.projects.values());
    const mockPlots = [];

    for (const project of projects) {
      const plotCount = project.plotCount || 10;

      for (let i = 0; i < plotCount; i++) {
        const plotId = 'ce-plot-' + crypto.randomUUID().slice(0, 8);
        const plot = {
          id: plotId,
          projectId: project.id,
          name: `Plot ${i + 1} - ${project.name}`,
          coordinates: {
            latitude: Math.random() * 180 - 90,
            longitude: Math.random() * 360 - 180,
          },
          size: Math.floor(Math.random() * 500) + 100, // 100-600 hectares
          forestType: project.metadata?.forestType || 'Mixed',
          carbonStock: Math.floor(Math.random() * 300) + 50, // 50-350 tC/ha
          biodiversityIndex: Math.random() * 10, // 0-10 scale
          status: Math.random() > 0.1 ? 'VERIFIED' : 'PENDING',
          lastUpdated: new Date().toISOString(),
          metadata: {
            soilType: ['Sandy', 'Clay', 'Loam', 'Silt'][
              Math.floor(Math.random() * 4)
            ],
            elevation: Math.floor(Math.random() * 2000),
            precipitation: Math.floor(Math.random() * 2000) + 500, // 500-2500 mm
          },
        };

        mockPlots.push(plot);
        this.cache.plots.set(plotId, plot);
      }
    }

    logger.info(`${LOG_PREFIX} Created ${mockPlots.length} mock plots`);
    return mockPlots;
  }

  /**
   * Create mock time series data for testing
   */
  async createMockTimeSeries() {
    const plots = Array.from(this.cache.plots.values());
    const mockTimeSeries = [];

    for (const plot of plots) {
      const timeSeriesId = 'em-timeseries-' + crypto.randomUUID().slice(0, 8);

      // Generate monthly data points for the last 12 months
      const dataPoints = [];
      const now = new Date();
      for (let i = 0; i < 12; i++) {
        const date = new Date(now);
        date.setMonth(now.getMonth() - i);

        dataPoints.push({
          timestamp: date.toISOString(),
          ndvi: Math.random() * 0.6 + 0.2, // NDVI between 0.2 and 0.8
          precipitation: Math.random() * 100 + 20, // 20-120 mm
          temperature: Math.random() * 15 + 10, // 10-25 °C
          forestCover: Math.random() * 30 + 70, // 70-100 %
          forestLoss: Math.max(0, Math.random() * 5 - 4), // 0-1 % mostly 0
          soilMoisture: Math.random() * 40 + 10, // 10-50 %
        });
      }

      const timeSeries = {
        id: timeSeriesId,
        plotId: plot.id,
        projectId: plot.projectId,
        type: 'EARTH_MAP',
        startDate: dataPoints[dataPoints.length - 1].timestamp,
        endDate: dataPoints[0].timestamp,
        resolution: '30m',
        dataPoints: dataPoints,
        metadata: {
          source: 'Sentinel-2',
          processing: 'Level 2A',
          cloudCoverage: Math.random() * 30, // 0-30 %
        },
      };

      mockTimeSeries.push(timeSeries);
      this.cache.timeSeries.set(timeSeriesId, timeSeries);
    }

    logger.info(
      `${LOG_PREFIX} Created ${mockTimeSeries.length} mock time series datasets`
    );
    return mockTimeSeries;
  }

  /**
   * Create mock climate data for testing
   */
  async createMockClimateData() {
    const regions = [
      'Europe',
      'North America',
      'South America',
      'Africa',
      'Asia',
      'Oceania',
    ];
    const scenarios = ['RCP2.6', 'RCP4.5', 'RCP6.0', 'RCP8.5'];
    const variables = [
      'temperature',
      'precipitation',
      'humidity',
      'wind',
      'cloud_cover',
    ];
    const mockClimateData = [];

    for (const region of regions) {
      for (const scenario of scenarios) {
        const climateDataId = 'cd-dataset-' + crypto.randomUUID().slice(0, 8);

        // Generate yearly projections for 2025-2100
        const projections = [];
        for (let year = 2025; year <= 2100; year += 5) {
          const projection = {
            year,
            temperature:
              14 +
              (Math.random() * 2 - 0.5) +
              ((year - 2025) * 0.03 * scenarios.indexOf(scenario)) /
                scenarios.length,
            precipitation:
              800 +
              (Math.random() * 200 - 100) +
              ((year - 2025) * 1 * scenarios.indexOf(scenario)) /
                scenarios.length,
            extremeEvents:
              Math.floor(Math.random() * 5) +
              Math.floor(
                ((year - 2025) * 0.02 * scenarios.indexOf(scenario)) /
                  scenarios.length
              ),
          };
          projections.push(projection);
        }

        const climateData = {
          id: climateDataId,
          region,
          scenario,
          timeRange: '2025-2100',
          resolution: '50km',
          variables,
          projections,
          metadata: {
            model: ['CMIP6', 'CMIP5', 'ECMWF', 'NASA-GISS'][
              Math.floor(Math.random() * 4)
            ],
            uncertainty: Math.random() * 0.2 + 0.1, // 10-30%
            source: 'OpenForis Climate Data',
          },
        };

        mockClimateData.push(climateData);
        this.cache.climateData.set(climateDataId, climateData);
      }
    }

    logger.info(
      `${LOG_PREFIX} Created ${mockClimateData.length} mock climate datasets`
    );
    return mockClimateData;
  }

  /**
   * Get all projects
   * @returns {Array<Object>} List of projects
   */
  getAllProjects() {
    this.ensureInitialized();
    return Array.from(this.cache.projects.values());
  }

  /**
   * Get project by ID
   * @param {string} projectId Project ID
   * @returns {Object|null} Project information or null if not found
   */
  getProjectById(projectId) {
    this.ensureInitialized();
    return this.cache.projects.get(projectId) || null;
  }

  /**
   * Get plots for a project
   * @param {string} projectId Project ID
   * @returns {Array<Object>} List of plots
   */
  getPlotsByProject(projectId) {
    this.ensureInitialized();
    return Array.from(this.cache.plots.values()).filter(
      plot => plot.projectId === projectId
    );
  }

  /**
   * Get plot by ID
   * @param {string} plotId Plot ID
   * @returns {Object|null} Plot information or null if not found
   */
  getPlotById(plotId) {
    this.ensureInitialized();
    return this.cache.plots.get(plotId) || null;
  }

  /**
   * Get time series for a plot
   * @param {string} plotId Plot ID
   * @returns {Object|null} Time series data or null if not found
   */
  getTimeSeriesForPlot(plotId) {
    this.ensureInitialized();
    return (
      Array.from(this.cache.timeSeries.values()).find(
        ts => ts.plotId === plotId
      ) || null
    );
  }

  /**
   * Get climate data for a region and scenario
   * @param {string} region Region name
   * @param {string} scenario Climate scenario code
   * @returns {Object|null} Climate data or null if not found
   */
  getClimateData(region, scenario) {
    this.ensureInitialized();
    return (
      Array.from(this.cache.climateData.values()).find(
        data => data.region === region && data.scenario === scenario
      ) || null
    );
  }

  /**
   * Get all climate scenarios
   * @returns {Array<string>} List of climate scenarios
   */
  getClimateScenarios() {
    this.ensureInitialized();
    return [
      ...new Set(
        Array.from(this.cache.climateData.values()).map(data => data.scenario)
      ),
    ];
  }

  /**
   * Create a new collect earth project
   * @param {Object} projectData Project data
   * @returns {Object} Created project
   */
  async createCollectEarthProject(projectData) {
    this.ensureInitialized();

    if (!this.testMode) {
      // Production implementation for creating OpenForis Collect Earth projects
      if (!this.apiKey) {
        throw new Error('OpenForis API key not configured for production mode');
      }

      try {
        // Validate input data structure
        const requestData = {
          name: projectData.name,
          description: projectData.description || '',
          type: projectData.type || 'forest_monitoring',
          region: projectData.region || 'Unknown',
          metadata: projectData.metadata || {},
          survey_template: projectData.surveyTemplate || 'default',
          coordinate_system: projectData.coordinateSystem || 'WGS84',
          created_by: 'wrfcoin-platform',
        };

        logger.info(`${LOG_PREFIX} Creating OpenForis project`, {
          name: requestData.name,
          type: requestData.type,
          region: requestData.region,
        });

        const response = await axios.post(
          `${this.endpoints.collectEarth}/v2/projects`,
          requestData,
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'User-Agent': 'Wrfcoin-Platform/1.0',
            },
            timeout: this.apiTimeout,
          }
        );

        // Transform the response data to application format
        const transformedProject = this.transformer.transformProject(
          response.data
        );

        // Cache the transformed project in both cache systems
        await this.cacheManager.cacheProject(
          transformedProject.id,
          transformedProject
        );
        this.cache.projects.set(transformedProject.id, transformedProject);

        logger.info(`${LOG_PREFIX} Successfully created OpenForis project`, {
          projectId: transformedProject.id,
          name: transformedProject.name,
        });

        return transformedProject;
      } catch (error) {
        logger.error(`${LOG_PREFIX} Error creating OpenForis project`, {
          error: error.message,
          projectName: projectData.name,
          projectType: projectData.type,
        });

        // Handle specific API errors
        if (error.response?.status === 401) {
          throw new Error(
            'OpenForis API authentication failed - check API key'
          );
        }
        if (error.response?.status === 403) {
          throw new Error(
            'OpenForis API access forbidden - insufficient permissions'
          );
        }
        if (error.response?.status === 422) {
          throw new Error(
            'Invalid project data provided to OpenForis API - check required fields'
          );
        }
        if (error.response?.status === 409) {
          throw new Error('Project with this name already exists in OpenForis');
        }

        throw error;
      }
    }

    const projectId = 'ce-project-' + crypto.randomUUID().slice(0, 8);
    const project = {
      id: projectId,
      name: projectData.name,
      description: projectData.description,
      type: projectData.type || 'FOREST_MONITORING',
      region: projectData.region,
      createdAt: new Date().toISOString(),
      status: 'ACTIVE',
      plotCount: 0,
      metadata: projectData.metadata || {},
    };

    this.cache.projects.set(projectId, project);
    logger.info(`${LOG_PREFIX} Created Collect Earth project`, { projectId });

    return project;
  }

  /**
   * Create a new plot
   * @param {Object} plotData Plot data
   * @returns {Object} Created plot
   */
  async createPlot(plotData) {
    this.ensureInitialized();

    if (!this.testMode) {
      // Production API implementation for creating OpenForis plots
      if (!this.apiKey) {
        throw new Error('OpenForis API key not configured for production mode');
      }

      try {
        // Check cache first
        const cachedPlot = await this.cacheManager.getPlot(
          plotData.id || `temp-${Date.now()}`
        );
        if (cachedPlot && cachedPlot.projectId === plotData.projectId) {
          logger.debug(`${LOG_PREFIX} Returning cached plot`, {
            plotId: cachedPlot.id,
          });
          return cachedPlot;
        }

        // Prepare request data with validation
        const requestData = {
          project_id: plotData.projectId,
          name: plotData.name,
          coordinates: {
            latitude: parseFloat(plotData.coordinates.latitude),
            longitude: parseFloat(plotData.coordinates.longitude),
          },
          area_hectares: parseFloat(plotData.size) || 0,
          forest_type: plotData.forestType || 'mixed',
          attributes: {
            ...plotData.metadata,
            carbon_stock_tc_per_ha: parseFloat(plotData.carbonStock) || 0,
            biodiversity_index: parseFloat(plotData.biodiversityIndex) || 5.0,
            created_by: 'wrfcoin-platform',
            created_at: new Date().toISOString(),
          },
        };

        logger.info(
          `${LOG_PREFIX} Creating plot for project ${plotData.projectId}`,
          {
            plotName: requestData.name,
            coordinates: requestData.coordinates,
            area: requestData.area_hectares,
          }
        );

        // Make API request with retry logic
        const response = await this.makeApiRequest(
          'POST',
          `${this.endpoints.collectEarth}/v2/projects/${plotData.projectId}/plots`,
          requestData,
          {
            timeout: 30000,
            maxRetries: 3,
          }
        );

        // Validate and transform the response
        if (!response.data || !response.data.id) {
          throw new Error(
            'Invalid response from OpenForis API - missing plot ID'
          );
        }

        const transformedPlot = this.transformer.transformPlot(response.data);

        // Enhance transformed plot with additional metadata
        transformedPlot.source = 'OpenForis';
        transformedPlot.createdVia = 'api';
        transformedPlot.lastSyncAt = new Date().toISOString();

        // Cache the transformed plot in both cache systems
        await this.cacheManager.cachePlot(transformedPlot.id, transformedPlot);
        this.cache.plots.set(transformedPlot.id, transformedPlot);

        // Update project plot count and cache
        const project =
          (await this.cacheManager.getProject(plotData.projectId)) ||
          this.cache.projects.get(plotData.projectId);
        if (project) {
          project.plotCount = (project.plotCount || 0) + 1;
          project.lastUpdated = new Date().toISOString();
          await this.cacheManager.cacheProject(project.id, project);
          this.cache.projects.set(project.id, project);
        }

        // Invalidate related caches
        await this.cacheManager.invalidate('PROJECT_PLOTS', plotData.projectId);

        logger.info(`${LOG_PREFIX} Successfully created plot`, {
          plotId: transformedPlot.id,
          projectId: plotData.projectId,
          name: transformedPlot.name,
          coordinates: transformedPlot.coordinates,
        });

        return transformedPlot;
      } catch (error) {
        logger.error(`${LOG_PREFIX} Plot creation failed`, {
          error: error.message,
          stack: error.stack,
          projectId: plotData.projectId,
          plotName: plotData.name,
          apiResponse: error.response?.data,
        });

        // Handle specific API errors
        if (error.response?.status === 404) {
          throw new Error(
            `Project with ID ${plotData.projectId} not found in OpenForis`
          );
        }
        if (error.response?.status === 422) {
          throw new Error(
            `Invalid plot data: ${error.response.data?.message || 'Validation failed'}`
          );
        }
        if (error.response?.status === 409) {
          throw new Error(
            `Plot with name '${plotData.name}' already exists in project ${plotData.projectId}`
          );
        }

        throw new Error(`Plot creation failed: ${error.message}`);
      }
    }

    // Verify project exists
    const project = this.cache.projects.get(plotData.projectId);
    if (!project) {
      throw new Error(`Project with ID ${plotData.projectId} not found`);
    }

    const plotId = 'ce-plot-' + crypto.randomUUID().slice(0, 8);
    const plot = {
      id: plotId,
      projectId: plotData.projectId,
      name: plotData.name,
      coordinates: plotData.coordinates,
      size: plotData.size,
      forestType: plotData.forestType,
      carbonStock: plotData.carbonStock,
      biodiversityIndex: plotData.biodiversityIndex,
      status: 'PENDING',
      lastUpdated: new Date().toISOString(),
      metadata: plotData.metadata || {},
    };

    this.cache.plots.set(plotId, plot);

    // Update project plot count
    project.plotCount = (project.plotCount || 0) + 1;

    logger.info(`${LOG_PREFIX} Created plot`, {
      plotId,
      projectId: plotData.projectId,
    });

    return plot;
  }

  /**
   * Start Earth Map time series analysis for a plot
   * @param {string} plotId Plot ID
   * @param {Object} options Analysis options
   * @returns {Object} Time series info
   */
  async startTimeSeriesAnalysis(plotId, options = {}) {
    this.ensureInitialized();

    if (!this.testMode) {
      // Production API implementation for OpenForis Earth Map time series analysis
      if (!this.apiKey) {
        throw new Error('OpenForis API key not configured for production mode');
      }

      try {
        // Check cache first for existing time series
        const cachedTimeSeries = await this.cacheManager.getTimeSeries(
          `${plotId}-${options.startDate || 'latest'}-${options.endDate || 'now'}`
        );
        if (cachedTimeSeries && cachedTimeSeries.status === 'COMPLETED') {
          logger.debug(`${LOG_PREFIX} Returning cached time series`, {
            timeSeriesId: cachedTimeSeries.id,
            plotId,
          });
          return cachedTimeSeries;
        }

        // Verify plot exists first
        const plot =
          (await this.cacheManager.getPlot(plotId)) ||
          this.cache.plots.get(plotId);
        if (!plot) {
          throw new Error(`Plot with ID ${plotId} not found`);
        }

        logger.info(
          `${LOG_PREFIX} Starting time series analysis for plot ${plotId}`,
          {
            plotName: plot.name,
            coordinates: plot.coordinates,
            forestType: plot.forestType,
          }
        );

        const requestData = {
          plot_id: plotId,
          coordinates: plot.coordinates,
          format: options.format || 'json',
          include_coordinates: options.includeCoordinates !== false,
          start_date:
            options.startDate ||
            new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
          end_date: options.endDate || new Date().toISOString(),
          resolution_meters: parseInt(options.resolution) || 30,
          variables: options.variables || [
            'ndvi',
            'precipitation_mm',
            'temperature_celsius',
            'forest_cover_percent',
            'forest_loss_percent',
            'soil_moisture_percent',
          ],
          satellite_source: options.satelliteSource || 'sentinel-2',
          cloud_cover_threshold: options.cloudCoverThreshold || 20,
          processing_level: options.processingLevel || 'L2A',
        };

        // Make API request with extended timeout for processing
        const response = await this.makeApiRequest(
          'POST',
          `${this.endpoints.earthMap}/v2/time-series/analyze`,
          requestData,
          {
            timeout: 120000, // 2 minutes for processing
            maxRetries: 2,
          }
        );

        // Validate response structure
        if (!response.data || !response.data.id) {
          throw new Error(
            'Invalid response from OpenForis Earth Map API - missing analysis ID'
          );
        }

        let transformedTimeSeries;

        // Handle different response scenarios
        if (response.data.status === 'COMPLETED' && response.data.data_points) {
          // Analysis completed immediately - transform and cache
          transformedTimeSeries = this.transformer.transformTimeSeries(
            response.data
          );
          transformedTimeSeries.plotId = plotId;
          transformedTimeSeries.projectId = plot.projectId;

          // Add processing metadata
          transformedTimeSeries.processingInfo = {
            completedAt: new Date().toISOString(),
            processingTime: response.data.processing_time_seconds || 0,
            dataQuality: response.data.data_quality || 'unknown',
            cloudCoverage: response.data.average_cloud_coverage || 0,
          };

          // Cache the completed time series data with longer TTL
          await this.cacheManager.cacheTimeSeries(
            transformedTimeSeries.id,
            transformedTimeSeries
          );
          this.cache.timeSeries.set(
            transformedTimeSeries.id,
            transformedTimeSeries
          );
        } else if (
          response.data.status === 'PROCESSING' ||
          response.data.status === 'QUEUED'
        ) {
          // Analysis in progress - create tracking record
          transformedTimeSeries = {
            id: response.data.id,
            plotId: plotId,
            projectId: plot.projectId,
            type: 'EARTH_MAP',
            status: response.data.status,
            progress: response.data.progress || 0,
            estimatedCompletion: response.data.estimated_completion_time,
            startDate: requestData.start_date,
            endDate: requestData.end_date,
            resolution: requestData.resolution_meters + 'm',
            dataPoints: [],
            metadata: {
              source: requestData.satellite_source,
              processing: requestData.processing_level,
              variables: requestData.variables,
              queuePosition: response.data.queue_position || 0,
              requestedAt: new Date().toISOString(),
            },
          };

          // Cache the processing time series with shorter TTL
          await this.cacheManager.cacheTimeSeries(
            transformedTimeSeries.id,
            transformedTimeSeries
          );
          this.cache.timeSeries.set(
            transformedTimeSeries.id,
            transformedTimeSeries
          );

          // Schedule status polling for processing jobs
          this.schedulePollTimeSeriesStatus(transformedTimeSeries.id, plotId);
        } else {
          throw new Error(
            `Unexpected analysis status: ${response.data.status}`
          );
        }

        // Update plot metadata with time series reference
        plot.lastTimeSeriesAnalysis = {
          id: transformedTimeSeries.id,
          requestedAt: new Date().toISOString(),
          status: transformedTimeSeries.status,
        };
        await this.cacheManager.cachePlot(plotId, plot);
        this.cache.plots.set(plotId, plot);

        logger.info(`${LOG_PREFIX} Time series analysis initiated`, {
          timeSeriesId: transformedTimeSeries.id,
          plotId,
          status: transformedTimeSeries.status,
          progress: transformedTimeSeries.progress,
          estimatedCompletion: transformedTimeSeries.estimatedCompletion,
        });

        return transformedTimeSeries;
      } catch (error) {
        logger.error(`${LOG_PREFIX} Time series analysis failed`, {
          error: error.message,
          stack: error.stack,
          plotId,
          options,
          apiResponse: error.response?.data,
        });

        // Handle specific API errors
        if (error.response?.status === 404) {
          throw new Error(
            `Plot with ID ${plotId} not found in OpenForis Earth Map`
          );
        }
        if (error.response?.status === 422) {
          throw new Error(
            `Invalid analysis parameters: ${error.response.data?.message || 'Validation failed'}`
          );
        }
        if (error.response?.status === 429) {
          throw new Error(
            'OpenForis Earth Map API rate limit exceeded - please try again later'
          );
        }
        if (error.response?.status === 503) {
          throw new Error(
            'OpenForis Earth Map processing service temporarily unavailable'
          );
        }

        throw new Error(`Time series analysis failed: ${error.message}`);
      }
    }

    // Verify plot exists
    const plot = this.cache.plots.get(plotId);
    if (!plot) {
      throw new Error(`Plot with ID ${plotId} not found`);
    }

    const timeSeriesId = 'em-timeseries-' + crypto.randomUUID().slice(0, 8);

    // Create an empty time series dataset
    const timeSeries = {
      id: timeSeriesId,
      plotId: plot.id,
      projectId: plot.projectId,
      type: 'EARTH_MAP',
      startDate:
        options.startDate ||
        new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year ago
      endDate: options.endDate || new Date().toISOString(),
      resolution: options.resolution || '30m',
      status: 'PROCESSING',
      progress: 0,
      dataPoints: [],
      metadata: options.metadata || {
        source: 'Sentinel-2',
        processing: 'Level 2A',
        cloudCoverage: Math.random() * 30, // 0-30 %
      },
    };

    this.cache.timeSeries.set(timeSeriesId, timeSeries);

    logger.info(`${LOG_PREFIX} Started time series analysis`, {
      timeSeriesId,
      plotId,
    });

    // Simulate processing
    if (this.testMode) {
      this.simulateTimeSeriesProcessing(timeSeriesId);
    }

    return timeSeries;
  }

  /**
   * Schedule polling for time series analysis status
   * @param {string} timeSeriesId Time series ID
   * @param {string} plotId Plot ID
   */
  schedulePollTimeSeriesStatus(timeSeriesId, plotId) {
    if (this.testMode) {
      return this.simulateTimeSeriesProcessing(timeSeriesId);
    }

    // Poll every 30 seconds for up to 30 minutes
    const maxPolls = 60; // 30 minutes / 30 seconds
    let pollCount = 0;

    const pollInterval = setInterval(async () => {
      try {
        pollCount++;

        if (pollCount > maxPolls) {
          clearInterval(pollInterval);
          logger.warn(`${LOG_PREFIX} Time series polling timeout`, {
            timeSeriesId,
            plotId,
          });
          return;
        }

        // Check status via API
        const response = await this.makeApiRequest(
          'GET',
          `${this.endpoints.earthMap}/v2/time-series/${timeSeriesId}/status`,
          null,
          { timeout: 10000 }
        );

        if (response.data.status === 'COMPLETED') {
          clearInterval(pollInterval);

          // Fetch complete data
          const dataResponse = await this.makeApiRequest(
            'GET',
            `${this.endpoints.earthMap}/v2/time-series/${timeSeriesId}`,
            null,
            { timeout: 30000 }
          );

          // Transform and cache the completed data
          const transformedTimeSeries = this.transformer.transformTimeSeries(
            dataResponse.data
          );
          transformedTimeSeries.plotId = plotId;
          transformedTimeSeries.projectId =
            this.cache.plots.get(plotId)?.projectId;

          await this.cacheManager.cacheTimeSeries(
            timeSeriesId,
            transformedTimeSeries
          );
          this.cache.timeSeries.set(timeSeriesId, transformedTimeSeries);

          logger.info(
            `${LOG_PREFIX} Time series analysis completed via polling`,
            {
              timeSeriesId,
              plotId,
              dataPointCount: transformedTimeSeries.dataPoints.length,
            }
          );
        } else if (response.data.status === 'FAILED') {
          clearInterval(pollInterval);
          logger.error(`${LOG_PREFIX} Time series analysis failed`, {
            timeSeriesId,
            plotId,
            error: response.data.error,
          });
        } else {
          // Update progress in cache
          const timeSeries = this.cache.timeSeries.get(timeSeriesId);
          if (timeSeries) {
            timeSeries.status = response.data.status;
            timeSeries.progress = response.data.progress || timeSeries.progress;
            this.cache.timeSeries.set(timeSeriesId, timeSeries);
          }

          logger.debug(`${LOG_PREFIX} Time series status update`, {
            timeSeriesId,
            status: response.data.status,
            progress: response.data.progress,
          });
        }
      } catch (error) {
        logger.error(`${LOG_PREFIX} Error polling time series status`, {
          timeSeriesId,
          plotId,
          error: error.message,
        });
      }
    }, 30000); // Poll every 30 seconds
  }

  /**
   * Schedule polling for climate projection status
   * @param {string} projectionId Climate projection ID
   * @param {string} region Region
   * @param {string} scenario Scenario
   */
  schedulePollClimateStatus(projectionId, region, scenario) {
    if (this.testMode) {
      return; // No polling needed in test mode
    }

    // Poll every 60 seconds for up to 2 hours
    const maxPolls = 120; // 2 hours / 60 seconds
    let pollCount = 0;

    const pollInterval = setInterval(async () => {
      try {
        pollCount++;

        if (pollCount > maxPolls) {
          clearInterval(pollInterval);
          logger.warn(`${LOG_PREFIX} Climate projection polling timeout`, {
            projectionId,
            region,
            scenario,
          });
          return;
        }

        // Check status via API
        const response = await this.makeApiRequest(
          'GET',
          `${this.endpoints.climateData}/v2/climate/projections/${projectionId}/status`,
          null,
          { timeout: 10000 }
        );

        if (response.data.status === 'COMPLETED') {
          clearInterval(pollInterval);

          // Fetch complete data
          const dataResponse = await this.makeApiRequest(
            'GET',
            `${this.endpoints.climateData}/v2/climate/projections/${projectionId}`,
            null,
            { timeout: 60000 }
          );

          // Transform and cache the completed data
          const transformedClimateData = this.transformer.transformClimateData(
            dataResponse.data
          );

          await this.cacheManager.cacheClimateData(
            region,
            scenario,
            transformedClimateData
          );
          this.cache.climateData.set(projectionId, transformedClimateData);

          logger.info(
            `${LOG_PREFIX} Climate projection completed via polling`,
            {
              projectionId,
              region,
              scenario,
              projectionCount: transformedClimateData.projections.length,
            }
          );
        } else if (response.data.status === 'FAILED') {
          clearInterval(pollInterval);
          logger.error(`${LOG_PREFIX} Climate projection failed`, {
            projectionId,
            region,
            scenario,
            error: response.data.error,
          });
        } else {
          // Update progress in cache
          const climateData = this.cache.climateData.get(projectionId);
          if (climateData) {
            climateData.status = response.data.status;
            climateData.progress =
              response.data.progress || climateData.progress;
            this.cache.climateData.set(projectionId, climateData);
          }

          logger.debug(`${LOG_PREFIX} Climate projection status update`, {
            projectionId,
            status: response.data.status,
            progress: response.data.progress,
          });
        }
      } catch (error) {
        logger.error(`${LOG_PREFIX} Error polling climate projection status`, {
          projectionId,
          region,
          scenario,
          error: error.message,
        });
      }
    }, 60000); // Poll every 60 seconds
  }

  /**
   * Simulate time series processing
   * @param {string} timeSeriesId Time series ID
   */
  simulateTimeSeriesProcessing(timeSeriesId) {
    const timeSeries = this.cache.timeSeries.get(timeSeriesId);
    if (!timeSeries) return;

    let progress = 0;
    const interval = setInterval(() => {
      progress += 10;
      timeSeries.progress = progress;

      if (progress >= 100) {
        clearInterval(interval);
        timeSeries.status = 'COMPLETED';

        // Generate data points
        const now = new Date();
        const dataPoints = [];

        for (let i = 0; i < 12; i++) {
          const date = new Date(now);
          date.setMonth(now.getMonth() - i);

          dataPoints.push({
            timestamp: date.toISOString(),
            ndvi: Math.random() * 0.6 + 0.2, // NDVI between 0.2 and 0.8
            precipitation: Math.random() * 100 + 20, // 20-120 mm
            temperature: Math.random() * 15 + 10, // 10-25 °C
            forestCover: Math.random() * 30 + 70, // 70-100 %
            forestLoss: Math.max(0, Math.random() * 5 - 4), // 0-1 % mostly 0
            soilMoisture: Math.random() * 40 + 10, // 10-50 %
          });
        }

        timeSeries.dataPoints = dataPoints;

        logger.info(`${LOG_PREFIX} Time series processing completed`, {
          timeSeriesId,
        });
      }

      logger.debug(`${LOG_PREFIX} Time series processing progress`, {
        timeSeriesId,
        progress,
      });
    }, 500);
  }

  /**
   * Generate climate projection for a region
   * @param {Object} options Projection options
   * @returns {Object} Climate projection data
   */
  async generateClimateProjection(options) {
    this.ensureInitialized();

    if (!this.testMode) {
      // Production API implementation for OpenForis climate data projections
      if (!this.apiKey) {
        throw new Error('OpenForis API key not configured for production mode');
      }

      try {
        // Check cache first for existing climate projection
        const cachedClimateData = await this.cacheManager.getClimateData(
          options.region,
          options.scenario
        );
        if (
          cachedClimateData &&
          cachedClimateData.timeRange ===
            `${options.startYear || 2025}-${options.endYear || 2100}`
        ) {
          logger.debug(`${LOG_PREFIX} Returning cached climate projection`, {
            region: options.region,
            scenario: options.scenario,
          });
          return cachedClimateData;
        }

        const baseUrl = this.endpoints.climateData;

        logger.info(`${LOG_PREFIX} Generating climate projection`, {
          region: options.region,
          scenario: options.scenario,
          timeRange: `${options.startYear || 2025}-${options.endYear || 2100}`,
          model: options.model || 'CMIP6',
        });

        const requestData = {
          region: options.region,
          scenario: options.scenario,
          start_year: parseInt(options.startYear) || 2025,
          end_year: parseInt(options.endYear) || 2100,
          resolution_km: options.resolution || '50km',
          variables: options.variables || [
            'temperature',
            'precipitation',
            'extreme_events',
          ],
          model: options.model || 'CMIP6',
          ensemble_size: options.ensembleSize || 10,
          confidence_level: options.confidenceLevel || 95,
          include_uncertainty: options.includeUncertainty !== false,
          processing_options: {
            bias_correction: options.biasCorrection !== false,
            downscaling: options.downscaling || 'statistical',
            temporal_aggregation: options.temporalAggregation || 'annual',
          },
        };

        // Make API request with extended timeout for climate modeling
        const response = await this.makeApiRequest(
          'POST',
          `${baseUrl}/v2/climate/projections`,
          requestData,
          {
            timeout: 300000, // 5 minutes for climate projections
            maxRetries: 2,
          }
        );

        // Validate response structure
        if (!response.data || !response.data.id) {
          throw new Error(
            'Invalid response from OpenForis Climate API - missing projection ID'
          );
        }

        let transformedClimateData;

        // Handle different response scenarios
        if (response.data.status === 'COMPLETED' && response.data.projections) {
          // Projection completed - transform and cache
          transformedClimateData = this.transformer.transformClimateData(
            response.data
          );

          // Enhanced metadata for climate projections
          transformedClimateData.metadata = {
            ...transformedClimateData.metadata,
            model: requestData.model,
            ensembleSize: requestData.ensemble_size,
            confidenceLevel: requestData.confidence_level,
            processingOptions: requestData.processing_options,
            completedAt: new Date().toISOString(),
            processingTime: response.data.processing_time_seconds || 0,
            dataQuality: response.data.data_quality || 'standard',
            uncertaintyBounds: response.data.uncertainty_bounds || {},
            validationMetrics: response.data.validation_metrics || {},
          };

          // Cache the climate data with extended TTL for projections
          await this.cacheManager.cacheClimateData(
            transformedClimateData.region,
            transformedClimateData.scenario,
            transformedClimateData
          );
          this.cache.climateData.set(
            transformedClimateData.id,
            transformedClimateData
          );
        } else if (
          response.data.status === 'PROCESSING' ||
          response.data.status === 'QUEUED'
        ) {
          // Long-running projection - create tracking record
          transformedClimateData = {
            id: response.data.id,
            region: options.region,
            scenario: options.scenario,
            status: response.data.status,
            progress: response.data.progress || 0,
            estimatedCompletion: response.data.estimated_completion_time,
            timeRange: `${requestData.start_year}-${requestData.end_year}`,
            resolution: requestData.resolution_km,
            variables: requestData.variables,
            projections: [],
            metadata: {
              model: requestData.model,
              queuePosition: response.data.queue_position || 0,
              requestedAt: new Date().toISOString(),
              processingOptions: requestData.processing_options,
            },
          };

          // Cache processing status with shorter TTL
          this.cache.climateData.set(
            transformedClimateData.id,
            transformedClimateData
          );

          // Schedule status polling for long-running projections
          this.schedulePollClimateStatus(
            transformedClimateData.id,
            options.region,
            options.scenario
          );
        } else {
          throw new Error(
            `Unexpected projection status: ${response.data.status}`
          );
        }

        logger.info(`${LOG_PREFIX} Climate projection initiated`, {
          projectionId: transformedClimateData.id,
          region: options.region,
          scenario: options.scenario,
          status: transformedClimateData.status,
          progress: transformedClimateData.progress,
          estimatedCompletion: transformedClimateData.estimatedCompletion,
        });

        return transformedClimateData;
      } catch (error) {
        logger.error(`${LOG_PREFIX} Climate projection generation failed`, {
          error: error.message,
          stack: error.stack,
          region: options.region,
          scenario: options.scenario,
          apiResponse: error.response?.data,
        });

        // Handle specific API errors
        if (error.response?.status === 400) {
          throw new Error(
            `Invalid climate projection parameters: ${error.response.data?.message || 'Bad request'}`
          );
        }
        if (error.response?.status === 422) {
          throw new Error(
            `Unsupported climate scenario or region: ${error.response.data?.message || 'Validation failed'}`
          );
        }
        if (error.response?.status === 429) {
          throw new Error(
            'OpenForis Climate API rate limit exceeded - please try again later'
          );
        }
        if (error.response?.status === 503) {
          throw new Error(
            'OpenForis Climate modeling service temporarily unavailable'
          );
        }

        throw new Error(
          `Climate projection generation failed: ${error.message}`
        );
      }
    }

    const {
      region,
      scenario,
      startYear = 2025,
      endYear = 2100,
      resolution = '50km',
    } = options;

    if (!region || !scenario) {
      throw new Error('Region and scenario are required');
    }

    // Check if projection already exists
    const existingData = this.getClimateData(region, scenario);
    if (existingData) {
      return existingData;
    }

    const climateDataId = 'cd-dataset-' + crypto.randomUUID().slice(0, 8);

    // Generate yearly projections
    const projections = [];
    const scenarioIndex = ['RCP2.6', 'RCP4.5', 'RCP6.0', 'RCP8.5'].indexOf(
      scenario
    );
    const scenarioFactor = scenarioIndex >= 0 ? scenarioIndex / 3 : 0.5;

    for (let year = startYear; year <= endYear; year += 5) {
      const yearProgress = (year - startYear) / (endYear - startYear);
      const projection = {
        year,
        temperature:
          14 + (Math.random() * 2 - 0.5) + yearProgress * 6 * scenarioFactor,
        precipitation:
          800 +
          (Math.random() * 200 - 100) +
          yearProgress * 300 * (scenarioFactor - 0.5),
        extremeEvents:
          Math.floor(Math.random() * 5) +
          Math.floor(yearProgress * 15 * scenarioFactor),
      };
      projections.push(projection);
    }

    const climateData = {
      id: climateDataId,
      region,
      scenario,
      timeRange: `${startYear}-${endYear}`,
      resolution,
      variables: ['temperature', 'precipitation', 'extremeEvents'],
      projections,
      metadata: {
        model: options.model || 'CMIP6',
        uncertainty: Math.random() * 0.2 + 0.1, // 10-30%
        source: 'OpenForis Climate Data',
        createdAt: new Date().toISOString(),
      },
    };

    this.cache.climateData.set(climateDataId, climateData);

    logger.info(`${LOG_PREFIX} Generated climate projection`, {
      climateDataId,
      region,
      scenario,
    });

    return climateData;
  }

  /**
   * Export data to Wrfcoin blockchain
   * @param {string} dataType Type of data to export
   * @param {string} dataId ID of the data to export
   * @returns {Object} Export result
   */
  async exportToBlockchain(dataType, dataId) {
    this.ensureInitialized();

    let data;
    let nftMetadata;

    switch (dataType) {
      case 'PROJECT':
        data = this.cache.projects.get(dataId);
        if (!data) {
          throw new Error(`Project with ID ${dataId} not found`);
        }
        nftMetadata = {
          name: `Forest Project: ${data.name}`,
          description: data.description,
          type: 'FOREST_PROJECT',
          region: data.region,
          plots: data.plotCount,
          forestType: data.metadata?.forestType,
          collaborators: data.metadata?.collaborators,
        };
        break;

      case 'PLOT':
        data = this.cache.plots.get(dataId);
        if (!data) {
          throw new Error(`Plot with ID ${dataId} not found`);
        }
        nftMetadata = {
          name: `Forest Plot: ${data.name}`,
          description: `Forest plot in ${data.forestType}`,
          type: 'FOREST_PLOT',
          coordinates: data.coordinates,
          size: data.size,
          forestType: data.forestType,
          carbonStock: data.carbonStock,
          biodiversityIndex: data.biodiversityIndex,
        };
        break;

      case 'TIME_SERIES':
        data = this.cache.timeSeries.get(dataId);
        if (!data) {
          throw new Error(`Time series with ID ${dataId} not found`);
        }
        nftMetadata = {
          name: `Earth Map Analysis: ${data.plotId}`,
          description: `Time series analysis from ${data.startDate} to ${data.endDate}`,
          type: 'EARTH_MAP_ANALYSIS',
          timeRange: `${data.startDate} to ${data.endDate}`,
          resolution: data.resolution,
          source: data.metadata?.source,
          dataPoints: data.dataPoints.length,
        };
        break;

      case 'CLIMATE_DATA':
        data = this.cache.climateData.get(dataId);
        if (!data) {
          throw new Error(`Climate data with ID ${dataId} not found`);
        }
        nftMetadata = {
          name: `Climate Projection: ${data.region} - ${data.scenario}`,
          description: `Climate projection for ${data.region} under ${data.scenario} scenario`,
          type: 'CLIMATE_PROJECTION',
          region: data.region,
          scenario: data.scenario,
          timeRange: data.timeRange,
          resolution: data.resolution,
          model: data.metadata?.model,
        };
        break;

      default:
        throw new Error(`Unsupported data type: ${dataType}`);
    }

    const txId = 'tx-' + crypto.randomUUID().slice(0, 8);

    logger.info(`${LOG_PREFIX} Exported data to blockchain`, {
      dataType,
      dataId,
      txId,
      nftMetadata: JSON.stringify(nftMetadata),
    });

    return {
      success: true,
      dataType,
      dataId,
      transactionId: txId,
      timestamp: new Date().toISOString(),
      nftMetadata,
    };
  }

  /**
   * Warm cache with frequently accessed data
   * @param {Object} options Cache warming options
   * @returns {Promise<Object>} Warming results
   */
  async warmCache(options = {}) {
    if (this.testMode) {
      logger.info(`${LOG_PREFIX} Cache warming skipped in test mode`);
      return { success: true, message: 'Test mode - cache warming skipped' };
    }

    try {
      logger.info(`${LOG_PREFIX} Starting cache warming process`);

      const warmingResults = {
        projects: 0,
        plots: 0,
        timeSeries: 0,
        climateData: 0,
        errors: [],
      };

      // Warm frequently accessed projects
      if (options.warmProjects !== false) {
        try {
          const response = await this.makeApiRequest(
            'GET',
            `${this.endpoints.collectEarth}/v2/projects?limit=20&sort=last_accessed`,
            null,
            { timeout: 30000 }
          );

          if (response.data && Array.isArray(response.data.projects)) {
            for (const project of response.data.projects) {
              try {
                const transformedProject =
                  this.transformer.transformProject(project);
                await this.cacheManager.cacheProject(
                  transformedProject.id,
                  transformedProject
                );
                this.cache.projects.set(
                  transformedProject.id,
                  transformedProject
                );
                warmingResults.projects++;
              } catch (error) {
                warmingResults.errors.push(
                  `Project ${project.id}: ${error.message}`
                );
              }
            }
          }
        } catch (error) {
          warmingResults.errors.push(`Projects warming: ${error.message}`);
        }
      }

      // Warm climate scenarios for major regions
      if (options.warmClimateData !== false) {
        const majorRegions = [
          'Global',
          'North America',
          'Europe',
          'Asia',
          'Africa',
        ];
        const scenarios = ['RCP2.6', 'RCP4.5', 'RCP8.5'];

        for (const region of majorRegions) {
          for (const scenario of scenarios) {
            try {
              const cachedData = await this.cacheManager.getClimateData(
                region,
                scenario
              );
              if (!cachedData) {
                // Generate and cache popular climate projections
                await this.generateClimateProjection({
                  region,
                  scenario,
                  startYear: 2025,
                  endYear: 2050,
                });
                warmingResults.climateData++;
              }
            } catch (error) {
              warmingResults.errors.push(
                `Climate ${region}-${scenario}: ${error.message}`
              );
            }
          }
        }
      }

      logger.info(`${LOG_PREFIX} Cache warming completed`, warmingResults);
      return { success: true, results: warmingResults };
    } catch (error) {
      logger.error(`${LOG_PREFIX} Cache warming failed`, {
        error: error.message,
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Get aggregated data statistics
   * @returns {Promise<Object>} Aggregated statistics
   */
  async getAggregatedStats() {
    try {
      const stats = {
        projects: {
          total: this.cache.projects.size,
          byType: {},
          byRegion: {},
          byStatus: {},
        },
        plots: {
          total: this.cache.plots.size,
          byForestType: {},
          averageCarbonStock: 0,
          averageBiodiversityIndex: 0,
        },
        timeSeries: {
          total: this.cache.timeSeries.size,
          byStatus: {},
          completedAnalyses: 0,
        },
        climateData: {
          total: this.cache.climateData.size,
          byScenario: {},
          byRegion: {},
        },
        cache: await this.cacheManager.getStats(),
      };

      // Aggregate project statistics
      for (const project of this.cache.projects.values()) {
        stats.projects.byType[project.type] =
          (stats.projects.byType[project.type] || 0) + 1;
        stats.projects.byRegion[project.region] =
          (stats.projects.byRegion[project.region] || 0) + 1;
        stats.projects.byStatus[project.status] =
          (stats.projects.byStatus[project.status] || 0) + 1;
      }

      // Aggregate plot statistics
      let totalCarbonStock = 0;
      let totalBiodiversityIndex = 0;
      let plotsWithData = 0;

      for (const plot of this.cache.plots.values()) {
        stats.plots.byForestType[plot.forestType] =
          (stats.plots.byForestType[plot.forestType] || 0) + 1;

        if (typeof plot.carbonStock === 'number' && plot.carbonStock > 0) {
          totalCarbonStock += plot.carbonStock;
          plotsWithData++;
        }

        if (typeof plot.biodiversityIndex === 'number') {
          totalBiodiversityIndex += plot.biodiversityIndex;
        }
      }

      if (plotsWithData > 0) {
        stats.plots.averageCarbonStock =
          Math.round((totalCarbonStock / plotsWithData) * 100) / 100;
        stats.plots.averageBiodiversityIndex =
          Math.round((totalBiodiversityIndex / this.cache.plots.size) * 100) /
          100;
      }

      // Aggregate time series statistics
      for (const timeSeries of this.cache.timeSeries.values()) {
        stats.timeSeries.byStatus[timeSeries.status] =
          (stats.timeSeries.byStatus[timeSeries.status] || 0) + 1;
        if (timeSeries.status === 'COMPLETED') {
          stats.timeSeries.completedAnalyses++;
        }
      }

      // Aggregate climate data statistics
      for (const climateData of this.cache.climateData.values()) {
        stats.climateData.byScenario[climateData.scenario] =
          (stats.climateData.byScenario[climateData.scenario] || 0) + 1;
        stats.climateData.byRegion[climateData.region] =
          (stats.climateData.byRegion[climateData.region] || 0) + 1;
      }

      return stats;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to get aggregated stats`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get data quality metrics
   * @returns {Promise<Object>} Data quality metrics
   */
  async getDataQualityMetrics() {
    try {
      const metrics = {
        completeness: {
          projects: 0,
          plots: 0,
          timeSeries: 0,
          climateData: 0,
        },
        accuracy: {
          coordinateValidation: 0,
          dataRangeValidation: 0,
          temporalConsistency: 0,
        },
        freshness: {
          recentUpdates: 0,
          staleCacheEntries: 0,
          averageAge: 0,
        },
        transformation: this.transformer.getStats(),
      };

      const now = Date.now();
      const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
      let totalAge = 0;
      let totalEntries = 0;

      // Check data completeness and freshness
      for (const project of this.cache.projects.values()) {
        if (project.name && project.type && project.region) {
          metrics.completeness.projects++;
        }

        const projectAge = new Date(project.createdAt).getTime();
        if (now - projectAge < oneWeekMs) {
          metrics.freshness.recentUpdates++;
        }

        totalAge += now - projectAge;
        totalEntries++;
      }

      for (const plot of this.cache.plots.values()) {
        if (
          plot.coordinates &&
          plot.coordinates.latitude &&
          plot.coordinates.longitude
        ) {
          // Validate coordinate ranges
          if (
            plot.coordinates.latitude >= -90 &&
            plot.coordinates.latitude <= 90 &&
            plot.coordinates.longitude >= -180 &&
            plot.coordinates.longitude <= 180
          ) {
            metrics.accuracy.coordinateValidation++;
          }
        }

        if (plot.name && plot.forestType && plot.size) {
          metrics.completeness.plots++;
        }

        const plotAge = new Date(plot.lastUpdated).getTime();
        totalAge += now - plotAge;
        totalEntries++;
      }

      for (const timeSeries of this.cache.timeSeries.values()) {
        if (timeSeries.dataPoints && timeSeries.dataPoints.length > 0) {
          metrics.completeness.timeSeries++;

          // Check temporal consistency
          let isConsistent = true;
          for (let i = 1; i < timeSeries.dataPoints.length; i++) {
            const prevTime = new Date(
              timeSeries.dataPoints[i - 1].timestamp
            ).getTime();
            const currTime = new Date(
              timeSeries.dataPoints[i].timestamp
            ).getTime();
            if (currTime <= prevTime) {
              isConsistent = false;
              break;
            }
          }

          if (isConsistent) {
            metrics.accuracy.temporalConsistency++;
          }
        }
      }

      for (const climateData of this.cache.climateData.values()) {
        if (climateData.projections && climateData.projections.length > 0) {
          metrics.completeness.climateData++;
        }
      }

      // Calculate average age in days
      metrics.freshness.averageAge =
        totalEntries > 0
          ? Math.round(totalAge / totalEntries / (24 * 60 * 60 * 1000))
          : 0;

      return metrics;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to get data quality metrics`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get status information about the adapter
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      initialized: this.initialized,
      testMode: this.testMode,
      endpoints: this.endpoints,
      cacheStats: {
        projects: this.cache.projects.size,
        plots: this.cache.plots.size,
        timeSeries: this.cache.timeSeries.size,
        climateData: this.cache.climateData.size,
      },
      transformationStats: this.transformer.getStats(),
      apiKeyConfigured: !!this.apiKey,
    };
  }

  /**
   * Check initialization
   * @throws {Error} If not initialized
   */
  ensureInitialized() {
    if (!this.initialized) {
      throw new Error('OpenForis adapter not initialized');
    }
  }
}

module.exports = { OpenForisAdapter };
