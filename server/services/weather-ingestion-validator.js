/**
 * Weather Data Ingestion Validator
 *
 * Enhanced validation service specifically for the data ingestion pipeline.
 * Extends the existing weather-data-validator with ingestion-specific validation
 * including source verification, data freshness, and pipeline-specific quality checks.
 */

const { logger } = require('../utils/logger');
const WeatherDataValidator = require('./weather-data-validator');
const { ValidationRules, QualityFlags } = require('./weather-data-schema');
const {
  getSharedAntiFraudQualityPipeline,
} = require('./anti-fraud-quality-pipeline');

class WeatherIngestionValidator extends WeatherDataValidator {
  constructor() {
    super();
    this.antiFraudPipeline = getSharedAntiFraudQualityPipeline();

    // Ingestion-specific validation rules
    this.ingestionRules = {
      dataFreshness: {
        current: { maxAgeHours: 2 }, // Current observations should be < 2 hours old
        forecast: { maxAgeHours: 6 }, // Forecasts should be < 6 hours old
        historical: { maxAgeYears: 150 }, // Historical data should be < 150 years old
      },

      sourceCredibility: {
        'NOAA-NWS': { credibilityScore: 1.0, trustLevel: 'high' },
        'NOAA-NCEI': { credibilityScore: 1.0, trustLevel: 'high' },
        OpenWeatherMap: { credibilityScore: 0.8, trustLevel: 'medium' },
        LocalStation: { credibilityScore: 0.7, trustLevel: 'medium' },
        Unknown: { credibilityScore: 0.3, trustLevel: 'low' },
      },

      dataCompleteness: {
        current: {
          essential: ['temperature', 'humidity', 'pressure'],
          recommended: ['windSpeed', 'windDirection', 'visibility'],
          optional: ['dewpoint', 'precipitation', 'cloudCoverage'],
        },
        forecast: {
          essential: ['temperature', 'precipitation'],
          recommended: ['windSpeed', 'windDirection', 'humidity'],
          optional: ['pressure', 'cloudCoverage', 'visibility'],
        },
        historical: {
          essential: ['temperature'],
          recommended: ['precipitation'],
          optional: ['pressure', 'windSpeed', 'snowfall'],
        },
      },

      temporalConsistency: {
        maxTemperatureChange: 20, // Max °C change per hour
        maxPressureChange: 10, // Max hPa change per hour
        maxHumidityChange: 30, // Max % change per hour
      },
    };

    // Validation severity levels
    this.severityLevels = {
      CRITICAL: 'critical', // Data cannot be ingested
      HIGH: 'high', // Data has significant issues
      MEDIUM: 'medium', // Data has minor issues but usable
      LOW: 'low', // Data quality warnings
      INFO: 'info', // Informational only
    };
  }

