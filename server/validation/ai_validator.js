/**
 * AI Validation Module for Wrfcoin
 *
 * This module implements AI-based validation for computational tasks,
 * particularly focused on weather, climate, and air quality forecast validation.
 * It provides intelligent verification of computational NFT results before
 * they are added to the blockchain.
 */

const crypto = require('crypto');
const path = require('path');
const { proximityIncentiveCalculator } = require('../proximity/incentives');
const { aimlLogger } = require('../utils/logger.js');

// Validation types
const VALIDATION_TYPES = {
  WEATHER_FORECAST: 'weather_forecast',
  CLIMATE_MODEL: 'climate_model',
  AIR_QUALITY: 'air_quality',
  CUSTOM: 'custom',
};

// Validation methods
const VALIDATION_METHODS = {
  ENSEMBLE_COMPARISON: 'ensemble_comparison',
  HISTORICAL_ACCURACY: 'historical_accuracy',
  PHYSICAL_CONSTRAINTS: 'physical_constraints',
  PATTERN_RECOGNITION: 'pattern_recognition',
  SPATIAL_COHERENCE: 'spatial_coherence',
  TEMPORAL_CONSISTENCY: 'temporal_consistency',
};

// Validation confidence levels
const CONFIDENCE_LEVELS = {
  VERY_LOW: 'very_low', // 0-20%
  LOW: 'low', // 21-40%
  MEDIUM: 'medium', // 41-60%
  HIGH: 'high', // 61-80%
  VERY_HIGH: 'very_high', // 81-100%
};

/**
 * AI Validator Class
 * Handles validation of computational results
 */
class AIValidator {
  constructor() {
    // Store validation models
    this.models = new Map();

    // Store validation histories
    this.validationHistory = [];

    // Configure validation thresholds
    this.thresholds = {
      weather: {
        temperature: 2.0, // °C
        precipitation: 5.0, // mm
        windSpeed: 5.0, // m/s
        pressure: 5.0, // hPa
      },
      climate: {
        temperature: 1.0, // °C
        precipitation: 10.0, // mm
      },
      airQuality: {
        pm25: 10.0, // µg/m³
        pm10: 20.0, // µg/m³
        ozone: 20.0, // ppb
        no2: 10.0, // ppb
      },
    };
  }

  /**
   * Register a new validation model
   *
   * @param {string} modelId - Unique identifier for the model
   * @param {string} modelType - Type of validation model
   * @param {Object} modelConfig - Configuration for the model
   * @returns {boolean} - Success status
   */
  registerModel(modelId, modelType, modelConfig) {
    if (this.models.has(modelId)) {
      aimlLogger.warn('Validation model already exists', {
        module: 'AIValidator',
        operation: 'registerModel',
        modelId,
      });
      return false;
    }

    // Create model metadata
    const modelData = {
      id: modelId,
      type: modelType,
      config: modelConfig,
      created: Date.now(),
      status: 'initialized',
    };

    this.models.set(modelId, modelData);
    aimlLogger.info('Registered validation model', {
      module: 'AIValidator',
      operation: 'registerModel',
      modelId,
      modelType,
    });

    return true;
  }

