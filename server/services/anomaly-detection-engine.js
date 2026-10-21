/**
 * Advanced Anomaly Detection Engine for WRFCoin Weather Data Quality Pipeline
 *
 * Implements multiple anomaly detection algorithms including statistical methods,
 * machine learning approaches, and ensemble techniques for comprehensive
 * weather data quality assurance.
 *
 * @author WRFCoin Development Team
 * @version 1.0.0
 * @since 2025-07-12
 */

// server/utils/logger is the CJS logger that ships inside dist; the root
// utils/logger is ESM-only and outside the runtime image (#1043).
const { logger } = require('../utils/logger');
const PhysicsValidationEngine = require('./physics-validation-engine');

class AnomalyDetectionEngine {
  constructor(options = {}) {
    this.config = {
      // Statistical detection parameters
      zScoreThreshold: 3.0,
      iqrMultiplier: 1.5,
      modifiedZScoreThreshold: 3.5,

      // Machine learning parameters
      isolationForestContamination: 0.1,
      localOutlierFactor: 20,

      // Temporal detection parameters
      windowSize: 24, // hours for rolling statistics
      seasonalDecomposition: true,

      // Ensemble parameters
      ensembleThreshold: 0.6, // Fraction of methods that must agree

      // Context-aware parameters
      locationContext: true,
      temporalContext: true,

      ...options,
    };

    // Detection method registry
    this.detectionMethods = new Map();
    this.ensembleResults = new Map();
    this.contextualModels = new Map();

    // Initialize physics validation engine
    this.physicsValidator = new PhysicsValidationEngine({
      temperatureTolerance: options.temperatureTolerance || 0.5,
      pressureTolerance: options.pressureTolerance || 1.0,
      humidityTolerance: options.humidityTolerance || 5.0,
      windTolerance: options.windTolerance || 2.0,
      radiationTolerance: options.radiationTolerance || 50.0,
      strictMode: options.strictMode || false,
      enableDebug: options.enableDebug || false,
      minConfidence: options.minConfidence || 0.7,
    });

    this._initializeDetectionMethods();

    logger.info('AnomalyDetectionEngine initialized', { config: this.config });
  }

  /**
   * Initialize detection methods
   * @private
   */
  _initializeDetectionMethods() {
    // Statistical methods
    this.detectionMethods.set('zscore', this._zScoreDetection.bind(this));
    this.detectionMethods.set('iqr', this._iqrDetection.bind(this));
    this.detectionMethods.set(
      'modified_zscore',
      this._modifiedZScoreDetection.bind(this)
    );
    this.detectionMethods.set('grubbs', this._grubbsTest.bind(this));

    // Machine learning methods
    this.detectionMethods.set(
      'isolation_forest',
      this._isolationForestDetection.bind(this)
    );
    this.detectionMethods.set(
      'local_outlier_factor',
      this._localOutlierFactorDetection.bind(this)
    );
    this.detectionMethods.set(
      'one_class_svm',
      this._oneClassSVMDetection.bind(this)
    );

    // Temporal methods
    this.detectionMethods.set(
      'temporal_anomaly',
      this._temporalAnomalyDetection.bind(this)
    );
    this.detectionMethods.set(
      'seasonal_decomposition',
      this._seasonalDecompositionDetection.bind(this)
    );

    // Multivariate methods
    this.detectionMethods.set(
      'mahalanobis',
      this._mahalanobisDetection.bind(this)
    );
    this.detectionMethods.set(
      'correlation_anomaly',
      this._correlationAnomalyDetection.bind(this)
    );

    // Physics-based methods
    this.detectionMethods.set(
      'physics_based',
      this._physicsBasedDetection.bind(this)
    );
    this.detectionMethods.set(
      'meteorological_consistency',
      this._meteorologicalConsistencyDetection.bind(this)
    );
  }