  /**
   * Comprehensive validation for ingested weather data
   */
  async validateIngestionData(transformedData, options = {}) {
    const {
      enableSourceValidation = true,
      enableFreshnessValidation = true,
      enableCompletenessValidation = true,
      enableConsistencyValidation = true,
      enablePhysicsValidation = true,
      enableAntiFraudValidation = true,
      strictMode = false,
      previousData = null, // For temporal consistency checks
    } = options;

    const validationResult = {
      isValid: true,
      overallScore: 1.0,
      qualityLevel: 'excellent',
      canIngest: true,
      issues: [],
      warnings: [],
      validationChecks: {
        sourceValidation: { passed: true, details: [] },
        freshnessValidation: { passed: true, details: [] },
        completenessValidation: { passed: true, details: [] },
        consistencyValidation: { passed: true, details: [] },
        physicsValidation: { passed: true, details: [] },
        structureValidation: { passed: true, details: [] },
        antiFraudValidation: { passed: true, details: [], reasonCodes: [] },
      },
      riskAssessment: {
        decision: 'accepted',
        shouldReject: false,
        riskLevel: 'low',
        riskScore: 0,
        penaltyPoints: 0,
        reasonCodes: [],
        eventId: null,
      },
      metadata: {
        validatedAt: new Date().toISOString(),
        validatorVersion: '1.0.0',
        strictMode,
        sourceType: transformedData.metadata?.sourceType,
        provider: transformedData.metadata?.provider,
      },
    };

    try {
      // Step 1: Validate data structure
      const structureCheck = this.validateDataStructure(transformedData);
      validationResult.validationChecks.structureValidation = structureCheck;
      this.updateValidationResult(validationResult, structureCheck, 'CRITICAL');

      if (!structureCheck.passed && strictMode) {
        validationResult.canIngest = false;
        return validationResult;
      }

      // Step 2: Source validation
      if (enableSourceValidation) {
        const sourceCheck = this.validateDataSource(transformedData);
        validationResult.validationChecks.sourceValidation = sourceCheck;
        this.updateValidationResult(validationResult, sourceCheck, 'HIGH');
      }

      // Step 3: Data freshness validation
      if (enableFreshnessValidation) {
        const freshnessCheck = this.validateDataFreshness(transformedData);
        validationResult.validationChecks.freshnessValidation = freshnessCheck;
        this.updateValidationResult(validationResult, freshnessCheck, 'MEDIUM');
      }

      // Step 4: Completeness validation
      if (enableCompletenessValidation) {
        const completenessCheck =
          this.validateDataCompleteness(transformedData);
        validationResult.validationChecks.completenessValidation =
          completenessCheck;
        this.updateValidationResult(
          validationResult,
          completenessCheck,
          'MEDIUM'
        );
      }

      // Step 5: Temporal consistency validation
      if (enableConsistencyValidation && previousData) {
        const consistencyCheck = this.validateTemporalConsistency(
          transformedData,
          previousData
        );
        validationResult.validationChecks.consistencyValidation =
          consistencyCheck;
        this.updateValidationResult(validationResult, consistencyCheck, 'HIGH');
      }

      // Step 6: Physics-based validation (using parent class)
      if (enablePhysicsValidation) {
        const physicsCheck = this.validatePhysicsRules(
          transformedData.measurements || {}
        );
        validationResult.validationChecks.physicsValidation = physicsCheck;
        this.updateValidationResult(validationResult, physicsCheck, 'HIGH');
      }

      // Step 7: Anti-fraud quality pipeline checks
      if (enableAntiFraudValidation) {
        const antiFraudResult = this.antiFraudPipeline.evaluateSubmission(
          transformedData,
          {
            previousData,
          }
        );

        const antiFraudCheck = {
          passed: !antiFraudResult.shouldReject,
          details: antiFraudResult.reasonCodes.map(
            reasonCode => `Anti-fraud reason code: ${reasonCode}`
          ),
          score: Math.max(0, 1 - antiFraudResult.penaltyPoints / 100),
          reasonCodes: antiFraudResult.reasonCodes,
          riskScore: antiFraudResult.riskScore,
          riskLevel: antiFraudResult.riskLevel,
          eventId: antiFraudResult.eventId,
        };

        validationResult.validationChecks.antiFraudValidation = antiFraudCheck;
        this.updateValidationResult(
          validationResult,
          antiFraudCheck,
          antiFraudResult.shouldReject ? 'CRITICAL' : 'HIGH'
        );

        validationResult.riskAssessment = {
          decision: antiFraudResult.decision,
          shouldReject: antiFraudResult.shouldReject,
          riskLevel: antiFraudResult.riskLevel,
          riskScore: antiFraudResult.riskScore,
          penaltyPoints: antiFraudResult.penaltyPoints,
          reasonCodes: antiFraudResult.reasonCodes,
          eventId: antiFraudResult.eventId,
          auditedAt: antiFraudResult.auditedAt,
        };

        if (antiFraudResult.decision === 'review_required') {
          validationResult.warnings.push(
            `Submission requires review: ${antiFraudResult.reasonCodes.join(', ')}`
          );
        }
      }

      // Calculate final quality score and level
      this.calculateFinalScore(validationResult);

      // Determine if data can be ingested
      if (validationResult.riskAssessment.shouldReject) {
        validationResult.isValid = false;
        validationResult.canIngest = false;
      } else if (strictMode) {
        validationResult.canIngest =
          validationResult.isValid &&
          validationResult.validationChecks.structureValidation.passed &&
          validationResult.validationChecks.physicsValidation.passed;
      } else {
        validationResult.canIngest = validationResult.overallScore >= 0.3; // Minimum threshold
      }

      logger.debug('Weather ingestion validation completed', {
        canIngest: validationResult.canIngest,
        overallScore: validationResult.overallScore,
        qualityLevel: validationResult.qualityLevel,
        issueCount: validationResult.issues.length,
        provider: transformedData.metadata?.provider,
      });

      return validationResult;
    } catch (error) {
      logger.error('Error during ingestion validation:', {
        error: error.message,
        provider: transformedData.metadata?.provider,
      });

      return {
        isValid: false,
        overallScore: 0,
        qualityLevel: 'invalid',
        canIngest: false,
        issues: [
          {
            severity: 'CRITICAL',
            type: 'validation_error',
            message: `Validation failed: ${error.message}`,
            timestamp: new Date().toISOString(),
          },
        ],
        warnings: [],
        validationChecks: {},
        riskAssessment: {
          decision: 'rejected',
          shouldReject: true,
          riskLevel: 'critical',
          riskScore: 100,
          penaltyPoints: 100,
          reasonCodes: ['AMBIGUOUS_STATE'],
          eventId: null,
        },
        metadata: {
          validatedAt: new Date().toISOString(),
          validatorVersion: '1.0.0',
          error: error.message,
        },
      };
    }
  }