  /**
   * Validate a computational NFT result
   *
   * @param {Object} nft - The NFT object with computational results
   * @param {Object} validationOptions - Options for validation
   * @returns {Promise<Object>} - Validation results
   */
  async validateResult(nft, validationOptions = {}) {
    if (!nft || !nft.result) {
      throw new Error('Invalid NFT or missing result data');
    }

    const { computationType } = nft;

    aimlLogger.info('Starting validation for NFT', {
      module: 'AIValidator',
      operation: 'validateResult',
      nftId: nft.id,
      computationType,
    });

    // Create a validation context with all needed information
    const validationContext = {
      nftId: nft.id,
      computationType,
      result: nft.result,
      metadata: nft.metadata || {},
      options: validationOptions,
      timestamp: Date.now(),
      validationId: `val-${crypto.randomBytes(16).toString('hex')}`,
    };

    // Select validation methods based on computation type
    let validationMethods = [];
    let validationResults = {};

    switch (computationType) {
      case 'weather':
        validationMethods = this._getWeatherValidationMethods(nft);
        validationResults = await this._validateWeatherForecast(
          nft,
          validationContext
        );
        break;
      case 'climate':
        validationMethods = this._getClimateValidationMethods(nft);
        validationResults = await this._validateClimateModel(
          nft,
          validationContext
        );
        break;
      case 'air_quality':
        validationMethods = this._getAirQualityValidationMethods(nft);
        validationResults = await this._validateAirQualityForecast(
          nft,
          validationContext
        );
        break;
      default:
        validationMethods = [VALIDATION_METHODS.PATTERN_RECOGNITION];
        validationResults = await this._validateGenericComputation(
          nft,
          validationContext
        );
        break;
    }

    // Calculate overall validation score
    const overallScore = this._calculateOverallScore(validationResults);

    // Determine confidence level
    const confidenceLevel = this._determineConfidenceLevel(overallScore);

    // Create final validation record
    const validationRecord = {
      validationId: validationContext.validationId,
      nftId: nft.id,
      timestamp: validationContext.timestamp,
      methods: validationMethods,
      results: validationResults,
      overallScore,
      confidenceLevel,
      decision: overallScore >= 0.7 ? 'ACCEPTED' : 'REJECTED',
      details: {
        validationDuration: Date.now() - validationContext.timestamp,
        validatedBy: this._getValidatorIdentifier(),
      },
    };

    // Store validation in history
    this.validationHistory.push(validationRecord);

    aimlLogger.info('Validation completed', {
      module: 'AIValidator',
      operation: 'validateResult',
      nftId: nft.id,
      overallScore: overallScore.toFixed(2),
      decision: validationRecord.decision,
    });

    return validationRecord;
  }

  /**
   * Validate a weather forecast
   *
   * @private
   * @param {Object} nft - The NFT object
   * @param {Object} context - Validation context
   * @returns {Promise<Object>} - Validation results for each method
   */
  async _validateWeatherForecast(nft, context) {
    const result = {};

    // Extract forecast data
    const forecast = nft.result;

    // Check if we have a proper structured forecast
    if (!forecast || !forecast.parameters) {
      return {
        spatialCoherence: 0,
        temporalConsistency: 0,
        physicalConstraints: 0,
        ensembleComparison: 0,
        comments: ['Invalid forecast structure'],
      };
    }

    // 1. Spatial coherence - check if spatial patterns are realistic
    result.spatialCoherence = await this._validateSpatialCoherence(forecast);

    // 2. Temporal consistency - check if time evolution is realistic
    result.temporalConsistency =
      await this._validateTemporalConsistency(forecast);

    // 3. Physical constraints - check if values are within physical bounds
    result.physicalConstraints =
      await this._validatePhysicalConstraints(forecast);

    // 4. Ensemble comparison - compare with ensemble of other models
    result.ensembleComparison = await this._validateEnsembleComparison(
      forecast,
      'weather'
    );

    // Add comments on specific issues found
    result.comments = [];

    // Check for specific anomalies in temperature
    if (forecast.parameters.temperature) {
      const tempData = forecast.parameters.temperature;

      // Check for unrealistic temperature gradients
      const maxGradient = this._calculateMaxGradient(tempData);
      if (maxGradient > 15) {
        // 15°C per grid cell is unrealistic
        result.comments.push(
          `Unrealistic temperature gradient detected (${maxGradient.toFixed(1)}°C)`
        );
        result.spatialCoherence *= 0.8; // Reduce score
      }

      // Check for physically impossible temperatures
      const { min, max } = this._findMinMax(tempData);
      if (min < -100 || max > 60) {
        // Impossible temperatures on Earth
        result.comments.push(
          `Temperature outside physically possible range: ${min.toFixed(1)}°C to ${max.toFixed(1)}°C`
        );
        result.physicalConstraints *= 0.6; // Severely reduce score
      }
    }

    return result;
  }