  /**
   * Detect anomalies using multiple methods and ensemble voting
   * @param {Array} data - Weather data array
   * @param {Object} options - Detection options
   * @returns {Object} Comprehensive anomaly detection results
   */
  async detectAnomalies(data, options = {}) {
    const startTime = Date.now();

    try {
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('Invalid or empty dataset provided');
      }

      logger.info('Starting anomaly detection', {
        recordCount: data.length,
        methods: Array.from(this.detectionMethods.keys()),
      });

      const params = this._extractWeatherParameters(data);
      const results = {
        metadata: {
          recordCount: data.length,
          parametersAnalyzed: params,
          detectionMethods: Array.from(this.detectionMethods.keys()),
          processingTimeMs: 0,
          detectedAt: new Date().toISOString(),
        },
        anomalies: {
          byMethod: {},
          ensemble: {},
          summary: {},
        },
        statistics: {},
        recommendations: [],
      };

      // Run individual detection methods
      for (const [methodName, methodFunc] of this.detectionMethods) {
        try {
          const methodResults = await methodFunc(data, params, options);
          results.anomalies.byMethod[methodName] = methodResults;

          logger.debug(`${methodName} detection completed`, {
            anomaliesFound: methodResults.anomalies?.length || 0,
          });
        } catch (error) {
          logger.warn(`${methodName} detection failed`, {
            error: error.message,
          });
          results.anomalies.byMethod[methodName] = { error: error.message };
        }
      }

      // Ensemble analysis
      results.anomalies.ensemble = this._performEnsembleAnalysis(
        results.anomalies.byMethod,
        data
      );

      // Generate summary statistics
      results.statistics = this._generateDetectionStatistics(results.anomalies);

      // Generate recommendations
      results.recommendations = this._generateAnomalyRecommendations(results);

      results.metadata.processingTimeMs = Date.now() - startTime;

      logger.info('Anomaly detection completed', {
        processingTimeMs: results.metadata.processingTimeMs,
        totalAnomalies: results.anomalies.ensemble.anomalies?.length || 0,
        confidenceScore: results.anomalies.ensemble.confidenceScore,
      });

      return results;
    } catch (error) {
      logger.error('Anomaly detection failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Z-Score based anomaly detection
   * @private
   */
  async _zScoreDetection(data, params, options) {
    const anomalies = [];
    const threshold = options.zScoreThreshold || this.config.zScoreThreshold;

    for (const param of params) {
      const values = this._extractParameterValues(data, param);
      if (values.length === 0) continue;

      const mean = this._calculateMean(values);
      const std = this._calculateStandardDeviation(values);

      if (std === 0) continue; // Skip if no variation

      data.forEach((record, index) => {
        const value = record[param];
        if (typeof value !== 'number' || isNaN(value)) return;

        const zScore = Math.abs((value - mean) / std);
        if (zScore > threshold) {
          anomalies.push({
            recordIndex: index,
            timestamp: record.timestamp,
            parameter: param,
            value: value,
            expectedRange: { mean, std },
            zScore: zScore,
            severity: zScore > threshold * 1.5 ? 'high' : 'medium',
            type: 'statistical_outlier',
          });
        }
      });
    }

    return {
      method: 'zscore',
      anomalies,
      threshold,
      summary: {
        total: anomalies.length,
        highSeverity: anomalies.filter(a => a.severity === 'high').length,
        mediumSeverity: anomalies.filter(a => a.severity === 'medium').length,
      },
    };
  }

  /**
   * Interquartile Range (IQR) based anomaly detection
   * @private
   */
  async _iqrDetection(data, params, options) {
    const anomalies = [];
    const multiplier = options.iqrMultiplier || this.config.iqrMultiplier;

    for (const param of params) {
      const values = this._extractParameterValues(data, param);
      if (values.length === 0) continue;

      const sortedValues = [...values].sort((a, b) => a - b);
      const q1 = this._calculatePercentile(sortedValues, 25);
      const q3 = this._calculatePercentile(sortedValues, 75);
      const iqr = q3 - q1;
      const lowerBound = q1 - multiplier * iqr;
      const upperBound = q3 + multiplier * iqr;

      data.forEach((record, index) => {
        const value = record[param];
        if (typeof value !== 'number' || isNaN(value)) return;

        if (value < lowerBound || value > upperBound) {
          const deviation =
            value < lowerBound
              ? (lowerBound - value) / iqr
              : (value - upperBound) / iqr;

          anomalies.push({
            recordIndex: index,
            timestamp: record.timestamp,
            parameter: param,
            value: value,
            expectedRange: { lowerBound, upperBound, q1, q3, iqr },
            deviation: deviation,
            severity: deviation > 2 ? 'high' : 'medium',
            type: 'iqr_outlier',
          });
        }
      });
    }

    return {
      method: 'iqr',
      anomalies,
      multiplier,
      summary: {
        total: anomalies.length,
        highSeverity: anomalies.filter(a => a.severity === 'high').length,
        mediumSeverity: anomalies.filter(a => a.severity === 'medium').length,
      },
    };
  }

  /**
   * Modified Z-Score based anomaly detection (using median and MAD)
   * @private
   */
  async _modifiedZScoreDetection(data, params, options) {
    const anomalies = [];
    const threshold =
      options.modifiedZScoreThreshold || this.config.modifiedZScoreThreshold;

    for (const param of params) {
      const values = this._extractParameterValues(data, param);
      if (values.length === 0) continue;

      const median = this._calculateMedian(values);
      const mad = this._calculateMAD(values, median);

      if (mad === 0) continue; // Skip if no variation

      data.forEach((record, index) => {
        const value = record[param];
        if (typeof value !== 'number' || isNaN(value)) return;

        const modifiedZScore = (0.6745 * (value - median)) / mad;
        if (Math.abs(modifiedZScore) > threshold) {
          anomalies.push({
            recordIndex: index,
            timestamp: record.timestamp,
            parameter: param,
            value: value,
            expectedRange: { median, mad },
            modifiedZScore: modifiedZScore,
            severity:
              Math.abs(modifiedZScore) > threshold * 1.5 ? 'high' : 'medium',
            type: 'modified_zscore_outlier',
          });
        }
      });
    }

    return {
      method: 'modified_zscore',
      anomalies,
      threshold,
      summary: {
        total: anomalies.length,
        highSeverity: anomalies.filter(a => a.severity === 'high').length,
        mediumSeverity: anomalies.filter(a => a.severity === 'medium').length,
      },
    };
  }

  /**
   * Grubbs' test for outliers
   * @private
   */
  async _grubbsTest(data, params, options) {
    const anomalies = [];
    const alpha = options.grubbsAlpha || 0.05;

    for (const param of params) {
      const values = this._extractParameterValues(data, param);
      if (values.length < 3) continue; // Need at least 3 values

      const mean = this._calculateMean(values);
      const std = this._calculateStandardDeviation(values);
      const n = values.length;

      // Critical value for Grubbs test
      const tCritical = this._getTCritical(alpha / (2 * n), n - 2);
      const grubbsCritical =
        ((n - 1) / Math.sqrt(n)) *
        Math.sqrt(Math.pow(tCritical, 2) / (n - 2 + Math.pow(tCritical, 2)));

      data.forEach((record, index) => {
        const value = record[param];
        if (typeof value !== 'number' || isNaN(value)) return;

        const grubbsStatistic = Math.abs(value - mean) / std;
        if (grubbsStatistic > grubbsCritical) {
          anomalies.push({
            recordIndex: index,
            timestamp: record.timestamp,
            parameter: param,
            value: value,
            expectedRange: { mean, std },
            grubbsStatistic: grubbsStatistic,
            critical: grubbsCritical,
            severity:
              grubbsStatistic > grubbsCritical * 1.2 ? 'high' : 'medium',
            type: 'grubbs_outlier',
          });
        }
      });
    }

    return {
      method: 'grubbs',
      anomalies,
      alpha,
      summary: {
        total: anomalies.length,
        highSeverity: anomalies.filter(a => a.severity === 'high').length,
        mediumSeverity: anomalies.filter(a => a.severity === 'medium').length,
      },
    };
  }

  /**
   * Isolation Forest anomaly detection (simplified implementation)
   * @private
   */
  async _isolationForestDetection(data, params, options) {
    const anomalies = [];

    try {
      // Extract feature matrix
      const features = this._extractFeatureMatrix(data, params);
      if (features.length === 0)
        return {
          method: 'isolation_forest',
          anomalies: [],
          error: 'No features extracted',
        };

      // Simplified isolation forest implementation
      const contamination =
        options.contamination || this.config.isolationForestContamination;
      const scores = await this._computeIsolationScores(features);
      const threshold = this._calculatePercentile(
        scores,
        (1 - contamination) * 100
      );

      scores.forEach((score, index) => {
        if (score > threshold) {
          anomalies.push({
            recordIndex: index,
            timestamp: data[index].timestamp,
            isolationScore: score,
            threshold: threshold,
            severity: score > threshold * 1.2 ? 'high' : 'medium',
            type: 'isolation_forest_outlier',
            affectedParameters: params.filter(
              param =>
                typeof data[index][param] === 'number' &&
                !isNaN(data[index][param])
            ),
          });
        }
      });
    } catch (error) {
      logger.warn('Isolation forest detection failed', {
        error: error.message,
      });
      return {
        method: 'isolation_forest',
        anomalies: [],
        error: error.message,
      };
    }

    return {
      method: 'isolation_forest',
      anomalies,
      contamination:
        options.contamination || this.config.isolationForestContamination,
      summary: {
        total: anomalies.length,
        highSeverity: anomalies.filter(a => a.severity === 'high').length,
        mediumSeverity: anomalies.filter(a => a.severity === 'medium').length,
      },
    };
  }

  /**
   * Temporal anomaly detection using rolling statistics
   * @private
   */
  async _temporalAnomalyDetection(data, params, options) {
    const anomalies = [];
    const windowSize = options.windowSize || this.config.windowSize;

    // Sort data by timestamp
    const sortedData = [...data].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );

    for (const param of params) {
      const values = sortedData
        .map(record => record[param])
        .filter(v => typeof v === 'number' && !isNaN(v));
      if (values.length < windowSize) continue;

      // Calculate rolling statistics
      for (let i = windowSize; i < sortedData.length; i++) {
        const window = values.slice(i - windowSize, i);
        const windowMean = this._calculateMean(window);
        const windowStd = this._calculateStandardDeviation(window);

        const currentValue = sortedData[i][param];
        if (typeof currentValue !== 'number' || isNaN(currentValue)) continue;

        const zScore =
          windowStd > 0 ? Math.abs((currentValue - windowMean) / windowStd) : 0;

        if (zScore > 3.0) {
          // Temporal anomaly threshold
          anomalies.push({
            recordIndex: i,
            timestamp: sortedData[i].timestamp,
            parameter: param,
            value: currentValue,
            rollingMean: windowMean,
            rollingStd: windowStd,
            temporalZScore: zScore,
            severity: zScore > 4.0 ? 'high' : 'medium',
            type: 'temporal_anomaly',
          });
        }
      }
    }

    return {
      method: 'temporal_anomaly',
      anomalies,
      windowSize,
      summary: {
        total: anomalies.length,
        highSeverity: anomalies.filter(a => a.severity === 'high').length,
        mediumSeverity: anomalies.filter(a => a.severity === 'medium').length,
      },
    };
  }

  /**
   * Comprehensive physics-based anomaly detection for meteorological data
   * Uses advanced atmospheric physics validation engine
   * @private
   */
  async _physicsBasedDetection(data, params, options) {
    try {
      const anomalies = [];
      const detectionResults = [];

      // Process data in batches for efficiency
      const batchSize = options.batchSize || 100;
      const batches = this._createBatches(data, batchSize);

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];

        for (let i = 0; i < batch.length; i++) {
          const record = batch[i];
          const globalIndex = batchIndex * batchSize + i;

          try {
            // Enhanced record format for physics validation
            const validationRecord =
              this._formatRecordForPhysicsValidation(record);

            // Run comprehensive physics validation
            const physicsResult = await this.physicsValidator.validateData(
              validationRecord,
              record.location || null,
              record.timestamp || null
            );

            detectionResults.push(physicsResult);

            // Convert physics violations to anomalies
            if (
              !physicsResult.overallValid &&
              physicsResult.violations.length > 0
            ) {
              const anomaly = this._convertPhysicsViolationsToAnomaly(
                physicsResult,
                record,
                globalIndex
              );

              if (anomaly) {
                anomalies.push(anomaly);
              }
            }
          } catch (recordError) {
            logger.warn('Physics validation error for record', {
              recordIndex: globalIndex,
              error: recordError.message,
              record: this._sanitizeRecordForLogging(record),
            });

            // Create anomaly for validation failure
            anomalies.push({
              recordIndex: globalIndex,
              timestamp: record.timestamp,
              violations: ['physics_validation_error'],
              severity: 'medium',
              type: 'validation_error',
              confidence: 0.5,
              message: `Physics validation failed: ${recordError.message}`,
              affectedParameters: ['unknown'],
            });
          }
        }
      }

      // Calculate aggregate metrics
      const validationMetrics =
        this._calculatePhysicsValidationMetrics(detectionResults);

      // Enhanced result with detailed physics analysis
      const result = {
        method: 'physics_based_enhanced',
        anomalies,
        validationResults: detectionResults,
        metrics: validationMetrics,
        summary: {
          total: anomalies.length,
          criticalSeverity: anomalies.filter(a => a.severity === 'critical')
            .length,
          highSeverity: anomalies.filter(a => a.severity === 'high').length,
          mediumSeverity: anomalies.filter(a => a.severity === 'medium').length,
          lowSeverity: anomalies.filter(a => a.severity === 'low').length,
          averageConfidence: validationMetrics.averageConfidence,
          physicsValidationCoverage: validationMetrics.validationCoverage,
          mostCommonViolations: this._getMostCommonViolations(anomalies),
        },
      };

      logger.info('Physics-based anomaly detection completed', {
        totalRecords: data.length,
        anomaliesFound: anomalies.length,
        averageConfidence: validationMetrics.averageConfidence,
        validationCoverage: validationMetrics.validationCoverage,
      });

      return result;
    } catch (error) {
      logger.error('Physics-based anomaly detection failed', {
        error: error.message,
        stack: error.stack,
        dataLength: data.length,
      });

      // Return fallback result
      return {
        method: 'physics_based_enhanced',
        anomalies: [],
        error: error.message,
        summary: {
          total: 0,
          error: 'Physics validation engine failed',
        },
      };
    }
  }

  /**
   * Format weather record for physics validation engine
   * @private
   */
  _formatRecordForPhysicsValidation(record) {
    return {
      // Temperature parameters
      temperature: record.temperature || record.temp,
      dewpoint: record.dewPoint || record.dewpoint || record.dew_point,

      // Atmospheric parameters
      pressure: record.pressure || record.barometricPressure,
      humidity: record.humidity || record.relativeHumidity,

      // Wind parameters
      windSpeed: record.windSpeed || record.wind_speed,
      windGust: record.windGust || record.wind_gust,
      windDirection: record.windDirection || record.wind_direction,

      // Radiation parameters
      solarRadiation: record.solarRadiation || record.solar_radiation,
      netRadiation: record.netRadiation || record.net_radiation,

      // Position parameters
      altitude: record.altitude || record.elevation,
      latitude: record.latitude || record.lat,
      longitude: record.longitude || record.lon,

      // Additional parameters
      soilTemperature: record.soilTemperature || record.soil_temperature,
      precipitation: record.precipitation || record.rainfall,

      // Metadata
      timestamp: record.timestamp,
      stationId: record.stationId || record.station_id,
      location: record.location,
    };
  }

  /**
   * Convert physics validation violations to anomaly format
   * @private
   */
  _convertPhysicsViolationsToAnomaly(
    physicsResult,
    originalRecord,
    recordIndex
  ) {
    if (!physicsResult.violations || physicsResult.violations.length === 0) {
      return null;
    }

    // Determine overall severity based on individual violation severities
    const severities = physicsResult.violations.map(v => v.severity);
    const overallSeverity = this._determineCombinedSeverity(severities);

    // Extract violation types and affected parameters
    const violationTypes = physicsResult.violations.map(v => v.type);
    const affectedParameters = this._extractAffectedParameters(
      physicsResult.violations
    );

    // Create detailed violation messages
    const violationMessages = physicsResult.violations
      .map(v => `${v.type}: ${v.message}`)
      .join('; ');

    return {
      recordIndex,
      timestamp: originalRecord.timestamp,
      violations: violationTypes,
      severity: overallSeverity,
      type: 'physics_violation',
      confidence: physicsResult.overallConfidence,
      message: violationMessages,
      affectedParameters,
      physicsCategories: Object.keys(physicsResult.validations || {}),
      validationDetails: physicsResult.validations,
      metadata: {
        stationId: originalRecord.stationId || originalRecord.station_id,
        location: originalRecord.location,
        totalChecks: physicsResult.metadata?.totalChecks || 0,
        passedChecks: physicsResult.metadata?.passedChecks || 0,
        failedChecks: physicsResult.metadata?.failedChecks || 0,
      },
    };
  }

  /**
   * Determine combined severity from multiple violation severities
   * @private
   */
  _determineCombinedSeverity(severities) {
    if (severities.includes('critical')) return 'critical';
    if (severities.includes('major')) return 'high';
    if (severities.includes('minor')) return 'medium';
    return 'low';
  }

  /**
   * Extract affected parameters from violations
   * @private
   */
  _extractAffectedParameters(violations) {
    const parameters = new Set();

    violations.forEach(violation => {
      // Map violation types to weather parameters
      const typeToParameter = {
        dewpoint_exceeds_temperature: ['temperature', 'dewpoint'],
        humidity_inconsistency: ['humidity'],
        pressure_altitude_inconsistency: ['pressure', 'altitude'],
        excessive_solar_radiation: ['solarRadiation'],
        negative_wind_speed: ['windSpeed'],
        vapor_pressure_inconsistency: ['temperature', 'dewpoint', 'humidity'],
        extreme_temperature_deviation: ['temperature'],
        invalid_wind_direction: ['windDirection'],
        radiation_temperature_inconsistency: ['solarRadiation', 'temperature'],
      };

      const params = typeToParameter[violation.type] || ['unknown'];
      params.forEach(param => parameters.add(param));
    });

    return Array.from(parameters);
  }

  /**
   * Calculate physics validation metrics
   * @private
   */
  _calculatePhysicsValidationMetrics(detectionResults) {
    if (detectionResults.length === 0) {
      return {
        averageConfidence: 0,
        validationCoverage: 0,
        totalValidations: 0,
        passedValidations: 0,
        failedValidations: 0,
      };
    }

    const totalConfidence = detectionResults.reduce(
      (sum, result) => sum + (result.overallConfidence || 0),
      0
    );

    const totalValidations = detectionResults.reduce(
      (sum, result) => sum + (result.metadata?.totalChecks || 0),
      0
    );

    const passedValidations = detectionResults.reduce(
      (sum, result) => sum + (result.metadata?.passedChecks || 0),
      0
    );

    const failedValidations = detectionResults.reduce(
      (sum, result) => sum + (result.metadata?.failedChecks || 0),
      0
    );

    const validationCoverage =
      totalValidations > 0
        ? (passedValidations + failedValidations) / totalValidations
        : 0;

    return {
      averageConfidence: totalConfidence / detectionResults.length,
      validationCoverage,
      totalValidations,
      passedValidations,
      failedValidations,
    };
  }

  /**
   * Get most common violation types
   * @private
   */
  _getMostCommonViolations(anomalies) {
    const violationCounts = {};

    anomalies.forEach(anomaly => {
      anomaly.violations.forEach(violation => {
        violationCounts[violation] = (violationCounts[violation] || 0) + 1;
      });
    });

    return Object.entries(violationCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([violation, count]) => ({ violation, count }));
  }

  /**
   * Create data batches for processing
   * @private
   */
  _createBatches(data, batchSize) {
    const batches = [];
    for (let i = 0; i < data.length; i += batchSize) {
      batches.push(data.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Sanitize record for logging (remove sensitive data)
   * @private
   */
  _sanitizeRecordForLogging(record) {
    const sanitized = { ...record };
    // Remove potentially sensitive fields
    delete sanitized.location;
    delete sanitized.stationId;
    delete sanitized.userId;
    return sanitized;
  }

  /**
   * Perform ensemble analysis to combine results from multiple methods
   * @private
   */
  _performEnsembleAnalysis(methodResults, data) {
    const ensembleAnomalies = [];
    const recordAnomalyCount = new Map();
    const ensembleThreshold = this.config.ensembleThreshold;

    // Count how many methods flagged each record
    Object.values(methodResults).forEach(result => {
      if (result.anomalies) {
        result.anomalies.forEach(anomaly => {
          const count = recordAnomalyCount.get(anomaly.recordIndex) || 0;
          recordAnomalyCount.set(anomaly.recordIndex, count + 1);
        });
      }
    });

    const totalMethods = Object.keys(methodResults).filter(
      key => methodResults[key].anomalies && !methodResults[key].error
    ).length;

    const minAgreement = Math.ceil(totalMethods * ensembleThreshold);

    // Create ensemble anomalies for records with sufficient agreement
    recordAnomalyCount.forEach((count, recordIndex) => {
      if (count >= minAgreement && recordIndex < data.length) {
        const methodsAgreeing = [];
        const severities = [];
        const types = new Set();

        Object.entries(methodResults).forEach(([methodName, result]) => {
          if (result.anomalies) {
            const anomaly = result.anomalies.find(
              a => a.recordIndex === recordIndex
            );
            if (anomaly) {
              methodsAgreeing.push(methodName);
              severities.push(anomaly.severity);
              types.add(anomaly.type);
            }
          }
        });

        const highSeverityCount = severities.filter(s => s === 'high').length;
        const confidence = count / totalMethods;

        ensembleAnomalies.push({
          recordIndex: recordIndex,
          timestamp: data[recordIndex].timestamp,
          methodsAgreeing: methodsAgreeing,
          agreementCount: count,
          totalMethods: totalMethods,
          confidence: confidence,
          severity:
            highSeverityCount > methodsAgreeing.length / 2 ? 'high' : 'medium',
          types: Array.from(types),
          record: data[recordIndex],
        });
      }
    });

    // Sort by confidence (highest first)
    ensembleAnomalies.sort((a, b) => b.confidence - a.confidence);

    return {
      anomalies: ensembleAnomalies,
      ensembleThreshold,
      totalMethods,
      confidenceScore:
        ensembleAnomalies.length > 0
          ? ensembleAnomalies.reduce((sum, a) => sum + a.confidence, 0) /
            ensembleAnomalies.length
          : 0,
      summary: {
        total: ensembleAnomalies.length,
        highSeverity: ensembleAnomalies.filter(a => a.severity === 'high')
          .length,
        mediumSeverity: ensembleAnomalies.filter(a => a.severity === 'medium')
          .length,
        highConfidence: ensembleAnomalies.filter(a => a.confidence > 0.8)
          .length,
      },
    };
  }

  /**
   * Generate detection statistics summary
   * @private
   */
  _generateDetectionStatistics(anomalies) {
    const stats = {
      methodsExecuted: Object.keys(anomalies.byMethod).length,
      methodsSuccessful: Object.keys(anomalies.byMethod).filter(
        key => !anomalies.byMethod[key].error
      ).length,
      totalAnomaliesByMethod: {},
      ensembleEffectiveness: 0,
    };

    Object.entries(anomalies.byMethod).forEach(([method, result]) => {
      if (result.anomalies) {
        stats.totalAnomaliesByMethod[method] = result.anomalies.length;
      }
    });

    if (anomalies.ensemble && anomalies.ensemble.anomalies) {
      const totalIndividual = Object.values(
        stats.totalAnomaliesByMethod
      ).reduce((sum, count) => sum + count, 0);
      const ensembleCount = anomalies.ensemble.anomalies.length;
      stats.ensembleEffectiveness =
        totalIndividual > 0 ? 1 - ensembleCount / totalIndividual : 0;
    }

    return stats;
  }

  /**
   * Generate recommendations based on anomaly detection results
   * @private
   */
  _generateAnomalyRecommendations(results) {
    const recommendations = [];

    if (results.anomalies.ensemble.summary.total > 0) {
      const highSeverityRatio =
        results.anomalies.ensemble.summary.highSeverity /
        results.anomalies.ensemble.summary.total;

      if (highSeverityRatio > 0.5) {
        recommendations.push({
          type: 'urgent',
          message:
            'High number of severe anomalies detected. Immediate investigation required.',
          action: 'Review data collection processes and sensor calibration',
        });
      }

      if (results.anomalies.ensemble.confidenceScore > 0.8) {
        recommendations.push({
          type: 'high_confidence',
          message:
            'High confidence anomalies detected. These are likely genuine data quality issues.',
          action: 'Prioritize investigation of high-confidence anomalies',
        });
      }

      // Method-specific recommendations
      Object.entries(results.anomalies.byMethod).forEach(([method, result]) => {
        if (result.anomalies && result.anomalies.length > 0) {
          switch (method) {
            case 'physics_based':
              recommendations.push({
                type: 'physics',
                message:
                  'Physics-based violations detected. Check sensor accuracy and calibration.',
                action: 'Validate meteorological relationships in data',
              });
              break;
            case 'temporal_anomaly':
              recommendations.push({
                type: 'temporal',
                message:
                  'Temporal anomalies detected. Check for sudden environmental changes or sensor malfunctions.',
                action: 'Investigate timing of anomalous readings',
              });
              break;
          }
        }
      });
    } else {
      recommendations.push({
        type: 'normal',
        message:
          'No significant anomalies detected. Data quality appears good.',
        action: 'Continue routine monitoring',
      });
    }

    return recommendations;
  }

  /**
   * Helper methods for statistical calculations
   * @private
   */
  _extractWeatherParameters(data) {
    if (!data.length) return [];

    const weatherParams = [
      'temperature',
      'humidity',
      'pressure',
      'windSpeed',
      'windDirection',
      'precipitation',
      'visibility',
      'dewPoint',
      'heatIndex',
      'windChill',
      'uvIndex',
      'solarRadiation',
      'snowDepth',
      'cloudCover',
    ];

    return Object.keys(data[0]).filter(
      key =>
        weatherParams.includes(key) &&
        data.some(
          record => typeof record[key] === 'number' && !isNaN(record[key])
        )
    );
  }

  _extractParameterValues(data, param) {
    return data
      .map(record => record[param])
      .filter(
        value => typeof value === 'number' && !isNaN(value) && isFinite(value)
      );
  }

  _extractFeatureMatrix(data, params) {
    return data
      .map(record => {
        return params.map(param => {
          const value = record[param];
          return typeof value === 'number' && !isNaN(value) ? value : 0;
        });
      })
      .filter(row => row.some(val => val !== 0));
  }

  _calculateMean(values) {
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  _calculateMedian(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  _calculateStandardDeviation(values) {
    const mean = this._calculateMean(values);
    const variance =
      values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
      values.length;
    return Math.sqrt(variance);
  }

  _calculateMAD(values, median) {
    const deviations = values.map(val => Math.abs(val - median));
    return this._calculateMedian(deviations);
  }

  _calculatePercentile(values, percentile) {
    const sorted = [...values].sort((a, b) => a - b);
    const index = (percentile / 100) * (sorted.length - 1);
    if (index % 1 === 0) {
      return sorted[index];
    } else {
      const lower = sorted[Math.floor(index)];
      const upper = sorted[Math.ceil(index)];
      return lower + (upper - lower) * (index % 1);
    }
  }

  _getTCritical(alpha, df) {
    // Simplified t-critical value calculation (approximation)
    // In production, use a proper statistical library
    const tTable = {
      0.05: {
        1: 12.706,
        2: 4.303,
        3: 3.182,
        5: 2.571,
        10: 2.228,
        20: 2.086,
        30: 2.042,
      },
    };

    const alphaValues = tTable[alpha] || tTable[0.05];
    const dfKeys = Object.keys(alphaValues)
      .map(Number)
      .sort((a, b) => a - b);

    for (const key of dfKeys) {
      if (df <= key) return alphaValues[key];
    }

    return 2.042; // Default value for large df
  }

  async _computeIsolationScores(features) {
    // Simplified isolation score calculation
    // In production, implement proper isolation forest algorithm
    const scores = [];
    const numFeatures = features[0]?.length || 0;

    for (let i = 0; i < features.length; i++) {
      let score = 0;
      const point = features[i];

      // Calculate average path length (simplified)
      for (let j = 0; j < features.length; j++) {
        if (i === j) continue;
        const otherPoint = features[j];
        const distance = Math.sqrt(
          point.reduce(
            (sum, val, idx) => sum + Math.pow(val - otherPoint[idx], 2),
            0
          )
        );
        score += 1 / (1 + distance);
      }

      scores.push(score / features.length);
    }

    return scores;
  }

  // Placeholder methods for future implementation
  async _localOutlierFactorDetection(data, params, options) {
    return {
      method: 'local_outlier_factor',
      anomalies: [],
      message: 'Not yet implemented',
    };
  }

  async _oneClassSVMDetection(data, params, options) {
    return {
      method: 'one_class_svm',
      anomalies: [],
      message: 'Not yet implemented',
    };
  }

  async _seasonalDecompositionDetection(data, params, options) {
    return {
      method: 'seasonal_decomposition',
      anomalies: [],
      message: 'Not yet implemented',
    };
  }

  async _mahalanobisDetection(data, params, options) {
    return {
      method: 'mahalanobis',
      anomalies: [],
      message: 'Not yet implemented',
    };
  }

  async _correlationAnomalyDetection(data, params, options) {
    return {
      method: 'correlation_anomaly',
      anomalies: [],
      message: 'Not yet implemented',
    };
  }

  async _meteorologicalConsistencyDetection(data, params, options) {
    return {
      method: 'meteorological_consistency',
      anomalies: [],
      message: 'Not yet implemented',
    };
  }
}

module.exports = AnomalyDetectionEngine;