  /**
   * Validate data structure and required fields
   */
  validateDataStructure(data) {
    const result = {
      passed: true,
      details: [],
      score: 1.0,
    };

    // Check required top-level sections
    const requiredSections = ['metadata', 'location', 'measurements'];
    for (const section of requiredSections) {
      if (!data[section]) {
        result.details.push(`Missing required section: ${section}`);
        result.passed = false;
        result.score -= 0.3;
      }
    }

    // Check required metadata fields
    if (data.metadata) {
      const requiredMetadata = [
        'sourceId',
        'sourceType',
        'provider',
        'timestamp',
      ];
      for (const field of requiredMetadata) {
        if (!data.metadata[field]) {
          result.details.push(`Missing required metadata field: ${field}`);
          result.passed = false;
          result.score -= 0.1;
        }
      }

      // Validate timestamp format
      if (data.metadata.timestamp) {
        const timestamp = new Date(data.metadata.timestamp);
        if (isNaN(timestamp.getTime())) {
          result.details.push('Invalid timestamp format');
          result.passed = false;
          result.score -= 0.1;
        }
      }
    }

    // Check required location fields
    if (data.location) {
      const requiredLocation = ['latitude', 'longitude'];
      for (const field of requiredLocation) {
        if (
          data.location[field] === null ||
          data.location[field] === undefined
        ) {
          result.details.push(`Missing required location field: ${field}`);
          result.passed = false;
          result.score -= 0.2;
        }
      }

      // Validate coordinate ranges
      if (
        data.location.latitude !== null &&
        data.location.latitude !== undefined
      ) {
        if (data.location.latitude < -90 || data.location.latitude > 90) {
          result.details.push(`Invalid latitude: ${data.location.latitude}`);
          result.passed = false;
          result.score -= 0.2;
        }
      }

      if (
        data.location.longitude !== null &&
        data.location.longitude !== undefined
      ) {
        if (data.location.longitude < -180 || data.location.longitude > 180) {
          result.details.push(`Invalid longitude: ${data.location.longitude}`);
          result.passed = false;
          result.score -= 0.2;
        }
      }
    }

    // Check measurements structure
    if (data.measurements) {
      if (Object.keys(data.measurements).length === 0) {
        result.details.push('No measurements provided');
        result.passed = false;
        result.score -= 0.3;
      } else {
        // Validate measurement structure
        Object.entries(data.measurements).forEach(([param, measurement]) => {
          if (!measurement || typeof measurement !== 'object') {
            result.details.push(`Invalid measurement structure for ${param}`);
            result.score -= 0.05;
          } else {
            if (measurement.value === null || measurement.value === undefined) {
              result.details.push(`Missing value for measurement ${param}`);
              result.score -= 0.03;
            }
            if (!measurement.unit) {
              result.details.push(`Missing unit for measurement ${param}`);
              result.score -= 0.02;
            }
          }
        });
      }
    }

    result.score = Math.max(0, result.score);
    return result;
  }