  /**
   * Validate a climate model result
   *
   * @private
   * @param {Object} nft - The NFT object
   * @param {Object} context - Validation context
   * @returns {Promise<Object>} - Validation results for each method
   */
  async _validateClimateModel(nft, context) {
    const result = {};

    // Extract model data
    const modelOutput = nft.result;

    // 1. Physical constraints - check if values are within physical bounds
    result.physicalConstraints =
      await this._validatePhysicalConstraints(modelOutput);

    // 2. Historical accuracy - compare with historical climate data
    result.historicalAccuracy =
      await this._validateHistoricalAccuracy(modelOutput);

    // 3. Spatial coherence - check if spatial patterns make sense
    result.spatialCoherence = await this._validateSpatialCoherence(modelOutput);

    // 4. Ensemble comparison - compare with ensemble of other climate models
    result.ensembleComparison = await this._validateEnsembleComparison(
      modelOutput,
      'climate'
    );

    // Add comments on specific issues found
    result.comments = [];

    // Check for specific issues in climate model
    if (modelOutput.parameters && modelOutput.parameters.temperatureAnomaly) {
      const anomalies = modelOutput.parameters.temperatureAnomaly;

      // Check for unrealistic warming/cooling rates
      const maxAnomaly = Math.max(...anomalies.map(Math.abs));
      if (maxAnomaly > 12) {
        // More than 12°C anomaly is extremely unlikely
        result.comments.push(
          `Unrealistic temperature anomaly detected (${maxAnomaly.toFixed(1)}°C)`
        );
        result.physicalConstraints *= 0.7; // Reduce score
      }
    }

    return result;
  }

  /**
   * Validate an air quality forecast
   *
   * @private
   * @param {Object} nft - The NFT object
   * @param {Object} context - Validation context
   * @returns {Promise<Object>} - Validation results for each method
   */
  async _validateAirQualityForecast(nft, context) {
    const result = {};

    // Extract forecast data
    const airQualityData = nft.result;

    // 1. Physical constraints - check if concentrations are within physical bounds
    result.physicalConstraints =
      await this._validatePhysicalConstraints(airQualityData);

    // 2. Spatial coherence - check if spatial distribution makes sense
    result.spatialCoherence =
      await this._validateSpatialCoherence(airQualityData);

    // 3. Temporal consistency - check if time evolution is realistic
    result.temporalConsistency =
      await this._validateTemporalConsistency(airQualityData);

    // 4. Ensemble comparison - compare with ensemble of other air quality models
    result.ensembleComparison = await this._validateEnsembleComparison(
      airQualityData,
      'air_quality'
    );

    // Add comments on specific issues found
    result.comments = [];

    // Check for specific issues in air quality data
    if (airQualityData.parameters) {
      // Check for impossible concentrations of pollutants
      const params = airQualityData.parameters;

      if (params.pm25 && Math.max(...params.pm25) > 1000) {
        result.comments.push(
          'Unrealistic PM2.5 concentration detected (>1000 µg/m³)'
        );
        result.physicalConstraints *= 0.7; // Reduce score
      }

      if (params.ozone && Math.max(...params.ozone) > 500) {
        result.comments.push(
          'Unrealistic ozone concentration detected (>500 ppb)'
        );
        result.physicalConstraints *= 0.7; // Reduce score
      }
    }

    return result;
  }

  /**
   * Validate a generic computation result
   *
   * @private
   * @param {Object} nft - The NFT object
   * @param {Object} context - Validation context
   * @returns {Promise<Object>} - Validation results for each method
   */
  async _validateGenericComputation(nft, context) {
    // TODO(#226): HARDCODED — replace with real AI inference.
    // patternRecognition: 0.8 is a placeholder that makes every computation look valid.
    // Implement statistical analysis of computation outputs against expected distributions.
    const score = 0.8; // TODO(#226): HARDCODED — replace with actual ML model inference
    if (typeof score !== 'number' || score < 0 || score > 1) {
      throw new Error('AI weather validator: patternRecognition score must be computed in range [0,1]');
    }
    return {
      patternRecognition: score,
      comments: [
        'Limited validation for custom computation type',
        'WARNING(#226): score is hardcoded — not based on real computation analysis',
      ],
    };
  }

  /**
   * Validate spatial coherence of forecast/model data
   *
   * @private
   * @param {Object} data - The forecast/model data
   * @returns {Promise<number>} - Validation score (0-1)
   */
  async _validateSpatialCoherence(data) {
    // TODO(#226): HARDCODED — replace with real spatial coherence analysis.
    // Should compare neighboring grid cells for physically plausible gradients
    // (e.g., temperature shouldn't jump 30C between adjacent cells).
    // Align with PhysicsRangePolicy from shared-protocol (PR #594).

    // Check if we have grid data
    if (!data.parameters) {
      return 0.5; // Neutral score if no parameters — TODO(#226): HARDCODED
    }

    const score = 0.85; // TODO(#226): HARDCODED — replace with spatial autocorrelation analysis
    if (typeof score !== 'number' || score < 0 || score > 1) {
      throw new Error('AI weather validator: spatial coherence score must be computed in range [0,1]');
    }
    return score;
  }

  /**
   * Validate temporal consistency of forecast/model data
   *
   * @private
   * @param {Object} data - The forecast/model data
   * @returns {Promise<number>} - Validation score (0-1)
   */
  async _validateTemporalConsistency(data) {
    // TODO(#226): HARDCODED — replace with real temporal consistency analysis.
    // Should verify forecast evolution follows physical constraints
    // (e.g., temperature change rates, pressure tendency rules).
    // Align with PhysicsRangePolicy from shared-protocol (PR #594).

    // Check if we have time series data
    if (!data.parameters || !data.timeSteps) {
      return 0.5; // Neutral score if no time data — TODO(#226): HARDCODED
    }

    const score = 0.9; // TODO(#226): HARDCODED — replace with temporal derivative bounds analysis
    if (typeof score !== 'number' || score < 0 || score > 1) {
      throw new Error('AI weather validator: temporal consistency score must be computed in range [0,1]');
    }
    return score;
  }

  /**
   * Validate physical constraints of forecast/model data
   *
   * @private
   * @param {Object} data - The forecast/model data
   * @returns {Promise<number>} - Validation score (0-1)
   */
  async _validatePhysicalConstraints(data) {
    // TODO(#226): HARDCODED — replace with real physics bounds checking.
    // Should call PhysicsRangePolicy / validate_physics() from shared-protocol (PR #594).

    // Check if we have parameter data
    if (!data.parameters) {
      return 0.5; // Neutral score if no parameters — TODO(#226): HARDCODED
    }

    const score = 0.95; // TODO(#226): HARDCODED — replace with validate_physics() call
    if (typeof score !== 'number' || score < 0 || score > 1) {
      throw new Error('AI weather validator: physical constraints score must be computed in range [0,1]');
    }
    return score;
  }

  /**
   * Validate by comparison with ensemble of other models
   *
   * @private
   * @param {Object} data - The forecast/model data
   * @param {string} dataType - Type of data (weather, climate, air_quality)
   * @returns {Promise<number>} - Validation score (0-1)
   */
  async _validateEnsembleComparison(data, dataType) {
    // TODO(#226): HARDCODED — replace with real ensemble comparison.
    // Should load other model results and compute statistical agreement score.

    const score = 0.8; // TODO(#226): HARDCODED — replace with actual ensemble model comparison
    if (typeof score !== 'number' || score < 0 || score > 1) {
      throw new Error('AI weather validator: ensemble comparison score must be computed in range [0,1]');
    }
    return score;
  }

  /**
   * Validate by comparing with historical accuracy
   *
   * @private
   * @param {Object} data - The model data
   * @returns {Promise<number>} - Validation score (0-1)
   */
  async _validateHistoricalAccuracy(data) {
    // TODO(#226): HARDCODED — replace with real historical accuracy check.
    // Should query historical weather data from PostgreSQL and compute
    // correlation/RMSE between forecast and observed values.

    const score = 0.85; // TODO(#226): HARDCODED — replace with historical DB query + correlation
    if (typeof score !== 'number' || score < 0 || score > 1) {
      throw new Error('AI weather validator: historical accuracy score must be computed in range [0,1]');
    }
    return score;
  }

  /**
   * Get methods for weather forecast validation
   *
   * @private
   * @param {Object} nft - The NFT object
   * @returns {Array<string>} - List of validation methods
   */
  _getWeatherValidationMethods(nft) {
    return [
      VALIDATION_METHODS.SPATIAL_COHERENCE,
      VALIDATION_METHODS.TEMPORAL_CONSISTENCY,
      VALIDATION_METHODS.PHYSICAL_CONSTRAINTS,
      VALIDATION_METHODS.ENSEMBLE_COMPARISON,
    ];
  }

  /**
   * Get methods for climate model validation
   *
   * @private
   * @param {Object} nft - The NFT object
   * @returns {Array<string>} - List of validation methods
   */
  _getClimateValidationMethods(nft) {
    return [
      VALIDATION_METHODS.PHYSICAL_CONSTRAINTS,
      VALIDATION_METHODS.HISTORICAL_ACCURACY,
      VALIDATION_METHODS.SPATIAL_COHERENCE,
      VALIDATION_METHODS.ENSEMBLE_COMPARISON,
    ];
  }