  /**
   * Validate data source credibility and authenticity
   */
  validateDataSource(data) {
    const result = {
      passed: true,
      details: [],
      score: 1.0,
    };

    const provider = data.metadata?.provider;
    const sourceType = data.metadata?.sourceType;
    const sourceId = data.metadata?.sourceId;

    // Check if provider is known and credible
    const sourceInfo =
      this.ingestionRules.sourceCredibility[provider] ||
      this.ingestionRules.sourceCredibility['Unknown'];

    result.score = sourceInfo.credibilityScore;

    if (sourceInfo.trustLevel === 'low') {
      result.details.push(`Low trust level for provider: ${provider}`);
      result.passed = false;
    }

    // Validate source type
    const validSourceTypes = ['api', 'station', 'satellite', 'model'];
    if (!validSourceTypes.includes(sourceType)) {
      result.details.push(`Invalid source type: ${sourceType}`);
      result.score -= 0.2;
    }

    // Check for required source identification
    if (!sourceId || sourceId === 'unknown') {
      result.details.push('Missing or invalid source identifier');
      result.score -= 0.1;
    }

    // Additional checks for station data
    if (sourceType === 'station') {
      if (!data.location?.stationId) {
        result.details.push('Missing station ID for station data');
        result.score -= 0.1;
      }
      if (!data.location?.stationName) {
        result.details.push('Missing station name for station data');
        result.score -= 0.05;
      }
    }

    result.score = Math.max(0, result.score);
    return result;
  }

  /**
   * Validate data freshness based on data type
   */
  validateDataFreshness(data) {
    const result = {
      passed: true,
      details: [],
      score: 1.0,
    };

    const timestamp = new Date(data.metadata?.timestamp);
    const now = new Date();
    const dataType = data.metadata?.dataType || 'current';

    if (isNaN(timestamp.getTime())) {
      result.details.push('Invalid timestamp for freshness validation');
      result.passed = false;
      result.score = 0;
      return result;
    }

    const ageHours = (now - timestamp) / (1000 * 60 * 60);
    const freshnessRule = this.ingestionRules.dataFreshness[dataType];

    if (!freshnessRule) {
      result.details.push(`No freshness rule for data type: ${dataType}`);
      result.score -= 0.1;
      return result;
    }

    // Check against maximum age
    if (dataType === 'historical') {
      const ageYears = ageHours / (24 * 365);
      if (ageYears > freshnessRule.maxAgeYears) {
        result.details.push(
          `Historical data too old: ${ageYears.toFixed(1)} years`
        );
        result.passed = false;
        result.score = 0.3; // Old historical data still has some value
      }
    } else {
      if (ageHours > freshnessRule.maxAgeHours) {
        result.details.push(
          `Data too stale: ${ageHours.toFixed(1)} hours old (max: ${freshnessRule.maxAgeHours})`
        );
        result.passed = false;
        result.score = Math.max(
          0,
          1 - (ageHours - freshnessRule.maxAgeHours) / freshnessRule.maxAgeHours
        );
      }
    }

    // Check for future timestamps
    if (timestamp > now) {
      const futureHours = (timestamp - now) / (1000 * 60 * 60);
      if (futureHours > 24) {
        // Allow up to 24 hours for forecast data
        result.details.push(
          `Data timestamp is too far in the future: ${futureHours.toFixed(1)} hours`
        );
        result.passed = false;
        result.score -= 0.5;
      }
    }

    result.score = Math.max(0, result.score);
    return result;
  }

  /**
   * Enhanced completeness validation for ingestion
   */
  validateDataCompleteness(data) {
    const result = {
      passed: true,
      details: [],
      score: 1.0,
      completenessRatio: 0,
    };

    const dataType = data.metadata?.dataType || 'current';
    const completenessRule = this.ingestionRules.dataCompleteness[dataType];

    if (!completenessRule) {
      result.details.push(`No completeness rule for data type: ${dataType}`);
      result.score = 0.8;
      return result;
    }

    const measurements = data.measurements || {};
    const presentParams = Object.keys(measurements).filter(param => {
      const measurement = measurements[param];
      return (
        measurement &&
        measurement.value !== null &&
        measurement.value !== undefined
      );
    });

    // Check essential parameters
    const missingEssential = completenessRule.essential.filter(
      param => !presentParams.includes(param)
    );
    if (missingEssential.length > 0) {
      result.details.push(
        `Missing essential parameters: ${missingEssential.join(', ')}`
      );
      result.passed = false;
      result.score -=
        0.3 * (missingEssential.length / completenessRule.essential.length);
    }

    // Check recommended parameters
    const missingRecommended = completenessRule.recommended.filter(
      param => !presentParams.includes(param)
    );
    if (missingRecommended.length > 0) {
      result.details.push(
        `Missing recommended parameters: ${missingRecommended.join(', ')}`
      );
      result.score -=
        0.1 * (missingRecommended.length / completenessRule.recommended.length);
    }

    // Calculate completeness ratio
    const totalExpected =
      completenessRule.essential.length +
      completenessRule.recommended.length +
      completenessRule.optional.length;
    const totalPresent = presentParams.length;

    result.completenessRatio = totalPresent / totalExpected;

    // Bonus for having optional parameters
    const optionalPresent = completenessRule.optional.filter(param =>
      presentParams.includes(param)
    );
    if (optionalPresent.length > 0) {
      result.score +=
        0.05 * (optionalPresent.length / completenessRule.optional.length);
    }

    result.score = Math.max(0, Math.min(1, result.score));
    return result;
  }

  /**
   * Validate temporal consistency with previous data
   */
  validateTemporalConsistency(currentData, previousData) {
    const result = {
      passed: true,
      details: [],
      score: 1.0,
    };

    if (!previousData || !previousData.measurements) {
      result.details.push('No previous data for temporal consistency check');
      return result;
    }

    const currentMeasurements = currentData.measurements || {};
    const previousMeasurements = previousData.measurements || {};

    // Calculate time difference in hours
    const currentTime = new Date(currentData.metadata?.timestamp);
    const previousTime = new Date(previousData.metadata?.timestamp);
    const timeDiffHours = (currentTime - previousTime) / (1000 * 60 * 60);

    if (timeDiffHours <= 0) {
      result.details.push('Current data is not newer than previous data');
      result.passed = false;
      result.score -= 0.3;
      return result;
    }

    // Check each parameter for reasonable change rates
    const consistencyRules = this.ingestionRules.temporalConsistency;

    // Temperature consistency
    const currentTemp = this.extractValue(currentMeasurements.temperature);
    const previousTemp = this.extractValue(previousMeasurements.temperature);

    if (currentTemp !== null && previousTemp !== null) {
      const tempChange = Math.abs(currentTemp - previousTemp);
      const maxTempChange =
        consistencyRules.maxTemperatureChange * timeDiffHours;

      if (tempChange > maxTempChange) {
        result.details.push(
          `Excessive temperature change: ${tempChange.toFixed(1)}°C in ${timeDiffHours.toFixed(1)} hours`
        );
        result.passed = false;
        result.score -= 0.2;
      }
    }

    // Pressure consistency
    const currentPressure = this.extractValue(currentMeasurements.pressure);
    const previousPressure = this.extractValue(previousMeasurements.pressure);

    if (currentPressure !== null && previousPressure !== null) {
      const pressureChange = Math.abs(currentPressure - previousPressure);
      const maxPressureChange =
        consistencyRules.maxPressureChange * timeDiffHours;

      if (pressureChange > maxPressureChange) {
        result.details.push(
          `Excessive pressure change: ${pressureChange.toFixed(1)} hPa in ${timeDiffHours.toFixed(1)} hours`
        );
        result.passed = false;
        result.score -= 0.2;
      }
    }

    // Humidity consistency
    const currentHumidity = this.extractValue(currentMeasurements.humidity);
    const previousHumidity = this.extractValue(previousMeasurements.humidity);

    if (currentHumidity !== null && previousHumidity !== null) {
      const humidityChange = Math.abs(currentHumidity - previousHumidity);
      const maxHumidityChange =
        consistencyRules.maxHumidityChange * timeDiffHours;

      if (humidityChange > maxHumidityChange) {
        result.details.push(
          `Excessive humidity change: ${humidityChange.toFixed(1)}% in ${timeDiffHours.toFixed(1)} hours`
        );
        result.score -= 0.1; // Less critical than temperature/pressure
      }
    }

    result.score = Math.max(0, result.score);
    return result;
  }