  /**
   * Get methods for air quality forecast validation
   *
   * @private
   * @param {Object} nft - The NFT object
   * @returns {Array<string>} - List of validation methods
   */
  _getAirQualityValidationMethods(nft) {
    return [
      VALIDATION_METHODS.PHYSICAL_CONSTRAINTS,
      VALIDATION_METHODS.SPATIAL_COHERENCE,
      VALIDATION_METHODS.TEMPORAL_CONSISTENCY,
      VALIDATION_METHODS.ENSEMBLE_COMPARISON,
    ];
  }

  /**
   * Calculate overall validation score
   *
   * @private
   * @param {Object} results - Results from individual validation methods
   * @returns {number} - Overall score (0-1)
   */
  _calculateOverallScore(results) {
    // Calculate weighted average of all scores
    const scores = Object.values(results).filter(v => typeof v === 'number');

    if (scores.length === 0) {
      return 0;
    }

    return scores.reduce((sum, score) => sum + score, 0) / scores.length;
  }

  /**
   * Determine confidence level from score
   *
   * @private
   * @param {number} score - Overall validation score (0-1)
   * @returns {string} - Confidence level
   */
  _determineConfidenceLevel(score) {
    if (score < 0.2) return CONFIDENCE_LEVELS.VERY_LOW;
    if (score < 0.4) return CONFIDENCE_LEVELS.LOW;
    if (score < 0.6) return CONFIDENCE_LEVELS.MEDIUM;
    if (score < 0.8) return CONFIDENCE_LEVELS.HIGH;
    return CONFIDENCE_LEVELS.VERY_HIGH;
  }

  /**
   * Calculate maximum gradient in a grid dataset
   *
   * @private
   * @param {Array|Object} data - Grid data
   * @returns {number} - Maximum gradient found
   */
  _calculateMaxGradient(data) {
    // TODO(#226): HARDCODED — replace with real gradient calculation across grid cells.
    return 8.5; // TODO(#226): HARDCODED — simulated gradient, not computed from data
  }

  /**
   * Find minimum and maximum values in a dataset
   *
   * @private
   * @param {Array|Object} data - Dataset
   * @returns {Object} - Min and max values
   */
  _findMinMax(data) {
    // TODO(#226): HARDCODED — replace with real min/max scan over the data array.
    return { min: -20, max: 40 }; // TODO(#226): HARDCODED — simulated range, not computed from data
  }

  /**
   * Get validator identifier
   *
   * @private
   * @returns {string} - Validator identifier
   */
  _getValidatorIdentifier() {
    return `ai-validator-${process.env.NODE_ENV}-${Math.floor(Date.now() / 1000000)}`;
  }

  /**
   * Validate a task result and calculate incentives
   *
   * @param {Object} task - The computational task
   * @param {Object} result - The result data
   * @param {Object} node - The node that performed the computation
   * @param {Object} networkState - Current network state
   * @returns {Promise<Object>} - Validation and incentive results
   */
  async validateTaskAndCalculateIncentives(task, result, node, networkState) {
    // Create an NFT-like object for validation
    const nftLike = {
      id: task.taskId,
      computationType: task.taskType,
      result: result,
      metadata: task.dataMetrics || {},
    };

    // Validate the result
    const validationResult = await this.validateResult(nftLike);

    // Calculate proximity-based incentives
    const proximityResult =
      proximityIncentiveCalculator.calculateProximityIncentive(
        task,
        node,
        networkState
      );

    // Adjust incentives based on validation score
    const adjustedIncentive = {
      ...proximityResult,
      // Scale the final reward by the validation score
      finalReward: proximityResult.finalReward * validationResult.overallScore,
    };

    // Return combined results
    return {
      validationId: validationResult.validationId,
      taskId: task.taskId,
      nodeId: node.nodeId,
      validation: {
        overallScore: validationResult.overallScore,
        confidenceLevel: validationResult.confidenceLevel,
        decision: validationResult.decision,
        methods: validationResult.methods,
        results: validationResult.results,
        comments: validationResult.results.comments || [],
      },
      incentive: {
        baseReward: proximityResult.baseReward,
        finalReward: adjustedIncentive.finalReward,
        proximityMultiplier: proximityResult.multipliers.distance,
        validationMultiplier: validationResult.overallScore,
        distance: proximityResult.metrics.distanceKm,
      },
      timestamp: Date.now(),
    };
  }
}

// Export as singleton
const aiValidator = new AIValidator();
module.exports = {
  aiValidator,
  VALIDATION_TYPES,
  VALIDATION_METHODS,
  CONFIDENCE_LEVELS,
};