  /**
   * Update validation result based on check results
   */
  updateValidationResult(validationResult, checkResult, severity) {
    if (!checkResult.passed) {
      validationResult.isValid = false;

      checkResult.details.forEach(detail => {
        validationResult.issues.push({
          severity,
          type: 'validation_check',
          message: detail,
          timestamp: new Date().toISOString(),
        });
      });
    }

    // Update overall score based on check score
    if (checkResult.score !== undefined) {
      const weight = this.getSeverityWeight(severity);
      validationResult.overallScore *=
        checkResult.score * weight + (1 - weight);
    }
  }

  /**
   * Calculate final quality score and level
   */
  calculateFinalScore(validationResult) {
    // Adjust score based on issue severity
    const severityPenalties = {
      CRITICAL: 0.5,
      HIGH: 0.2,
      MEDIUM: 0.1,
      LOW: 0.05,
      INFO: 0.01,
    };

    validationResult.issues.forEach(issue => {
      const penalty = severityPenalties[issue.severity] || 0.1;
      validationResult.overallScore = Math.max(
        0,
        validationResult.overallScore - penalty
      );
    });

    // Determine quality level
    if (validationResult.overallScore >= 0.9) {
      validationResult.qualityLevel = 'excellent';
    } else if (validationResult.overallScore >= 0.75) {
      validationResult.qualityLevel = 'good';
    } else if (validationResult.overallScore >= 0.5) {
      validationResult.qualityLevel = 'fair';
    } else if (validationResult.overallScore >= 0.3) {
      validationResult.qualityLevel = 'poor';
    } else {
      validationResult.qualityLevel = 'invalid';
    }
  }

  /**
   * Get severity weight for score calculation
   */
  getSeverityWeight(severity) {
    const weights = {
      CRITICAL: 1.0,
      HIGH: 0.8,
      MEDIUM: 0.6,
      LOW: 0.4,
      INFO: 0.2,
    };
    return weights[severity] || 0.5;
  }

  /**
   * Validate batch of ingestion data
   */
  async validateIngestionBatch(transformedDataArray, options = {}) {
    const results = [];

    for (let i = 0; i < transformedDataArray.length; i++) {
      const currentData = transformedDataArray[i];
      const previousData =
        i > 0 ? transformedDataArray[i - 1] : options.previousData;

      try {
        const result = await this.validateIngestionData(currentData, {
          ...options,
          previousData,
        });
        results.push(result);
      } catch (error) {
        logger.error('Error validating data in batch:', {
          error: error.message,
          index: i,
        });
        results.push({
          isValid: false,
          overallScore: 0,
          qualityLevel: 'invalid',
          canIngest: false,
          issues: [
            {
              severity: 'CRITICAL',
              type: 'validation_error',
              message: `Batch validation failed: ${error.message}`,
              timestamp: new Date().toISOString(),
            },
          ],
          warnings: [],
          validationChecks: {},
          metadata: {
            validatedAt: new Date().toISOString(),
            batchIndex: i,
            error: error.message,
          },
        });
      }
    }

    return results;
  }

  /**
   * Get validation statistics for batch results
   */
  getValidationStatistics(validationResults) {
    const stats = {
      totalRecords: validationResults.length,
      canIngestCount: 0,
      qualityDistribution: {
        excellent: 0,
        good: 0,
        fair: 0,
        poor: 0,
        invalid: 0,
      },
      issueDistribution: {
        CRITICAL: 0,
        HIGH: 0,
        MEDIUM: 0,
        LOW: 0,
        INFO: 0,
      },
      averageScore: 0,
      ingestionRate: 0,
      commonIssues: {},
    };

    validationResults.forEach(result => {
      if (result.canIngest) {
        stats.canIngestCount++;
      }

      stats.qualityDistribution[result.qualityLevel]++;
      stats.averageScore += result.overallScore;

      result.issues?.forEach(issue => {
        stats.issueDistribution[issue.severity]++;

        const issueType = issue.message.split(':')[0];
        stats.commonIssues[issueType] =
          (stats.commonIssues[issueType] || 0) + 1;
      });
    });

    stats.averageScore = stats.averageScore / validationResults.length;
    stats.ingestionRate = stats.canIngestCount / stats.totalRecords;

    return stats;
  }
}

module.exports = WeatherIngestionValidator;
